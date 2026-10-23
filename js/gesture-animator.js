/**
 * GestureAnimator — makes every operation unfold like an artist's gesture.
 *
 * Operations are not stamped instantly. Each stamp becomes a timed action
 * whose pigment and water are laid down progressively in the simulation:
 * radially for drops blooming outward, or right behind the brush tip as it
 * makes back-and-forth passes across a wash. Wet paint flows while it is
 * being placed.
 *
 * Gestures run on their own real-time clock (seconds of painting, excluding
 * pauses), not on the simulation clock: a drop falls and a brush moves at a
 * natural pace whatever the playback speed. Faster playback only makes the
 * rain of gestures denser. The artist has one hand: brush strokes are
 * serialised (see SplashGenerator).
 *
 * A 2D overlay draws the hand: falling drops and their shadows, satellite
 * droplets in flight, a round watercolor brush (also used clean to lift).
 * Paint never comes from the overlay.
 */

/** '#rrggbb' or 'rgba(r,g,b,a)' -> [r, g, b] (0–255). */
function rgbOf( color ) {
	if ( '#' === color[ 0 ] ) {
		const n = parseInt( color.slice( 1 ), 16 );
		return [ ( n >> 16 ) & 255, ( n >> 8 ) & 255, n & 255 ];
	}
	const m = color.match( /[\d.]+/g ) || [ 180, 210, 235 ];
	return [ +m[ 0 ], +m[ 1 ], +m[ 2 ] ];
}

const rgba = ( c, a ) => `rgba(${ c[ 0 ] | 0 },${ c[ 1 ] | 0 },${ c[ 2 ] | 0 },${ a })`;
const mixRgb = ( c, d, w ) => [ c[ 0 ] + ( d[ 0 ] - c[ 0 ] ) * w, c[ 1 ] + ( d[ 1 ] - c[ 1 ] ) * w, c[ 2 ] + ( d[ 2 ] - c[ 2 ] ) * w ];
const WHITE = [ 255, 255, 255 ];
const BLACK = [ 0, 0, 0 ];

/**
 * A bead of liquid lit from the upper left: translucent body that is lighter
 * where it is thin, a darker refracting rim, light focused (caustic) on the
 * far side and a sharp specular highlight.
 */
function drawBead( ctx, x, y, rx, ry, angle, rgb, alpha ) {
	const r = Math.max( rx, ry );
	ctx.save();
	ctx.translate( x, y );
	ctx.rotate( angle );
	const body = ctx.createRadialGradient( -rx * 0.25, -ry * 0.3, 0, 0, 0, r );
	body.addColorStop( 0, rgba( mixRgb( rgb, WHITE, 0.35 ), 0.5 * alpha ) );
	body.addColorStop( 0.62, rgba( rgb, 0.78 * alpha ) );
	body.addColorStop( 1, rgba( mixRgb( rgb, BLACK, 0.4 ), 0.95 * alpha ) );
	ctx.fillStyle = body;
	ctx.beginPath();
	ctx.ellipse( 0, 0, rx, ry, 0, 0, Math.PI * 2 );
	ctx.fill();
	if ( r > 2 ) {
		const caustic = ctx.createRadialGradient( rx * 0.3, ry * 0.38, 0, rx * 0.3, ry * 0.38, r * 0.5 );
		caustic.addColorStop( 0, `rgba(255,255,255,${ 0.32 * alpha })` );
		caustic.addColorStop( 1, 'rgba(255,255,255,0)' );
		ctx.fillStyle = caustic;
		ctx.beginPath();
		ctx.ellipse( 0, 0, rx, ry, 0, 0, Math.PI * 2 );
		ctx.fill();
	}
	const spec = ctx.createRadialGradient( -rx * 0.38, -ry * 0.42, 0, -rx * 0.38, -ry * 0.42, r * 0.3 );
	spec.addColorStop( 0, `rgba(255,255,255,${ 0.95 * alpha })` );
	spec.addColorStop( 0.45, `rgba(255,255,255,${ 0.55 * alpha })` );
	spec.addColorStop( 1, 'rgba(255,255,255,0)' );
	ctx.fillStyle = spec;
	ctx.beginPath();
	ctx.ellipse( -rx * 0.38, -ry * 0.42, r * 0.3, r * 0.22, -0.6, 0, Math.PI * 2 );
	ctx.fill();
	ctx.restore();
}

function softShadow( ctx, x, y, rx, ry, a ) {
	const g = ctx.createRadialGradient( x, y, 0, x, y, Math.max( rx, ry ) );
	g.addColorStop( 0, `rgba(45,32,20,${ a })` );
	g.addColorStop( 1, 'rgba(45,32,20,0)' );
	ctx.fillStyle = g;
	ctx.beginPath();
	ctx.ellipse( x, y, rx, ry, 0, 0, Math.PI * 2 );
	ctx.fill();
}

const smooth = ( a, b, x ) => {
	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );
};

/** Position of the brush tip along a back-and-forth wash, p in [0,1]. */
export function brushPath( a, p ) {
	const n = a.passes;
	const q = Math.min( n - 1e-6, Math.max( 0, p * n ) );
	const band = Math.floor( q );
	const u = q - band;
	const cOf = ( b ) => ( ( b + 0.5 ) / n ) * 2 - 1;
	let c = cOf( band );
	// Round the turn at the end of each pass into the next one.
	if ( band < n - 1 ) {
		c += ( cOf( band + 1 ) - c ) * smooth( 0.88, 1, u );
	}
	const half = Math.max( 0.25, Math.sqrt( Math.max( 0, 1 - cOf( band ) * cOf( band ) ) ) );
	const along = band & 1 ? 1 - u : u;
	const ac = ( along * 2 - 1 ) * half;
	return {
		x: a.x + a.dx * ac * a.R - a.dy * c * a.R,
		y: a.y + a.dy * ac * a.R + a.dx * c * a.R,
		// Lighter touch while turning between passes.
		turn: band < n - 1 ? smooth( 0.85, 0.97, u ) * ( 1 - smooth( 0.97, 1, u ) ) : 0,
	};
}

export class GestureAnimator {
	constructor( model, pigments ) {
		this.model = model;
		this.colors = pigments.map( ( p ) => p.hex );
		this.actions = [];
		this.showGestures = true;
		this.dirty = false;
		this.clock = 0;
		this.brushFreeAt = 0;
	}

	reset() {
		this.actions = [];
		this.dirty = true;
		this.clock = 0;
		this.brushFreeAt = 0;
	}

	tick( dtSeconds ) {
		this.clock += dtSeconds;
	}

	get busy() {
		return this.actions.length > 0;
	}

	/**
	 * @param {Object} a { blob?, lift?, start, dur, mode: 'radial'|'sweep'|'none',
	 *   tool: 'drop'|'brush'|'particle'|'sponge', linger, ... }
	 */
	add( a ) {
		a.prev = 0;
		a.prepared = false;
		this.actions.push( a );
	}

	/**
	 * Advance deposits to the gesture clock, within a time budget. Actions
	 * not reached this frame simply catch up on the next one.
	 */
	update( t = this.clock, budgetMs = Infinity ) {
		const model = this.model;
		const deadline = performance.now() + budgetMs;
		// Rotate the starting point so no gesture starves under the budget.
		const n = this.actions.length;
		const offset = n ? ( this._rr = ( ( this._rr || 0 ) + 1 ) % n ) : 0;
		let w = 0;
		const order = offset ? this.actions.slice( offset ).concat( this.actions.slice( 0, offset ) ) : this.actions;
		for ( let i = 0; i < order.length; i++ ) {
			const a = order[ i ];
			let keep = true;
			if ( t >= a.start && ( i < 4 || performance.now() < deadline ) ) {
				if ( ! a.prepared ) {
					a.prepared = true;
					if ( a.blob && ! model.prepare( a.blob ) ) {
						a.empty = true;
					}
				}
				const x = a.dur > 0 ? Math.min( 1, ( t - a.start ) / a.dur ) : 1;
				const p = 'radial' === a.mode ? 1 - Math.pow( 1 - x, 2.2 ) : x;
				if ( p > a.prev && ! a.empty && a.blob ) {
					model.deposit( a.blob, a.prev, p >= 1 ? 2 : p, a.mode );
				}
				a.prev = p;
				if ( x >= 1 ) {
					if ( a.lift && ! a.lifted ) {
						model.lift( a.lift );
						a.lifted = true;
					}
					keep = t < a.start + a.dur + ( a.linger || 0 );
				}
			}
			if ( keep ) {
				order[ w++ ] = a;
			}
		}
		order.length = w;
		this.actions = order;
	}

	/** Draws the hand: drops, particles, brush, tissue. */
	draw( ctx, t, sx, sy, dpr ) {
		const cw = ctx.canvas.width;
		const ch = ctx.canvas.height;
		if ( ! this.actions.length || ! this.showGestures ) {
			if ( this.dirty ) {
				ctx.clearRect( 0, 0, cw, ch );
				this.dirty = false;
			}
			return;
		}
		ctx.clearRect( 0, 0, cw, ch );
		this.dirty = true;
		const unit = Math.min( sx, sy );
		const view = { sx, sy, unit, dpr };
		// Brushes last so the hand stays above the drops.
		for ( const a of this.actions ) {
			if ( 'brush' === a.tool ) {
				continue;
			}
			const color = a.color || ( a.blob && a.blob.k >= 0 ? this.colors[ a.blob.k ] : 'rgba(170,205,235,0.75)' );
			if ( 'drop' === a.tool ) {
				this._drop( ctx, a, t, view, color );
			} else if ( 'particle' === a.tool ) {
				this._particle( ctx, a, t, view, color );
			}
		}
		for ( const a of this.actions ) {
			if ( 'brush' === a.tool ) {
				// A clean, damp brush for clear water and for lifting.
				const color = a.color || ( a.blob && a.blob.k >= 0 ? this.colors[ a.blob.k ] : '#c9c0ae' );
				this._brush( ctx, a, t, view, color );
			}
		}
	}

	_drop( ctx, a, t, { sx, sy, unit, dpr }, color ) {
		const x = a.x * sx;
		const y = a.y * sy;
		const rr = Math.max( 2.5 * dpr, a.size * unit );
		const rgb = a.rgb || ( a.rgb = rgbOf( color ) );
		if ( t < a.start ) {
			const q = Math.max( 0, 1 - ( a.start - t ) / a.fall );
			if ( q <= 0 ) {
				return;
			}
			// Shadow sharpening and converging on the landing point.
			softShadow( ctx, x + ( 1 - q ) * rr * 2.2, y + ( 1 - q ) * rr * 1.2, rr * ( 2.2 - 1.1 * q ), rr * ( 1.7 - 0.8 * q ), 0.22 * q * q );
			// Accelerating fall; a falling drop is nearly spherical.
			const h = ( 1 - q ) * ( 1 - q ) * ( 60 * dpr + rr * 5 );
			const s = rr * ( 1.15 - 0.2 * q );
			drawBead( ctx, x, y - h, s * 0.94, s * 1.04, 0, rgb, 0.95 );
			return;
		}
		// Impact: the bead spreads flat and soaks into the paper.
		const u = ( t - a.start ) / a.squash;
		if ( u < 1 ) {
			const e = 1 - ( 1 - u ) * ( 1 - u );
			drawBead( ctx, x, y, rr * ( 1 + 0.8 * e ), rr * ( 0.95 - 0.45 * e ), a.tilt || 0, rgb, 0.9 * ( 1 - u ) );
		}
	}

	_particle( ctx, a, t, { sx, sy, unit, dpr }, color ) {
		if ( t < a.launch || t >= a.start ) {
			return;
		}
		const rgb = a.rgb || ( a.rgb = rgbOf( color ) );
		const pos = ( q ) => [
			( a.from.x + ( a.x - a.from.x ) * q ) * sx,
			( a.from.y + ( a.y - a.from.y ) * q ) * sy - Math.sin( Math.PI * q ) * a.arc * unit,
		];
		const q = ( t - a.launch ) / ( a.start - a.launch );
		const [ x, y ] = pos( q );
		const [ bx, by ] = pos( Math.max( 0, q - 0.14 ) );
		const gx = ( a.from.x + ( a.x - a.from.x ) * q ) * sx;
		const gy = ( a.from.y + ( a.y - a.from.y ) * q ) * sy;
		const rr = Math.max( 1.2 * dpr, a.size * unit * ( 1 + 0.35 * Math.sin( Math.PI * q ) ) );
		softShadow( ctx, gx + ( y - gy ) * -0.15, gy, rr * 1.6, rr * 1.2, 0.16 );
		// Motion streak, then the droplet stretched along its velocity.
		const vx = x - bx;
		const vy = y - by;
		const speed = Math.hypot( vx, vy );
		ctx.strokeStyle = rgba( rgb, 0.22 );
		ctx.lineCap = 'round';
		ctx.lineWidth = rr * 1.1;
		ctx.beginPath();
		ctx.moveTo( bx, by );
		ctx.lineTo( x, y );
		ctx.stroke();
		const stretch = Math.min( 1.8, 1 + speed / ( rr * 6 ) );
		drawBead( ctx, x, y, rr * stretch, rr / Math.sqrt( stretch ), Math.atan2( vy, vx ), rgb, 0.95 );
	}

	/**
	 * A round watercolor brush: lacquered handle, crimped ferrule and a hair
	 * belly loaded with pigment that bends behind the motion and flattens
	 * under pressure. Presses down at the start, lifts off at the end.
	 */
	_brush( ctx, a, t, { sx, sy, unit, dpr }, color ) {
		const approach = a.approach;
		if ( t < a.start - approach || t > a.start + a.dur + approach ) {
			return;
		}
		const p = Math.min( 1, Math.max( 0, ( t - a.start ) / a.dur ) );
		const here = brushPath( a, p );
		const ahead = brushPath( a, Math.min( 1, p + 0.015 ) );
		const behind = brushPath( a, Math.max( 0, p - 0.015 ) );
		let vx = ( ahead.x - behind.x ) * sx;
		let vy = ( ahead.y - behind.y ) * sy;
		const vl = Math.hypot( vx, vy ) || 1;
		vx /= vl;
		vy /= vl;
		// Before / after the stroke the brush hovers above the paper.
		const lift = t < a.start ? ( a.start - t ) / approach : t > a.start + a.dur ? ( t - a.start - a.dur ) / approach : 0;
		const press = ( 1 - lift ) * ( 0.55 + 0.45 * smooth( 0, 0.08, p ) * ( 1 - smooth( 0.9, 1, p ) ) ) * ( 1 - 0.35 * here.turn );
		const alpha = Math.min( 1, 1.6 * ( 1 - lift ) + 0.2 );

		const tipW = Math.max( 3.5 * dpr, a.tip * unit );
		const hairL = Math.max( 18 * dpr, tipW * 3.4 );
		const ferL = Math.max( 12 * dpr, hairL * 0.42 );
		const ferW = Math.max( 5 * dpr, tipW * 0.95 );
		const handleL = Math.max( 120 * dpr, hairL * 4.5 );
		// The handle leans up and to the right, pulled slightly along the stroke.
		let hx = 0.62 + vx * 0.28;
		let hy = -0.78 + vy * 0.28;
		const hl = Math.hypot( hx, hy );
		hx /= hl;
		hy /= hl;
		const px = -hy;
		const py = hx;
		const raise = lift * 14 * dpr + ( 1 - press ) * 3 * dpr;
		const P = { x: here.x * sx + hx * raise * 0.4, y: here.y * sy - raise };
		const F = { x: P.x + hx * hairL * ( 1 - 0.18 * press ), y: P.y + hy * hairL * ( 1 - 0.18 * press ) };
		const E = { x: F.x + hx * ferL, y: F.y + hy * ferL };
		const End = { x: E.x + hx * handleL, y: E.y + hy * handleL };
		// Bristles drag behind the direction of travel and spread with pressure.
		const drag = press * tipW * 1.1;
		const belly = ferW * ( 0.62 + 0.45 * press );
		const mid = { x: ( F.x + P.x ) / 2 - vx * drag, y: ( F.y + P.y ) / 2 - vy * drag };
		const tip = { x: P.x - vx * drag * 0.55, y: P.y - vy * drag * 0.55 };

		ctx.save();
		ctx.globalAlpha = alpha;
		// Contact shadow, offset as the brush rises.
		const so = ( 6 + 16 * lift ) * dpr;
		ctx.fillStyle = 'rgba(35,25,15,0.16)';
		ctx.beginPath();
		ctx.moveTo( tip.x + so * 0.4, tip.y + so * 0.25 );
		ctx.lineTo( End.x + so * 1.6 + px * ferW * 0.3, End.y + so + py * ferW * 0.3 );
		ctx.lineTo( End.x + so * 1.6 - px * ferW * 0.3, End.y + so - py * ferW * 0.3 );
		ctx.closePath();
		ctx.fill();

		// Handle: tapered lacquered wood.
		const hg = ctx.createLinearGradient( E.x + px * ferW, E.y + py * ferW, E.x - px * ferW, E.y - py * ferW );
		hg.addColorStop( 0, '#3f1512' );
		hg.addColorStop( 0.35, '#a33b2c' );
		hg.addColorStop( 0.5, '#d8735e' );
		hg.addColorStop( 0.7, '#7c241c' );
		hg.addColorStop( 1, '#2e0f0c' );
		ctx.fillStyle = hg;
		const w0 = ferW * 0.5;
		const wMax = ferW * 0.62;
		const w1 = ferW * 0.3;
		const Q = { x: E.x + hx * handleL * 0.3, y: E.y + hy * handleL * 0.3 };
		ctx.beginPath();
		ctx.moveTo( E.x + px * w0, E.y + py * w0 );
		ctx.lineTo( Q.x + px * wMax, Q.y + py * wMax );
		ctx.lineTo( End.x + px * w1, End.y + py * w1 );
		ctx.quadraticCurveTo( End.x + hx * w1 * 2, End.y + hy * w1 * 2, End.x - px * w1, End.y - py * w1 );
		ctx.lineTo( Q.x - px * wMax, Q.y - py * wMax );
		ctx.lineTo( E.x - px * w0, E.y - py * w0 );
		ctx.closePath();
		ctx.fill();

		// Ferrule: brushed metal with crimp rings.
		const fg = ctx.createLinearGradient( F.x + px * ferW, F.y + py * ferW, F.x - px * ferW, F.y - py * ferW );
		fg.addColorStop( 0, '#5d6268' );
		fg.addColorStop( 0.4, '#e9ecef' );
		fg.addColorStop( 0.55, '#ffffff' );
		fg.addColorStop( 0.8, '#8a9097' );
		fg.addColorStop( 1, '#4a4e53' );
		ctx.fillStyle = fg;
		const fw0 = ferW * 0.5;
		const fw1 = ferW * 0.5;
		ctx.beginPath();
		ctx.moveTo( F.x + px * fw0, F.y + py * fw0 );
		ctx.lineTo( E.x + px * fw1, E.y + py * fw1 );
		ctx.lineTo( E.x - px * fw1, E.y - py * fw1 );
		ctx.lineTo( F.x - px * fw0, F.y - py * fw0 );
		ctx.closePath();
		ctx.fill();
		ctx.strokeStyle = 'rgba(60,62,66,0.55)';
		ctx.lineWidth = Math.max( 1, dpr * 0.8 );
		for ( const k of [ 0.72, 0.84 ] ) {
			const c = { x: F.x + ( E.x - F.x ) * k, y: F.y + ( E.y - F.y ) * k };
			ctx.beginPath();
			ctx.moveTo( c.x + px * fw1, c.y + py * fw1 );
			ctx.lineTo( c.x - px * fw1, c.y - py * fw1 );
			ctx.stroke();
		}

		// Hair: a teardrop belly from the ferrule to the tip, loaded with paint.
		const gg = ctx.createLinearGradient( F.x, F.y, tip.x, tip.y );
		gg.addColorStop( 0, '#a8835c' );
		gg.addColorStop( 0.22, '#7a5a3c' );
		gg.addColorStop( 0.45, color );
		gg.addColorStop( 1, color );
		ctx.fillStyle = gg;
		ctx.beginPath();
		ctx.moveTo( F.x + px * fw0, F.y + py * fw0 );
		ctx.quadraticCurveTo( mid.x + px * belly * 1.25, mid.y + py * belly * 1.25, tip.x, tip.y );
		ctx.quadraticCurveTo( mid.x - px * belly * 1.25, mid.y - py * belly * 1.25, F.x - px * fw0, F.y - py * fw0 );
		ctx.closePath();
		ctx.fill();
		// Darker, wetter tip and a glint of water along the belly.
		ctx.globalAlpha = alpha * 0.35;
		ctx.fillStyle = '#000000';
		ctx.beginPath();
		ctx.ellipse( tip.x + ( mid.x - tip.x ) * 0.25, tip.y + ( mid.y - tip.y ) * 0.25, belly * 0.45, belly * 0.28, Math.atan2( hy, hx ), 0, Math.PI * 2 );
		ctx.fill();
		ctx.globalAlpha = alpha * 0.5;
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = Math.max( 1, dpr );
		ctx.beginPath();
		ctx.moveTo( F.x + px * fw0 * 0.5, F.y + py * fw0 * 0.5 );
		ctx.quadraticCurveTo( mid.x + px * belly * 0.7, mid.y + py * belly * 0.7, tip.x + ( mid.x - tip.x ) * 0.3, tip.y + ( mid.y - tip.y ) * 0.3 );
		ctx.stroke();
		ctx.restore();
	}
}
