/**
 * SplashGenerator — Phase C, controlled chaos.
 *
 * Turns a planned op (intended position, pigment, scale, target level) into
 * concrete stamps on the PigmentModel with seeded random variation:
 *  - landing offset scaled by op size, stage chaos and (inversely) by the
 *    edge strength at the target, so silhouettes stay sharp
 *  - irregular polar profile (random harmonics), aspect and rotation
 *  - ±15% pigment quantity, water and mottling
 *  - splatter satellites whose pigment is clamped by the local need, plus a
 *    small decorative allowance only in low-importance areas
 */

import { Rng } from './prng.js';
import { brushPath } from './gesture-animator.js';
import { boxBlur } from './image-analyzer.js';

const PROFILE_N = 64;

// Cinematic: seconds the brush takes to come down onto the paper (and to lift).
const CINE_APPROACH = 0.4;
// Cinematic: the fastest the brush moves along a stroke (cells per second),
// from fine marks (size 0) to broad washes (size 1).
const handSpeed = ( B, size ) => B * ( 0.08 + 0.22 * size );

/** Water (h) above which paper counts as wet for a hard edge beside it. */
const WET_BESIDE = 0.03;

/**
 * Cinematic: the clean border a careful painter leaves around the sheet. Along
 * each edge the margin wanders (between about 1% and 3.5% of the sheet's long
 * side), as a hand stops short of the edge by eye rather than by ruler.
 * `room( x, y )` is how far (cells) a point lies inside it; negative in the border.
 */
export function makeBorder( W, H, seed ) {
	const rng = new Rng( ( seed ^ 0x5bd1e995 ) >>> 0 );
	const B = Math.max( W, H );
	const maxM = 0.035 * B;
	const edge = () => {
		const f = [ rng.range( 2, 4 ), rng.range( 5, 9 ), rng.range( 11, 17 ) ];
		const ph = [ rng.range( 0, 6.3 ), rng.range( 0, 6.3 ), rng.range( 0, 6.3 ) ];
		// u: 0–1 along the edge -> margin (cells).
		return ( u ) => {
			const n = 0.55 * Math.sin( u * f[ 0 ] + ph[ 0 ] ) + 0.3 * Math.sin( u * f[ 1 ] + ph[ 1 ] ) + 0.15 * Math.sin( u * f[ 2 ] + ph[ 2 ] );
			return maxM * ( 0.62 + 0.38 * n );
		};
	};
	const left = edge();
	const right = edge();
	const top = edge();
	const bottom = edge();
	return {
		// The widest the border can get (a share of the long side): the brush
		// lifts up to 1.25 times the margin from the edge, plus its tip.
		reach: ( maxM * 1.3 ) / B,
		room( x, y, scale = 1 ) {
			return Math.min( x - left( y / H ) * scale, W - x - right( y / H ) * scale, y - top( x / W ) * scale, H - y - bottom( x / W ) * scale );
		},
	};
}

export class SplashGenerator {
	constructor( model, analysis, drying ) {
		this.model = model;
		this.an = analysis;
		this.drying = drying;
		this.complexity = 1;
		// Drops and splashes off: the brush paints those marks instead (the
		// splash code is kept for later, e.g. painting by hand).
		this.noSplashes = false;
		this.animator = null;
		// The pigment currently on the brush, and where the brush last was.
		this.loaded = -1;
		this.handX = analysis.W / 2;
		this.handY = analysis.H / 2;
		// In a photo, where a colour belongs is judged over a small
		// neighbourhood: a field strewn with flowers is still a green field.
		const { W, H, B } = analysis;
		const r = Math.max( 1, Math.round( B / 80 ) );
		this.belongT = analysis.photo ? model.T[ 0 ].map( ( m ) => boxBlur( m, W, H, r ) ) : model.T[ 0 ];
	}

	_profile( rng, amp ) {
		const out = new Float32Array( PROFILE_N + 1 );
		const harmonics = [];
		for ( let hI = 2; hI <= 9; hI++ ) {
			harmonics.push( [ hI, ( amp * rng.range( 0.3, 1 ) ) / Math.sqrt( hI ), rng.range( 0, Math.PI * 2 ) ] );
		}
		let max = 0;
		for ( let j = 0; j <= PROFILE_N; j++ ) {
			const th = ( j / PROFILE_N ) * Math.PI * 2;
			let v = 1;
			for ( const [ f, a, p ] of harmonics ) {
				v += a * Math.sin( f * th + p );
			}
			out[ j ] = Math.max( 0.35, v );
			max = Math.max( max, out[ j ] );
		}
		out[ PROFILE_N ] = out[ 0 ];
		out.max = max;
		return out;
	}

	_idx( x, y ) {
		const { W, H } = this.an;
		return Math.min( H - 1, Math.max( 0, Math.round( y ) ) ) * W + Math.min( W - 1, Math.max( 0, Math.round( x ) ) );
	}

	/**
	 * Is pigment k really part of the colour at (x, y)? Untrimmed gestures lay
	 * one tone over their whole footprint, so a wrong colour would show in full.
	 */
	belongs( k, x, y ) {
		const m = this.model;
		const i = this._idx( x, y );
		// Compare how much of each pigment the spot calls for (not how dark each
		// one is), so a light main colour is not overruled by a strong accent.
		const T = this.belongT;
		let best = 0;
		for ( let j = 0; j < m.K; j++ ) {
			best = Math.max( best, T[ j ][ i ] );
		}
		return best > 0 && T[ k ][ i ] >= 0.35 * best;
	}

	/** Distance (cells) from (x, y) to the nearest border between areas. */
	roomAt( x, y ) {
		return this.an.room ? this.an.room[ this._idx( x, y ) ] : Infinity;
	}

	/** Strongest edge within radius r of (x, y): borders between colour areas. */
	edgeNear( x, y, r ) {
		const { W, H, edge } = this.an;
		let m = 0;
		const st = Math.max( 1, r / 3 );
		for ( let dy = -r; dy <= r; dy += st ) {
			for ( let dx = -r; dx <= r; dx += st ) {
				const xx = Math.round( x + dx );
				const yy = Math.round( y + dy );
				if ( xx >= 0 && yy >= 0 && xx < W && yy < H ) {
					m = Math.max( m, edge[ yy * W + xx ] );
				}
			}
		}
		return m;
	}

	/** Direction along the local contour (perpendicular to the tonal gradient). */
	_tangent( x, y ) {
		const { W, H, darkness } = this.an;
		const xi = Math.min( W - 2, Math.max( 1, Math.round( x ) ) );
		const yi = Math.min( H - 2, Math.max( 1, Math.round( y ) ) );
		let gx = 0;
		let gy = 0;
		for ( let d = -1; d <= 1; d++ ) {
			gx += darkness[ ( yi + d ) * W + xi + 1 ] - darkness[ ( yi + d ) * W + xi - 1 ];
			gy += darkness[ ( yi + 1 ) * W + xi + d ] - darkness[ ( yi - 1 ) * W + xi + d ];
		}
		return Math.atan2( gy, gx ) + Math.PI / 2;
	}

	/**
	 * Pigment whose remaining need contributes most density here. A painter
	 * keeps using the colour already on the brush when it is nearly as good.
	 */
	autoPigment( x, y, level, prefer = this.loaded ) {
		const m = this.model;
		const i = this._idx( x, y );
		let best = -1;
		let bestS = 0;
		for ( let k = 0; k < m.K; k++ ) {
			if ( m.pigments[ k ].isPaper ) {
				continue;
			}
			const nd = m.need( k, level, i );
			const s = nd * m.normA[ k ];
			if ( nd > 0.015 && s > bestS && this.belongs( k, x, y ) ) {
				bestS = s;
				best = k;
			}
		}
		if ( prefer >= 0 && best >= 0 && prefer !== best ) {
			const nd = m.need( prefer, level, i );
			if ( nd > 0.015 && nd * m.normA[ prefer ] > 0.85 * bestS && this.belongs( prefer, x, y ) ) {
				return prefer;
			}
		}
		return best;
	}

	/** Builds (but does not apply) an irregular blob stamp. */
	_stamp( rng, op, x, y, r, k, extra = {} ) {
		const amp = extra.amp ?? 0.16;
		const prof = this._profile( rng, amp );
		const aspect = extra.aspect ?? rng.range( 1, 1.45 );
		const dir = extra.rot ?? rng.range( 0, Math.PI * 2 );
		return {
			x,
			y,
			r,
			k,
			level: op.level ?? 1,
			aspect,
			rot: extra.rot ?? rng.range( 0, Math.PI ),
			profile: prof,
			reach: prof.max * aspect,
			soft: extra.soft ?? 0.35,
			amount: ( op.amount ?? 0.6 ) * rng.range( 0.85, 1.12 ),
			flat: op.flat ?? 0.4,
			follow: extra.follow ?? op.follow ?? 0.8,
			water: extra.water ?? ( op.water ?? 0.5 ) * rng.range( 0.88, 1.12 ),
			capMul: extra.capMul ?? 1.15,
			spill: extra.spill ?? 0,
			minNeed: extra.minNeed ?? 0.012,
			seed: rng.u32(),
			dx: Math.cos( dir ),
			dy: Math.sin( dir ),
		};
	}

	_emit( blob, g ) {
		if ( ! this.animator ) {
			this.model.deposit( blob );
			return;
		}
		this.animator.add( { ...g, blob } );
	}

	/** One "already painted" record per object wash, shared by all its rows. */
	_washMask( id ) {
		this._washes = this._washes || new Map();
		if ( ! this._washes.has( id ) ) {
			if ( this._washes.size > 4 ) {
				this._washes.delete( this._washes.keys().next().value );
			}
			this._washes.set( id, new Float32Array( this.an.W * this.an.H ) );
		}
		return this._washes.get( id );
	}

	get now() {
		return this.animator ? this.animator.clock : 0;
	}

	/**
	 * A brush sweep: back-and-forth passes, paint appears behind the tip.
	 * One hand: strokes queue behind the current one. When the hand is
	 * already busy for a while, the paint is dropped from the brush instead.
	 *
	 * @return {Object|null} real-time { start, dur } of the stroke, or null when dropped.
	 */
	_brush( rng, op, x, y, r, k, extra = {}, delay = 0 ) {
		const anim = this.animator;
		const backlog = anim ? anim.backlog( this.now ) : 0;
		if ( anim && ! extra.queue && backlog > 1.2 ) {
			// Too close to a border for a blot: leave it for a later brush pass.
			const room = this.roomAt( x, y );
			if ( room >= r * 0.9 ) {
				this._drop( rng, op, x, y, r, k, { crown: 2 + rng.int( 4 ), extra, delay, fit: room * 0.95 } );
			}
			return null;
		}
		if ( anim && extra.queue && ! extra.keep && backlog > 3 ) {
			// The hand is busy: this mark is left for a later pass.
			return null;
		}
		if ( k >= 0 ) {
			this.loaded = k;
		}
		this.handX = x;
		this.handY = y;
		const B = this.an.B;
		// Cinematic: washes are laid in near-horizontal bands, starting from
		// the end nearer the hand (top-left or bottom-right), so one stroke
		// carries on from the last.
		let dir = extra.rot ?? rng.range( 0, Math.PI * 2 );
		if ( undefined === extra.rot && anim && anim.cinematic ) {
			const from = anim.lastEnd || { x: x - r, y: y - r };
			const nearTopLeft = Math.hypot( x - r - from.x, y - r - from.y ) <= Math.hypot( x + r - from.x, y + r - from.y );
			dir = ( nearTopLeft ? 0 : Math.PI ) + rng.range( -0.12, 0.12 );
		}
		const dx = Math.cos( dir );
		const dy = Math.sin( dir );
		// Detail strokes are long and thin along a contour; washes are
		// back-and-forth passes across an area.
		const contour = undefined !== extra.aspect && 1 === extra.passes;
		let R = contour ? r * extra.aspect : r * 1.2;
		let passes = extra.passes ?? Math.max( 1, Math.min( 5, Math.ceil( R / ( B * 0.03 ) ) ) );
		if ( extra.fitR ) {
			// Planned footprint: passes plus tip stay within fitR.
			passes = Math.max( 1, Math.min( 5, Math.ceil( extra.fitR / ( B * 0.03 ) ) ) );
			R = ( extra.fitR * passes ) / ( passes + 1 );
		}
		const tip = Math.max( 0.8, contour ? r * 0.9 : R / passes );
		// The paint is exactly the ribbon the tip sweeps along this path. The tip
		// only touches paper where there is room for it; near a border the brush
		// lifts instead of crossing (nothing is trimmed afterwards).
		const keepIn = contour ? 0.45 : 0.8;
		const stopAt = this.border ? rng.range( 0.75, 1.25 ) : 1;
		const M = Math.max( 6, Math.ceil( ( passes * 2 * R ) / Math.max( 0.6, tip * 0.5 ) ) );
		const path = new Float32Array( M * 4 );
		const shape = { x, y, R, passes, dx, dy };
		for ( let j = 0; j < M; j++ ) {
			const sj = ( j + 0.5 ) / M;
			const pt = brushPath( shape, sj );
			const u = sj * passes - Math.floor( sj * passes );
			const press = 0.55 + 0.45 * Math.min( 1, u / 0.15, ( 1 - u ) / 0.15 ) * ( 1 - 0.4 * pt.turn );
			const tr = tip * press;
			const inside = pt.x >= 0 && pt.y >= 0 && pt.x < this.an.W && pt.y < this.an.H;
			path[ j * 4 ] = pt.x;
			path[ j * 4 + 1 ] = pt.y;
			path[ j * 4 + 2 ] = sj;
			// The tip touches paper only where there is room for it and where
			// this colour belongs (k < 0 is clear water).
			// Contour strokes are meant to sit on the edge: they only need the
			// colour to belong there (their tip is sized to the shape).
			const roomy = contour || extra.fitR || this.roomAt( pt.x, pt.y ) >= tr * keepIn;
			// Cinematic: the brush lifts before the border, each stroke stopping
			// a little nearer or farther.
			const clear = ! this.border || this.border.room( pt.x, pt.y, stopAt ) >= tr * 0.6;
			const ok = inside && roomy && clear && ( k < 0 || extra.trust || this.belongs( k, pt.x, pt.y ) );
			path[ j * 4 + 3 ] = ok ? tr : 0;
		}
		// No dabs: a touch shorter than a few tip-widths would leave a dot, so
		// the brush stays lifted there.
		const minRun = Math.max( 3, Math.ceil( ( 3 * tip ) / ( ( passes * 2 * R ) / M ) ) );
		for ( let j = 0; j < M; ) {
			if ( ! path[ j * 4 + 3 ] ) {
				j++;
				continue;
			}
			let e = j;
			while ( e < M && path[ e * 4 + 3 ] ) {
				e++;
			}
			if ( e - j < minRun ) {
				for ( let q = j; q < e; q++ ) {
					path[ q * 4 + 3 ] = 0;
				}
			}
			j = e;
		}
		// Cinematic: the hand brushes only the part of the path that paints
		// (coming down at the first touch, lifting after the last), instead of
		// sweeping on over the desk around a wash near the edge.
		// A stroke with nothing to paint is never made (the hand would mime it).
		let paints = false;
		for ( let j = 0; j < M && ! paints; j++ ) {
			paints = path[ j * 4 + 3 ] > 0;
		}
		if ( ! paints ) {
			return null;
		}
		let p0 = 0;
		let p1 = 1;
		if ( anim && anim.cinematic ) {
			let j0 = 0;
			let j1 = M - 1;
			while ( j0 < M && ! path[ j0 * 4 + 3 ] ) {
				j0++;
			}
			while ( j1 > j0 && ! path[ j1 * 4 + 3 ] ) {
				j1--;
			}
			if ( j0 < M ) {
				p0 = j0 / M;
				p1 = ( j1 + 1 ) / M;
			}
		}
		const blob = {
			brush: true,
			k,
			level: op.level ?? 1,
			amount: ( op.amount ?? 0.6 ) * rng.range( 0.88, 1.08 ),
			water: extra.water ?? ( op.water ?? 0.5 ) * rng.range( 0.88, 1.12 ),
			minNeed: extra.minNeed ?? 0.012,
			spill: 0,
			seed: rng.u32(),
			path,
		};
		// Small marks are quick flicks of a fine brush; washes take their time.
		const size = Math.min( 1, ( contour ? r : R ) / ( B * 0.025 ) );
		let dur = ( 0.25 + passes * rng.range( 0.4, 0.6 ) ) * ( extra.slow ?? 1 ) * ( 0.45 + 0.55 * size );
		if ( anim && anim.cinematic ) {
			// Seen up close, a hand never races: fine marks slow, washes broader.
			dur = Math.max( 0.3, Math.max( dur, Math.min( ( passes * 2 * R ) / handSpeed( B, size ), Math.max( dur * 1.5, 6 ) ) ) * ( p1 - p0 ) );
		}
		// Cinematic: the brush is seen coming down onto the paper and lifting off.
		const approach = anim && anim.cinematic ? CINE_APPROACH : 0.08 + 0.14 * size;
		const j0 = Math.min( M - 1, Math.floor( p0 * M ) );
		const start = anim ? anim.nextBrush( this.now + delay, approach, k, path[ j0 * 4 ], path[ j0 * 4 + 1 ] ) : 0;
		if ( anim ) {
			anim.brushFreeAt = start + dur + approach;
		}
		this._emit( blob, {
			tool: 'brush',
			mode: 'sweep',
			start,
			dur,
			approach,
			linger: approach,
			x,
			y,
			R,
			passes,
			tip,
			dx,
			dy,
			p0,
			p1,
		} );
		return { start, dur };
	}

	/**
	 * A brush stroke along a planned centreline (letters, contours, gaps): the
	 * tip follows the shape's spine and its width follows the shape.
	 */
	_brushAlong( rng, op, k, delay = 0 ) {
		const anim = this.animator;
		// Object washes are never skipped: they queue and the timeline waits.
		// Optional fine work is let go when the hand is far behind.
		if ( anim && 'sweep' !== op.type && anim.backlog( this.now ) > 3 ) {
			return null;
		}
		const pts = op.path;
		const n = pts.length / 3;
		let total = 0;
		const cum = new Float32Array( n );
		for ( let q = 1; q < n; q++ ) {
			total += Math.hypot( pts[ q * 3 ] - pts[ q * 3 - 3 ], pts[ q * 3 + 1 ] - pts[ q * 3 - 2 ] );
			cum[ q ] = total;
		}
		const path = new Float32Array( n * 4 );
		const track = new Float32Array( n * 3 );
		const stopAt = this.border ? rng.range( 0.75, 1.25 ) : 1;
		for ( let q = 0; q < n; q++ ) {
			const x = pts[ q * 3 ];
			const y = pts[ q * 3 + 1 ];
			const s = total > 0 ? cum[ q ] / total : q / Math.max( 1, n - 1 );
			// Pressure: lighter as the brush lands and lifts.
			const u = n > 1 ? q / ( n - 1 ) : 0.5;
			// A gentle taper only at the very ends of a stroke.
			const press = 0.88 + 0.12 * Math.min( 1, u / 0.06, ( 1 - u ) / 0.06 );
			// Object sweeps were planned to run under later neighbours on purpose.
			const ok = ( op.trust || k < 0 || this.belongs( k, x, y ) ) && ( ! this.border || this.border.room( x, y, stopAt ) >= pts[ q * 3 + 2 ] * 0.6 );
			path[ q * 4 ] = x;
			path[ q * 4 + 1 ] = y;
			path[ q * 4 + 2 ] = Math.min( 0.9999, s );
			path[ q * 4 + 3 ] = ok ? Math.max( 0.7, pts[ q * 3 + 2 ] * press ) : 0;
			track[ q * 3 ] = x;
			track[ q * 3 + 1 ] = y;
			track[ q * 3 + 2 ] = s;
		}
		// Cinematic, with its border: the hand brushes only from the first touch
		// to the last (it lifts before the border rather than sweeping on).
		let q0 = 0;
		let q1 = n - 1;
		if ( this.border && anim && anim.cinematic ) {
			while ( q0 < n && ! path[ q0 * 4 + 3 ] ) {
				q0++;
			}
			if ( q0 >= n ) {
				return null;
			}
			while ( q1 > q0 && ! path[ q1 * 4 + 3 ] ) {
				q1--;
			}
		}
		const p0 = path[ q0 * 4 + 2 ];
		const p1 = q1 === n - 1 ? 1 : path[ q1 * 4 + 2 ];
		const trimmed = q0 > 0 || q1 < n - 1;
		if ( k >= 0 ) {
			this.loaded = k;
		}
		this.handX = pts[ q1 * 3 ];
		this.handY = pts[ q1 * 3 + 1 ];
		const blob = {
			brush: true,
			k,
			level: op.level ?? 0,
			amount: ( op.amount ?? 0.95 ) * rng.range( 0.92, 1.05 ),
			water: ( op.water ?? 0.14 ) * rng.range( 0.9, 1.1 ),
			minNeed: 0.01,
			spill: 0,
			seed: rng.u32(),
			path,
			shared: op.shared,
			// Detail strokes also grade their tone along the path (a brow dark at
			// its root, lighter at its tip); washes unload a little less.
			graded: op.graded || 'detail' === op.type,
			unload: 'sweep' === op.type ? 0.15 : 0.3,
		};
		const B = this.an.B;
		const tip = op.r ?? 1.5;
		let dur = op.speed ? Math.min( 8, 0.2 + total / op.speed ) : Math.min( 2.6, 0.25 + total / ( B * 0.3 ) );
		if ( anim && anim.cinematic ) {
			// ...but a long wash (rows across a whole shape) keeps moving: never
			// more than half again its usual time, or 6 s.
			dur = Math.max( dur, Math.min( total / handSpeed( B, Math.min( 1, tip / ( B * 0.025 ) ) ), Math.max( dur * 1.5, 6 ) ) );
		}
		// Cinematic: the brush is seen coming down onto the paper and lifting off.
		const approach = anim && anim.cinematic ? CINE_APPROACH : 0.08 + 0.14 * Math.min( 1, tip / ( B * 0.025 ) );
		if ( trimmed ) {
			dur = Math.max( 0.3, dur * ( p1 - p0 ) );
		}
		const start = anim ? anim.nextBrush( this.now + delay, approach, k, pts[ q0 * 3 ], pts[ q0 * 3 + 1 ] ) : 0;
		if ( anim ) {
			anim.brushFreeAt = start + dur + approach;
		}
		this._emit( blob, { tool: 'brush', mode: 'sweep', start, dur, approach, linger: approach, x: pts[ q0 * 3 ], y: pts[ q0 * 3 + 1 ], tip, track, ...( trimmed ? { p0, p1 } : {} ) } );
		return { start, dur };
	}

	/**
	 * A drop falls, lands and blooms outward; heavier drops throw a crown of
	 * satellite droplets (particles) that bloom where they land.
	 */
	/**
	 * A line lifted with a clean, thirsty brush: drawn along the path at the
	 * pace of a fine stroke; the paint comes off as the brush leaves.
	 */
	_liftAlong( rng, op, lift ) {
		const anim = this.animator;
		const P = op.path;
		const n = P.length / 3;
		let total = 0;
		const track = new Float32Array( n * 3 );
		for ( let q = 0; q < n; q++ ) {
			if ( q ) {
				total += Math.hypot( P[ q * 3 ] - P[ q * 3 - 3 ], P[ q * 3 + 1 ] - P[ q * 3 - 2 ] );
			}
			track[ q * 3 ] = P[ q * 3 ];
			track[ q * 3 + 1 ] = P[ q * 3 + 1 ];
			track[ q * 3 + 2 ] = total;
		}
		for ( let q = 0; q < n; q++ ) {
			track[ q * 3 + 2 ] = total > 0 ? track[ q * 3 + 2 ] / total : q / Math.max( 1, n - 1 );
		}
		const B = this.an.B;
		const approach = anim.cinematic ? CINE_APPROACH : 0.12;
		const start = anim.nextBrush( this.now, approach, -1, P[ 0 ], P[ 1 ] );
		const dur = Math.min( 2.6, 0.25 + total / ( B * 0.3 ) );
		anim.brushFreeAt = start + dur + approach;
		anim.add( { tool: 'brush', mode: 'sweep', start, dur, approach, linger: approach, x: P[ 0 ], y: P[ 1 ], tip: Math.max( 0.8, op.r ?? 1 ), track, color: '#c9c0ae', lift } );
		this.handX = P[ ( n - 1 ) * 3 ];
		this.handY = P[ ( n - 1 ) * 3 + 1 ];
		return true;
	}

	_drop( rng, op, x, y, r, k, { crown = 0, spray = 0, extra = {}, delay = 0, color, fit = Infinity } = {} ) {
		if ( this.noSplashes ) {
			// Drops and splashes off: the brush paints the same mark, a short
			// touch that stays within the room the drop had.
			// One short, deliberate touch, laid along the way the hand is going.
			const R = Math.max( 1, Math.min( r, fit ) );
			const from = this.animator && this.animator.lastEnd;
			const rot = from ? Math.atan2( y - from.y, x - from.x ) : 0;
			// Like the drop it replaces, it paints where it lands.
			this._brush( rng, op, x, y, R, k, { queue: true, keep: true, trust: true, passes: 1, aspect: 1, rot, water: extra.water }, delay );
			return;
		}
		const an = this.an;
		const fall = rng.range( 0.3, 0.42 );
		const start = this.now + delay + fall;
		// Drops are never clipped to the target shape: one tone, an organic
		// outline, sized by the caller to fit the room around the landing point.
		const blob = this._stamp( rng, op, x, y, r, k, { amp: 0.22, soft: 0.4, ...extra, follow: 0 } );
		blob.uniform = k >= 0;
		// The whole ragged outline, not just its nominal radius, must fit.
		if ( blob.r * blob.reach > fit ) {
			blob.r = Math.max( 1, fit / blob.reach );
			r = blob.r;
		}
		this._emit( blob, {
			tool: 'drop',
			mode: 'radial',
			start,
			fall,
			squash: 0.16,
			linger: 0.16,
			tilt: rng.range( 0, Math.PI ),
			dur: 0.45 + ( 5 * r ) / an.B,
			x,
			y,
			size: Math.max( 1.5, Math.min( r * 0.32, an.B * 0.02 ) ),
			color,
		} );
		const n = Math.round( ( crown + spray ) * this.complexity );
		if ( k < 0 || n <= 0 ) {
			return;
		}
		const dirBias = rng.range( 0, Math.PI * 2 );
		for ( let s = 0; s < n; s++ ) {
			const far = s >= crown * this.complexity;
			const ang = far ? dirBias + rng.normal() * 0.7 : rng.range( 0, Math.PI * 2 );
			const dist = r * ( far ? rng.range( 1.8, 4.5 ) : rng.range( 1.0, 1.9 ) );
			const sx = x + Math.cos( ang ) * dist;
			const sy = y + Math.sin( ang ) * dist;
			if ( sx < 0 || sy < 0 || sx >= an.W || sy >= an.H ) {
				continue;
			}
			const si = this._idx( sx, sy );
			const imp = an.importance[ si ];
			// Droplets stay inside the colour area they were thrown in; only
			// background spatter may wander, and never onto a border.
			const near = this.edgeNear( sx, sy, 2 );
			// Droplets only land where their colour belongs (no dark spatter
			// thrown onto a light neighbour), and never on a border.
			const sameArea = an.labels[ si ] === an.labels[ this._idx( x, y ) ];
			if ( near > 0.3 || ! this.belongs( k, sx, sy ) || ( ! sameArea && near > 0.15 ) ) {
				continue;
			}
			// A faint decorative tint only in quiet background areas of this colour.
			const spill = 0.06 * ( op.chaos ?? 1 ) * ( 1 - imp ) * ( 1 - imp );
			const sr = Math.max( 0.8, r * ( far ? rng.range( 0.05, 0.14 ) : rng.range( 0.08, 0.22 ) ) );
			const flight = ( 0.12 + ( 0.22 * dist ) / ( r * 4.5 ) ) * rng.range( 0.8, 1.2 );
			const sblob = this._stamp( rng, op, sx, sy, sr, k, {
				amp: 0.08,
				soft: 0.3,
				aspect: rng.range( 1, 1.35 ),
				water: 0.5,
				follow: 0,
				spill,
				minNeed: 0.02,
				capMul: 1.4,
			} );
			this._emit( sblob, {
				tool: 'particle',
				mode: 'radial',
				launch: start,
				start: start + flight,
				dur: 0.25,
				from: { x, y },
				x: sx,
				y: sy,
				size: Math.max( 0.6, sr * 0.6 ),
				arc: dist * 0.35,
			} );
		}
	}

	/**
	 * Where along a sweep's path the paper beside it is wet but not its
	 * colour's (the sky still wet next to a building), if anywhere. Wet is
	 * wet: even water whose pigment has settled lets new paint run into it.
	 */
	_wetBeside( op ) {
		const { W, H, h } = this.model;
		const pts = op.path;
		let since = Infinity;
		for ( let q = 0; q < pts.length; q += 3 ) {
			const r = pts[ q + 2 ] + 2;
			since += q ? Math.hypot( pts[ q ] - pts[ q - 3 ], pts[ q + 1 ] - pts[ q - 2 ] ) : 0;
			if ( since < Math.max( 1, r * 0.5 ) ) {
				continue;
			}
			since = 0;
			const cx = pts[ q ];
			const cy = pts[ q + 1 ];
			const st = Math.max( 1, Math.floor( r / 4 ) );
			for ( let y = Math.max( 0, Math.floor( cy - r ) ); y <= Math.min( H - 1, cy + r ); y += st ) {
				for ( let x = Math.max( 0, Math.floor( cx - r ) ); x <= Math.min( W - 1, cx + r ); x += st ) {
					if ( h[ y * W + x ] > WET_BESIDE && ! this.belongs( op.k, x, y ) ) {
						return { x, y, r };
					}
				}
			}
		}
		return null;
	}

	/**
	 * Executes an op by scheduling its gestures. Returns false when the op
	 * should be deferred (e.g. a dry-brush mark on a still-wet region).
	 */
	execute( op ) {
		const an = this.an;
		const rng = new Rng( op.seed );
		const model = this.model;
		const edge = an.edge[ this._idx( op.x, op.y ) ];
		const chaos = op.chaos ?? 1;
		// Controlled chaos: less wander on strong edges / silhouettes.
		const sigma = op.r * 0.3 * chaos * ( 1 - 0.85 * edge );
		const x = Math.min( an.W - 1, Math.max( 0, op.x + rng.normal() * sigma ) );
		const y = Math.min( an.H - 1, Math.max( 0, op.y + rng.normal() * sigma ) );
		let r = op.r * rng.range( 0.85, 1.18 );

		if ( op.requireDry && ! op.force && ! this.drying.isDryEnough( model, x, y, r ) ) {
			// Coming back to a wet spot: help that spot dry, then return.
			this.drying.helpDry( model, x, y, r );
			return false;
		}

		let k = op.k;
		const level = op.level ?? 1;
		// Planned (trusted) strokes keep their colour; others are re-checked.
		if ( k >= 0 && ! op.trust && ( model.need( k, level, this._idx( x, y ) ) < 0.01 || ! this.belongs( k, x, y ) ) ) {
			// The planned pigment is already satisfied here; pick the one that is not.
			k = this.autoPigment( x, y, level );
		} else if ( k < 0 && 'bloom' !== op.type && 'wetblend' !== op.type ) {
			// The plan's colour for this mark, if it still has work to do here.
			const pk = op.pk ?? -1;
			k = pk >= 0 && model.need( pk, level, this._idx( x, y ) ) > 0.015 && this.belongs( pk, x, y ) ? pk : this.autoPigment( x, y, level );
		}
		const B = an.B;

		switch ( op.type ) {
			case 'wash':
				if ( k < 0 ) {
					return true;
				}
				if ( op.fit ) {
					// Planned to fit its colour's area: a drop or a brush wash whose
					// whole natural footprint stays inside it.
					// Drops for open interiors; near borders the brush lays a cleaner edge.
					if ( op.drop || ( ! op.brushOnly && op.fit >= B * 0.035 && rng.float() < 0.5 ) ) {
						this._drop( rng, op, x, y, op.fit, k, {
							// A dab from the brush tip throws no droplets.
							crown: op.dab ? 0 : Math.round( 3 + ( op.fit / B ) * 90 ),
							spray: ! op.dab && op.drop && rng.float() < 0.5 ? rng.int( 8 ) : 0,
							extra: { amp: 0.15, soft: op.soft ?? 0.45, aspect: rng.range( 1, 1.12 ) },
							fit: op.fit,
						} );
					} else {
						this._brush( rng, op, x, y, op.fit, k, { fitR: op.fit } );
					}
					return true;
				}
				// Unplanned washes: a drop only where it fits, else the brush.
				const room = this.roomAt( x, y );
				if ( ! op.brushOnly && room >= r * 0.9 && ( 0 === op.stage || rng.float() < 0.45 ) ) {
					this._drop( rng, op, x, y, r, k, {
						crown: Math.round( 4 + ( Math.min( r, room / 2 ) / B ) * 110 ),
						spray: rng.float() < 0.5 ? rng.int( 10 ) : 0,
						extra: { amp: 0.2, soft: 0.45 },
						fit: room * 0.95,
					} );
				} else {
					this._brush( rng, op, x, y, r, k, { amp: 0.18, soft: 0.45, queue: !! op.brushOnly } );
				}
				return true;

			case 'sweep':
				// A wash with a hard edge waits until the paint of another colour
				// beside it is dry (a painter lets the sky dry before cutting the
				// buildings in against it), or the two bleed and every corner goes
				// soft. The first wash is wet-in-wet on purpose.
				if ( op.stage >= 1 && op.k >= 0 && ! op.force ) {
					const wet = this._wetBeside( op );
					if ( wet ) {
						this.drying.helpDry( model, wet.x, wet.y, wet.r );
						return false;
					}
				}
				// One row-by-row pass of an object's wash, carried top to bottom.
				this._brushAlong( rng, { ...op, trust: true, graded: true, shared: this._washMask( op.wash ) }, op.k );
				return true;

			case 'detail':
				if ( k < 0 ) {
					return true;
				}
				if ( op.path ) {
					this._brushAlong( rng, op, k );
					return true;
				}
				// Detail is brushwork drawn along the contour, like a hairline.
				this._brush( rng, op, x, y, r, k, {
					amp: 0.1,
					soft: 0.2,
					// Sized and oriented to the shape it paints (planner), else along the contour.
					aspect: op.aspect ?? rng.range( 1.8, 3 ),
					rot: op.rot ?? this._tangent( x, y ) + rng.normal() * 0.15,
					capMul: 1.05,
					passes: 1,
					slow: 1.1,
					queue: true,
				} );
				return true;

			case 'drop':
				if ( k < 0 ) {
					return true;
				}
				this._drop( rng, op, x, y, r, k, { extra: { amp: 0.05, soft: 0.25, aspect: rng.range( 1, 1.15 ) }, fit: Math.max( 1.5, this.roomAt( x, y ) ) } );
				return true;

			case 'wetblend': {
				// Wet the area with clear water, then charge two pigments into it.
				const wetting = this._brush( rng, op, x, y, r * 1.25, -1, { amp: 0.15, soft: 0.5, water: 0.8, follow: 0 } );
				const a = rng.range( 0, Math.PI * 2 );
				const off = r * 0.35;
				const k1 = op.k >= 0 ? op.k : this.autoPigment( x, y, level );
				const k2 = op.k2 >= 0 ? op.k2 : -1;
				// Charge the pigments into the wet area as the brush finishes.
				const later = wetting ? wetting.start - this.now + wetting.dur * 0.85 : 0;
				if ( k1 >= 0 ) {
					this._drop( rng, op, x + Math.cos( a ) * off, y + Math.sin( a ) * off, r * 0.8, k1, { delay: later, extra: { soft: 0.6, water: 0.3 } } );
				}
				if ( k2 >= 0 ) {
					this._drop( rng, op, x - Math.cos( a ) * off, y - Math.sin( a ) * off, r * 0.8, k2, { delay: later * 1.4, extra: { soft: 0.6, water: 0.3 } } );
				}
				return true;
			}

			case 'bloom':
				// A backrun on a border leaves a pale ring: blooms stay inside areas.
				if ( this.drying.isDamp( model, x, y, r ) && this.edgeNear( x, y, r * 1.3 ) < 0.2 ) {
					this._drop( rng, op, x, y, r, -1, { extra: { amp: 0.3, soft: 0.3, water: op.water, follow: 0 }, color: 'rgba(170,205,235,0.75)' } );
				}
				return true;

			case 'splash': {
				if ( k < 0 ) {
					return true;
				}
				const imp = an.importance[ this._idx( x, y ) ];
				this._drop( rng, op, x, y, r * 1.6, k, {
					crown: 10 + rng.int( 14 ),
					spray: Math.round( op.satellites * 1.6 ),
					extra: { amp: 0.28, soft: 0.25, spill: 0.04 * ( 1 - imp ) },
				} );
				return true;
			}

			case 'lift': {
				// A clean damp brush blots the spot; pigment comes off as it finishes.
				// `wet`: how damp the brush is (1 = usual; Endless lifts barely damp).
				// With a `path` (x, y, r per point) it is drawn along a line instead
				// (a thirsty brush lifting a strand or a highlight out of dark paint).
				// `scrub`: worked over an overworked patch, evening the paint out
				// instead of taking it up (see PigmentModel.scrub).
				const lift = { x, y, r, path: op.path, strength: op.strength ?? 0.5, wet: op.wet ?? 1, scrub: !! op.scrub, seed: rng.u32() };
				if ( ! this.animator ) {
					model.lift( lift );
					return true;
				}
				const anim = this.animator;
				if ( op.path ) {
					return this._liftAlong( rng, op, lift );
				}
				// A tiny spot is a quick dab; a big blot takes its time.
				const u = Math.min( 1, r / ( this.an.B * 0.02 ) );
				// Cinematic: the brush is seen coming down onto the paper and lifting off.
				const approach = anim && anim.cinematic ? CINE_APPROACH : 0.1 + 0.12 * u;
				const start = anim.nextBrush( this.now, approach, -1, x, y );
				const dur = 0.25 + 0.45 * u;
				anim.brushFreeAt = start + dur + approach;
				const dir = rng.range( 0, Math.PI * 2 );
				anim.add( {
					tool: 'brush',
					mode: 'none',
					start,
					dur,
					approach,
					linger: approach,
					x,
					y,
					R: r * 0.6,
					passes: 2,
					tip: Math.max( 0.8, r * 0.35 ),
					dx: Math.cos( dir ),
					dy: Math.sin( dir ),
					color: '#c9c0ae',
					lift,
				} );
				return true;
			}
		}
		return true;
	}
}
