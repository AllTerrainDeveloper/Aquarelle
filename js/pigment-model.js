/**
 * PigmentModel — Phase E (hybrid grid simulation, CPU, typed arrays).
 *
 * A simplified take on Curtis et al. 1997 ("Computer-Generated Watercolor"):
 *  - water height h per cell; water spreads between wet cells and only
 *    advances into dry paper when its head exceeds the paper's local
 *    capacity (fibre noise) -> irregular, organic wash boundaries
 *  - suspended pigment g_k moves with the water flux (upwind advection)
 *    and diffuses between wet cells (wet-in-wet blending)
 *  - evaporation is stronger at wash edges, which drives an outward flow
 *    that carries pigment to the rim -> darkened edges / coffee rings
 *  - suspended pigment is adsorbed onto the paper (deposited d_k), faster
 *    in paper valleys -> granulation; everything left settles when dry
 *  - very wet cells re-lift a little deposited pigment -> backruns/blooms
 *
 * Only 16x16 tiles that are wet (plus a one-tile ring) are simulated; dry
 * tiles are a stable layer that is never recomputed.
 *
 * Colour: Beer–Lambert glazing. Each pigment k has an absorbance A_k (RGB);
 * optical density D = Σ (d_k + g_k) A_k and colour = paper * exp(-D).
 * Pigments therefore mix subtractively (yellow over blue reads green).
 */

import { valueNoise } from './noise.js';

const EPS = 1e-4;
const WET = 0.012;
const DRY = 0.004;
const TS = 16;

export class PigmentModel {
	constructor( { W, H, pigments, T, paper } ) {
		this.W = W;
		this.H = H;
		const N = ( this.N = W * H );
		this.K = pigments.length;
		this.pigments = pigments;
		this.A = new Float32Array( this.K * 3 );
		this.normA = new Float32Array( this.K );
		pigments.forEach( ( p, k ) => {
			this.A.set( p.A, k * 3 );
			this.normA[ k ] = Math.hypot( p.A[ 0 ], p.A[ 1 ], p.A[ 2 ] );
		} );
		this.T = T;
		this.paper = paper;
		this.cap = new Float32Array( N );
		for ( let i = 0; i < N; i++ ) {
			this.cap[ i ] = 0.4 + 0.5 * paper[ i ];
		}
		this.h = new Float32Array( N );
		this.g = [];
		this.d = [];
		for ( let k = 0; k < this.K; k++ ) {
			this.g.push( new Float32Array( N ) );
			this.d.push( new Float32Array( N ) );
		}
		this.fx = new Float32Array( N );
		this.fy = new Float32Array( N );
		this.tmp = new Float32Array( N );
		this.comp = new Float32Array( N * 4 );
		this.TX = Math.ceil( W / TS );
		this.TY = Math.ceil( H / TS );
		const NT = ( this.NT = this.TX * this.TY );
		this.tileWet = new Uint8Array( NT );
		this.tilePig = new Uint32Array( NT );
		this.tileComp = new Uint8Array( NT );
		this.tileTouch = new Float32Array( NT ).fill( -1e9 );
		this.list = new Int32Array( NT );
		this.mark = new Uint8Array( NT );
		this.proc = new Uint32Array( NT );
		this.params = {
			flow: 2.6, // water flux coefficient (1/s)
			dryGate: 0.35, // fraction of flux that can invade dry paper
			diffuse: 0.9, // pigment diffusion between wet cells (1/s)
			evap: 0.055, // evaporation (h/s)
			edge: 3.4, // extra evaporation at wash rims
			adsorb: 0.05, // suspended -> deposited (1/s)
			granulation: 0.45,
			lift: 0.03, // deposited -> suspended in very wet cells (1/s)
		};
		this.time = 0;
		this.wetCells = 0;
		this.activeTiles = 0;
		this.dirtyY0 = H;
		this.dirtyY1 = -1;
	}

	reset() {
		this.h.fill( 0 );
		for ( let k = 0; k < this.K; k++ ) {
			this.g[ k ].fill( 0 );
			this.d[ k ].fill( 0 );
		}
		this.comp.fill( 0 );
		this.tileWet.fill( 0 );
		this.tilePig.fill( 0 );
		this.tileComp.fill( 1 );
		this.tileTouch.fill( -1e9 );
		this.time = 0;
		this.wetCells = 0;
		this.activeTiles = 0;
	}

	tileOf( x, y ) {
		return ( ( y / TS ) | 0 ) * this.TX + ( ( x / TS ) | 0 );
	}

	/** Remaining need of pigment k at cell i for a target level. */
	need( k, level, i ) {
		return this.T[ level ][ k ][ i ] - this.d[ k ][ i ] - this.g[ k ][ i ];
	}

	/* ------------------------------------------------------------------ */
	/* Brush stamps                                                         */
	/* ------------------------------------------------------------------ */

	_geom( b ) {
		if ( b.geom ) {
			return b.geom;
		}
		const { W, H } = this;
		const R = b.r * b.reach + 2;
		const g = {
			x0: Math.max( 0, Math.floor( b.x - R ) ),
			x1: Math.min( W - 1, Math.ceil( b.x + R ) ),
			y0: Math.max( 0, Math.floor( b.y - R ) ),
			y1: Math.min( H - 1, Math.ceil( b.y + R ) ),
			R,
			s: 0,
		};
		const cos = Math.cos( b.rot );
		const sin = Math.sin( b.rot );
		const invAsp = 1 / b.aspect;
		const prof = b.profile;
		const PN = prof.length - 1;
		const softInv = 1 / Math.max( 0.02, b.soft );
		// Mask in [0,1]; also leaves the normalised radius in g.s for radial reveals.
		g.mask = ( x, y ) => {
			const dx = x - b.x;
			const dy = y - b.y;
			const u = ( dx * cos + dy * sin ) * invAsp;
			const v = -dx * sin + dy * cos;
			const dist = Math.sqrt( u * u + v * v );
			const th = ( Math.atan2( v, u ) / ( 2 * Math.PI ) + 0.5 ) * PN;
			const ti = th | 0;
			const rp = b.r * ( prof[ ti ] + ( prof[ ti + 1 ] - prof[ ti ] ) * ( th - ti ) );
			g.s = dist / rp;
			const m = ( ( rp - dist ) / rp ) * softInv;
			return m <= 0 ? 0 : m >= 1 ? 1 : m;
		};
		b.geom = g;
		return g;
	}

	/**
	 * Measures the remaining need under the blob. Returns false when the
	 * region already resembles the target, so the gesture is skipped.
	 */
	prepare( b ) {
		if ( b.k < 0 ) {
			b.meanNeed = 0;
			return true;
		}
		const { W } = this;
		const g = this._geom( b );
		if ( g.x0 > g.x1 || g.y0 > g.y1 ) {
			return false;
		}
		const Tk = this.T[ b.level ][ b.k ];
		const gk = this.g[ b.k ];
		const dk = this.d[ b.k ];
		let sumM = 0;
		let sumN = 0;
		for ( let y = g.y0; y <= g.y1; y++ ) {
			for ( let x = g.x0; x <= g.x1; x++ ) {
				const m = g.mask( x, y );
				if ( m <= 0 ) {
					continue;
				}
				const i = y * W + x;
				const nd = Tk[ i ] - dk[ i ] - gk[ i ];
				if ( nd > 0 ) {
					sumN += m * nd;
				}
				sumM += m;
			}
		}
		b.meanNeed = sumM > 0 ? sumN / sumM : 0;
		return ! ( b.meanNeed < b.minNeed && b.spill <= 0 );
	}

	/**
	 * Applies an irregular blob of water and (optionally) pigment.
	 * Pigment amount is driven by the remaining need of the target map so a
	 * wash paints where the subject needs it; its shape is the polar profile
	 * of the blob, optionally clipped to where the need is (follow).
	 *
	 * Gestures lay the blob down progressively: only cells whose reveal
	 * coordinate falls in [s0, s1) are painted — radial distance for drops
	 * blooming outward, position along the stroke for brush sweeps.
	 *
	 * @return {number} pigment mass deposited (or water for k < 0).
	 */
	deposit( b, s0 = 0, s1 = 2, mode = 'none' ) {
		if ( undefined === b.meanNeed && ! this.prepare( b ) ) {
			return 0;
		}
		const { W } = this;
		const g = this._geom( b );
		if ( g.x0 > g.x1 || g.y0 > g.y1 ) {
			return 0;
		}
		const k = b.k;
		const h = this.h;
		const meanNeed = b.meanNeed;
		const Tk = k >= 0 ? this.T[ b.level ][ k ] : null;
		const gk = k >= 0 ? this.g[ k ] : null;
		const dk = k >= 0 ? this.d[ k ] : null;
		const sweep = 'sweep' === mode;
		const radial = 'radial' === mode;
		const sdx = b.dx ?? 1;
		const sdy = b.dy ?? 0;
		const invR = 1 / ( b.r * b.reach * 0.85 );
		const passes = b.passes || 1;
		let total = 0;
		const bit = k >= 0 ? 1 << k : 0;
		const seed = b.seed | 0;
		let ty0 = g.y1;
		let ty1 = g.y0;
		let tx0 = g.x1;
		let tx1 = g.x0;
		// A blooming drop only reaches radius s1 so far: scan just that.
		let { x0, x1, y0, y1 } = g;
		if ( radial && s1 < 1.2 ) {
			const rr = ( s1 + 0.1 ) * b.r * b.reach + 1.5;
			x0 = Math.max( x0, Math.floor( b.x - rr ) );
			x1 = Math.min( x1, Math.ceil( b.x + rr ) );
			y0 = Math.max( y0, Math.floor( b.y - rr ) );
			y1 = Math.min( y1, Math.ceil( b.y + rr ) );
		}
		for ( let y = y0; y <= y1; y++ ) {
			for ( let x = x0; x <= x1; x++ ) {
				const m = g.mask( x, y );
				if ( m <= 0 ) {
					continue;
				}
				const n = valueNoise( x * 0.09, y * 0.09, seed );
				if ( radial || sweep ) {
					// Ragged reveal front so the paint creeps rather than wipes.
					let s;
					if ( radial ) {
						s = g.s + ( n - 0.5 ) * 0.18;
					} else {
						// Back-and-forth passes: band across the stroke, alternating direction.
						// Each pass runs along a chord of the blob, like the brush path drawn on top.
						const across = Math.min( 0.9999, Math.max( 0, ( ( -( x - b.x ) * sdy + ( y - b.y ) * sdx ) * invR + 1 ) * 0.5 ) );
						const band = Math.floor( across * passes );
						const c = ( ( band + 0.5 ) / passes ) * 2 - 1;
						const half = Math.max( 0.25, Math.sqrt( 1 - c * c ) );
						const a = ( ( x - b.x ) * sdx + ( y - b.y ) * sdy ) * invR;
						const along = Math.min( 0.9999, Math.max( 0, ( a / half + 1 ) * 0.5 ) );
						const u = band & 1 ? 1 - along : along;
						s = ( band + u ) / passes + ( n - 0.5 ) * 0.05;
					}
					if ( s < s0 || s >= s1 ) {
						continue;
					}
				}
				const i = y * W + x;
				let mm = m;
				if ( k >= 0 ) {
					const nd = Math.max( 0, Tk[ i ] - dk[ i ] - gk[ i ] );
					if ( b.follow > 0 ) {
						const ratio = nd / ( meanNeed + 1e-4 ) - 0.25 + ( n - 0.5 ) * 0.3;
						let cov = ratio / 0.35;
						cov = cov <= 0 ? 0 : cov >= 1 ? 1 : cov * cov * ( 3 - 2 * cov );
						mm = m * ( 1 - b.follow + b.follow * cov );
					}
					let pig = b.amount * ( nd + ( meanNeed - nd ) * b.flat ) * ( 0.92 + 0.16 * n );
					pig = Math.min( pig, nd * b.capMul + b.spill );
					pig = Math.max( pig, b.spill * m );
					const add = pig * mm;
					if ( add > 0 ) {
						gk[ i ] += add;
						total += add;
					}
				} else {
					total += b.water * mm;
				}
				if ( b.water > 0 && mm > 0 ) {
					const hv = h[ i ] + b.water * mm * ( 0.75 + 0.5 * n );
					h[ i ] = hv > 1.6 ? 1.6 : hv;
				}
				if ( x < tx0 ) {
					tx0 = x;
				}
				if ( x > tx1 ) {
					tx1 = x;
				}
				if ( y < ty0 ) {
					ty0 = y;
				}
				if ( y > ty1 ) {
					ty1 = y;
				}
			}
		}
		if ( tx1 >= tx0 ) {
			this._touch( tx0, ty0, tx1, ty1, bit, b.water > 0 );
		}
		return total;
	}

	/** Sponge lift: removes pigment (correcting regions that went too dark). */
	lift( b ) {
		const { W, H } = this;
		const R = b.r + 2;
		const x0 = Math.max( 0, Math.floor( b.x - R ) );
		const x1 = Math.min( W - 1, Math.ceil( b.x + R ) );
		const y0 = Math.max( 0, Math.floor( b.y - R ) );
		const y1 = Math.min( H - 1, Math.ceil( b.y + R ) );
		let bits = 0;
		let removed = 0;
		for ( let y = y0; y <= y1; y++ ) {
			for ( let x = x0; x <= x1; x++ ) {
				const dx = x - b.x;
				const dy = y - b.y;
				const dist = Math.sqrt( dx * dx + dy * dy ) / b.r;
				if ( dist >= 1 ) {
					continue;
				}
				const m = Math.min( 1, ( 1 - dist ) * 2.5 ) * ( 0.8 + 0.4 * valueNoise( x * 0.3, y * 0.3, b.seed | 0 ) );
				const f = Math.min( 0.9, b.strength * m );
				const i = y * W + x;
				for ( let k = 0; k < this.K; k++ ) {
					const ov = this.d[ k ][ i ] + this.g[ k ][ i ] - this.T[ 0 ][ k ][ i ];
					if ( ov <= 0 ) {
						continue;
					}
					// Only lift the excess over the target, never below it.
					const take = ov * f;
					const fromG = Math.min( this.g[ k ][ i ], take );
					this.g[ k ][ i ] -= fromG;
					this.d[ k ][ i ] -= take - fromG;
					removed += take;
					if ( this.g[ k ][ i ] > 0 ) {
						bits |= 1 << k;
					}
				}
				this.h[ i ] = Math.min( 1.6, this.h[ i ] + 0.12 * m );
			}
		}
		this._touch( x0, y0, x1, y1, bits, true );
		return removed;
	}

	_touch( x0, y0, x1, y1, bits, wet ) {
		const tx0 = ( x0 / TS ) | 0;
		const tx1 = ( x1 / TS ) | 0;
		const ty0 = ( y0 / TS ) | 0;
		const ty1 = ( y1 / TS ) | 0;
		for ( let ty = ty0; ty <= ty1; ty++ ) {
			for ( let tx = tx0; tx <= tx1; tx++ ) {
				const t = ty * this.TX + tx;
				this.tilePig[ t ] |= bits;
				this.tileComp[ t ] = 1;
				if ( wet || bits ) {
					this.tileWet[ t ] = 1;
				}
				this.tileTouch[ t ] = this.time;
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Simulation step                                                      */
	/* ------------------------------------------------------------------ */

	step( dt, evapScale = 1 ) {
		const { W, H, TX, TY, h, fx, fy, tmp, cap, paper, list, mark, proc, tileWet, tilePig } = this;
		const P = this.params;
		this.time += dt;

		// Wet tiles plus a one-tile ring.
		let n = 0;
		mark.fill( 0 );
		for ( let t = 0; t < this.NT; t++ ) {
			if ( ! tileWet[ t ] ) {
				continue;
			}
			const tx = t % TX;
			const ty = ( t / TX ) | 0;
			for ( let dy = -1; dy <= 1; dy++ ) {
				const yy = ty + dy;
				if ( yy < 0 || yy >= TY ) {
					continue;
				}
				for ( let dx = -1; dx <= 1; dx++ ) {
					const xx = tx + dx;
					if ( xx < 0 || xx >= TX ) {
						continue;
					}
					const u = yy * TX + xx;
					if ( ! mark[ u ] ) {
						mark[ u ] = 1;
						list[ n++ ] = u;
					}
				}
			}
		}
		this.activeTiles = n;
		if ( 0 === n ) {
			this.wetCells = 0;
			return;
		}
		let union = 0;
		for ( let li = 0; li < n; li++ ) {
			const t = list[ li ];
			const tx = t % TX;
			const ty = ( t / TX ) | 0;
			let m = 0;
			for ( let dy = -1; dy <= 1; dy++ ) {
				const yy = ty + dy;
				if ( yy < 0 || yy >= TY ) {
					continue;
				}
				for ( let dx = -1; dx <= 1; dx++ ) {
					const xx = tx + dx;
					if ( xx >= 0 && xx < TX ) {
						m |= tilePig[ yy * TX + xx ];
					}
				}
			}
			proc[ t ] = m;
			union |= m;
		}

		const kf = Math.min( 0.18, P.flow * dt );
		const kd = Math.min( 0.06, P.diffuse * dt );
		const gate = P.dryGate;

		// 1. Water fluxes across right and bottom faces.
		for ( let li = 0; li < n; li++ ) {
			const t = list[ li ];
			const xs = ( t % TX ) * TS;
			const ys = ( ( t / TX ) | 0 ) * TS;
			const xe = Math.min( W, xs + TS );
			const ye = Math.min( H, ys + TS );
			for ( let y = ys; y < ye; y++ ) {
				const row = y * W;
				for ( let x = xs; x < xe; x++ ) {
					const i = row + x;
					const hi = h[ i ];
					let f = 0;
					if ( x < W - 1 ) {
						const j = i + 1;
						const hj = h[ j ];
						if ( hi > EPS || hj > EPS ) {
							const diff = hi - hj;
							if ( diff > 0 ) {
								if ( hj > WET ) {
									f = kf * diff;
								} else if ( hi > cap[ j ] ) {
									f = kf * gate * ( hi - cap[ j ] );
								}
							} else if ( diff < 0 ) {
								if ( hi > WET ) {
									f = kf * diff;
								} else if ( hj > cap[ i ] ) {
									f = -kf * gate * ( hj - cap[ i ] );
								}
							}
						}
					}
					fx[ i ] = f;
					f = 0;
					if ( y < H - 1 ) {
						const j = i + W;
						const hj = h[ j ];
						if ( hi > EPS || hj > EPS ) {
							const diff = hi - hj;
							if ( diff > 0 ) {
								if ( hj > WET ) {
									f = kf * diff;
								} else if ( hi > cap[ j ] ) {
									f = kf * gate * ( hi - cap[ j ] );
								}
							} else if ( diff < 0 ) {
								if ( hi > WET ) {
									f = kf * diff;
								} else if ( hj > cap[ i ] ) {
									f = -kf * gate * ( hj - cap[ i ] );
								}
							}
						}
					}
					fy[ i ] = f;
				}
			}
		}

		// 2. Pigment transport: advection with the water + wet diffusion.
		for ( let k = 0; k < this.K; k++ ) {
			const bit = 1 << k;
			if ( ! ( union & bit ) ) {
				continue;
			}
			const gk = this.g[ k ];
			for ( let li = 0; li < n; li++ ) {
				const t = list[ li ];
				if ( ! ( proc[ t ] & bit ) ) {
					continue;
				}
				const xs = ( t % TX ) * TS;
				const ys = ( ( t / TX ) | 0 ) * TS;
				const xe = Math.min( W, xs + TS );
				const ye = Math.min( H, ys + TS );
				for ( let y = ys; y < ye; y++ ) {
					const row = y * W;
					for ( let x = xs; x < xe; x++ ) {
						const i = row + x;
						const gi = gk[ i ];
						const hi = h[ i ];
						const ci = hi > EPS ? gi / hi : 0;
						if ( x < W - 1 ) {
							const j = i + 1;
							const gj = gk[ j ];
							if ( gi > 0 || gj > 0 ) {
								const hj = h[ j ];
								const cj = hj > EPS ? gj / hj : 0;
								const f = fx[ i ];
								let tr = f > 0 ? f * ci : f * cj;
								if ( hi > WET && hj > WET ) {
									tr += kd * ( ci - cj ) * ( hi < hj ? hi : hj );
								}
								if ( 0 !== tr ) {
									tmp[ i ] -= tr;
									tmp[ j ] += tr;
								}
							}
						}
						if ( y < H - 1 ) {
							const j = i + W;
							const gj = gk[ j ];
							if ( gi > 0 || gj > 0 ) {
								const hj = h[ j ];
								const cj = hj > EPS ? gj / hj : 0;
								const f = fy[ i ];
								let tr = f > 0 ? f * ci : f * cj;
								if ( hi > WET && hj > WET ) {
									tr += kd * ( ci - cj ) * ( hi < hj ? hi : hj );
								}
								if ( 0 !== tr ) {
									tmp[ i ] -= tr;
									tmp[ j ] += tr;
								}
							}
						}
					}
				}
			}
			for ( let li = 0; li < n; li++ ) {
				const t = list[ li ];
				if ( ! ( proc[ t ] & bit ) ) {
					continue;
				}
				const xs = ( t % TX ) * TS;
				const ys = ( ( t / TX ) | 0 ) * TS;
				const xe = Math.min( W, xs + TS );
				const ye = Math.min( H, ys + TS );
				for ( let y = ys; y < ye; y++ ) {
					const row = y * W;
					for ( let x = xs; x < xe; x++ ) {
						const i = row + x;
						const v = tmp[ i ];
						if ( 0 !== v ) {
							const gv = gk[ i ] + v;
							gk[ i ] = gv > 0 ? gv : 0;
							tmp[ i ] = 0;
						}
					}
				}
			}
		}

		// 3. Apply water fluxes, then clear them.
		for ( let li = 0; li < n; li++ ) {
			const t = list[ li ];
			const xs = ( t % TX ) * TS;
			const ys = ( ( t / TX ) | 0 ) * TS;
			const xe = Math.min( W, xs + TS );
			const ye = Math.min( H, ys + TS );
			for ( let y = ys; y < ye; y++ ) {
				const row = y * W;
				for ( let x = xs; x < xe; x++ ) {
					const i = row + x;
					let dh = -fx[ i ] - fy[ i ];
					if ( x > 0 ) {
						dh += fx[ i - 1 ];
					}
					if ( y > 0 ) {
						dh += fy[ i - W ];
					}
					if ( 0 !== dh ) {
						const v = h[ i ] + dh;
						h[ i ] = v > 0 ? v : 0;
					}
				}
			}
		}
		for ( let li = 0; li < n; li++ ) {
			const t = list[ li ];
			const xs = ( t % TX ) * TS;
			const ys = ( ( t / TX ) | 0 ) * TS;
			const xe = Math.min( W, xs + TS );
			const ye = Math.min( H, ys + TS );
			for ( let y = ys; y < ye; y++ ) {
				const row = y * W;
				for ( let x = xs; x < xe; x++ ) {
					fx[ row + x ] = 0;
					fy[ row + x ] = 0;
				}
			}
		}

		// 4. Evaporation (stronger at rims), adsorption, granulation, lifting.
		const evap = P.evap * dt * evapScale;
		const ads = P.adsorb * dt;
		const liftR = P.lift * dt;
		const gran = P.granulation;
		let wetCells = 0;
		for ( let li = 0; li < n; li++ ) {
			const t = list[ li ];
			const xs = ( t % TX ) * TS;
			const ys = ( ( t / TX ) | 0 ) * TS;
			const xe = Math.min( W, xs + TS );
			const ye = Math.min( H, ys + TS );
			const pm = proc[ t ];
			let wet = 0;
			let pig = 0;
			let changed = false;
			for ( let y = ys; y < ye; y++ ) {
				const row = y * W;
				for ( let x = xs; x < xe; x++ ) {
					const i = row + x;
					let hi = h[ i ];
					if ( hi > 0 ) {
						let wn = 0;
						if ( x > 0 && h[ i - 1 ] > WET ) {
							wn++;
						}
						if ( x < W - 1 && h[ i + 1 ] > WET ) {
							wn++;
						}
						if ( y > 0 && h[ i - W ] > WET ) {
							wn++;
						}
						if ( y < H - 1 && h[ i + W ] > WET ) {
							wn++;
						}
						hi -= evap * ( 1 + P.edge * ( 1 - wn * 0.25 ) ) * ( 0.75 + 0.5 * paper[ i ] );
						if ( hi < DRY ) {
							hi = 0;
						}
						h[ i ] = hi;
						changed = true;
					}
					if ( pm ) {
						const rate = ads * ( 1 + gran * ( 0.5 - paper[ i ] ) * 2 );
						for ( let m = pm; m; m &= m - 1 ) {
							const lowbit = m & -m;
							const k = 31 - Math.clz32( lowbit );
							const gk = this.g[ k ];
							const gv = gk[ i ];
							if ( gv > 0 ) {
								changed = true;
								if ( hi <= 0 ) {
									this.d[ k ][ i ] += gv;
									gk[ i ] = 0;
								} else {
									const dd = gv * ( rate > 1 ? 1 : rate < 0 ? 0 : rate );
									const rest = gv - dd;
									if ( rest > 1e-5 ) {
										gk[ i ] = rest;
										this.d[ k ][ i ] += dd;
										pig |= lowbit;
									} else {
										gk[ i ] = 0;
										this.d[ k ][ i ] += gv;
									}
								}
							}
							if ( hi > 0.3 ) {
								const dv = this.d[ k ][ i ];
								if ( dv > 0 ) {
									const l = liftR * dv * ( hi - 0.3 );
									this.d[ k ][ i ] = dv - l;
									gk[ i ] += l;
									pig |= lowbit;
								}
							}
						}
					}
					if ( hi > DRY ) {
						wet = 1;
						if ( hi > WET ) {
							wetCells++;
						}
					}
				}
			}
			tileWet[ t ] = wet || pig ? 1 : 0;
			tilePig[ t ] = pig;
			if ( changed ) {
				this.tileComp[ t ] = 1;
			}
		}
		this.wetCells = wetCells;
	}

	/** Recompute optical density for changed tiles; tracks dirty rows. */
	updateComposite() {
		const { W, H, TX, K, A, comp, h } = this;
		for ( let t = 0; t < this.NT; t++ ) {
			if ( ! this.tileComp[ t ] ) {
				continue;
			}
			this.tileComp[ t ] = 0;
			const xs = ( t % TX ) * TS;
			const ys = ( ( t / TX ) | 0 ) * TS;
			const xe = Math.min( W, xs + TS );
			const ye = Math.min( H, ys + TS );
			if ( ys < this.dirtyY0 ) {
				this.dirtyY0 = ys;
			}
			if ( ye - 1 > this.dirtyY1 ) {
				this.dirtyY1 = ye - 1;
			}
			for ( let y = ys; y < ye; y++ ) {
				const row = y * W;
				for ( let x = xs; x < xe; x++ ) {
					const i = row + x;
					let r = 0;
					let g = 0;
					let b = 0;
					for ( let k = 0; k < K; k++ ) {
						const v = this.d[ k ][ i ] + this.g[ k ][ i ];
						if ( v > 0 ) {
							r += v * A[ k * 3 ];
							g += v * A[ k * 3 + 1 ];
							b += v * A[ k * 3 + 2 ];
						}
					}
					comp[ i * 4 ] = r;
					comp[ i * 4 + 1 ] = g;
					comp[ i * 4 + 2 ] = b;
					comp[ i * 4 + 3 ] = h[ i ];
				}
			}
		}
	}

	consumeDirtyRows() {
		if ( this.dirtyY1 < this.dirtyY0 ) {
			return null;
		}
		const r = [ this.dirtyY0, this.dirtyY1 ];
		this.dirtyY0 = this.H;
		this.dirtyY1 = -1;
		return r;
	}

	/** Optical density snapshot (3 per cell) for the evaluator. */
	snapshotDensity() {
		const n = this.N;
		const out = new Float32Array( n * 3 );
		const c = this.comp;
		for ( let i = 0; i < n; i++ ) {
			out[ i * 3 ] = c[ i * 4 ];
			out[ i * 3 + 1 ] = c[ i * 4 + 1 ];
			out[ i * 3 + 2 ] = c[ i * 4 + 2 ];
		}
		return out;
	}

	meanWater( cx, cy, r ) {
		const { W, H, h } = this;
		let s = 0;
		let n = 0;
		const st = Math.max( 1, Math.floor( r / 4 ) );
		for ( let y = Math.max( 0, Math.floor( cy - r ) ); y <= Math.min( H - 1, cy + r ); y += st ) {
			for ( let x = Math.max( 0, Math.floor( cx - r ) ); x <= Math.min( W - 1, cx + r ); x += st ) {
				s += h[ y * W + x ];
				n++;
			}
		}
		return n ? s / n : 0;
	}
}
