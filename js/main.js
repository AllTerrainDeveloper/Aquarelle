/**
 * UI wiring. Heavy work (analysis, planning, similarity) runs in a worker;
 * the simulation runs on the main thread under a per-frame budget.
 */

import { PAPER_LINEAR } from './color.js';
import { WatercolorRenderer } from './watercolor-renderer.js';
import { PigmentModel } from './pigment-model.js';
import { SplashGenerator } from './splash-generator.js';
import { DryingModel } from './drying-model.js';
import { AdaptiveController } from './adaptive-controller.js';
import { AnimationController } from './animation-controller.js';
import { ExportManager } from './export-manager.js';
import { SAMPLES, makeSample } from './samples.js';
import { GestureAnimator } from './gesture-animator.js';

const $ = ( id ) => document.getElementById( id );
const SPEEDS = [ 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64 ];
const PAPER_SIZE = 1024;
const params = new URLSearchParams( location.search );

/* Worker RPC ------------------------------------------------------------ */
const worker = new Worker( new URL( './analysis-worker.js', import.meta.url ), { type: 'module' } );
let reqId = 0;
const pending = new Map();
worker.onmessage = ( e ) => {
	const { id, error, ...rest } = e.data;
	const p = pending.get( id );
	pending.delete( id );
	if ( p ) {
		error ? p.reject( new Error( error ) ) : p.resolve( rest );
	}
};
function call( type, payload = {}, transfer = [] ) {
	return new Promise( ( resolve, reject ) => {
		const id = ++reqId;
		pending.set( id, { resolve, reject } );
		worker.postMessage( { id, type, ...payload }, transfer );
	} );
}

/* Core objects ------------------------------------------------------------ */
let renderer;
try {
	renderer = new WatercolorRenderer( $( 'paint' ) );
} catch ( err ) {
	$( 'status' ).textContent = err.message;
	throw err;
}
const adaptive = new AdaptiveController();
const exporter = new ExportManager( renderer );
let paperTex = null;
const paperReady = call( 'paper', { size: PAPER_SIZE, seed: 7 } ).then( ( { tex } ) => {
	paperTex = tex.slice();
	renderer.setPaper( tex, PAPER_SIZE, PAPER_LINEAR );
} );

let source = null;
// Palette colours the user removed, and colours dragged onto another
// (from -> to), as indices into the analysed palette.
const excluded = new Set();
const remap = new Map();
let sourceName = 'image';
let session = null;
let doneResolve = null;
let finalScores = null;

const animation = new AnimationController( {
	renderer,
	adaptive,
	evaluate: ( D ) => call( 'evaluate', { D: D.buffer }, [ D.buffer ] ),
	planLayer: ( msg, transfer ) => call( 'planLayer', msg, transfer ),
	onStats: updateHud,
	onDone: handleDone,
} );

adaptive.onLevelChange = () => {
	if ( session ) {
		session.splash.complexity = adaptive.q.complexity;
	}
	layout();
};

/* Helpers ----------------------------------------------------------------- */
const fmt = ( s ) => {
	s = Math.max( 0, Math.round( s ) );
	return Math.floor( s / 60 ) + ':' + String( s % 60 ).padStart( 2, '0' );
};
const setStatus = ( t ) => ( $( 'status' ).textContent = t );
const srcSize = ( s ) => [ s.naturalWidth || s.width, s.naturalHeight || s.height ];

/**
 * Fine-detail levels: grid resolution, how many detail strokes the hand
 * makes, and how small they get. Higher levels keep text and logos legible.
 */
const DETAIL = [
	{ name: 'Soft', res: 300, strokes: 0.6, fine: 1.25 },
	{ name: 'Balanced', res: 400, strokes: 1, fine: 1 },
	{ name: 'Fine', res: 520, strokes: 1.7, fine: 0.75 },
	{ name: 'Very fine', res: 640, strokes: 2.4, fine: 0.6 },
	{ name: 'Maximum', res: 800, strokes: 3.2, fine: 0.5 },
];
const detailLevel = () => DETAIL[ Number( $( 'detail' ).value ) ] || DETAIL[ 1 ];

function simResolution() {
	return detailLevel().res;
}

/** Paper height at simulation resolution, matching the renderer's mapping. */
function paperAtSim( W, H ) {
	const out = new Float32Array( W * H );
	const B = Math.max( W, H );
	const texPerCell = ( 1.5 * PAPER_SIZE ) / B;
	const st = Math.max( 1, Math.floor( texPerCell / 2 ) );
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			const u0 = Math.floor( x * texPerCell );
			const v0 = Math.floor( y * texPerCell );
			let s = 0;
			let n = 0;
			for ( let dv = 0; dv < texPerCell; dv += st ) {
				for ( let du = 0; du < texPerCell; du += st ) {
					const u = ( u0 + Math.floor( du ) ) % PAPER_SIZE;
					const v = ( v0 + Math.floor( dv ) ) % PAPER_SIZE;
					s += paperTex[ ( v * PAPER_SIZE + u ) * 4 ];
					n++;
				}
			}
			out[ y * W + x ] = s / n / 255;
		}
	}
	return out;
}

/* Layout -------------------------------------------------------------------- */
function layout() {
	const box = $( 'canvases' ).getBoundingClientRect();
	const compare = $( 'compare' ).checked && source;
	const narrow = window.innerWidth <= 860;
	const [ sw, sh ] = source ? srcSize( source ) : [ 4, 3 ];
	const aspect = sw / sh;
	let availW = box.width;
	let availH = narrow ? window.innerHeight * 0.62 : box.height - 26;
	if ( compare ) {
		if ( narrow ) {
			availH = availH / 2 - 20;
		} else {
			availW = ( availW - 18 ) / 2;
		}
	}
	let w = availW;
	let h = w / aspect;
	if ( h > availH ) {
		h = availH;
		w = h * aspect;
	}
	w = Math.max( 50, Math.floor( w ) );
	h = Math.max( 50, Math.floor( h ) );
	for ( const id of [ 'paint', 'refCanvas', 'overlay' ] ) {
		$( id ).style.width = w + 'px';
		$( id ).style.height = h + 'px';
	}
	const dpr = Math.min( 2, window.devicePixelRatio || 1 ) * adaptive.q.renderScale;
	renderer.resize( Math.round( w * dpr ), Math.round( h * dpr ) );
	const ov = $( 'overlay' );
	const od = Math.min( 2, window.devicePixelRatio || 1 );
	if ( ov.width !== Math.round( w * od ) || ov.height !== Math.round( h * od ) ) {
		ov.width = Math.round( w * od );
		ov.height = Math.round( h * od );
	}
	$( 'refFig' ).hidden = ! compare;
	if ( compare ) {
		const rc = $( 'refCanvas' );
		const rd = Math.min( 2, window.devicePixelRatio || 1 );
		rc.width = Math.round( w * rd );
		rc.height = Math.round( h * rd );
		rc.getContext( '2d' ).drawImage( source, 0, 0, rc.width, rc.height );
	}
	if ( ! session ) {
		const g = renderer.gl;
		g.viewport( 0, 0, renderer.canvas.width, renderer.canvas.height );
		g.clearColor( 0.98, 0.965, 0.935, 1 );
		g.clear( g.COLOR_BUFFER_BIT );
	}
}
new ResizeObserver( layout ).observe( $( 'canvases' ) );
window.addEventListener( 'resize', layout );

/* Source loading ------------------------------------------------------------- */
function loadSource( img, name ) {
	excluded.clear();
	remap.clear();
	source = img;
	sourceName = name;
	const [ sw, sh ] = srcSize( img );
	const pv = $( 'refPreview' );
	const s = Math.min( 560 / sw, 360 / sh );
	pv.width = Math.round( sw * s );
	pv.height = Math.round( sh * s );
	pv.getContext( '2d' ).drawImage( img, 0, 0, pv.width, pv.height );
	pv.hidden = false;
	$( 'dropHint' ).hidden = true;
	$( 'analyze' ).disabled = false;
	layout();
	return analyze();
}

async function loadFile( file ) {
	if ( ! file || ! file.type.startsWith( 'image/' ) ) {
		setStatus( 'That file is not an image.' );
		return;
	}
	try {
		const bmp = await createImageBitmap( file );
		await loadSource( bmp, file.name.replace( /\.[^.]+$/, '' ) );
	} catch ( err ) {
		setStatus( 'Could not read that image: ' + err.message );
	}
}

$( 'file' ).addEventListener( 'change', ( e ) => loadFile( e.target.files[ 0 ] ) );
for ( const target of [ $( 'drop' ), document.body ] ) {
	target.addEventListener( 'dragover', ( e ) => {
		e.preventDefault();
		$( 'drop' ).classList.add( 'over' );
	} );
	target.addEventListener( 'dragleave', () => $( 'drop' ).classList.remove( 'over' ) );
	target.addEventListener( 'drop', ( e ) => {
		e.preventDefault();
		$( 'drop' ).classList.remove( 'over' );
		loadFile( e.dataTransfer.files[ 0 ] );
	} );
}
for ( const [ key, s ] of Object.entries( SAMPLES ) ) {
	const b = document.createElement( 'button' );
	b.type = 'button';
	b.textContent = s.label;
	b.addEventListener( 'click', () => loadSource( makeSample( key ), key ) );
	$( 'samples' ).appendChild( b );
}

/* Analysis + planning ----------------------------------------------------------- */
async function analyze() {
	if ( ! source ) {
		return;
	}
	animation.pause();
	if ( animation.state !== 'idle' ) {
		animation.state = 'idle';
	}
	for ( const id of [ 'analyze', 'start', 'pause', 'restart', 'exportPng', 'record' ] ) {
		$( id ).disabled = true;
	}
	$( 'analyze' ).classList.remove( 'attention' );
	const [ sw, sh ] = srcSize( source );
	const res = simResolution();
	const s = res / Math.max( sw, sh );
	const W = Math.max( 16, Math.round( sw * s ) );
	const H = Math.max( 16, Math.round( sh * s ) );
	const grab = ( w, h ) => {
		const c = document.createElement( 'canvas' );
		c.width = w;
		c.height = h;
		const g = c.getContext( '2d', { willReadFrequently: true } );
		g.imageSmoothingQuality = 'high';
		g.drawImage( source, 0, 0, w, h );
		return g.getImageData( 0, 0, w, h ).data;
	};
	const pixels = grab( W, H );
	const rs = Math.min( 1, Math.min( 1200, 2 * res ) / Math.max( sw, sh ) );
	const refW = Math.max( W, Math.round( sw * rs ) );
	const refH = Math.max( H, Math.round( sh * rs ) );
	const refPixels = grab( refW, refH );
	const K = Number( $( 'pigments' ).value );
	const seed = Number( $( 'seed' ).value ) >>> 0;
	const minutes = Math.min( 30, Math.max( 1, Number( $( 'duration' ).value ) || 10 ) );
	const duration = minutes * 60;
	setStatus( `Analyzing ${ W }×${ H } in a background worker…` );
	const t0 = performance.now();
	let r;
	try {
		r = await call( 'analyze', { width: W, height: H, pixels: pixels.buffer, refW, refH, refPixels: refPixels.buffer, K, seed, duration, exclude: [ ...excluded ], remap: [ ...remap ], detail: { strokes: detailLevel().strokes, fine: detailLevel().fine } }, [
			pixels.buffer,
			refPixels.buffer,
		] );
	} catch ( err ) {
		setStatus( 'Analysis failed: ' + err.message );
		$( 'analyze' ).disabled = false;
		throw err;
	}
	const wall = performance.now() - t0;
	await paperReady;
	const an = r.analysis;
	const model = new PigmentModel( { W, H, pigments: an.pigments, T: an.T, paper: paperAtSim( W, H ), reserve: an.reserve } );
	const drying = new DryingModel( duration );
	const splash = new SplashGenerator( model, an, drying );
	splash.complexity = adaptive.q.complexity;
	const animator = new GestureAnimator( model, an.pigments );
	animator.showGestures = $( 'hand' ).checked;
	// ?instant=1 (QA): deposits apply immediately without the animated hand.
	splash.animator = params.get( 'instant' ) ? null : animator;
	animation.overlay = $( 'overlay' ).getContext( '2d' );
	renderer.setup( W, H );
	session = { an, plan: r.plan, model, drying, splash, animator, baseline: r.baseline, timings: r.timings, wall, W, H, refW, refH, seed, K, duration };
	finalScores = null;
	animation.load( { analysis: an, plan: r.plan, model, splash, drying, animator } );
	animation.setError( r.baseline );
	layout();

	// Palette: click a colour to take it off (the painter mixes that area from
	// the remaining pigments); drag a colour onto another to turn it into that
	// one; click a removed or transformed colour to restore it.
	$( 'swatches' ).innerHTML = '';
	an.palette.forEach( ( p, idx ) => {
		const d = document.createElement( 'button' );
		d.type = 'button';
		const mapped = p.mappedTo >= 0 ? an.palette[ p.mappedTo ] : null;
		d.className = 'swatch' + ( p.isPaper ? ' paper' : '' ) + ( p.excluded ? ' excluded' : '' ) + ( mapped ? ' mapped' : '' );
		d.style.background = mapped ? `linear-gradient(135deg, ${ p.hex } 0 45%, ${ mapped.hex } 55% 100%)` : p.hex;
		d.title = mapped
			? `${ p.hex } → painted as ${ mapped.hex } (click to restore)`
			: p.excluded
			? `${ p.hex } — removed (click to allow it again)`
			: p.isPaper
			? `${ p.hex } — left as bare paper`
			: `${ p.hex } — click to remove, or drag onto another colour to turn it into that one`;
		d.setAttribute( 'aria-label', d.title );
		d.disabled = p.isPaper;
		d.dataset.idx = String( idx );
		const canDrag = ! p.isPaper && ! p.excluded && ! mapped;
		// Pointer-based drag (works with mouse and touch, in every browser):
		// press a colour, move, release over another colour to paint it as
		// that one. A press without movement is a click.
		d.addEventListener( 'pointerdown', ( e ) => {
			if ( p.isPaper ) {
				return;
			}
			e.preventDefault();
			const sx = e.clientX;
			const sy = e.clientY;
			let ghost = null;
			let over = null;
			const move = ( ev ) => {
				if ( ! ghost && canDrag && Math.hypot( ev.clientX - sx, ev.clientY - sy ) > 5 ) {
					ghost = document.createElement( 'div' );
					ghost.className = 'swatch-ghost';
					ghost.style.background = p.hex;
					document.body.appendChild( ghost );
				}
				if ( ! ghost ) {
					return;
				}
				ghost.style.left = ev.clientX - 13 + 'px';
				ghost.style.top = ev.clientY - 13 + 'px';
				const el = document.elementFromPoint( ev.clientX, ev.clientY );
				const t = el && el.closest ? el.closest( '#swatches .swatch' ) : null;
				const ok = t && t !== d && ! t.classList.contains( 'excluded' ) && ! t.classList.contains( 'mapped' ) && ! t.disabled;
				if ( over && over !== t ) {
					over.classList.remove( 'target' );
				}
				over = ok ? t : null;
				if ( over ) {
					over.classList.add( 'target' );
				}
			};
			const up = () => {
				window.removeEventListener( 'pointermove', move );
				window.removeEventListener( 'pointerup', up );
				window.removeEventListener( 'pointercancel', up );
				if ( ghost ) {
					ghost.remove();
					if ( over ) {
						over.classList.remove( 'target' );
						const to = Number( over.dataset.idx );
						// Anything already turned into this colour now follows it.
						for ( const [ a, b ] of remap ) {
							if ( b === idx ) {
								remap.set( a, to );
							}
						}
						remap.set( idx, to );
						excluded.delete( idx );
						analyze();
					}
					return;
				}
				// A click: restore a transformed/removed colour, or remove it.
				if ( remap.has( idx ) ) {
					remap.delete( idx );
				} else if ( excluded.has( idx ) ) {
					excluded.delete( idx );
				} else {
					excluded.add( idx );
				}
				analyze();
			};
			window.addEventListener( 'pointermove', move );
			window.addEventListener( 'pointerup', up );
			window.addEventListener( 'pointercancel', up );
		} );
		d.addEventListener( 'keydown', ( e ) => {
			if ( 'Enter' === e.key || ' ' === e.key ) {
				e.preventDefault();
				if ( remap.has( idx ) ) {
					remap.delete( idx );
				} else if ( excluded.has( idx ) ) {
					excluded.delete( idx );
				} else {
					excluded.add( idx );
				}
				analyze();
			}
		} );
		$( 'swatches' ).appendChild( d );
	} );
	$( 'planInfo' ).textContent =
		`Plan: ${ r.plan.layers.length } layers over ${ fmt( duration ) } (${ r.plan.layers.map( ( l ) => l.name.toLowerCase() ).join( ' → ' ) }), each planned from the paper as it is. ` +
		`Analysis ${ Math.round( r.timings.analysis ) } ms, planning ${ Math.round( r.timings.plan ) } ms in a worker. ` +
		`Palette fidelity ΔE ${ an.stats.paletteDE.toFixed( 1 ) }; blank-paper similarity ${ r.baseline.scores.similarity.toFixed( 1 ) }.`;
	$( 'time' ).textContent = `0:00 / ${ fmt( duration ) }`;
	for ( const id of [ 'analyze', 'start', 'restart', 'exportPng' ] ) {
		$( id ).disabled = false;
	}
	$( 'record' ).disabled = ! exporter.canRecord();
	$( 'start' ).textContent = 'Start painting';
	setStatus( `Ready: ${ W }×${ H } simulation grid, ${ an.pigments.filter( ( p ) => ! p.isPaper ).length } pigments. Press Start.` );
	return session;
}

$( 'analyze' ).addEventListener( 'click', analyze );
$( 'pigments' ).addEventListener( 'input', ( e ) => {
	$( 'pigOut' ).textContent = e.target.value;
	// A different palette size gives different colours: start with all allowed.
	excluded.clear();
	remap.clear();
	if ( session ) {
		$( 'analyze' ).classList.add( 'attention' );
	}
} );
$( 'duration' ).addEventListener( 'input', ( e ) => {
	$( 'durOut' ).textContent = e.target.value + ' min';
} );
$( 'detail' ).addEventListener( 'input', ( e ) => {
	$( 'detailOut' ).textContent = DETAIL[ Number( e.target.value ) ].name;
	if ( session ) {
		$( 'analyze' ).classList.add( 'attention' );
	}
} );
for ( const id of [ 'duration', 'seed' ] ) {
	$( id ).addEventListener( 'change', () => session && $( 'analyze' ).classList.add( 'attention' ) );
}
$( 'dice' ).addEventListener( 'click', () => {
	$( 'seed' ).value = Math.floor( Math.random() * 1e6 );
	if ( session ) {
		$( 'analyze' ).classList.add( 'attention' );
	}
} );

/* Playback ------------------------------------------------------------------------ */
$( 'start' ).addEventListener( 'click', () => {
	if ( ! session ) {
		return;
	}
	if ( 'done' === animation.state ) {
		restart();
	}
	animation.start();
	$( 'pause' ).disabled = false;
	$( 'start' ).disabled = true;
	setStatus( '' );
} );

$( 'pause' ).addEventListener( 'click', () => {
	if ( 'painting' === animation.state ) {
		animation.pause();
		$( 'pause' ).textContent = 'Resume';
	} else if ( 'paused' === animation.state ) {
		animation.resume();
		$( 'pause' ).textContent = 'Pause';
	}
} );

function restart() {
	animation.reset();
	animation.setError( session.baseline );
	finalScores = null;
	$( 'pause' ).textContent = 'Pause';
}

$( 'restart' ).addEventListener( 'click', () => {
	if ( ! session ) {
		return;
	}
	const wasPainting = 'painting' === animation.state;
	restart();
	if ( wasPainting ) {
		animation.start();
	} else {
		$( 'start' ).disabled = false;
		$( 'pause' ).disabled = true;
	}
} );

function setSpeedIndex( i ) {
	const s = SPEEDS[ i ];
	$( 'speedOut' ).textContent = s + '×';
	animation.setSpeed( s );
}
$( 'speed' ).addEventListener( 'input', ( e ) => setSpeedIndex( Number( e.target.value ) ) );
$( 'view' ).addEventListener( 'change', ( e ) => renderer.setView( Number( e.target.value ) ) );
$( 'compare' ).addEventListener( 'change', layout );
$( 'hand' ).addEventListener( 'change', ( e ) => session && ( session.animator.showGestures = e.target.checked ) );
document.addEventListener( 'keydown', ( e ) => {
	if ( ' ' === e.key && e.target === document.body ) {
		e.preventDefault();
		$( 'pause' ).click();
	}
} );

async function finalEvaluation() {
	const { refW, refH } = session;
	const px = renderer.renderToPixels( refW, refH );
	const r = await call( 'evaluateRendered', { pixels: px.buffer, w: refW, h: refH }, [ px.buffer ] );
	return r.scores;
}

async function handleDone() {
	$( 'pause' ).disabled = true;
	$( 'start' ).disabled = false;
	$( 'start' ).textContent = 'Paint again';
	try {
		finalScores = await finalEvaluation();
		setStatus(
			`Finished. Final similarity ${ finalScores.similarity.toFixed( 1 ) } at ${ finalScores.width }×${ finalScores.height } ` +
				`(ΔE ${ finalScores.deltaE.toFixed( 1 ) }, SSIM ${ finalScores.ssim.toFixed( 3 ) }, edge r ${ finalScores.edgeCorr.toFixed( 2 ) }).`
		);
	} catch ( err ) {
		setStatus( 'Finished.' );
	}
	doneResolve?.();
	doneResolve = null;
}

/* Export ------------------------------------------------------------------------------ */
$( 'exportPng' ).addEventListener( 'click', async () => {
	const scale = Number( $( 'exportScale' ).value );
	const r = await exporter.exportPNG( scale, `aquarelle-${ sourceName }-${ session.seed }.png` );
	$( 'exportInfo' ).textContent = `Exported ${ r.w }×${ r.h } PNG (${ ( r.bytes / 1e6 ).toFixed( 1 ) } MB) — simulation grid is ${ session.W }×${ session.H }.`;
} );

$( 'record' ).addEventListener( 'click', async () => {
	if ( exporter.recorder ) {
		await exporter.stopRecording( `aquarelle-${ sourceName }` );
		$( 'record' ).textContent = 'Record video';
	} else {
		exporter.startRecording( $( 'paint' ) );
		$( 'record' ).textContent = 'Stop & save video';
	}
} );

/* HUD ---------------------------------------------------------------------------------- */
function updateHud( s ) {
	const label = { ready: 'Ready', painting: s.stage, paused: 'Paused — ' + s.stage, done: 'Finished', idle: 'Ready' }[ s.state ] || s.stage;
	$( 'stageName' ).textContent = label;
	$( 'time' ).textContent = `${ fmt( s.simTime ) } / ${ fmt( s.duration ) }`;
	$( 'pct' ).textContent = Math.round( s.progress * 100 ) + '%';
	$( 'bar' ).style.width = s.progress * 100 + '%';
	$( 'fps' ).textContent = `${ Math.round( s.fps ) } fps`;
	const sc = finalScores || s.scores;
	$( 'sim' ).textContent = sc ? `similarity ${ sc.similarity.toFixed( 1 ) }` : 'similarity —';
	const e = s.ema;
	const rows = [
		[ 'Operations', `${ s.executed } done · ${ s.cursor }/${ s.total } scheduled` ],
		[ 'Deferred (wet)', s.deferred ],
		[ 'Corrections', `${ s.corrections.paint } paint · ${ s.corrections.lift } lift` ],
		[ 'Wet area', ( s.wet.wetFraction * 100 ).toFixed( 1 ) + '%' ],
		[ 'Active tiles', s.wet.activeTiles ],
		[ 'Quality level', `${ s.level } (sim step ×${ s.dtScale.toFixed( 2 ) })` ],
		[ 'Ops / sim ms', `${ e.ops.toFixed( 2 ) } / ${ e.sim.toFixed( 2 ) }` ],
		[ 'Composite / upload', `${ e.composite.toFixed( 2 ) } / ${ e.upload.toFixed( 2 ) }` ],
		[ 'Render submit ms', e.render.toFixed( 2 ) ],
	];
	if ( s.scores ) {
		rows.push( [ 'ΔE (OKLab×100)', s.scores.deltaE.toFixed( 2 ) ] );
		rows.push( [ 'SSIM (L)', s.scores.ssim.toFixed( 3 ) ] );
		rows.push( [ 'Edge correlation', s.scores.edgeCorr.toFixed( 3 ) ] );
		rows.push( [ 'Eval (worker)', s.scores.ms.toFixed( 1 ) + ' ms' ] );
	}
	$( 'perf' ).innerHTML = rows.map( ( [ k, v ] ) => `<dt>${ k }</dt><dd>${ v }</dd>` ).join( '' );
}

/* Benchmark ------------------------------------------------------------------------------ */
const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

async function runBench() {
	const fast = Number( params.get( 'benchSpeed' ) || 12 );
	const rtSecs = Number( params.get( 'benchRt' ) || 20 );
	const only = params.get( 'benchOnly' );
	const results = [];
	$( 'bench' ).disabled = true;
	for ( const name of Object.keys( SAMPLES ) ) {
		if ( only && ! only.split( ',' ).includes( name ) ) {
			continue;
		}
		await loadSource( makeSample( name ), name );
		const t0 = performance.now();
		const done = new Promise( ( r ) => ( doneResolve = r ) );
		setSpeedIndex( 2 );
		animation.start();
		await sleep( rtSecs * 1000 );
		const rt = adaptive.summary();
		adaptive.reset();
		animation.setSpeed( fast );
		await done;
		const fastSum = adaptive.summary();
		await sleep( 300 );
		const row = {
			name,
			grid: `${ session.W }x${ session.H }`,
			analysisMs: Math.round( session.timings.analysis ),
			planMs: Math.round( session.timings.plan ),
			ops: session.plan.ops.length,
			paletteDE: +session.an.stats.paletteDE.toFixed( 1 ),
			rt1x: { avgFps: +rt.avgFps.toFixed( 1 ), minFps: +rt.minFps.toFixed( 1 ), secondsBelow55: rt.secondsBelow55, longFrames: rt.longFrames, frames: rt.totalFrames, p95FrameMs: +rt.p95FrameMs.toFixed( 1 ), perFrameMs: rt.perFrameMs },
			fast: { speed: fast, avgFps: +fastSum.avgFps.toFixed( 1 ), minFps: +fastSum.minFps.toFixed( 1 ), secondsBelow55: fastSum.secondsBelow55, longFrames: fastSum.longFrames, frames: fastSum.totalFrames, finalLevel: fastSum.finalLevel, perFrameMs: fastSum.perFrameMs },
			wallSeconds: Math.round( ( performance.now() - t0 ) / 1000 ),
			baseline: +session.baseline.scores.similarity.toFixed( 1 ),
			final: finalScores && {
				similarity: +finalScores.similarity.toFixed( 1 ),
				deltaE: +finalScores.deltaE.toFixed( 2 ),
				ssim: +finalScores.ssim.toFixed( 3 ),
				edgeCorr: +finalScores.edgeCorr.toFixed( 3 ),
			},
		};
		results.push( row );
		renderBench( results );
		console.log( 'BENCH', JSON.stringify( row ) );
	}
	window.__bench = results;
	$( 'bench' ).disabled = false;
	return results;
}

function renderBench( rows ) {
	$( 'benchOut' ).innerHTML =
		'<table><tr><th>Image</th><th>Analysis</th><th>FPS 1×</th><th>min</th><th>FPS fast</th><th>Similarity</th></tr>' +
		rows
			.map(
				( r ) =>
					`<tr><td>${ r.name }</td><td>${ r.analysisMs } ms</td><td>${ r.rt1x.avgFps }</td><td>${ r.rt1x.minFps }</td><td>${ r.fast.avgFps }</td><td>${ r.baseline } → ${ r.final ? r.final.similarity : '—' }</td></tr>`
			)
			.join( '' ) +
		'</table>';
}

$( 'bench' ).addEventListener( 'click', runBench );
window.__app = { runBench, animation, adaptive, get session() { return session; }, loadSample: ( n ) => loadSource( makeSample( n ), n ), setSpeed: ( s ) => animation.setSpeed( s ) };

layout();
if ( params.get( 'bench' ) ) {
	paperReady.then( runBench );
} else if ( params.get( 'sample' ) ) {
	paperReady.then( () => loadSource( makeSample( params.get( 'sample' ) ), params.get( 'sample' ) ) );
}
