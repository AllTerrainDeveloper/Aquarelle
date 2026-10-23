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

const smooth = ( a, b, x ) => {
	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );
};
const lerp = ( a, b, t ) => a + ( b - a ) * t;
const mixRgb = ( c, d, w ) => [ lerp( c[ 0 ], d[ 0 ], w ), lerp( c[ 1 ], d[ 1 ], w ), lerp( c[ 2 ], d[ 2 ], w ) ];
const rgba = ( c, a ) => `rgba(${ c[ 0 ] | 0 },${ c[ 1 ] | 0 },${ c[ 2 ] | 0 },${ a })`;
const hexRgb = ( h ) => {
	const n = parseInt( h.slice( 1 ), 16 );
	return [ ( n >> 16 ) & 255, ( n >> 8 ) & 255, n & 255 ];
};

const WATER = [ 214, 226, 232 ];
const HAIR = [ 176, 132, 86 ];
const STRANDS = 72;
// A clean, wet brush: just the sable, a little darker for the water.
const CLEAN = [ 120, 88, 56 ];
// The longest the brush's hair may look on screen (CSS px), however close the camera.
const MAX_HAIR_PX = 54;
// Camera: the closest it goes (on small details), and how far ahead it looks.
const MAX_ZOOM = 2.4;
const LOOKAHEAD = 2.5;
// Broad washes take a bigger brush: up to this much bigger, and this long on screen.
const MAX_GROW = 1.8;
const MAX_BIG_HAIR_PX = 80;

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
	const sp = Math.min( 0.085, Math.max( 0.3, Hn - 2 * jarR - 0.1 ) / rows );
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
		wells[ k ] = { x: tray.x + pad + ( ( j % cols ) + 0.5 ) * sp, y: tray.y + pad + ( Math.floor( j / cols ) + 0.5 ) * sp, r: sp * 0.4 };
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
		const rnd = mulberry32( 11 );
		// Each hair: where it sits across the bundle (−1 lit side, 1 shadowed),
		// its length, a little irregularity, and the tuft it joins when dry.
		const tufts = Array.from( { length: 6 }, () => rnd() * 2 - 1 );
		this.hairs = Array.from( { length: STRANDS }, ( _, i ) => {
			const s = ( ( i + 0.5 ) / STRANDS ) * 2 - 1 + ( rnd() - 0.5 ) * 0.05;
			return { s, len: 0.84 + 0.16 * rnd(), n: rnd() * 2 - 1, clump: tufts[ Math.min( 5, Math.floor( ( s + 1 ) * 3 ) ) ] };
		} );
		this.reset();
	}

	reset() {
		this.cam = null;
		this.hand = null;
		this.raw = null;
		this.bend = { x: 0, y: 0, vx: 0, vy: 0 };
		this.color = CLEAN.slice();
		this.load = 0;
		this.water = WATER.slice();
		this.ripples = [];
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
		this.scss = scss;
		this.cam = null;
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
					const off = p.x < 0 || p.y < 0 || p.x > this.W || p.y > this.H;
					const lift = Math.max( smooth( 0, 1, p.lift ), off ? 1 : ink > 0 ? 0 : 0.7 );
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
			if ( Math.hypot( T.x - raw.x, T.y - raw.y ) > S * 0.004 ) {
				off.x += raw.x - T.x;
				off.y += raw.y - T.y;
			}
			if ( Math.abs( T.lift - raw.lift ) > 0.1 ) {
				off.lift += raw.lift - T.lift;
			}
		}
		// On the paper the tip must sit on the paint at once.
		const melt = Math.exp( -dt / ( T.lift < 0.05 ? 0.03 : 0.2 ) );
		off.x *= melt;
		off.y *= melt;
		off.lift *= melt;
		this.raw = { x: T.x, y: T.y, lift: T.lift, id: T.id };
		const px = h.x;
		const py = h.y;
		h.x = T.x + off.x;
		h.y = T.y + off.y;
		const lift = Math.max( 0, T.lift + off.lift );
		h.lift = undefined === h.lift ? lift : h.lift + ( lift - h.lift ) * ( 1 - Math.exp( -dt / 0.08 ) );
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
		const base = Math.min( 0.05 * this.scss, MAX_HAIR_PX / ( this.cam ? this.cam.z : 1 ) ) * 0.26 * 0.9;
		const want = h.ink ? Math.min( MAX_GROW, Math.max( 1, ( h.ink * this.pc ) / base ) ) : 1;
		h.grow = ( h.grow || 1 ) + ( want - ( h.grow || 1 ) ) * ( 1 - Math.exp( -dt / 0.8 ) );
		h.dip = !! T.dip;
		h.seg = T.seg;
		this.target = T;

		// The brush's colour: what it last took up.
		if ( T.dip ) {
			if ( 'rinse' === T.seg ) {
				if ( this.dipSeen !== this._dipId( t ) ) {
					this.dipSeen = this._dipId( t );
					// The rinse water takes a little of the colour.
					this.water = mixRgb( this.water, this.color, this.load > 0.05 ? 0.1 : 0 );
				}
				// Rinsing washes the hairs clean (the jar keeps the colour).
				this.color = mixRgb( this.color, CLEAN, 1 - Math.exp( -dt * 5 ) );
				this.load = Math.max( 0, this.load - dt * 2 );
				if ( ! this.ripples.length || this.time - this.ripples[ this.ripples.length - 1 ].t > 0.14 ) {
					this.ripples.push( { x: h.x, y: h.y, t: this.time } );
				}
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
		this.ripples = this.ripples.filter( ( r ) => this.time - r.t < 1.2 );

		// Strands: a lightly damped spring dragged behind the motion, which
		// flicks as the brush changes direction or lifts off.
		const b = this.bend;
		const B = this.brushDims();
		const contact = 1 - smooth( 0, 0.35, h.lift );
		const drag = Math.min( 1, h.speed / 260 ) * B.ferW * ( 0.5 + 1.3 * h.press ) * ( 0.25 + 0.75 * contact );
		const tx = -h.dirX * drag;
		const ty = -h.dirY * drag;
		const w = 26;
		const z = 0.38;
		const steps = Math.max( 1, Math.ceil( dt / 0.008 ) );
		const st = dt / steps;
		for ( let i = 0; i < steps; i++ ) {
			b.vx += ( w * w * ( tx - b.x ) - 2 * z * w * b.vx ) * st;
			b.vy += ( w * w * ( ty - b.y ) - 2 * z * w * b.vy ) * st;
			b.x += b.vx * st;
			b.y += b.vy * st;
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
		return { hairL: k, ferW: k * 0.26, ferL: k * 0.62, handleL: k * 4.6, ink };
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

	_drawDesk( ctx, z ) {
		const s = this.scss;
		const L = this.layout;
		const pw = L.Wn * s;
		const ph = L.Hn * s;
		// The view in sheet px.
		const x0 = -( this.ox + this.tx ) / z;
		const y0 = -( this.oy + this.ty ) / z;
		const x1 = x0 + this.stage.clientWidth / z;
		const y1 = y0 + this.stage.clientHeight / z;
		this.pattern = this.pattern || deskPattern( ctx );
		ctx.save();
		ctx.beginPath();
		ctx.rect( x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4 );
		ctx.rect( 0.3, 0.3, pw - 0.6, ph - 0.6 );
		ctx.clip( 'evenodd' );
		ctx.fillStyle = this.pattern;
		ctx.fillRect( x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4 );
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

		// Water jar, seen from above: glass rim, the water clouded by rinsing.
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
		const wg = ctx.createRadialGradient( jx - jr * 0.25, jy - jr * 0.3, 0, jx, jy, jr * 0.9 );
		wg.addColorStop( 0, rgba( mixRgb( this.water, [ 255, 255, 255 ], 0.45 ), 0.9 ) );
		wg.addColorStop( 1, rgba( mixRgb( this.water, [ 60, 70, 80 ], 0.15 ), 0.95 ) );
		ctx.fillStyle = wg;
		ctx.beginPath();
		ctx.arc( jx, jy, jr * 0.88, 0, Math.PI * 2 );
		ctx.fill();
		ctx.save();
		ctx.beginPath();
		ctx.arc( jx, jy, jr * 0.88, 0, Math.PI * 2 );
		ctx.clip();
		const pc = this.pc;
		for ( const rp of this.ripples ) {
			const age = ( this.time - rp.t ) / 1.2;
			ctx.strokeStyle = `rgba(255,255,255,${ 0.5 * ( 1 - age ) })`;
			ctx.lineWidth = Math.max( 0.5, jr * 0.02 );
			ctx.beginPath();
			ctx.arc( rp.x * pc, rp.y * pc, jr * ( 0.05 + 0.55 * age ), 0, Math.PI * 2 );
			ctx.stroke();
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
	 * The brush, hair by hair: a round sable bundle that swells from the
	 * ferrule into a belly and draws to a point, lit from the upper left so
	 * it reads as round. The hairs bend progressively toward the tip behind
	 * the motion, spread as the brush presses, part into tufts as it dries,
	 * and carry the paint in their lower part. Above them a lacquered handle
	 * that leans with the motion and trembles a little.
	 *
	 * Its shadow is cast from the upper left onto the paper: sharp and close
	 * where the tip touches, softer and further off the higher the brush is,
	 * so the handle's shadow falls well away from it.
	 */
	_drawBrush( ctx, scale ) {
		const h = this.hand;
		const { hairL, ferW, ferL, handleL, ink } = this.brushDims();
		const pc = this.pc;
		const lift = Math.max( 0, h.lift );
		const contact = 1 - smooth( 0, 0.3, lift );
		// A wide ribbon of paint means pressing harder: 0 for a mark the tip
		// covers, 1 for one twice the brush's width.
		const wide = contact * smooth( 0.6, 2.2, ink / Math.max( 1e-3, ferW ) );
		const press = Math.max( h.press * contact, wide );
		// The handle leans up and to the right, pulled along the motion; a
		// living hand is never quite still.
		const tremor = Math.sin( this.time * 5.3 ) * 0.008 + Math.sin( this.time * 2.1 + 1 ) * 0.012;
		let hx = 0.6 + h.dirX * 0.25 + tremor;
		let hy = -0.8 + h.dirY * 0.25 + tremor * 0.6;
		const hl = Math.hypot( hx, hy );
		hx /= hl;
		hy /= hl;
		const px = -hy;
		const py = hx;
		// Height of the tip above the paper: none while it paints.
		const height = Math.min( 2, lift ) * hairL * 0.9;
		const touch = 1 - smooth( 0, 0.25, lift );
		const b = this.bend;
		// On the paper the tip stays exactly where the paint goes down and the
		// ferrule leads, the hairs trailing; in the air the tip flicks freely.
		const P = { x: h.x * pc, y: h.y * pc - height };
		// Pressed down, the bundle bends over and looks shorter.
		const squash = 1 - 0.22 * press - 0.15 * wide;
		const F = { x: P.x + hx * hairL * squash - b.x * touch, y: P.y + hy * hairL * squash - b.y * touch };
		const E = { x: F.x + hx * ferL, y: F.y + hy * ferL };
		const End = { x: E.x + hx * handleL, y: E.y + hy * handleL };
		const dry = 1 - this.load;
		const fw0 = ferW * 0.47;
		const bulge = ferW * 0.5 * ( 0.5 + 0.35 * this.load + 0.45 * press + 0.6 * wide );
		// The tip spreads to the width of the paint it lays, as far as a real
		// tip can (about the brush's own width).
		// Up to what a round brush pressed flat can reach (about 2.3x its width).
		const splay = touch * Math.min( ink, ferW * 2.3 ) * ( 0.6 + 0.4 * press ) + ( 1 - touch ) * ferW * 0.06 * ( 1 + dry );
		// Pressed flat, the hairs fan out from further up the bundle.
		const fan = 3 - 1.6 * wide;
		// Along the bundle (t: 0 at the ferrule, 1 at the tip): centre line,
		// bent more toward the tip in the air, and half-width.
		const free = 1 - touch;
		const cx = ( t ) => F.x + ( P.x - F.x ) * t + b.x * t * t * free;
		const cy = ( t ) => F.y + ( P.y - F.y ) * t + b.y * t * t * free;
		const half = ( t ) => fw0 * ( 1 - t ) + bulge * Math.sin( Math.PI * t ) * ( 1 - 0.35 * t ) + splay * Math.pow( t, fan );
		// Sideways: across the handle near the ferrule, across the stroke at
		// the tip while it paints (so the spread matches the ribbon of paint).
		const mx = -( h.dirY || 0 );
		const my = h.dirX || 0;
		const sgn = mx * px + my * py < 0 ? -1 : 1;
		const lat = ( t ) => {
			const u = t * t * touch;
			const x = px + ( sgn * mx - px ) * u;
			const y = py + ( sgn * my - py ) * u;
			const n = Math.hypot( x, y ) || 1;
			return [ x / n, y / n ];
		};

		this._drawShadow( ctx, scale, { P, hx, hy, height, hairL, ferL, handleL, ferW, bulge } );

		ctx.save();
		drawHandle( ctx, F, E, End, hx, hy, ferW, handleL, 1 );

		// The bundle's body, so the hairs read as a dense brush.
		const paint = this.color;
		const paintAt = 0.42 + 0.2 * dry;
		const T = 14;
		ctx.beginPath();
		for ( let i = 0; i <= T; i++ ) {
			const t = i / T;
			const w = half( t );
			const [ lx, ly ] = lat( t );
			ctx[ i ? 'lineTo' : 'moveTo' ]( cx( t ) + lx * w, cy( t ) + ly * w );
		}
		for ( let i = T; i >= 0; i-- ) {
			const t = i / T;
			const w = half( t );
			const [ lx, ly ] = lat( t );
			ctx.lineTo( cx( t ) - lx * w, cy( t ) - ly * w );
		}
		ctx.closePath();
		const body = ctx.createLinearGradient( F.x, F.y, cx( 1 ), cy( 1 ) );
		body.addColorStop( 0, rgba( mixRgb( HAIR, [ 0, 0, 0 ], 0.35 ), 1 ) );
		body.addColorStop( Math.max( 0, paintAt - 0.1 ), rgba( mixRgb( HAIR, [ 0, 0, 0 ], 0.45 ), 1 ) );
		body.addColorStop( Math.min( 1, paintAt + 0.06 ), rgba( mixRgb( paint, [ 0, 0, 0 ], 0.3 ), 1 ) );
		body.addColorStop( 1, rgba( mixRgb( paint, [ 0, 0, 0 ], 0.45 ), 1 ) );
		ctx.fillStyle = body;
		ctx.fill();

		// The hairs, in four bands of light (shadowed side first), each split
		// where the paint begins.
		const up = [ [], [], [], [] ];
		const down = [ [], [], [], [] ];
		const N = 8;
		for ( const hr of this.hairs ) {
			const band = Math.min( 3, Math.max( 0, Math.floor( ( 1 - ( hr.s + hr.n * 0.15 ) ) * 2 ) ) );
			const tuft = hr.clump * dry * ferW * 0.4;
			const cut = paintAt + hr.n * 0.05;
			const pts = [];
			for ( let i = 0; i <= N; i++ ) {
				const t = ( i / N ) * hr.len;
				const w = half( t ) * hr.s + ( tuft + hr.n * ferW * 0.05 ) * t * t;
				const [ lx, ly ] = lat( t );
				pts.push( [ cx( t ) + lx * w, cy( t ) + ly * w, t ] );
			}
			const a = [];
			const z = [];
			for ( let i = 0; i <= N; i++ ) {
				( pts[ i ][ 2 ] <= cut ? a : z ).push( pts[ i ] );
			}
			if ( a.length && z.length ) {
				z.unshift( a[ a.length - 1 ] );
			}
			up[ band ].push( a );
			down[ band ].push( z );
		}
		const lw = Math.max( 0.3, ( ferW * 2.6 ) / this.hairs.length );
		const hairShade = [ [ [ 255, 236, 200 ], 0.35 ], [ HAIR, 0 ], [ [ 0, 0, 0 ], 0.25 ], [ [ 0, 0, 0 ], 0.5 ] ];
		const paintShade = [ [ [ 255, 255, 255 ], 0.3 ], [ paint, 0 ], [ [ 0, 0, 0 ], 0.2 ], [ [ 0, 0, 0 ], 0.4 ] ];
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = lw;
		const stroke = ( lines ) => {
			ctx.beginPath();
			for ( const l of lines ) {
				for ( let i = 0; i < l.length; i++ ) {
					ctx[ i ? 'lineTo' : 'moveTo' ]( l[ i ][ 0 ], l[ i ][ 1 ] );
				}
			}
			ctx.stroke();
		};
		for ( let k = 3; k >= 0; k-- ) {
			ctx.strokeStyle = rgba( mixRgb( HAIR, hairShade[ k ][ 0 ], hairShade[ k ][ 1 ] ), 0.85 );
			stroke( up[ k ] );
			ctx.strokeStyle = rgba( mixRgb( paint, paintShade[ k ][ 0 ], paintShade[ k ][ 1 ] ), 0.8 );
			stroke( down[ k ] );
		}

		// Wet sheen on the lit side: a soft broad glow and a fine glint.
		const sheen = 0.1 + 0.3 * this.load;
		const along = ( s, t0, t1 ) => {
			ctx.beginPath();
			for ( let i = 0; i <= 10; i++ ) {
				const t = t0 + ( ( t1 - t0 ) * i ) / 10;
				const w = half( t ) * s;
				const [ lx, ly ] = lat( t );
				ctx[ i ? 'lineTo' : 'moveTo' ]( cx( t ) + lx * w, cy( t ) + ly * w );
			}
			ctx.stroke();
		};
		ctx.strokeStyle = `rgba(255,255,255,${ sheen * 0.45 })`;
		ctx.lineWidth = ferW * 0.35;
		along( -0.45, 0.12, 0.8 );
		ctx.strokeStyle = `rgba(255,255,255,${ sheen * 1.6 })`;
		ctx.lineWidth = Math.max( 0.4, lw * 1.4 );
		along( -0.55, 0.2, 0.75 );

		// A freshly loaded brush in the air holds a bead at its tip; in the
		// jar the water rings around it.
		if ( this.load > 0.8 && lift > 0.3 && ! h.dip ) {
			const r = ferW * 0.32;
			drawBead( ctx, cx( 1 ), cy( 1 ) + r * 0.4, r, r * 1.12, 0, paint, smooth( 0.3, 0.6, lift ) * 0.85 );
		}
		if ( h.dip && 'rinse' === h.seg ) {
			ctx.strokeStyle = 'rgba(255,255,255,0.5)';
			ctx.lineWidth = 0.8;
			ctx.beginPath();
			ctx.ellipse( cx( 1 ), cy( 1 ), bulge * 1.6, bulge * 1.1, 0, 0, Math.PI * 2 );
			ctx.stroke();
		}
		ctx.restore();
	}

	/**
	 * The brush's shadow. A point d along the brush from the tip stands
	 * about `height + 0.55 d` above the paper; its shadow falls that far
	 * toward the lower right. Near the paper it is sharp and dark, high up
	 * it is wide, soft and faint. Drawn with the canvas shadow (its blur
	 * stays soft at any zoom): the shape itself is placed far off the canvas
	 * and only its shadow is moved back into view.
	 */
	_drawShadow( ctx, scale, { P, hx, hy, height, hairL, ferL, handleL, ferW, bulge } ) {
		const lx = 0.55;
		const ly = 0.75;
		const at = ( d ) => {
			const z = height + d * 0.55;
			return { x: P.x + hx * d * 0.7 + lx * z * 0.8, y: P.y + height + hy * d * 0.7 + ly * z * 0.8, z };
		};
		const K = 20000;
		const part = ( ds, ws, blur, alpha ) => {
			const pts = ds.map( at );
			ctx.save();
			ctx.shadowColor = `rgba(40,28,16,${ alpha })`;
			ctx.shadowBlur = blur * scale;
			ctx.shadowOffsetX = K * scale;
			ctx.fillStyle = '#000';
			ctx.beginPath();
			pts.forEach( ( p, i ) => {
				const nx = -( pts[ Math.min( i + 1, pts.length - 1 ) ].y - pts[ Math.max( i - 1, 0 ) ].y );
				const ny = pts[ Math.min( i + 1, pts.length - 1 ) ].x - pts[ Math.max( i - 1, 0 ) ].x;
				const n = Math.hypot( nx, ny ) || 1;
				const w = ws[ i ];
				ctx[ i ? 'lineTo' : 'moveTo' ]( p.x - K + ( nx / n ) * w, p.y + ( ny / n ) * w );
			} );
			for ( let i = pts.length - 1; i >= 0; i-- ) {
				const p = pts[ i ];
				const nx = -( pts[ Math.min( i + 1, pts.length - 1 ) ].y - pts[ Math.max( i - 1, 0 ) ].y );
				const ny = pts[ Math.min( i + 1, pts.length - 1 ) ].x - pts[ Math.max( i - 1, 0 ) ].x;
				const n = Math.hypot( nx, ny ) || 1;
				ctx.lineTo( p.x - K - ( nx / n ) * ws[ i ], p.y - ( ny / n ) * ws[ i ] );
			}
			ctx.closePath();
			ctx.fill();
			ctx.restore();
		};
		const top = hairL + ferL + handleL;
		// Hair and ferrule: close to the paper.
		part( [ 0, hairL * 0.4, hairL, hairL + ferL ], [ 0.3, bulge * 0.9, ferW * 0.42, ferW * 0.42 ], 2.5 + height * 0.35, 0.26 - 0.12 * smooth( 0, ferW * 4, height ) );
		// Handle: higher, so softer and fainter, fading out toward its end.
		part( [ hairL + ferL * 0.8, hairL + ferL + handleL * 0.3, top ], [ ferW * 0.42, ferW * 0.5, ferW * 0.2 ], 9 + height * 0.3, 0.11 );
		// Where the tip touches the wet paper it darkens it a little.
		const touch = 1 - smooth( 0, ferW, height );
		if ( touch > 0 ) {
			const g = ctx.createRadialGradient( P.x, P.y + height, 0, P.x, P.y + height, bulge * 1.4 );
			g.addColorStop( 0, `rgba(30,22,14,${ 0.18 * touch })` );
			g.addColorStop( 1, 'rgba(30,22,14,0)' );
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc( P.x, P.y + height, bulge * 1.4, 0, Math.PI * 2 );
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
		const g = c.getContext( '2d' );
		this.recorder = {
			canvas: c,
			frame: () => {
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
