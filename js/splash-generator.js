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

const PROFILE_N = 64;

export class SplashGenerator {
	constructor( model, analysis, drying ) {
		this.model = model;
		this.an = analysis;
		this.drying = drying;
		this.complexity = 1;
		this.animator = null;
		// The pigment currently on the brush.
		this.loaded = -1;

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
			if ( nd > 0.015 && s > bestS ) {
				bestS = s;
				best = k;
			}
		}
		if ( prefer >= 0 && best >= 0 && prefer !== best ) {
			const nd = m.need( prefer, level, i );
			if ( nd > 0.015 && nd * m.normA[ prefer ] > 0.6 * bestS ) {
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
		const dir = rng.range( 0, Math.PI * 2 );
		return {
			x,
			y,
			r,
			k,
			level: op.level ?? 1,
			aspect,
			rot: rng.range( 0, Math.PI ),
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
		if ( anim && anim.brushFreeAt - this.now > 1.2 ) {
			this._drop( rng, op, x, y, r, k, { crown: 2 + rng.int( 4 ), extra, delay } );
			return null;
		}
		const blob = this._stamp( rng, op, x, y, r, k, extra );
		const R = r * blob.reach * 0.85;
		const passes = extra.passes ?? Math.max( 1, Math.min( 5, Math.ceil( R / ( this.an.B * 0.03 ) ) ) );
		blob.passes = passes;
		const dur = ( 0.25 + passes * rng.range( 0.4, 0.6 ) ) * ( extra.slow ?? 1 );
		const approach = 0.22;
		const start = anim ? Math.max( this.now + delay, anim.brushFreeAt + approach ) : 0;
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
			tip: Math.max( 0.8, ( R / passes ) * 0.8 ),
			dx: blob.dx,
			dy: blob.dy,
		} );
		return { start, dur };
	}

	/**
	 * A drop falls, lands and blooms outward; heavier drops throw a crown of
	 * satellite droplets (particles) that bloom where they land.
	 */
	_drop( rng, op, x, y, r, k, { crown = 0, spray = 0, extra = {}, delay = 0, color } = {} ) {
		const an = this.an;
		const fall = rng.range( 0.3, 0.42 );
		const start = this.now + delay + fall;
		const blob = this._stamp( rng, op, x, y, r, k, { amp: 0.22, soft: 0.4, ...extra } );
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
			const imp = an.importance[ this._idx( sx, sy ) ];
			// Decorative allowance only where it cannot hurt the subject.
			const spill = 0.14 * ( op.chaos ?? 1 ) * ( 1 - imp ) * ( 1 - imp );
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
		const r = op.r * rng.range( 0.85, 1.18 );

		if ( op.requireDry && ! op.force && ! this.drying.isDryEnough( model, x, y, r ) ) {
			return false;
		}

		let k = op.k;
		const level = op.level ?? 1;
		if ( k >= 0 && model.need( k, level, this._idx( x, y ) ) < 0.01 ) {
			// The planned pigment is already satisfied here; pick the one that is not.
			k = this.autoPigment( x, y, level );
		} else if ( k < 0 && 'bloom' !== op.type && 'wetblend' !== op.type ) {
			// The plan's colour for this mark, if it still has work to do here.
			const pk = op.pk ?? -1;
			k = pk >= 0 && model.need( pk, level, this._idx( x, y ) ) > 0.015 ? pk : this.autoPigment( x, y, level );
		}
		if ( k >= 0 ) {
			this.loaded = k;
		}
		const B = an.B;

		switch ( op.type ) {
			case 'wash':
				if ( k < 0 ) {
					return true;
				}
				// Big masses arrive as heavy drops with a crown; later washes mix
				// drops and brush sweeps.
				if ( 0 === op.stage || rng.float() < 0.45 ) {
					this._drop( rng, op, x, y, r, k, {
						crown: Math.round( 4 + ( r / B ) * 110 ),
						spray: rng.float() < 0.5 ? rng.int( 10 ) : 0,
						extra: { amp: 0.2, soft: 0.45 },
					} );
				} else {
					this._brush( rng, op, x, y, r, k, { amp: 0.18, soft: 0.45 } );
				}
				return true;

			case 'detail':
				if ( k < 0 ) {
					return true;
				}
				if ( rng.float() < 0.3 ) {
					this._drop( rng, op, x, y, r, k, { crown: rng.int( 3 ), extra: { amp: 0.06, soft: 0.25, aspect: 1.05, capMul: 1.05 } } );
				} else {
					this._brush( rng, op, x, y, r, k, { amp: 0.12, soft: 0.2, aspect: rng.range( 1, 2.2 ), capMul: 1.05, passes: 1, slow: 0.8 } );
				}
				return true;

			case 'drop':
				if ( k < 0 ) {
					return true;
				}
				this._drop( rng, op, x, y, r, k, { crown: 3 + rng.int( 6 ), extra: { amp: 0.05, soft: 0.25, aspect: rng.range( 1, 1.15 ) } } );
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
				if ( this.drying.isDamp( model, x, y, r ) ) {
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
				const lift = { x, y, r, strength: op.strength ?? 0.5, seed: rng.u32() };
				if ( ! this.animator ) {
					model.lift( lift );
					return true;
				}
				const anim = this.animator;
				const approach = 0.22;
				const start = Math.max( this.now, anim.brushFreeAt + approach );
				const dur = 0.7;
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
