/**
 * Director — Cinematic mode: the painting filmed at the painter's own pace.
 *
 * The sheet lies on a desk beside a water jar and a porcelain palette with a
 * well for each pigment. A camera follows the brush: it pans with the hand,
 * moves in close for fine work, shows the whole sheet for washes and while
 * the paint dries, and goes over to the palette when the brush does.
 *
 * Between colours (and whenever it has run dry) the brush goes back to the
 * desk: it swishes in the jar, which slowly clouds with the colours rinsed
 * in it, and loads up in the next colour's well (the trips are scheduled by
 * GestureAnimator so the strokes wait for them). The brush is drawn hair by
 * hair: the strands bend behind the motion with a little spring, splay under
 * pressure and as the brush dries out, and carry the paint in their lower
 * part. The hand is never teleported: between strokes it travels in the air.
 *
 * Nothing is enlarged as a picture: the renderer draws the part of the sheet
 * the camera sees at screen resolution, and the desk, the drops and the
 * brush are drawn on an overlay covering the stage with the camera applied
 * in 2D, so everything stays sharp however close the camera gets. Every
 * movement (hand, hairs, camera) runs on springs or eased paths: nothing
 * jumps.
 */

import { brushPath, brushPose, drawBead, drawHandle } from './gesture-animator.js';
import { mulberry32 } from './prng.js';
import { valueNoise } from './noise.js';
import { Bristles } from './bristles.js';

const smooth = ( a, b, x ) => {
	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );
};
const lerp = ( a, b, t ) => a + ( b - a ) * t;
// The brush's resting hold: the handle up and to the right of the tip.
const BRUSH_YAW = Math.atan2( 0.12, 0.42 );
const BRUSH_TILT = Math.acos( 0.86 / Math.hypot( 0.42, 0.12, 0.86 ) );
const norm3 = ( a ) => {
	const l = Math.hypot( a.x, a.y, a.z ) || 1;
	return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const mixRgb = ( c, d, w ) => [ lerp( c[ 0 ], d[ 0 ], w ), lerp( c[ 1 ], d[ 1 ], w ), lerp( c[ 2 ], d[ 2 ], w ) ];
const rgba = ( c, a ) => `rgba(${ c[ 0 ] | 0 },${ c[ 1 ] | 0 },${ c[ 2 ] | 0 },${ a })`;
const hexRgb = ( h ) => {
	const n = parseInt( h.slice( 1 ), 16 );
	return [ ( n >> 16 ) & 255, ( n >> 8 ) & 255, n & 255 ];
};

const WATER = [ 214, 226, 232 ];
const HAIR = [ 176, 132, 86 ];
// A clean, wet brush: just the sable, a little darker for the water.
const CLEAN = [ 120, 88, 56 ];
// The longest the brush's hair may look on screen (CSS px), however close the camera.
const MAX_HAIR_PX = 54;
// Camera: the closest it goes (on small details), and how far ahead it looks.
const MAX_ZOOM = 2.4;
const LOOKAHEAD = 2.5;
// Broad washes take a bigger brush: up to this much bigger, and this long on screen.
const MAX_GROW = 2.4;
const MAX_BIG_HAIR_PX = 120;
// Pressed right down, a round brush spreads to about this many hair lengths
// either side; and the deepest it is pressed (in hair lengths).
const SPREAD = 0.42;
const MAX_PRESS = 0.85;
// Seconds over which the hand's pressure follows the brush's contact: it
// bears down quickly and eases off slowly.
const PRESS_EASE = 0.1;
const RELEASE_EASE = 0.3;

/** Half-width of the paint a brush blob lays at progress p (path: x, y, s, r). */
function inkAt( path, p ) {
	const n = path.length / 4;
	let lo = 0;
	let hi = n - 1;
	while ( lo < hi ) {
		const mid = ( lo + hi ) >> 1;
		if ( path[ mid * 4 + 2 ] < p ) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return path[ lo * 4 + 3 ];
}

/**
 * Where things sit on the desk, in units of the sheet's longer side: the
 * sheet spans [0, Wn] x [0, Hn]; the jar and the palette stand to its right.
 * `bounds` is the part of the desk the camera may show.
 */
export function deskLayout( aspect, pigments ) {
	const Wn = aspect >= 1 ? 1 : aspect;
	const Hn = aspect >= 1 ? 1 / aspect : 1;
	const ks = [];
	pigments.forEach( ( p, k ) => p.isPaper || ks.push( k ) );
	const cols = ks.length > 5 ? 2 : 1;
	const rows = Math.max( 1, Math.ceil( ks.length / cols ) );
	const jarR = 0.075;
	const sp = Math.min( 0.11, Math.max( 0.36, Hn - 2 * jarR - 0.1 ) / rows );
	const pad = 0.022;
	const trayW = cols * sp + 2 * pad;
	const trayH = rows * sp + 2 * pad;
	const sideW = Math.max( trayW, 2 * jarR + 0.02 );
	const x0 = Wn + 0.06;
	const total = 2 * jarR + 0.05 + trayH;
	const top = Math.max( -0.03, Hn / 2 - total / 2 );
	const jar = { x: x0 + sideW / 2, y: top + jarR, r: jarR };
	const tray = { x: x0 + ( sideW - trayW ) / 2, y: top + 2 * jarR + 0.05, w: trayW, h: trayH };
	const wells = {};
	ks.forEach( ( k, j ) => {
		wells[ k ] = { x: tray.x + pad + ( ( j % cols ) + 0.5 ) * sp, y: tray.y + pad + ( Math.floor( j / cols ) + 0.5 ) * sp, r: sp * 0.45 };
	} );
	const m = 0.05;
	return {
		Wn,
		Hn,
		jar,
		tray,
		wells,
		rest: { x: Wn + 0.03, y: Hn * 0.55 },
		bounds: { x0: -m, y0: Math.min( -m, top - m ), x1: x0 + sideW + m, y1: Math.max( Hn + m, tray.y + trayH + m ) },
	};
}

/** A desk surface: warm grey, with a faint grain. */
function deskPattern( ctx ) {
	const c = document.createElement( 'canvas' );
	c.width = c.height = 256;
	const g = c.getContext( '2d' );
	g.fillStyle = '#d8d1c4';
	g.fillRect( 0, 0, 256, 256 );
	const img = g.getImageData( 0, 0, 256, 256 );
	const rnd = mulberry32( 7 );
	for ( let y = 0; y < 256; y++ ) {
		const grain = Math.sin( y * 0.21 + Math.sin( y * 0.031 ) * 3 ) * 3;
		for ( let x = 0; x < 256; x++ ) {
			const i = ( y * 256 + x ) * 4;
			const n = ( rnd() - 0.5 ) * 10 + grain;
			img.data[ i ] += n;
			img.data[ i + 1 ] += n * 0.95;
			img.data[ i + 2 ] += n * 0.85;
		}
	}
	g.putImageData( img, 0, 0 );
	return ctx.createPattern( c, 'repeat' );
}

export class Director {
	/**
	 * @param {Object} els { stage: the element the camera frames, figure: the
	 *   sheet's element (moved by the camera), overlay: 2D canvas over the stage }
	 */
	constructor( { stage, figure, overlay, renderer } ) {
		this.stage = stage;
		this.figure = figure;
		this.overlay = overlay;
		this.ctx = overlay.getContext( '2d' );
		this.renderer = renderer;
		this.active = false;
		this.desk = null;
		this.scss = 1;
		// The brush's hairs, simulated.
		this.br = new Bristles( 36 );
		this.reset();
	}

	reset() {
		this.cam = null;
		this.hand = null;
		this.raw = null;
		this.depth = 0;
		this.bear = undefined;
		this.corr = { x: 0, y: 0 };
		this.lean = { x: 0, y: 0 };
		// How the brush is held: re-gripped a little differently for each
		// stroke (yaw round the vertical and tilt from it, in radians).
		this.grip = { yaw: 0, tilt: 0, wantYaw: 0, wantTilt: 0, rnd: mulberry32( 11 ) };
		// The hand's flight lags its plan on a loose spring (see _moveHand).
		this.fly = null;
		if ( this.br ) {
			this.br.ready = false;
		}
		this.color = CLEAN.slice();
		this.load = 0;
		// The rinse water: the colour that clouds it, and how much (0 clear).
		this.water = WATER.slice();
		this.stain = 0;
		this.swirl = { parts: [], energy: 0, spawn: 0, at: null, rnd: mulberry32( 5 ) };
		this.idleFor = 10;
		this.dipSeen = null;
		this.time = 0;
	}

	/** A new painting: its pigments and the desk around its sheet. */
	setup( session ) {
		this.session = session;
		this.animator = session.animator;
		this.W = session.W;
		this.H = session.H;
		this.colors = session.an.pigments.map( ( p ) => hexRgb( p.hex ) );
		this.layout = deskLayout( session.W / session.H, session.an.pigments );
		this.deskCache = null;
		this.animator.desk = this._deskInCells();
		this.reset();
	}

	/** The desk in simulation cells, for scheduling the brush's trips. */
	_deskInCells() {
		const S = Math.max( this.W, this.H );
		const L = this.layout;
		const pt = ( p ) => ( { x: p.x * S, y: p.y * S, r: ( p.r || 0 ) * S } );
		const wells = {};
		for ( const k in L.wells ) {
			wells[ k ] = pt( L.wells[ k ] );
		}
		return { S, jar: pt( L.jar ), wells, rest: pt( L.rest ) };
	}

	enable( on ) {
		this.active = on;
		this.stage.classList.toggle( 'cinematic', on );
		// The overlay leaves the sheet (which the camera moves) to cover the stage.
		( on ? this.stage : this.figure ).appendChild( this.overlay );
		this.ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		this.ctx.clearRect( 0, 0, this.overlay.width, this.overlay.height );
		this.renderer.setSheen( on ? 2.2 : 1 );
		if ( ! on ) {
			this.renderer.setCamera( 0, 0, 1, 1 );
		}
		this.reset();
	}

	/** Called by the page layout with the sheet's size on screen (CSS px per desk unit). */
	setScale( scss ) {
		// The camera is kept (only rescaled): a relayout, say when the quality
		// level changes during a slow frame, must never cut back to the wide shot.
		const r = scss / this.scss;
		if ( this.cam && r !== 1 && isFinite( r ) ) {
			const c = this.cam;
			c.x *= r;
			c.y *= r;
			c.vx *= r;
			c.vy *= r;
		}
		if ( this.framing && r !== 1 && isFinite( r ) ) {
			this.framing.focus = { x: this.framing.focus.x * r, y: this.framing.focus.y * r };
		}
		this.scss = scss;
	}

	/** Cells to sheet CSS px. */
	get pc() {
		return ( this.scss * this.layout.Wn ) / this.W;
	}

	/* The hand ------------------------------------------------------------------ */

	/**
	 * Where the brush should be now: on an active stroke (the paint is laid
	 * there), carried through the air or to the desk, or (between gestures)
	 * held where it is.
	 */
	_target( t ) {
		for ( const a of this.animator.actions ) {
			if ( a.hidden ) {
				continue;
			}
			if ( 'brush' === a.tool ) {
				const p = brushPose( a, t );
				if ( p ) {
					const k = a.blob ? a.blob.k : -1;
					// The width of the paint being laid under the tip right now
					// (0 where the stroke skips: the brush rises a little there).
					const ink = a.blob && a.blob.path ? inkAt( a.blob.path, p.p ) : a.tip * 0.6;
					// Coming down and lifting off ease in and out.
					// Off the sheet, or where the stroke lays nothing, the brush is lifted clear.
					// (gradually, over a few cells past the edge)
					const out = Math.max( 0, -p.x, -p.y, p.x - this.W, p.y - this.H );
					const lift = Math.max( smooth( 0, 1, p.lift ), smooth( 0, 4, out ), ink > 0 ? 0 : 0.7 );
					// Lifted, the hand never wanders off over the desk: it waits at the sheet's edge.
					p.x = Math.min( this.W, Math.max( 0, p.x ) );
					p.y = Math.min( this.H, Math.max( 0, p.y ) );
					return { ...p, lift, id: a, exact: true, stroke: true, ink: ink || a.tip, k, lifting: !! a.lift, focus: { x: a.x, y: a.y } };
				}
			}
			if ( 'dip' === a.tool && t >= a.start && t <= a.start + a.dur ) {
				return this._dipPose( a, t );
			}
		}
		const at = this.raw || this.animator.desk.rest;
		return { x: at.x, y: at.y, dx: 0, dy: 0, lift: 1, press: 0, exact: false };
	}

	/** The brush carried to the next mark, or to the jar and the palette and back. */
	_dipPose( a, t ) {
		let e = t - a.start;
		let j = 0;
		while ( j < a.segs.length - 1 && e > a.segs[ j ].dur ) {
			e -= a.segs[ j ].dur;
			j++;
		}
		const g = a.segs[ j ];
		const u = Math.min( 1, Math.max( 0, e / g.dur ) );
		const S = this.animator.desk.S;
		const pose = { dip: ! a.travel, id: a, exact: true, press: 0, dx: 0, dy: 0, k: a.k, seg: g.kind, u };
		if ( 'move' === g.kind || 'out' === g.kind ) {
			const to = 'out' === g.kind ? ( a.next ? brushPath( a.next, a.next.p0 ?? 0 ) : g.from ) : g.to;
			if ( 'out' === g.kind && a.next ) {
				// On the way, the brush takes the size of the next mark.
				pose.ink = a.next.blob && a.next.blob.path ? inkAt( a.next.blob.path, 0.02 ) || a.next.tip : a.next.tip;
			}
			// Smooth start and stop (zero speed at both ends) along a gentle
			// arc, lifted higher the further it goes.
			// Smoothstep: zero speed at both ends, a gentle peak in between.
			const w = u * u * ( 3 - 2 * u );
			const dx = to.x - g.from.x;
			const dy = to.y - g.from.y;
			const dist = Math.hypot( dx, dy );
			const bow = Math.sin( Math.PI * w ) * 0.1;
			pose.x = g.from.x + dx * w - dy * bow;
			pose.y = g.from.y + dy * w + dx * bow;
			pose.dx = dx;
			pose.dy = dy;
			pose.to = to;
			const l0 = 0 === j ? 1 : 0;
			const l1 = 'out' === g.kind ? 1 : 0;
			pose.lift = lerp( l0, l1, w ) + Math.min( 0.9, dist / ( 0.12 * S ) ) * Math.sin( Math.PI * w );
			return pose;
		}
		// In the jar or a well the speed builds up and dies down again.
		const env = Math.sin( Math.PI * u );
		pose.lift = 0;
		if ( 'rinse' === g.kind ) {
			const ang = ( u - Math.sin( 2 * Math.PI * u ) / ( 2 * Math.PI ) ) * Math.PI * 2 * 1.5;
			const r = g.at.r * 0.42 * env;
			pose.x = g.at.x + Math.cos( ang ) * r;
			pose.y = g.at.y + Math.sin( ang ) * r * 0.8;
			pose.dx = -Math.sin( ang );
			pose.dy = Math.cos( ang );
			pose.press = 0.35 * env;
		} else {
			// Loading: the belly rolled back and forth in the well.
			const ang = u * Math.PI * 2 * 1.25;
			pose.x = g.at.x + Math.sin( ang ) * g.at.r * 0.4 * env;
			pose.y = g.at.y + Math.sin( ang * 0.5 ) * g.at.r * 0.2 * env;
			pose.dx = Math.cos( ang );
			pose.dy = 0.25 * Math.cos( ang * 0.5 );
			pose.press = 0.65 * env;
		}
		return pose;
	}

	/**
	 * Advances the hand, the brush's colour and its strands' spring. Nothing
	 * may jump: when the planned path itself jumps (a mark dropped, a stroke
	 * moved up), the difference is taken up by an offset that melts away.
	 */
	_moveHand( dt, t ) {
		const T = this._target( t );
		const S = this.animator.desk.S;
		if ( ! this.hand ) {
			this.hand = { x: T.x, y: T.y, lift: T.lift, press: 0, dirX: 0, dirY: 1, speed: 0 };
			this.raw = { x: T.x, y: T.y, lift: T.lift };
			this.off = { x: 0, y: 0, lift: 0 };
		}
		const h = this.hand;
		const raw = this.raw;
		const off = this.off;
		// Only a change of gesture can jump; within one, the path is continuous.
		if ( T.id !== raw.id ) {
			if ( T.stroke ) {
				// Each stroke, the fingers settle on the handle a little differently.
				const g = this.grip;
				g.wantYaw = ( g.rnd() - 0.5 ) * 0.42;
				g.wantTilt = ( g.rnd() - 0.5 ) * 0.22;
			}
			if ( Math.hypot( T.x - raw.x, T.y - raw.y ) > S * 0.004 ) {
				off.x += raw.x - T.x;
				off.y += raw.y - T.y;
			}
			if ( Math.abs( T.lift - raw.lift ) > 0.1 ) {
				off.lift += raw.lift - T.lift;
			}
		}
		// On the paper the tip must sit on the paint at once.
		const melt = Math.exp( -dt / ( T.stroke && T.lift < 0.05 ? 0.12 : 0.25 ) );
		off.x *= melt;
		off.y *= melt;
		off.lift *= melt;
		this.raw = { x: T.x, y: T.y, lift: T.lift, id: T.id };
		const px = h.x;
		const py = h.y;
		const lift = Math.max( 0, T.lift + off.lift );
		h.x = T.x + off.x;
		h.y = T.y + off.y;
		// A hand in the air is not a machine: it trails its flight on a loose
		// spring (overshooting a little where the path turns or stops), sways
		// off the straight line, and comes back onto the plan to land. On the
		// paper (and at the jar and the palette) it follows the plan exactly.
		// (Eased, so arriving over the jar or a well never jumps; touching
		// down, it is back on the plan within a few frames, before the drawn
		// tip, which follows the lift more slowly, meets the paper.)
		const airWant = T.dip ? 0 : smooth( 0.02, 0.5, lift );
		h.air = undefined === h.air ? airWant : h.air + ( airWant - h.air ) * ( 1 - Math.exp( -dt / ( airWant < h.air ? 0.06 : 0.3 ) ) );
		const air = h.air;
		const fly = this.fly || ( this.fly = { x: h.x, y: h.y, vx: 0, vy: 0 } );
		const w = 2 * Math.PI * 1.6;
		const sdt = Math.min( dt, 1 / 30 );
		fly.vx += ( w * w * ( h.x - fly.x ) - 2 * 0.62 * w * fly.vx ) * sdt;
		fly.vy += ( w * w * ( h.y - fly.y ) - 2 * 0.62 * w * fly.vy ) * sdt;
		fly.x += fly.vx * sdt;
		fly.y += fly.vy * sdt;
		const nt = this.time * 0.5;
		const sway = S * 0.01 * air;
		h.x += ( fly.x - h.x ) * air + ( valueNoise( nt, 3.7, 41 ) - 0.5 ) * 2 * sway;
		h.y += ( fly.y - h.y ) * air + ( valueNoise( 8.1, nt, 43 ) - 0.5 ) * 2 * sway;
		h.lift = undefined === h.lift ? lift : h.lift + ( lift - h.lift ) * ( 1 - Math.exp( -dt / 0.14 ) );
		const pc = this.pc;
		const vx = ( ( h.x - px ) * pc ) / Math.max( dt, 1e-3 );
		const vy = ( ( h.y - py ) * pc ) / Math.max( dt, 1e-3 );
		h.speed += ( Math.hypot( vx, vy ) - h.speed ) * ( 1 - Math.exp( -dt / 0.06 ) );
		// Direction of travel (the stroke's own, else the hand's), turned
		// smoothly so the handle never snaps round.
		let dx = T.dx;
		let dy = T.dy;
		if ( ! dx && ! dy ) {
			dx = vx;
			dy = vy;
		}
		const dl = Math.hypot( dx, dy );
		if ( dl > 1e-6 ) {
			const f = 1 - Math.exp( -dt / 0.25 );
			h.dirX += ( dx / dl - h.dirX ) * f;
			h.dirY += ( dy / dl - h.dirY ) * f;
			const n = Math.hypot( h.dirX, h.dirY ) || 1;
			h.dirX /= n;
			h.dirY /= n;
		}
		h.press += ( T.press - h.press ) * ( 1 - Math.exp( -dt / 0.05 ) );
		// Size: the half-width of the paint (cells); it follows the stroke on
		// the paper (a brush spreads as it presses) and changes gently in the air.
		if ( T.ink ) {
			h.ink = h.ink ? h.ink + ( T.ink - h.ink ) * ( 1 - Math.exp( -dt / ( h.lift < 0.1 ? 0.05 : 0.3 ) ) ) : T.ink;
		}
		h.tip = h.ink || 2;
		// A wide ribbon of paint calls for a bigger brush: it grows (and
		// shrinks back) slowly, never in a jump.
		// Grown so that, pressed right down, its hairs can spread as wide as the paint.
		const base = Math.min( 0.05 * this.scss, MAX_HAIR_PX / ( this.cam ? this.cam.z : 1 ) ) * SPREAD;
		const want = h.ink ? Math.min( MAX_GROW, Math.max( 1, ( h.ink * this.pc ) / base ) ) : 1;
		h.grow = ( h.grow || 1 ) + ( want - ( h.grow || 1 ) ) * ( 1 - Math.exp( -dt / 0.8 ) );
		h.dip = !! T.dip;
		h.seg = T.seg;
		this.target = T;

		// The brush's colour: what it last took up.
		if ( T.dip ) {
			if ( 'rinse' === T.seg ) {
				// The paint coming off the hairs stains the water strongly, in
				// the brush's colour (mixed with what clouds it already).
				if ( this.load > 0.03 ) {
					const take = Math.max( 1 - Math.exp( -dt * 3 ), 1 - this.stain );
					this.water = mixRgb( this.water, this.color, take );
					this.stain = Math.min( 1, this.stain + dt * 1.4 * ( 0.4 + this.load ) );
				}
				// Rinsing washes the hairs clean (the jar keeps the colour).
				this.color = mixRgb( this.color, CLEAN, 1 - Math.exp( -dt * 5 ) );
				this.load = Math.max( 0, this.load - dt * 2 );
				this._stirJar( dt, h );
			} else if ( 'load' === T.seg && T.k >= 0 ) {
				this.color = mixRgb( this.color, this.colors[ T.k ], 1 - Math.exp( -dt * 6 ) );
				this.load = Math.min( 1, this.load + dt * 2 );
			}
		} else if ( T.stroke ) {
			if ( T.k >= 0 && ! T.lifting ) {
				this.color = mixRgb( this.color, this.colors[ T.k ], 1 - Math.exp( -dt * 8 ) );
			} else if ( T.k < 0 ) {
				// Clear water (wet-in-wet, softening, lifting): a clean brush.
				this.color = mixRgb( this.color, CLEAN, 1 - Math.exp( -dt * 8 ) );
			}
			// The brush gives up its paint as it goes.
			if ( h.lift < 0.2 ) {
				this.load = Math.max( 0.15, this.load - dt / 9 );
			}
		}
		this._flowJar( dt );
	}

	/**
	 * Rinsing stirs the jar: the brush's colour comes off in curls that the
	 * water carries away, with pale streaks where the water moves.
	 * Positions are in jar radii from its centre.
	 */
	_stirJar( dt, h ) {
		const J = this.layout.jar;
		const s = this.scss;
		const pc = this.pc;
		const bx = ( h.x * pc - J.x * s ) / ( J.r * s );
		const by = ( h.y * pc - J.y * s ) / ( J.r * s );
		const sw = this.swirl;
		sw.energy = Math.min( 1, sw.energy + dt * 3 );
		sw.at = { x: bx, y: by };
		sw.spawn += dt * 45;
		const rnd = sw.rnd;
		while ( sw.spawn >= 1 && sw.parts.length < 90 ) {
			sw.spawn--;
			const a = rnd() * Math.PI * 2;
			const r = 0.05 + 0.12 * rnd();
			const pigment = rnd() < 0.7 && this.load > 0.05;
			sw.parts.push( {
				x: bx + Math.cos( a ) * r,
				y: by + Math.sin( a ) * r,
				age: 0,
				life: 1.6 + 1.8 * rnd(),
				w: 0.012 + 0.02 * rnd(),
				rgb: pigment ? this.color.slice() : null,
				a: pigment ? 0.35 + 0.35 * this.load : 0.35,
				trail: [],
			} );
		}
	}

	/** The water keeps moving after the rinse: curl noise, a slowing swirl. */
	_flowJar( dt ) {
		const sw = this.swirl;
		sw.energy *= Math.exp( -dt / 2 );
		// Left alone, the pigment settles and the water clears again while
		// the brush is away painting.
		if ( ! ( this.target && 'rinse' === this.target.seg ) ) {
			this.stain *= Math.exp( -dt / 4 );
		}
		// The water turns with the stir, faster near the middle (so the
		// stain winds into curls), and slows as the stir dies down.
		sw.turn = ( sw.turn || 0 ) + dt * ( 0.12 + 1.6 * sw.energy );
		const T = this.time * 0.25;
		const n = ( x, y ) => valueNoise( x * 2.2 + T, y * 2.2 - T * 0.7, 23 );
		const e = 0.05;
		for ( const p of sw.parts ) {
			// Curl of the noise: a flow without sources or sinks, so it curls.
			const cx = ( n( p.x, p.y + e ) - n( p.x, p.y - e ) ) / ( 2 * e );
			const cy = -( n( p.x + e, p.y ) - n( p.x - e, p.y ) ) / ( 2 * e );
			const k = 0.5 * ( 0.3 + sw.energy );
			// ...and the stir: round the jar, and round the brush while it swishes.
			let vx = cx * k - p.y * 0.5 * sw.energy;
			let vy = cy * k + p.x * 0.5 * sw.energy;
			if ( sw.at ) {
				const dx = p.x - sw.at.x;
				const dy = p.y - sw.at.y;
				const d2 = dx * dx + dy * dy + 0.02;
				vx += ( -dy / d2 ) * 0.04 * sw.energy;
				vy += ( dx / d2 ) * 0.04 * sw.energy;
			}
			p.x += vx * dt;
			p.y += vy * dt;
			const r = Math.hypot( p.x, p.y );
			if ( r > 0.84 ) {
				p.x *= 0.84 / r;
				p.y *= 0.84 / r;
			}
			p.age += dt;
			// A long trail (about two thirds of a second), kept every other frame.
			p.tick = ( p.tick || 0 ) + dt;
			if ( p.tick >= 1 / 30 || ! p.trail.length ) {
				p.tick = 0;
				p.trail.push( p.x, p.y );
				if ( p.trail.length > 40 ) {
					p.trail.splice( 0, 2 );
				}
			} else {
				p.trail[ p.trail.length - 2 ] = p.x;
				p.trail[ p.trail.length - 1 ] = p.y;
			}
		}
		sw.parts = sw.parts.filter( ( p ) => p.age < p.life );
		if ( sw.energy < 0.02 && ! sw.parts.length ) {
			sw.at = null;
		}
	}

	_dipId( t ) {
		const a = this.animator.actions.find( ( q ) => 'dip' === q.tool && ! q.travel && t >= q.start && t <= q.start + q.dur );
		return a ? a.start : null;
	}

	/**
	 * The brush (sheet CSS px), the same from the first frame; broad washes
	 * make it grow slowly, up to MAX_GROW. Up close it looks bigger, as it
	 * would, but never more than MAX_BIG_HAIR_PX of hair on screen.
	 */
	brushDims() {
		const z = this.cam ? this.cam.z : 1;
		const grow = ( this.hand && this.hand.grow ) || 1;
		const k = Math.min( 0.05 * this.scss * grow, ( MAX_HAIR_PX * grow ) / z, MAX_BIG_HAIR_PX / z );
		const ink = ( ( this.hand && this.hand.ink ) || 0 ) * this.pc;
		// A bigger brush has a longer handle, but not in proportion.
		return { hairL: k, ferW: k * 0.26, ferL: k * 0.62, handleL: ( k * 4.6 ) / Math.sqrt( grow ), ink };
	}

	/* The camera ----------------------------------------------------------------- */

	/**
	 * A camera on two slow, critically damped springs (pan and zoom), so it
	 * eases in and out of every move. It frames the work of the next few
	 * seconds rather than each stroke, so it moves little and zooms in only
	 * on small, close work. Where it aims is kept inside the desk; the
	 * camera itself is never stopped hard.
	 */
	_moveCamera( dt, t ) {
		const L = this.layout;
		const s = this.scss;
		const h = this.hand;
		const T = this.target;
		const pc = this.pc;
		const b = { x0: L.bounds.x0 * s, y0: L.bounds.y0 * s, x1: L.bounds.x1 * s, y1: L.bounds.y1 * s };
		const centre = { x: ( b.x0 + b.x1 ) / 2, y: ( b.y0 + b.y1 ) / 2 };
		this.idleFor = T.exact ? 0 : this.idleFor + dt;
		let focus = centre;
		let zoom = 1;
		const vw = this.stage.clientWidth;
		const vh = this.stage.clientHeight;
		const rinsing = T.dip && ( 'rinse' === T.seg || 'load' === T.seg );
		// On a trip to the palette the camera goes with the brush (to the jar
		// and the wells), and only on the way back looks at the work ahead.
		const toPalette = T.dip && 'move' === T.seg;
		const box = rinsing ? null : toPalette ? { x0: h.x, y0: h.y, x1: h.x, y1: h.y } : this._workBox( t );
		if ( rinsing ) {
			// At the palette, framing the jar and the wells.
			focus = { x: ( L.jar.x + L.tray.x + L.tray.w / 2 ) * 0.5 * s, y: ( L.jar.y + L.tray.y + L.tray.h * 0.5 ) * 0.5 * s };
			zoom = 1.5;
		} else if ( box && ( T.exact || this.idleFor < 2.5 ) ) {
			// The work of the next few seconds, with the brush and where it is
			// heading: close only when that is small and together (a detail),
			// wide when it is spread out.
			const grow = ( x, y ) => {
				box.x0 = Math.min( box.x0, x );
				box.y0 = Math.min( box.y0, y );
				box.x1 = Math.max( box.x1, x );
				box.y1 = Math.max( box.y1, y );
			};
			grow( h.x, h.y );
			if ( T.to ) {
				grow( T.to.x, T.to.y );
			}
			focus = { x: ( ( box.x0 + box.x1 ) / 2 ) * pc, y: ( ( box.y0 + box.y1 ) / 2 ) * pc };
			const fill = Math.max( ( ( box.x1 - box.x0 ) * pc ) / vw, ( ( box.y1 - box.y0 ) * pc ) / vh ) * 1.8;
			zoom = Math.min( MAX_ZOOM, Math.max( 1, 1 / Math.max( fill, 1e-3 ) ) );
			this.framing = { focus, zoom };
		} else if ( this.framing && this.idleFor < 2.5 ) {
			// A short pause: hold the shot.
			( { focus, zoom } = this.framing );
		}
		const keep = ( f, lo, hi, half ) => ( hi - lo <= 2 * half ? ( lo + hi ) / 2 : Math.min( hi - half, Math.max( lo + half, f ) ) );
		focus = { x: keep( focus.x, b.x0, b.x1, vw / ( 2 * zoom ) ), y: keep( focus.y, b.y0, b.y1, vh / ( 2 * zoom ) ) };
		if ( ! this.cam ) {
			this.cam = { x: centre.x, y: centre.y, vx: 0, vy: 0, lz: 0, vz: 0, z: 1 };
		}
		const c = this.cam;
		const steps = Math.max( 1, Math.ceil( dt / 0.01 ) );
		const st = dt / steps;
		// Slow, calm springs: the camera glides and settles.
		const wp = 1.5;
		const wz = 0.8;
		for ( let i = 0; i < steps; i++ ) {
			c.vx += ( wp * wp * ( focus.x - c.x ) - 2 * wp * c.vx ) * st;
			c.vy += ( wp * wp * ( focus.y - c.y ) - 2 * wp * c.vy ) * st;
			c.vz += ( wz * wz * ( Math.log( zoom ) - c.lz ) - 2 * wz * c.vz ) * st;
			c.x += c.vx * st;
			c.y += c.vy * st;
			c.lz += c.vz * st;
		}
		c.z = Math.exp( c.lz );
		// Keep the brush well inside the frame: if it nears an edge, the camera
		// is drawn along with it (smoothly, in proportion to how far out it is).
		if ( h ) {
			const margin = 0.18;
			const pull = 1 - Math.exp( -dt / 0.25 );
			const ex = ( h.x * pc - c.x ) * c.z;
			const ey = ( h.y * pc - c.y ) * c.z;
			const over = ( e, v ) => ( e < ( margin - 0.5 ) * v ? e - ( margin - 0.5 ) * v : e > ( 0.5 - margin ) * v ? e - ( 0.5 - margin ) * v : 0 );
			c.x += ( over( ex, vw ) / c.z ) * pull;
			c.y += ( over( ey, vh ) / c.z ) * pull;
		}
		// Where the sheet's corner would be with the whole desk in view, and
		// the camera's offset from there.
		this.ox = ( vw - ( b.x1 - b.x0 ) ) / 2 - b.x0;
		this.oy = ( vh - ( b.y1 - b.y0 ) ) / 2 - b.y0;
		this.tx = vw / 2 - this.ox - c.z * c.x;
		this.ty = vh / 2 - this.oy - c.z * c.y;
		// The sheet is rendered for this view at screen resolution (never
		// an enlarged picture), so it stays sharp however close the camera is.
		const sw = c.z * L.Wn * s;
		const sh = c.z * L.Hn * s;
		this.renderer.setCamera( -( this.ox + this.tx ) / sw, -( this.oy + this.ty ) / sh, vw / sw, vh / sh, smooth( 1.1, 2, c.z ) );
	}

	/**
	 * Bounding box (cells) of the brushwork under way or starting within the
	 * next LOOKAHEAD seconds, or null.
	 */
	_workBox( t ) {
		let box = null;
		const add = ( x, y, r ) => {
			if ( ! box ) {
				box = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
				return;
			}
			box.x0 = Math.min( box.x0, x - r );
			box.y0 = Math.min( box.y0, y - r );
			box.x1 = Math.max( box.x1, x + r );
			box.y1 = Math.max( box.y1, y + r );
		};
		for ( const a of this.animator.actions ) {
			if ( a.hidden || 'brush' !== a.tool || a.start - a.approach > t + LOOKAHEAD || a.start + a.dur < t ) {
				continue;
			}
			const p0 = a.p0 ?? 0;
			const p1 = a.p1 ?? 1;
			for ( let q = 0; q <= 8; q++ ) {
				const pt = brushPath( a, p0 + ( ( p1 - p0 ) * q ) / 8 );
				add( Math.min( this.W, Math.max( 0, pt.x ) ), Math.min( this.H, Math.max( 0, pt.y ) ), a.tip || 1 );
			}
		}
		return box;
	}

	/* Drawing --------------------------------------------------------------------- */

	frame( dt, t ) {
		if ( ! this.layout ) {
			return;
		}
		dt = Math.min( 0.1, Math.max( 0, dt ) );
		this.time += dt;
		this.lastDt = dt;
		this._moveHand( dt, t );
		this._moveCamera( dt, t );
		const ctx = this.ctx;
		const cv = this.overlay;
		const dpr = cv.width / ( cv.clientWidth || cv.width );
		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.clearRect( 0, 0, cv.width, cv.height );
		const z = this.cam.z;
		ctx.setTransform( dpr * z, 0, 0, dpr * z, dpr * ( this.ox + this.tx ), dpr * ( this.oy + this.ty ) );
		this._drawDesk( ctx, z );
		const pc = this.pc;
		this.animator.draw( ctx, t, pc, pc, 1, true );
		if ( this.animator.showGestures && this.hand ) {
			this._drawBrush( ctx, z * dpr );
		}
		this.recorder?.frame();
	}

	/**
	 * The desk, the sheet's shadow, the palette and the jar's glass hardly
	 * change, so they are painted once into a picture (at the resolution the
	 * closest shot needs, within limits) and that is laid down each frame.
	 * Only the water in the jar is drawn live.
	 */
	_drawDesk( ctx, z ) {
		const s = this.scss;
		const L = this.layout;
		const dpr = this.overlay.width / ( this.overlay.clientWidth || this.overlay.width );
		const vw = this.stage.clientWidth;
		const vh = this.stage.clientHeight;
		// The view in sheet px.
		const x0 = -( this.ox + this.tx ) / z;
		const y0 = -( this.oy + this.ty ) / z;
		const x1 = x0 + vw / z;
		const y1 = y0 + vh / z;
		const key = [ s, vw, vh, dpr, this.colors.join() ].join( '|' );
		if ( ! this.deskCache || this.deskCache.key !== key ) {
			// Everything the camera can show: the desk's bounds and the wide shot.
			const b = L.bounds;
			const cx = ( ( b.x0 + b.x1 ) / 2 ) * s;
			const cy = ( ( b.y0 + b.y1 ) / 2 ) * s;
			const m = 0.15 * Math.max( vw, vh );
			const R = {
				x0: Math.min( b.x0 * s, cx - vw / 2 ) - m,
				y0: Math.min( b.y0 * s, cy - vh / 2 ) - m,
				x1: Math.max( b.x1 * s, cx + vw / 2 ) + m,
				y1: Math.max( b.y1 * s, cy + vh / 2 ) + m,
			};
			const rw = R.x1 - R.x0;
			const rh = R.y1 - R.y0;
			const cs = Math.min( dpr * MAX_ZOOM, 4096 / Math.max( rw, rh ) );
			const c = this.deskCache?.canvas || document.createElement( 'canvas' );
			c.width = Math.ceil( rw * cs );
			c.height = Math.ceil( rh * cs );
			const g = c.getContext( '2d' );
			g.setTransform( cs, 0, 0, cs, -R.x0 * cs, -R.y0 * cs );
			// Shadows as soft as they always looked on a sharp (2×) screen.
			this._paintDesk( g, R, cs / 2 );
			this.deskCache = { key, canvas: c, R };
		}
		const { canvas, R } = this.deskCache;
		if ( x0 < R.x0 || y0 < R.y0 || x1 > R.x1 || y1 > R.y1 ) {
			// Past the picture's edge (it should not happen): plain desk.
			this.pattern = this.pattern || deskPattern( ctx );
			ctx.save();
			ctx.beginPath();
			ctx.rect( x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4 );
			ctx.rect( R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0 );
			ctx.clip( 'evenodd' );
			ctx.fillStyle = this.pattern;
			ctx.fillRect( x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4 );
			ctx.restore();
		}
		// Only the part in view, from the picture.
		const cs = canvas.width / ( R.x1 - R.x0 );
		const vx0 = Math.max( R.x0, x0 - 2 );
		const vy0 = Math.max( R.y0, y0 - 2 );
		const vx1 = Math.min( R.x1, x1 + 2 );
		const vy1 = Math.min( R.y1, y1 + 2 );
		if ( vx1 > vx0 && vy1 > vy0 ) {
			ctx.drawImage( canvas, ( vx0 - R.x0 ) * cs, ( vy0 - R.y0 ) * cs, ( vx1 - vx0 ) * cs, ( vy1 - vy0 ) * cs, vx0, vy0, vx1 - vx0, vy1 - vy0 );
		}
		this._drawJarWater( ctx );
	}

	/** The still parts of the desk, into its picture (`z`: the shadows' scale). */
	_paintDesk( ctx, R, z ) {
		const s = this.scss;
		const L = this.layout;
		const pw = L.Wn * s;
		const ph = L.Hn * s;
		const pattern = deskPattern( ctx );
		ctx.save();
		ctx.beginPath();
		ctx.rect( R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0 );
		ctx.rect( 0.3, 0.3, pw - 0.6, ph - 0.6 );
		ctx.clip( 'evenodd' );
		ctx.fillStyle = pattern;
		ctx.fillRect( R.x0, R.y0, R.x1 - R.x0, R.y1 - R.y0 );
		// The sheet's shadow on the desk.
		ctx.shadowColor = 'rgba(40,28,15,0.28)';
		ctx.shadowBlur = 14 * z;
		ctx.shadowOffsetY = 3 * z;
		ctx.fillStyle = '#fff';
		ctx.fillRect( 0, 0, pw, ph );
		ctx.restore();

		// Palette: a porcelain tray with a well of each colour.
		const T = L.tray;
		ctx.save();
		ctx.shadowColor = 'rgba(40,28,15,0.3)';
		ctx.shadowBlur = 10 * z;
		ctx.shadowOffsetY = 3 * z;
		ctx.fillStyle = '#f7f5f1';
		ctx.beginPath();
		ctx.roundRect( T.x * s, T.y * s, T.w * s, T.h * s, 0.02 * s );
		ctx.fill();
		ctx.restore();
		for ( const k in L.wells ) {
			const wl = L.wells[ k ];
			const x = wl.x * s;
			const y = wl.y * s;
			const r = wl.r * s;
			const rgb = this.colors[ k ];
			const cup = ctx.createRadialGradient( x - r * 0.2, y - r * 0.25, r * 0.1, x, y, r );
			cup.addColorStop( 0, '#ffffff' );
			cup.addColorStop( 0.8, '#ebe7e0' );
			cup.addColorStop( 1, '#c9c3b8' );
			ctx.fillStyle = cup;
			ctx.beginPath();
			ctx.arc( x, y, r, 0, Math.PI * 2 );
			ctx.fill();
			// The paint: a pool, darker where it is deep, with a gloss.
			const pool = ctx.createRadialGradient( x + r * 0.1, y + r * 0.12, 0, x, y, r * 0.78 );
			pool.addColorStop( 0, rgba( mixRgb( rgb, [ 0, 0, 0 ], 0.25 ), 0.95 ) );
			pool.addColorStop( 0.75, rgba( rgb, 0.9 ) );
			pool.addColorStop( 1, rgba( mixRgb( rgb, [ 255, 255, 255 ], 0.4 ), 0.5 ) );
			ctx.fillStyle = pool;
			ctx.beginPath();
			ctx.ellipse( x, y + r * 0.04, r * 0.76, r * 0.7, 0.3, 0, Math.PI * 2 );
			ctx.fill();
			ctx.fillStyle = 'rgba(255,255,255,0.45)';
			ctx.beginPath();
			ctx.ellipse( x - r * 0.3, y - r * 0.3, r * 0.18, r * 0.08, -0.6, 0, Math.PI * 2 );
			ctx.fill();
		}

		// Water jar, seen from above: its glass (the water is drawn live).
		const J = L.jar;
		const jx = J.x * s;
		const jy = J.y * s;
		const jr = J.r * s;
		ctx.save();
		ctx.shadowColor = 'rgba(40,28,15,0.25)';
		ctx.shadowBlur = 12 * z;
		ctx.shadowOffsetX = 4 * z;
		ctx.shadowOffsetY = 5 * z;
		ctx.fillStyle = 'rgba(235,240,242,0.9)';
		ctx.beginPath();
		ctx.arc( jx, jy, jr, 0, Math.PI * 2 );
		ctx.fill();
		ctx.restore();
	}

	/**
	 * The stain in the jar, a small picture (smoothed up when drawn): clear
	 * water and the rinsed colour marbled together by curl noise. The water
	 * coordinates are turned with the stir (more in the middle) and warped by
	 * the noise's curl, so the colour winds into tendrils between clear
	 * streaks; the more stained the jar, the more of it the colour fills.
	 */
	_stainTexture() {
		const N = 64;
		if ( ! this.stainCanvas ) {
			this.stainCanvas = document.createElement( 'canvas' );
			this.stainCanvas.width = N;
			this.stainCanvas.height = N;
			this.stainImg = this.stainCanvas.getContext( '2d' ).createImageData( N, N );
		}
		const px = this.stainImg.data;
		const [ r, g, b ] = this.water;
		const st = this.stain;
		const turn = this.swirl.turn || 0;
		const T = this.time * 0.2;
		const n = ( x, y, k ) => valueNoise( x, y, k );
		const e = 0.08;
		for ( let j = 0; j < N; j++ ) {
			for ( let i = 0; i < N; i++ ) {
				let x = ( ( i + 0.5 ) / N ) * 2 - 1;
				let y = ( ( j + 0.5 ) / N ) * 2 - 1;
				const rr = Math.hypot( x, y );
				const o = ( j * N + i ) * 4;
				if ( rr > 1.05 ) {
					px[ o + 3 ] = 0;
					continue;
				}
				// The stir: a turn that winds the middle round more than the edge.
				const a = turn * ( 1.3 - rr );
				const ca = Math.cos( a );
				const sa = Math.sin( a );
				const u = x * ca - y * sa;
				const v = x * sa + y * ca;
				x = u * 1.8 + T;
				y = v * 1.8 - T * 0.6;
				// Curl warp: along the noise's level lines, so it curls.
				const cx = ( n( x, y + e, 61 ) - n( x, y - e, 61 ) ) / ( 2 * e );
				const cy = -( n( x + e, y, 61 ) - n( x - e, y, 61 ) ) / ( 2 * e );
				const m = 0.65 * n( x * 1.6 + cx * 0.35, y * 1.6 + cy * 0.35, 67 ) + 0.35 * n( x * 3.4 + cx * 0.5, y * 3.4 + cy * 0.5, 71 );
				// Colour where the marbling says so (more of it as the stain
				// builds), over a faint tint of the whole jar.
				const lo = 0.58 - 0.3 * st;
				const c = smooth( lo, lo + 0.3, m );
				px[ o ] = r;
				px[ o + 1 ] = g;
				px[ o + 2 ] = b;
				px[ o + 3 ] = 255 * st * ( 0.3 + 0.6 * c );
			}
		}
		this.stainCanvas.getContext( '2d' ).putImageData( this.stainImg, 0, 0 );
		return this.stainCanvas;
	}

	/** The water in the jar, clouded by rinsing, its curls and the glass rim. */
	_drawJarWater( ctx ) {
		const s = this.scss;
		const J = this.layout.jar;
		const jx = J.x * s;
		const jy = J.y * s;
		const jr = J.r * s;
		const wg = ctx.createRadialGradient( jx - jr * 0.25, jy - jr * 0.3, 0, jx, jy, jr * 0.9 );
		wg.addColorStop( 0, rgba( mixRgb( WATER, [ 255, 255, 255 ], 0.45 ), 0.9 ) );
		wg.addColorStop( 1, rgba( mixRgb( WATER, [ 60, 70, 80 ], 0.15 ), 0.95 ) );
		ctx.fillStyle = wg;
		ctx.beginPath();
		ctx.arc( jx, jy, jr * 0.88, 0, Math.PI * 2 );
		ctx.fill();
		ctx.save();
		ctx.beginPath();
		ctx.arc( jx, jy, jr * 0.88, 0, Math.PI * 2 );
		ctx.clip();
		if ( this.stain > 0.01 ) {
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage( this._stainTexture(), jx - jr * 0.88, jy - jr * 0.88, jr * 1.76, jr * 1.76 );
		}
		// The stirred water: each curl a trail, fading and thinning toward its
		// tail; the colour spreads (wider, fainter) as it ages.
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		const CHUNKS = 4;
		for ( const p of this.swirl.parts ) {
			const tr = p.trail;
			const m = tr.length / 2;
			if ( m < 3 ) {
				continue;
			}
			const fade = smooth( 0, 0.3, p.age ) * ( 1 - smooth( p.life * 0.5, p.life, p.age ) );
			const spread = p.rgb ? 1 + p.age * 1.5 : 0.7;
			for ( let c = 0; c < CHUNKS; c++ ) {
				// Chunk c of the trail, from the tail (0) to the head.
				const j0 = Math.floor( ( c * ( m - 1 ) ) / CHUNKS );
				const j1 = Math.floor( ( ( c + 1 ) * ( m - 1 ) ) / CHUNKS );
				if ( j1 <= j0 ) {
					continue;
				}
				const u = ( c + 1 ) / CHUNKS;
				const alpha = ( p.a * fade * u ) / Math.sqrt( spread );
				ctx.strokeStyle = p.rgb ? rgba( p.rgb, alpha ) : `rgba(255,255,255,${ alpha })`;
				ctx.lineWidth = jr * p.w * spread * ( 0.4 + 0.6 * u );
				ctx.beginPath();
				ctx.moveTo( jx + tr[ j0 * 2 ] * jr, jy + tr[ j0 * 2 + 1 ] * jr );
				for ( let i = j0 + 1; i < j1; i++ ) {
					const x = jx + tr[ i * 2 ] * jr;
					const y = jy + tr[ i * 2 + 1 ] * jr;
					ctx.quadraticCurveTo( x, y, ( x + jx + tr[ i * 2 + 2 ] * jr ) / 2, ( y + jy + tr[ i * 2 + 3 ] * jr ) / 2 );
				}
				ctx.lineTo( jx + tr[ j1 * 2 ] * jr, jy + tr[ j1 * 2 + 1 ] * jr );
				ctx.stroke();
			}
		}
		ctx.restore();
		ctx.strokeStyle = 'rgba(255,255,255,0.85)';
		ctx.lineWidth = jr * 0.06;
		ctx.beginPath();
		ctx.arc( jx, jy, jr * 0.94, Math.PI * 1.05, Math.PI * 1.6 );
		ctx.stroke();
		ctx.strokeStyle = 'rgba(120,135,145,0.5)';
		ctx.lineWidth = jr * 0.04;
		ctx.beginPath();
		ctx.arc( jx, jy, jr * 0.97, 0, Math.PI * 2 );
		ctx.stroke();
	}

	/**
	 * The brush: its hairs are simulated (see Bristles), the hand only places
	 * and tilts the ferrule. Two small controls keep the result honest: the
	 * part of the bundle touching the paper is steered onto the paint being
	 * laid, and the brush is pressed down (or eased off) until that part is
	 * as wide as the paint. Then the bundle, its handle and its shadow are
	 * drawn from the simulated hairs.
	 */
	_drawBrush( ctx, scale ) {
		const h = this.hand;
		const dt = Math.min( 0.05, this.lastDt || 1 / 60 );
		const { hairL, ferW, ferL, handleL, ink } = this.brushDims();
		const pc = this.pc;
		const lift = Math.max( 0, h.lift );
		const touching = 1 - smooth( 0, 0.45, lift );
		// How hard the hand bears down follows the contact gently: lifting off,
		// the pressure eases away over a third of a second (the splayed hairs
		// close up as the brush rises, not all at once); landing, it builds up
		// a little quicker.
		const bear = 1 - Math.exp( -dt / ( touching < ( this.bear ?? 0 ) ? RELEASE_EASE : PRESS_EASE ) );
		this.bear = undefined === this.bear ? touching : this.bear + ( touching - this.bear ) * bear;
		// The handle leans up and to the right, held as a person holds it: the
		// grip changes a little from stroke to stroke, the wrist drifts slowly
		// and is never quite still, more so while flying.
		const g = this.grip;
		const gf = 1 - Math.exp( -dt / 0.45 );
		g.yaw += ( g.wantYaw - g.yaw ) * gf;
		g.tilt += ( g.wantTilt - g.tilt ) * gf;
		const nt = this.time;
		const nz = ( x, k ) => ( valueNoise( x, k, 59 ) - 0.5 ) * 2;
		const air = smooth( 0.05, 0.5, lift );
		const shake = 0.012 + 0.02 * air * Math.min( 1, h.speed / 400 );
		const yaw = BRUSH_YAW + g.yaw + nz( nt * 0.32, 1.3 ) * 0.14 + nz( nt * 5.5, 7.9 ) * shake;
		const tilt = Math.min( 0.78, Math.max( 0.2, BRUSH_TILT + g.tilt + nz( nt * 0.27, 4.1 ) * 0.08 + nz( nt * 6.3, 2.2 ) * shake * 0.7 ) );
		// The lean comes with real speed only, and changes slowly, so the brush
		// never swings about on a curved flight.
		const pull = Math.min( 1, h.speed / 250 );
		const lf = 1 - Math.exp( -dt / 0.35 );
		this.lean.x += ( ( h.dirX || 0 ) * pull - this.lean.x ) * lf;
		this.lean.y += ( ( h.dirY || 0 ) * pull - this.lean.y ) * lf;
		const st = Math.sin( tilt );
		const A = norm3( { x: st * Math.cos( yaw ) + this.lean.x * 0.26, y: st * Math.sin( yaw ) + this.lean.y * 0.26, z: Math.cos( tilt ) } );
		const down = { x: -A.x, y: -A.y, z: -A.z };
		const br = this.br;
		const c = br.contact;
		// Pressure: lower the ferrule until the touching hairs are as wide as
		// the paint (a light touch where there is no paint to match).
		const want = ink > 0 ? ink : ferW * 0.3;
		if ( touching > 0.5 && c.n ) {
			this.depth += Math.max( -ferW, Math.min( ferW, want - c.width ) ) * dt * 8;
		}
		this.depth = Math.min( hairL * MAX_PRESS, Math.max( hairL * 0.06, this.depth || hairL * 0.12 ) );
		// Steering: the touching part of the bundle sits on the paint.
		const P = { x: h.x * pc, y: h.y * pc };
		if ( touching > 0.5 && c.n ) {
			const g = Math.min( 1, dt * 22 );
			this.corr.x += ( P.x - c.x ) * g;
			this.corr.y += ( P.y - c.y ) * g;
			const cl = Math.hypot( this.corr.x, this.corr.y );
			if ( cl > hairL ) {
				this.corr.x *= hairL / cl;
				this.corr.y *= hairL / cl;
			}
		} else {
			const melt = Math.exp( -dt / 0.25 );
			this.corr.x *= melt;
			this.corr.y *= melt;
		}
		// The brush rises slowly at first (the hairs still drag on the paper
		// while the pressure goes), then clears it.
		const height = Math.min( 2, lift ) * smooth( 0, 0.6, lift ) * hairL * 0.9;
		const F = {
			x: P.x - down.x * hairL + this.corr.x,
			y: P.y - down.y * hairL + this.corr.y,
			z: -down.z * hairL - this.depth * this.bear + height,
		};
		br.step( dt, { F, down, hairL, fw: ferW * 0.47, belly: ferW * 0.5 * ( 0.5 + 0.35 * this.load ), wet: 0.25 + 0.75 * this.load, dry: 1 - this.load, dirX: h.dirX || 0, dirY: h.dirY || 0, air: smooth( 0.05, 0.4, lift ) } );

		// Seen from above and in front: height lifts a point up the screen.
		const proj = ( x, y, z ) => [ x, y - z ];
		const E3 = { x: F.x + A.x * ferL, y: F.y + A.y * ferL, z: F.z + A.z * ferL };
		const End3 = { x: E3.x + A.x * handleL, y: E3.y + A.y * handleL, z: E3.z + A.z * handleL };
		const [ fx, fy ] = proj( F.x, F.y, F.z );
		const [ ex, ey ] = proj( E3.x, E3.y, E3.z );
		const [ nx, ny ] = proj( End3.x, End3.y, End3.z );
		let hx = ex - fx;
		let hy = ey - fy;
		const hl = Math.hypot( hx, hy ) || 1;
		hx /= hl;
		hy /= hl;
		const S = br.segs;
		const H = br.hairs.length;

		this._drawShadow( ctx, scale, { F, E3, End3, ferW, hairL } );

		ctx.save();

		// Each hair as a smooth curve through its simulated points, split where
		// the paint begins; lit from the upper left, so hairs on that side of
		// the bundle are lighter.
		const paint = this.color;
		const paintAt = 0.42 + 0.2 * ( 1 - this.load );
		const lines = [];
		for ( let i = 0; i < H; i++ ) {
			const d = br.hairs[ i ].dir;
			const sx = d.x;
			const sy = d.y - d.z;
			const sl = Math.hypot( sx, sy ) || 1;
			const lit = ( -0.6 * sx - 0.75 * sy ) / sl;
			const pts = [];
			for ( let j = 0; j <= S; j++ ) {
				const [ x, y, z ] = br.at( i, j );
				pts.push( proj( x, y, z ) );
			}
			lines.push( { pts, lit, cut: Math.max( 1, Math.min( S - 1, Math.round( ( paintAt + br.hairs[ i ].n * 0.05 ) * S ) ) ) } );
		}
		// Far hairs first: the viewer looks from the front and above, so a
		// point is nearer the more it is toward +y and up.
		const depthOf = ( i ) => {
			let dsum = 0;
			for ( let j = 1; j <= S; j++ ) {
				const [ , y, z ] = br.at( i, j );
				dsum += y + z;
			}
			return dsum;
		};
		lines.forEach( ( l, i ) => ( l.depth = depthOf( i ) ) );
		lines.sort( ( a, b ) => a.depth - b.depth );
		const curve = ( pts, j0, j1 ) => {
			ctx.moveTo( pts[ j0 ][ 0 ], pts[ j0 ][ 1 ] );
			for ( let j = j0 + 1; j < j1; j++ ) {
				ctx.quadraticCurveTo( pts[ j ][ 0 ], pts[ j ][ 1 ], ( pts[ j ][ 0 ] + pts[ j + 1 ][ 0 ] ) / 2, ( pts[ j ][ 1 ] + pts[ j + 1 ][ 1 ] ) / 2 );
			}
			ctx.lineTo( pts[ j1 ][ 0 ], pts[ j1 ][ 1 ] );
		};
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		// Lit from the upper left: a hair's shade from its side of the bundle.
		const tone = ( c0, lit ) => ( lit > 0 ? mixRgb( c0, [ 255, 240, 215 ], lit * 0.35 ) : mixRgb( c0, [ 0, 0, 0 ], -lit * 0.4 ) );
		const thin = Math.max( 0.35, ferW * 0.09 );
		for ( const l of lines ) {
			// Each hair over a darker body, so the bundle reads dense.
			ctx.lineWidth = ferW * 0.38;
			ctx.strokeStyle = rgba( mixRgb( HAIR, [ 0, 0, 0 ], 0.45 ), 0.45 );
			ctx.beginPath();
			curve( l.pts, 0, l.cut );
			ctx.stroke();
			ctx.strokeStyle = rgba( mixRgb( paint, [ 0, 0, 0 ], 0.35 ), 0.5 );
			ctx.beginPath();
			curve( l.pts, l.cut, S );
			ctx.stroke();
			ctx.lineWidth = thin;
			ctx.strokeStyle = rgba( tone( HAIR, l.lit ), 0.9 );
			ctx.beginPath();
			curve( l.pts, 0, l.cut );
			ctx.stroke();
			ctx.strokeStyle = rgba( tone( paint, l.lit ), 0.85 );
			ctx.beginPath();
			curve( l.pts, l.cut, S );
			ctx.stroke();
		}
		lines.sort( ( a, b ) => a.lit - b.lit );
		// Wet glints on the most lit hairs.
		ctx.strokeStyle = `rgba(255,255,255,${ 0.12 + 0.3 * this.load })`;
		ctx.lineWidth = Math.max( 0.4, ferW * 0.1 );
		ctx.beginPath();
		for ( const l of lines.slice( -4 ) ) {
			curve( l.pts, 1, S - 1 );
		}
		ctx.stroke();

		// The ferrule and handle stand nearer the viewer than the hair roots
		// they hold, so they are drawn over them.
		drawHandle( ctx, { x: fx, y: fy }, { x: ex, y: ey }, { x: nx, y: ny }, hx, hy, ferW, Math.hypot( nx - ex, ny - ey ), 1 );

		// The tip: where the hairs meet.
		let tx = 0;
		let ty = 0;
		for ( const l of lines ) {
			tx += l.pts[ S ][ 0 ] / H;
			ty += l.pts[ S ][ 1 ] / H;
		}
		// A freshly loaded brush in the air holds a bead at its tip; in the
		// jar the water rings around it.
		if ( this.load > 0.8 && lift > 0.3 && ! h.dip ) {
			const r = ferW * 0.32;
			drawBead( ctx, tx, ty + r * 0.4, r, r * 1.12, 0, paint, smooth( 0.3, 0.6, lift ) * 0.85 );
		}
		if ( h.dip && 'rinse' === h.seg ) {
			ctx.strokeStyle = 'rgba(255,255,255,0.5)';
			ctx.lineWidth = 0.8;
			ctx.beginPath();
			ctx.ellipse( tx, ty, ferW * 0.9, ferW * 0.6, 0, 0, Math.PI * 2 );
			ctx.stroke();
		}
		ctx.restore();
	}

	/**
	 * The brush's shadow, cast from the upper left onto the paper: each point
	 * falls toward the lower right by its height, so the touching hairs'
	 * shadow is sharp and close and the handle's is long, soft and faint.
	 * Drawn with the canvas shadow (its blur stays soft at any zoom): the
	 * shape itself is placed far off the canvas and only its shadow is moved
	 * back into view.
	 */
	_drawShadow( ctx, scale, { F, E3, End3, ferW, hairL } ) {
		const fall = ( x, y, z ) => [ x + 0.45 * z, y + 0.6 * z ];
		const K = 20000;
		const br = this.br;
		const S = br.segs;
		// Drawn straight onto the frame, in two strokes of the pen: the handle
		// as one filled shape and all the hairs as one stroke. Within one
		// stroke nothing is painted twice, so overlapping parts never darken;
		// the handle's shadow starts a little up the ferrule, clear of the
		// hairs'. (No separate layer to clear and lay down every frame.)
		const pts = [ { x: lerp( F.x, E3.x, 0.35 ), y: lerp( F.y, E3.y, 0.35 ), z: lerp( F.z, E3.z, 0.35 ) }, E3, { x: lerp( E3.x, End3.x, 0.3 ), y: lerp( E3.y, End3.y, 0.3 ), z: lerp( E3.z, End3.z, 0.3 ) }, End3 ].map( ( p ) => fall( p.x, p.y, p.z ) );
		ctx.save();
		ctx.shadowOffsetX = K * scale;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = '#000';
		ctx.fillStyle = '#000';
		// Ferrule and handle: higher, so softer and fainter, tapering away.
		const widths = [ ferW * 0.45, ferW * 0.45, ferW * 0.55, ferW * 0.25 ];
		ctx.shadowColor = 'rgba(40,28,16,0.14)';
		ctx.shadowBlur = ( 6 + hairL * 0.15 ) * scale;
		ctx.beginPath();
		const side = ( k, sgn ) => {
			const a0 = pts[ Math.max( 0, k - 1 ) ];
			const a1 = pts[ Math.min( pts.length - 1, k + 1 ) ];
			const nx = -( a1[ 1 ] - a0[ 1 ] );
			const ny = a1[ 0 ] - a0[ 0 ];
			const n = Math.hypot( nx, ny ) || 1;
			return [ pts[ k ][ 0 ] - K + ( sgn * nx * widths[ k ] ) / n, pts[ k ][ 1 ] + ( sgn * ny * widths[ k ] ) / n ];
		};
		for ( let k = 0; k < pts.length; k++ ) {
			ctx[ k ? 'lineTo' : 'moveTo' ]( ...side( k, 1 ) );
		}
		for ( let k = pts.length - 1; k >= 0; k-- ) {
			ctx.lineTo( ...side( k, -1 ) );
		}
		ctx.closePath();
		ctx.fill();
		// Hairs: near the paper, sharp and dark.
		ctx.shadowColor = 'rgba(40,28,16,0.28)';
		ctx.shadowBlur = ( 1.5 + F.z * 0.04 ) * scale;
		ctx.lineWidth = ferW * 0.35;
		ctx.beginPath();
		for ( let i = 0; i < br.hairs.length; i += 2 ) {
			for ( let j = 0; j <= S; j++ ) {
				const [ x, y, z ] = br.at( i, j );
				const [ sx, sy ] = fall( x, y, z );
				ctx[ j ? 'lineTo' : 'moveTo' ]( sx - K, sy );
			}
		}
		ctx.stroke();
		ctx.restore();
		// Where the hairs press on the wet paper it darkens a little.
		const c = br.contact;
		if ( c.n ) {
			const r = Math.max( ferW, c.width * 1.3 );
			const g = ctx.createRadialGradient( c.x, c.y, 0, c.x, c.y, r );
			g.addColorStop( 0, 'rgba(30,22,14,0.14)' );
			g.addColorStop( 1, 'rgba(30,22,14,0)' );
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc( c.x, c.y, r, 0, Math.PI * 2 );
			ctx.fill();
		}
	}

	/* Recording -------------------------------------------------------------------- */

	/**
	 * A canvas showing what the camera sees (the sheet and everything over
	 * it), redrawn every frame while recording.
	 */
	startRecording( paint ) {
		const c = document.createElement( 'canvas' );
		c.width = this.overlay.width;
		c.height = this.overlay.height;
		const g = c.getContext( '2d', { alpha: false } );
		let last = 0;
		this.recorder = {
			canvas: c,
			// The video runs at 30 fps: copying every screen frame would only
			// cost time the painting needs.
			frame: () => {
				const now = performance.now();
				if ( now - last < 1000 / 31 ) {
					return;
				}
				last = now;
				g.drawImage( paint, 0, 0, c.width, c.height );
				g.drawImage( this.overlay, 0, 0 );
			},
		};
		return c;
	}

	stopRecording() {
		this.recorder = null;
	}
}
