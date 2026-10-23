/**
 * Bristles — a round watercolor brush as a bundle of simulated hairs.
 *
 * Each hair is a short chain of points in 3D (x, y on the paper, z up),
 * rooted in the ferrule. Every step the hairs:
 *  - move on by their own momentum (Verlet), so they lag, flick and settle;
 *  - spring back toward the brush's natural shape (a belly drawn to a
 *    point), stiff at the root and supple toward the tip;
 *  - cling together while wet, so a loaded brush keeps its point, and part
 *    into tufts as it dries;
 *  - keep their length;
 *  - cannot go through the paper: where they touch it, friction holds them
 *    back (they trail behind the stroke) and, pressed down, they are pushed
 *    out sideways (the bundle fans out).
 * The hand only places and tilts the ferrule; everything else follows.
 */

import { mulberry32 } from './prng.js';

const SEGS = 7;

const cross = ( a, b ) => ( { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x } );
const norm = ( a ) => {
	const l = Math.hypot( a.x, a.y, a.z ) || 1;
	return { x: a.x / l, y: a.y / l, z: a.z / l };
};

export class Bristles {
	constructor( count = 36, seed = 11 ) {
		const rnd = mulberry32( seed );
		// Each hair: its place in the ferrule (angle, how far out), length
		// and a little irregularity; the tuft it joins when dry.
		this.hairs = Array.from( { length: count }, ( _, i ) => {
			const phi = ( i / count ) * Math.PI * 2 + ( rnd() - 0.5 ) * 0.3;
			return {
				phi,
				rho: Math.sqrt( 0.15 + 0.85 * rnd() ),
				len: 0.86 + 0.14 * rnd(),
				tuft: Math.floor( ( ( phi / ( Math.PI * 2 ) ) * 6 + 6 ) % 6 ),
				n: rnd() * 2 - 1,
			};
		} );
		const P = count * ( SEGS + 1 ) * 3;
		this.pos = new Float32Array( P );
		this.prev = new Float32Array( P );
		this.rest = new Float32Array( P );
		this.ready = false;
		this.contact = { n: 0, x: 0, y: 0, width: 0 };
	}

	/**
	 * The ferrule's frame: mouth F, unit axis `down` along the hairs (toward
	 * the tip); `hairL` hair length, `fw` half-width at the ferrule, `belly`
	 * extra swell. Returns the rest shape for that frame.
	 */
	_restShape( f ) {
		const a = f.down;
		const up = Math.abs( a.z ) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
		const u = norm( cross( a, up ) );
		const v = norm( cross( a, u ) );
		this.u = u;
		this.v = v;
		const R = this.rest;
		const S = SEGS;
		this.hairs.forEach( ( hr, i ) => {
			const cx = Math.cos( hr.phi );
			const cy = Math.sin( hr.phi );
			const dx = u.x * cx + v.x * cy;
			const dy = u.y * cx + v.y * cy;
			const dz = u.z * cx + v.z * cy;
			hr.dir = { x: dx, y: dy, z: dz };
			for ( let j = 0; j <= S; j++ ) {
				const s = ( j / S ) * hr.len;
				const w = f.fw * ( 1 - s ) + f.belly * Math.sin( Math.PI * s ) * ( 1 - 0.35 * s );
				const r = hr.rho * w;
				const o = ( i * ( S + 1 ) + j ) * 3;
				R[ o ] = f.F.x + a.x * s * f.hairL + dx * r;
				R[ o + 1 ] = f.F.y + a.y * s * f.hairL + dy * r;
				R[ o + 2 ] = f.F.z + a.z * s * f.hairL + dz * r;
			}
		} );
	}

	/**
	 * Advance the hairs by dt seconds with the ferrule placed by `f`:
	 * { F, down, hairL, fw, belly, wet (0–1), dry (0–1) }.
	 */
	step( dt, f ) {
		this._restShape( f );
		const R = this.rest;
		const p = this.pos;
		const q = this.prev;
		const S = SEGS;
		const H = this.hairs.length;
		// A first frame, or a jump: start from the natural shape.
		if ( ! this.ready || Math.hypot( f.F.x - this.lastF.x, f.F.y - this.lastF.y, f.F.z - this.lastF.z ) > f.hairL * 3 ) {
			p.set( R );
			q.set( R );
			this.ready = true;
		}
		this.lastF = { ...f.F };
		const segL = f.hairL / S;
		const steps = Math.max( 1, Math.min( 24, Math.ceil( dt * 240 ) ) );
		const h = dt / steps;
		const rate = h * 120;
		// Momentum kept per step: the same damping whatever the frame rate.
		const keep = Math.exp( -h * 9 );
		const mean = new Float32Array( ( S + 1 ) * 3 );
		for ( let it = 0; it < steps; it++ ) {
			// Roots go with the ferrule; the rest move on and spring back.
			for ( let i = 0; i < H; i++ ) {
				for ( let j = 0; j <= S; j++ ) {
					const o = ( i * ( S + 1 ) + j ) * 3;
					if ( 0 === j ) {
						for ( let c = 0; c < 3; c++ ) {
							q[ o + c ] = p[ o + c ] = R[ o + c ];
						}
						continue;
					}
					const s = j / S;
					// Stiffness falls off evenly toward the tip, so a pressed hair bends
					// in one smooth curve rather than kinking.
					const k = 1 - Math.pow( 1 - ( 0.3 * ( 1 - s ) + 0.06 ), rate );
					for ( let c = 0; c < 3; c++ ) {
						const v = ( p[ o + c ] - q[ o + c ] ) * keep;
						q[ o + c ] = p[ o + c ];
						p[ o + c ] += v + ( R[ o + c ] - p[ o + c ] - v ) * k;
					}
				}
			}
			// Wet hairs cling together toward the bundle's middle; a dry brush
			// parts into tufts.
			mean.fill( 0 );
			for ( let i = 0; i < H; i++ ) {
				for ( let j = 0; j <= S; j++ ) {
					const o = ( i * ( S + 1 ) + j ) * 3;
					mean[ j * 3 ] += p[ o ] / H;
					mean[ j * 3 + 1 ] += p[ o + 1 ] / H;
					mean[ j * 3 + 2 ] += p[ o + 2 ] / H;
				}
			}
			const coh = 1 - Math.pow( 1 - 0.06 * f.wet, rate );
			for ( let i = 0; i < H; i++ ) {
				const hr = this.hairs[ i ];
				const tuftOff = ( hr.tuft / 6 ) * Math.PI * 2;
				for ( let j = 1; j <= S; j++ ) {
					const o = ( i * ( S + 1 ) + j ) * 3;
					const s = j / S;
					p[ o ] += ( mean[ j * 3 ] - p[ o ] ) * coh * s;
					p[ o + 1 ] += ( mean[ j * 3 + 1 ] - p[ o + 1 ] ) * coh * s;
					p[ o + 2 ] += ( mean[ j * 3 + 2 ] - p[ o + 2 ] ) * coh * s;
					if ( f.dry > 0 ) {
						const push = f.dry * 0.02 * f.fw * s * s * rate;
						p[ o ] += Math.cos( tuftOff ) * push * ( this.u.x ) + Math.sin( tuftOff ) * push * this.v.x;
						p[ o + 1 ] += Math.cos( tuftOff ) * push * ( this.u.y ) + Math.sin( tuftOff ) * push * this.v.y;
					}
				}
			}
			// Hairs keep their length (twice through, root to tip).
			for ( let pass = 0; pass < 2; pass++ ) {
				for ( let i = 0; i < H; i++ ) {
					const L = segL * this.hairs[ i ].len;
					for ( let j = 1; j <= S; j++ ) {
						const a = ( i * ( S + 1 ) + j - 1 ) * 3;
						const b = a + 3;
						const dx = p[ b ] - p[ a ];
						const dy = p[ b + 1 ] - p[ a + 1 ];
						const dz = p[ b + 2 ] - p[ a + 2 ];
						const d = Math.hypot( dx, dy, dz ) || 1e-6;
						const m = ( d - L ) / d;
						// The point nearer the root holds firmer.
						const wa = 1 === j ? 0 : 0.3;
						p[ a ] += dx * m * wa;
						p[ a + 1 ] += dy * m * wa;
						p[ a + 2 ] += dz * m * wa;
						p[ b ] -= dx * m * ( 1 - wa );
						p[ b + 1 ] -= dy * m * ( 1 - wa );
						p[ b + 2 ] -= dz * m * ( 1 - wa );
					}
				}
			}
			// The paper: nothing goes through it. Touching hairs are held back by
			// friction, and pressed ones are pushed out sideways.
			for ( let i = 0; i < H; i++ ) {
				const dir = this.hairs[ i ].dir;
				const dl = Math.hypot( dir.x, dir.y ) || 1;
				for ( let j = 1; j <= S; j++ ) {
					const o = ( i * ( S + 1 ) + j ) * 3;
					if ( p[ o + 2 ] >= 0 ) {
						continue;
					}
					const depth = -p[ o + 2 ];
					p[ o + 2 ] = 0;
					const mu = 0.55;
					p[ o ] = q[ o ] + ( p[ o ] - q[ o ] ) * ( 1 - mu );
					p[ o + 1 ] = q[ o + 1 ] + ( p[ o + 1 ] - q[ o + 1 ] ) * ( 1 - mu );
					const fan = Math.min( depth, f.hairL * 0.2 ) * 0.35;
					p[ o ] += ( dir.x / dl ) * fan;
					p[ o + 1 ] += ( dir.y / dl ) * fan;
				}
			}
		}
		// Where the bundle touches the paper (for the hand to steer by),
		// weighted toward the tip, which is where the paint goes down.
		let n = 0;
		let sw = 0;
		let sx = 0;
		let sy = 0;
		for ( let i = 0; i < H; i++ ) {
			for ( let j = 1; j <= S; j++ ) {
				const o = ( i * ( S + 1 ) + j ) * 3;
				if ( p[ o + 2 ] < 0.5 ) {
					const w = ( j / S ) * ( j / S );
					sx += p[ o ] * w;
					sy += p[ o + 1 ] * w;
					sw += w;
					n++;
				}
			}
		}
		const c = this.contact;
		c.n = n;
		if ( n ) {
			c.x = sx / sw;
			c.y = sy / sw;
			// Half-width across the direction of travel.
			const mx = -f.dirY;
			const my = f.dirX;
			let lo = Infinity;
			let hi = -Infinity;
			for ( let i = 0; i < H; i++ ) {
				for ( let j = 1; j <= S; j++ ) {
					const o = ( i * ( S + 1 ) + j ) * 3;
					if ( p[ o + 2 ] < 0.5 ) {
						const e = ( p[ o ] - c.x ) * mx + ( p[ o + 1 ] - c.y ) * my;
						lo = Math.min( lo, e );
						hi = Math.max( hi, e );
					}
				}
			}
			c.width = ( hi - lo ) / 2;
		} else {
			c.width = 0;
		}
	}

	/** Point j of hair i: [x, y, z]. */
	at( i, j ) {
		const o = ( i * ( SEGS + 1 ) + j ) * 3;
		return [ this.pos[ o ], this.pos[ o + 1 ], this.pos[ o + 2 ] ];
	}

	get segs() {
		return SEGS;
	}
}

