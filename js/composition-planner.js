/**
 * CompositionPlanner — Phase B.
 *
 * Turns the analysis into a timeline of painting operations, coarse to fine:
 *   0 large color masses   1 silhouettes & structure   2 secondary regions
 *   3 transitions          4 shadows & details          5 splashes & accents
 *   6 drying & final glazes
 * plus "correction" slots that are materialised at runtime from the latest
 * similarity error map (Phase D).
 *
 * Every op has a spatial and chromatic objective (position + pigment + target
 * map level). Randomness only perturbs how it is executed.
 */

import { Rng } from './prng.js';

export const STAGES = [
	{ id: 'masses', name: 'Large color masses', t0: 0.0, t1: 0.17, chaos: 1.0 },
	{ id: 'structure', name: 'Silhouettes & structure', t0: 0.13, t1: 0.38, chaos: 0.5 },
	{ id: 'secondary', name: 'Secondary regions', t0: 0.33, t1: 0.55, chaos: 0.7 },
	{ id: 'transitions', name: 'Transitions & blending', t0: 0.5, t1: 0.64, chaos: 1.1 },
	{ id: 'details', name: 'Shadows, contrast & detail', t0: 0.6, t1: 0.88, chaos: 0.3 },
	{ id: 'accents', name: 'Splashes & accents', t0: 0.86, t1: 0.95, chaos: 1.4 },
	{ id: 'finish', name: 'Final glazes & drying', t0: 0.95, t1: 1.0, chaos: 0.3 },
];

export function stageAt( u ) {
	let s = 0;
	for ( let i = 0; i < STAGES.length; i++ ) {
		if ( u >= STAGES[ i ].t0 ) {
			s = i;
		}
	}
	return s;
}

/**
 * Importance sampler over a weight map, using 4x4 blocks and a CDF.
 */
export class MapSampler {
	constructor( weight, W, H, block = 4 ) {
		this.W = W;
		this.H = H;
		this.block = block;
		this.BW = Math.ceil( W / block );
		this.BH = Math.ceil( H / block );
		const nb = this.BW * this.BH;
		this.cdf = new Float64Array( nb );
		let acc = 0;
		for ( let by = 0; by < this.BH; by++ ) {
			for ( let bx = 0; bx < this.BW; bx++ ) {
				let s = 0;
				const x1 = Math.min( W, ( bx + 1 ) * block );
				const y1 = Math.min( H, ( by + 1 ) * block );
				for ( let y = by * block; y < y1; y++ ) {
					for ( let x = bx * block; x < x1; x++ ) {
						s += weight( y * W + x );
					}
				}
				acc += Math.max( 0, s );
				this.cdf[ by * this.BW + bx ] = acc;
			}
		}
		this.total = acc;
	}

	sample( rng ) {
		if ( this.total <= 0 ) {
			return null;
		}
		const r = rng.float() * this.total;
		let lo = 0;
		let hi = this.cdf.length - 1;
		while ( lo < hi ) {
			const mid = ( lo + hi ) >> 1;
			if ( this.cdf[ mid ] < r ) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		const bx = lo % this.BW;
		const by = ( lo / this.BW ) | 0;
		return {
			x: Math.min( this.W - 1, ( bx + rng.float() ) * this.block ),
			y: Math.min( this.H - 1, ( by + rng.float() ) * this.block ),
		};
	}
}

const smooth = ( a, b, x ) => {
	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );
};

export function planComposition( an, { duration, seed, density = 1, fineDetail = { strokes: 1, fine: 1 } } ) {
	const t0 = performance.now();
	const rng = new Rng( ( seed ^ 0x9e3779b9 ) >>> 0 );
	const { W, H, B, pigments, T, edge, detail, importance, scale, darkness, labels, regions, regionOf } = an;
	const N = W * H;
	const K = pigments.length;
	const at = ( x, y ) => Math.min( H - 1, Math.max( 0, Math.round( y ) ) ) * W + Math.min( W - 1, Math.max( 0, Math.round( x ) ) );
	const stageOps = STAGES.map( () => [] );
	const add = ( stage, op ) => {
		op.stage = stage;
		op.seed = rng.u32();
		op.chaos = ( op.chaos ?? 1 ) * STAGES[ stage ].chaos;
		stageOps[ stage ].push( op );
		return op;
	};

	/* 0–2. Coverage: fill each colour's area with gestures that fit -------- */
	// Gestures are never trimmed to the image, so the planner must make them
	// fit. For each colour, its area is where that pigment belongs. The
	// deepest uncovered point inside the area (furthest from its border) gets
	// the biggest gesture whose whole footprint still fits; it is marked
	// covered and the next deepest point is taken. Big drops land in the
	// middle of big areas, smaller drops and brush washes fill toward the
	// edges, and nothing crosses a border. A second, jittered pass at a finer
	// scale glazes over the first. What no disc can reach (thin bands along
	// borders, small shapes) is left to the fine brush in stage 4.
	let bestT = new Float32Array( N );
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		for ( let i = 0; i < N; i++ ) {
			if ( T[ 0 ][ k ][ i ] > bestT[ i ] ) {
				bestT[ i ] = T[ 0 ][ k ][ i ];
			}
		}
	}
	const areaOf = ( k, Tl ) => {
		const m = new Uint8Array( N );
		const T0k = T[ 0 ][ k ];
		for ( let i = 0; i < N; i++ ) {
			m[ i ] = Tl[ i ] > 0.05 && T0k[ i ] >= 0.35 * bestT[ i ] ? 1 : 0;
		}
		return m;
	};
	// Chamfer distance from each area cell to the nearest cell outside the
	// area (the sheet edge is not a border).
	const depthIn = ( mask ) => {
		const d = new Float32Array( N );
		for ( let i = 0; i < N; i++ ) {
			d[ i ] = mask[ i ] ? 1e9 : 0;
		}
		const S2 = Math.SQRT2;
		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				const i = y * W + x;
				if ( ! d[ i ] ) {
					continue;
				}
				let v = d[ i ];
				if ( x > 0 ) {
					v = Math.min( v, d[ i - 1 ] + 1 );
				}
				if ( y > 0 ) {
					v = Math.min( v, d[ i - W ] + 1 );
					if ( x > 0 ) {
						v = Math.min( v, d[ i - W - 1 ] + S2 );
					}
					if ( x < W - 1 ) {
						v = Math.min( v, d[ i - W + 1 ] + S2 );
					}
				}
				d[ i ] = v;
			}
		}
		for ( let y = H - 1; y >= 0; y-- ) {
			for ( let x = W - 1; x >= 0; x-- ) {
				const i = y * W + x;
				if ( ! d[ i ] ) {
					continue;
				}
				let v = d[ i ];
				if ( x < W - 1 ) {
					v = Math.min( v, d[ i + 1 ] + 1 );
				}
				if ( y < H - 1 ) {
					v = Math.min( v, d[ i + W ] + 1 );
					if ( x < W - 1 ) {
						v = Math.min( v, d[ i + W + 1 ] + S2 );
					}
					if ( x > 0 ) {
						v = Math.min( v, d[ i + W - 1 ] + S2 );
					}
				}
				d[ i ] = Math.min( v, B );
			}
		}
		return d;
	};
	const pack = ( mask, depth, covered, maxR, minR, jitter ) => {
		const cand = [];
		for ( let i = 0; i < N; i++ ) {
			if ( mask[ i ] && depth[ i ] * 0.9 >= minR ) {
				cand.push( i );
			}
		}
		cand.sort( ( a, b ) => depth[ b ] - depth[ a ] );
		const discs = [];
		for ( const c of cand ) {
			if ( covered[ c ] ) {
				continue;
			}
			const cx = c % W;
			const cy = ( c / W ) | 0;
			const ang = rng.range( 0, Math.PI * 2 );
			const off = jitter * depth[ c ] * rng.float();
			const x = Math.min( W - 1, Math.max( 0, cx + Math.cos( ang ) * off ) );
			const y = Math.min( H - 1, Math.max( 0, cy + Math.sin( ang ) * off ) );
			// Neighbouring washes meet and overlap slightly at the border, as real
			// washes do (a faint darker seam), rather than leaving bare paper.
			const fit = Math.min( maxR, ( depth[ c ] - off ) * 0.9 + seam ) * rng.range( 0.85, 1 );
			if ( fit < minR ) {
				continue;
			}
			discs.push( { x, y, fit } );
			// Neighbouring gestures overlap a little, like real washes.
			const rc = fit * 0.8;
			for ( let yy = Math.max( 0, Math.floor( y - rc ) ); yy <= Math.min( H - 1, Math.ceil( y + rc ) ); yy++ ) {
				for ( let xx = Math.max( 0, Math.floor( x - rc ) ); xx <= Math.min( W - 1, Math.ceil( x + rc ) ); xx++ ) {
					if ( ( xx - x ) ** 2 + ( yy - y ) ** 2 <= rc * rc ) {
						covered[ yy * W + xx ] = 1;
					}
				}
			}
		}
		return discs;
	};
	const seam = Math.max( 2, B * 0.015 );
	const leftover = []; // per pigment: area cells no disc reached (for stage 4)
	const bigR = B * 0.06;
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		// First wash: the shared tone at the broadest scale.
		const area1 = areaOf( k, T[ 2 ][ k ] );
		const cov1 = new Uint8Array( N );
		for ( const d of pack( area1, depthIn( area1 ), cov1, B * 0.13, B * 0.025, 0.15 ) ) {
			add( d.fit >= bigR ? 0 : 1, {
				type: 'wash',
				k,
				x: d.x,
				y: d.y,
				r: d.fit / 1.25,
				fit: d.fit,
				drop: d.fit >= bigR,
				level: 2,
				amount: 0.6,
				water: rng.range( 0.75, 1.05 ),
				chaos: 0.2,
				order: 0.6 * ( 1 - pigments[ k ].L ) + rng.range( 0, 0.4 ),
			} );
		}
		// Second glaze: finer, jittered, building the value up.
		const area2 = areaOf( k, T[ 1 ][ k ] );
		const cov2 = new Uint8Array( N );
		for ( const d of pack( area2, depthIn( area2 ), cov2, B * 0.06, B * 0.02, 0.3 ) ) {
			add( 2, {
				type: 'wash',
				k,
				x: d.x,
				y: d.y,
				r: d.fit / 1.25,
				fit: d.fit,
				level: 1,
				amount: 0.85,
				water: rng.range( 0.45, 0.7 ),
				chaos: 0.2,
				order: rng.float(),
			} );
		}
		// Third glaze at full resolution: smaller marks that model the values
		// (shading, gradients) inside each area.
		const area3 = areaOf( k, T[ 0 ][ k ] );
		const cov3 = new Uint8Array( N );
		const discs3 = pack( area3, depthIn( area3 ), cov3, B * 0.035, B * 0.012, 0.35 ).slice( 0, Math.round( 90 * density ) );
		for ( const d of discs3 ) {
			add( 3, {
				type: 'wash',
				k,
				x: d.x,
				y: d.y,
				r: d.fit / 1.25,
				fit: d.fit,
				level: 0,
				amount: 0.9,
				water: rng.range( 0.3, 0.5 ),
				chaos: 0.2,
				order: rng.float(),
			} );
		}
		const rest = new Uint8Array( N );
		for ( let i = 0; i < N; i++ ) {
			rest[ i ] = area2[ i ] && ! cov2[ i ] && ! cov3[ i ] ? 1 : 0;
		}
		leftover[ k ] = rest;
	}
	bestT = null;

	/* 3. Transitions: wet-in-wet blends across soft region borders ---- */
	const boundary = new Float32Array( N );
	let nb = 0;
	for ( let y = 0; y < H - 1; y++ ) {
		for ( let x = 0; x < W - 1; x++ ) {
			const i = y * W + x;
			if ( ( labels[ i ] !== labels[ i + 1 ] || labels[ i ] !== labels[ i + W ] ) && edge[ i ] < 0.45 ) {
				boundary[ i ] = importance[ i ] * ( 1 - edge[ i ] );
				nb++;
			}
		}
	}
	const n3 = Math.round( Math.min( 140, Math.max( 30, nb / ( B * 0.6 ) ) ) * density );
	const bSampler = new MapSampler( ( i ) => boundary[ i ], W, H );
	for ( let j = 0; j < n3; j++ ) {
		const p = bSampler.sample( rng );
		if ( ! p ) {
			break;
		}
		const i = at( p.x, p.y );
		const k1 = labels[ i ];
		let k2 = -1;
		for ( let rr = 1; rr <= 5 && k2 < 0; rr++ ) {
			for ( let a = 0; a < 8; a++ ) {
				const l = labels[ at( p.x + Math.cos( a * 0.785 ) * rr, p.y + Math.sin( a * 0.785 ) * rr ) ];
				if ( l !== k1 ) {
					k2 = l;
					break;
				}
			}
		}
		add( 3, {
			type: 'wetblend',
			k: pigments[ k1 ].isPaper ? -1 : k1,
			k2: k2 >= 0 && ! pigments[ k2 ].isPaper ? k2 : -1,
			x: p.x,
			y: p.y,
			r: B * rng.range( 0.022, 0.045 ),
			amount: 0.55,
			water: 1.0,
			flat: 0.35,
			follow: 0.85,
			level: 1,
			order: rng.float(),
		} );
	}

	/* 4. Detail: paint exactly what the broad washes could not ---------- */
	// For each colour, the fine brush's job is the fine target minus what the
	// wash-level target already gives (a letter, a sliver of blue around a
	// white letter, an eyelid). Each such leftover shape gets one or more
	// near-dry strokes sized and oriented to it (principal axes), instead of
	// random dabs. One hand, natural pace: the stroke budget follows the stage
	// length; the most visible shapes go first and the rest is left to the
	// corrections.
	const handBudget = Math.round( ( STAGES[ 4 ].t1 - STAGES[ 4 ].t0 ) * duration * 1.2 * fineDetail.strokes * density );
	const shapes = [];
	const seen = new Uint8Array( N );
	const stack = new Int32Array( N );
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		const T0k = T[ 0 ][ k ];
		const T1k = T[ 1 ][ k ];
		const rest = leftover[ k ];
		const inShape = ( i ) => ( T0k[ i ] > 0.08 && T0k[ i ] - T1k[ i ] > 0.05 ) || ( rest && rest[ i ] );
		seen.fill( 0 );
		for ( let s0 = 0; s0 < N; s0++ ) {
			if ( seen[ s0 ] || ! inShape( s0 ) ) {
				continue;
			}
			// Collect the shape, then cut it into stroke-sized pieces so curved
			// bands (a ring along a border) get several strokes that follow them.
			let sp = 0;
			stack[ sp++ ] = s0;
			seen[ s0 ] = 1;
			const cells = [];
			while ( sp > 0 ) {
				const i = stack[ --sp ];
				cells.push( i );
				const x = i % W;
				const y = ( i / W ) | 0;
				const nb = [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1 ];
				for ( const j2 of nb ) {
					if ( j2 >= 0 && ! seen[ j2 ] && inShape( j2 ) ) {
						seen[ j2 ] = 1;
						stack[ sp++ ] = j2;
					}
				}
			}
			if ( cells.length < 3 ) {
				continue;
			}
			const G = Math.max( 4, B * 0.04 );
			const groups = new Map();
			for ( const i of cells ) {
				const key = Math.floor( ( i % W ) / G ) + 4096 * Math.floor( ( ( i / W ) | 0 ) / G );
				if ( ! groups.has( key ) ) {
					groups.set( key, [] );
				}
				groups.get( key ).push( i );
			}
			for ( const part of groups.values() ) {
				if ( part.length < 3 ) {
					continue;
				}
				let n = 0;
				let sx = 0;
				let sy = 0;
				let sxx = 0;
				let syy = 0;
				let sxy = 0;
				let mass = 0;
				for ( const i of part ) {
					const x = i % W;
					const y = ( i / W ) | 0;
					n++;
					sx += x;
					sy += y;
					sxx += x * x;
					syy += y * y;
					sxy += x * y;
					mass += Math.max( 0.05, T0k[ i ] - T1k[ i ] ) * importance[ i ];
				}
				const mx = sx / n;
				const my = sy / n;
				const cxx = sxx / n - mx * mx;
				const cyy = syy / n - my * my;
				const cxy = sxy / n - mx * my;
				const tr = cxx + cyy;
				const det = cxx * cyy - cxy * cxy;
				const disc = Math.sqrt( Math.max( 0, ( tr * tr ) / 4 - det ) );
				shapes.push( {
					k,
					x: mx,
					y: my,
					angle: 0.5 * Math.atan2( 2 * cxy, cxx - cyy ),
					half: 2 * Math.sqrt( tr / 2 + disc ) + 1,
					width: 2 * Math.sqrt( Math.max( 0, tr / 2 - disc ) ) + 1,
					mass,
				} );
			}
		}
	}
	shapes.sort( ( a, b ) => b.mass - a.mass );
	let strokes = 0;
	for ( const sh of shapes ) {
		const across = Math.max( 1.2, sh.width * 1.15 );
		const pieces = Math.max( 1, Math.ceil( sh.half / ( 3 * across ) ) );
		if ( strokes + pieces > handBudget ) {
			continue;
		}
		strokes += pieces;
		const ux = Math.cos( sh.angle );
		const uy = Math.sin( sh.angle );
		for ( let j = 0; j < pieces; j++ ) {
			const off = -sh.half + ( ( 2 * j + 1 ) * sh.half ) / pieces;
			add( 4, {
				type: 'detail',
				k: sh.k,
				x: sh.x + ux * off,
				y: sh.y + uy * off,
				r: across,
				rot: sh.angle,
				aspect: Math.min( 3.2, Math.max( 1, ( ( sh.half / pieces ) * 1.15 ) / across ) ),
				amount: 0.95,
				water: rng.range( 0.08, 0.14 ),
				flat: 0.05,
				follow: 0.97,
				level: 0,
				chaos: 0.15,
				requireDry: true,
				order: darkness[ at( sh.x, sh.y ) ] + rng.range( 0, 0.2 ),
			} );
		}
	}

	/* 5. Splashes & accents: decorative, in the background, off the edges */
	const nSplash = Math.round( ( 30 + rng.int( 20 ) ) * density );
	// A splash on the border between two big colour areas reads as a stray dot.
	const outskirts = new MapSampler( ( i ) => ( 1 - importance[ i ] ) ** 2 * ( 1 - edge[ i ] ) ** 3, W, H );
	const edgeOut = outskirts;
	for ( let j = 0; j < nSplash; j++ ) {
		const p = ( rng.float() < 0.6 ? edgeOut : outskirts ).sample( rng );
		if ( ! p ) {
			break;
		}
		add( 5, {
			type: 'splash',
			k: -1,
			x: p.x,
			y: p.y,
			r: B * rng.range( 0.012, 0.03 ),
			amount: 0.6,
			water: 0.7,
			flat: 0.5,
			follow: 0.3,
			level: 1,
			satellites: 6 + rng.int( 13 ),
			dir: rng.range( 0, Math.PI * 2 ),
			spread: rng.range( 0.6, 2.2 ),
			order: rng.float(),
		} );
	}
	// Single droplets only where there is a genuinely small feature (a highlight, an eye).
	const midSampler = new MapSampler( ( i ) => ( scale[ i ] < B * 0.015 && detail[ i ] > 0.55 ? importance[ i ] * detail[ i ] : 0 ), W, H );
	for ( let j = 0; j < Math.round( 12 * density ); j++ ) {
		const p = midSampler.sample( rng );
		if ( ! p ) {
			break;
		}
		add( 5, {
			type: 'drop',
			k: -1,
			x: p.x,
			y: p.y,
			r: B * rng.range( 0.004, 0.01 ),
			amount: 0.7,
			water: 0.6,
			flat: 0.6,
			follow: 0.4,
			level: 0,
			order: rng.float(),
		} );
	}

	/* Paint like a person: one colour at a time ---------------------- */
	// Each op gets the pigment it will most likely paint with. Within a stage,
	// ops are grouped by pigment (light to dark) and each group is walked as a
	// short spatial path, so the brush stays loaded with one colour and moves
	// across the sheet instead of jumping around.
	const normA = pigments.map( ( p ) => Math.hypot( p.A[ 0 ], p.A[ 1 ], p.A[ 2 ] ) );
	const lightOrder = pigments.map( ( p, k ) => k ).sort( ( a, b ) => pigments[ b ].L - pigments[ a ].L );
	const rank = new Int32Array( K );
	lightOrder.forEach( ( k, r ) => ( rank[ k ] = r ) );
	const dominant = ( x, y ) => {
		const i = at( x, y );
		let best = -1;
		let bv = 0;
		for ( let k = 0; k < K; k++ ) {
			const v = T[ 0 ][ k ][ i ] * normA[ k ];
			if ( ! pigments[ k ].isPaper && v > bv ) {
				bv = v;
				best = k;
			}
		}
		return best;
	};
	const groupByColour = ( list ) => {
		for ( const op of list ) {
			op.pk = op.k >= 0 ? op.k : dominant( op.x, op.y );
		}
		const groups = new Map();
		for ( const op of list.sort( ( a, b ) => a.order - b.order ) ) {
			const key = op.pk < 0 ? K : rank[ op.pk ];
			if ( ! groups.has( key ) ) {
				groups.set( key, [] );
			}
			groups.get( key ).push( op );
		}
		const out = [];
		let cx = W / 2;
		let cy = H / 2;
		for ( const key of [ ...groups.keys() ].sort( ( a, b ) => a - b ) ) {
			const g = groups.get( key );
			const used = new Uint8Array( g.length );
			for ( let n = 0; n < g.length; n++ ) {
				// Nearest unvisited op, with a little slack so the path isn't mechanical.
				let best = -1;
				let bd = Infinity;
				for ( let j = 0; j < g.length; j++ ) {
					if ( used[ j ] ) {
						continue;
					}
					const d = Math.hypot( g[ j ].x - cx, g[ j ].y - cy ) * ( 0.85 + 0.3 * rng.float() );
					if ( d < bd ) {
						bd = d;
						best = j;
					}
				}
				used[ best ] = 1;
				out.push( g[ best ] );
				cx = g[ best ].x;
				cy = g[ best ].y;
			}
		}
		return out;
	};

	/* Schedule each stage inside its window ---------------------------- */
	const ops = [];
	stageOps.forEach( ( list, s ) => {
		const st = STAGES[ s ];
		list = groupByColour( list );
		const n = list.length;
		list.forEach( ( op, i ) => {
			op.t = ( st.t0 + ( ( i + 0.15 + rng.float() * 0.7 ) / n ) * ( st.t1 - st.t0 ) ) * duration;
			delete op.order;
			ops.push( op );
		} );
	} );

	/* Blooms / backruns: clear water into damp washes a few seconds later */
	const bloomables = ops.filter( ( o ) => ( 1 === o.stage || 2 === o.stage ) && 'wash' === o.type && o.r > B * 0.03 );
	const nBloom = Math.min( bloomables.length, Math.round( ( 12 + rng.int( 10 ) ) * density ) );
	const timeScale = duration / 600;
	for ( let j = 0; j < nBloom; j++ ) {
		const src = bloomables[ rng.int( bloomables.length ) ];
		const a = rng.range( 0, Math.PI * 2 );
		const d = src.r * rng.range( 0, 0.5 );
		ops.push( {
			type: 'bloom',
			stage: src.stage,
			seed: rng.u32(),
			chaos: 0.8,
			k: -1,
			x: src.x + Math.cos( a ) * d,
			y: src.y + Math.sin( a ) * d,
			r: src.r * rng.range( 0.35, 0.6 ),
			water: 0.7,
			t: src.t + rng.range( 4, 9 ) * Math.max( 0.35, timeScale ),
		} );
	}

	/* Correction slots, denser toward the end ------------------------- */
	// Corrections share the same hand: keep them within its pace too.
	const nC = Math.min( Math.round( ops.length * 0.38 ), Math.round( 0.67 * duration * 0.35 * Math.sqrt( fineDetail.strokes ) ) );
	for ( let j = 0; j < nC; j++ ) {
		const u = ( j + rng.float() ) / nC;
		const t = duration * ( 0.3 + 0.67 * Math.pow( u, 0.85 ) );
		ops.push( { type: 'correct', stage: stageAt( t / duration ), seed: rng.u32(), t, chaos: 0.5 } );
	}

	ops.sort( ( a, b ) => a.t - b.t );

	/* Colour sessions across the whole timeline -------------------------- */
	// Stages overlap in time, so per-stage grouping alone still alternates
	// colours. Cut the timeline into sessions; inside each one, every mark is
	// grouped by pigment, starting with the colour already on the brush, and
	// correction slots go last so they keep using that colour. The slot times
	// stay where they were, so pacing is unchanged.
	const sessionLen = Math.max( 8, duration / 8 );
	let carry = -1;
	// Where the brush is; each colour's marks are walked from here, nearest first.
	let bx = W / 2;
	let by = H / 2;
	const walk = ( group ) => {
		const out = [];
		const used = new Uint8Array( group.length );
		for ( let n = 0; n < group.length; n++ ) {
			let best = -1;
			let bd = Infinity;
			for ( let j = 0; j < group.length; j++ ) {
				if ( ! used[ j ] ) {
					const d = Math.hypot( group[ j ].x - bx, group[ j ].y - by );
					if ( d < bd ) {
						bd = d;
						best = j;
					}
				}
			}
			used[ best ] = 1;
			out.push( group[ best ] );
			bx = group[ best ].x;
			by = group[ best ].y;
		}
		// 2-opt: uncross the route so greedy leftovers don't force long jumps back.
		const dist = ( a, b ) => Math.hypot( a.x - b.x, a.y - b.y );
		for ( let pass = 0, improved = true; improved && pass < 25; pass++ ) {
			improved = false;
			for ( let i = 0; i < out.length - 2; i++ ) {
				for ( let j = i + 2; j < out.length; j++ ) {
					const a = out[ i ];
					const b = out[ i + 1 ];
					const c = out[ j ];
					const d = out[ j + 1 ];
					const before = dist( a, b ) + ( d ? dist( c, d ) : 0 );
					const after = dist( a, c ) + ( d ? dist( b, d ) : 0 );
					if ( after < before - 1e-6 ) {
						for ( let l = i + 1, r = j; l < r; l++, r-- ) {
							const t = out[ l ];
							out[ l ] = out[ r ];
							out[ r ] = t;
						}
						improved = true;
					}
				}
			}
		}
		if ( out.length ) {
			bx = out[ out.length - 1 ].x;
			by = out[ out.length - 1 ].y;
		}
		return out;
	};
	for ( let i = 0; i < ops.length; ) {
		const tEnd = ops[ i ].t + sessionLen;
		let j = i;
		while ( j < ops.length && ops[ j ].t < tEnd ) {
			j++;
		}
		const chunk = ops.slice( i, j );
		const times = chunk.map( ( o ) => o.t );
		const groupKey = ( o ) => {
			if ( 'correct' === o.type ) {
				return 1e6;
			}
			const k = o.pk ?? o.k ?? -1;
			if ( k < 0 ) {
				return 1e5;
			}
			return k === carry ? -1 : rank[ k ];
		};
		const groups = new Map();
		for ( const o of chunk ) {
			const g = groupKey( o );
			if ( ! groups.has( g ) ) {
				groups.set( g, [] );
			}
			groups.get( g ).push( o );
		}
		chunk.length = 0;
		for ( const g of [ ...groups.keys() ].sort( ( a, b ) => a - b ) ) {
			const list = groups.get( g );
			chunk.push( ...( 1e6 === g ? list : walk( list ) ) );
		}
		chunk.forEach( ( o, n ) => {
			o.t = times[ n ];
			ops[ i + n ] = o;
		} );
		for ( let n = chunk.length - 1; n >= 0; n-- ) {
			const k = chunk[ n ].pk ?? chunk[ n ].k ?? -1;
			if ( k >= 0 && 'correct' !== chunk[ n ].type ) {
				carry = k;
				break;
			}
		}
		i = j;
	}

	const counts = STAGES.map( () => 0 );
	const byType = {};
	for ( const op of ops ) {
		counts[ op.stage ]++;
		byType[ op.type ] = ( byType[ op.type ] || 0 ) + 1;
	}
	return {
		ops,
		duration,
		stages: STAGES.map( ( s, i ) => ( { ...s, count: counts[ i ] } ) ),
		byType,
		planMs: performance.now() - t0,
	};
}

/**
 * Step-back pass: look at the painting as it is and plan fine strokes for
 * whatever is still mostly bare where a colour belongs. Gaps are found per
 * pigment, cut into stroke-sized pieces, and returned grouped by colour and
 * walked nearest-first (from the brush position).
 *
 * @return {Object[]} ops (without times), in painting order.
 */
export function planGapStrokes( model, an, { budget, seed, handX, handY } ) {
	const rng = new Rng( seed >>> 0 );
	const { W, H, B, importance, pigments } = an;
	const N = W * H;
	const K = pigments.length;
	const T0 = model.T[ 0 ];
	let bestT = new Float32Array( N );
	for ( let k = 0; k < K; k++ ) {
		if ( ! pigments[ k ].isPaper ) {
			for ( let i = 0; i < N; i++ ) {
				bestT[ i ] = Math.max( bestT[ i ], T0[ k ][ i ] );
			}
		}
	}
	const pieces = [];
	const seen = new Uint8Array( N );
	const stack = new Int32Array( N );
	const G = Math.max( 4, B * 0.035 );
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		const Tk = T0[ k ];
		const dk = model.d[ k ];
		const gk = model.g[ k ];
		const gap = ( i ) => Tk[ i ] > 0.06 && Tk[ i ] >= 0.35 * bestT[ i ] && ! model.reserve[ i ] && Tk[ i ] - dk[ i ] - gk[ i ] > 0.5 * Tk[ i ];
		seen.fill( 0 );
		for ( let s0 = 0; s0 < N; s0++ ) {
			if ( seen[ s0 ] || ! gap( s0 ) ) {
				continue;
			}
			let sp = 0;
			stack[ sp++ ] = s0;
			seen[ s0 ] = 1;
			const cells = [];
			while ( sp > 0 ) {
				const i = stack[ --sp ];
				cells.push( i );
				const x = i % W;
				const y = ( i / W ) | 0;
				if ( x > 0 && ! seen[ i - 1 ] && gap( i - 1 ) ) {
					seen[ i - 1 ] = 1;
					stack[ sp++ ] = i - 1;
				}
				if ( x < W - 1 && ! seen[ i + 1 ] && gap( i + 1 ) ) {
					seen[ i + 1 ] = 1;
					stack[ sp++ ] = i + 1;
				}
				if ( y > 0 && ! seen[ i - W ] && gap( i - W ) ) {
					seen[ i - W ] = 1;
					stack[ sp++ ] = i - W;
				}
				if ( y < H - 1 && ! seen[ i + W ] && gap( i + W ) ) {
					seen[ i + W ] = 1;
					stack[ sp++ ] = i + W;
				}
			}
			if ( cells.length < 4 ) {
				continue;
			}
			const groups = new Map();
			for ( const i of cells ) {
				const key = Math.floor( ( i % W ) / G ) + 4096 * Math.floor( ( ( i / W ) | 0 ) / G );
				if ( ! groups.has( key ) ) {
					groups.set( key, [] );
				}
				groups.get( key ).push( i );
			}
			for ( const part of groups.values() ) {
				if ( part.length < 3 ) {
					continue;
				}
				let sx = 0;
				let sy = 0;
				let sxx = 0;
				let syy = 0;
				let sxy = 0;
				let mass = 0;
				for ( const i of part ) {
					const x = i % W;
					const y = ( i / W ) | 0;
					sx += x;
					sy += y;
					sxx += x * x;
					syy += y * y;
					sxy += x * y;
					mass += Tk[ i ] * importance[ i ];
				}
				const n = part.length;
				const mx = sx / n;
				const my = sy / n;
				const cxx = sxx / n - mx * mx;
				const cyy = syy / n - my * my;
				const cxy = sxy / n - mx * my;
				const tr = cxx + cyy;
				const disc = Math.sqrt( Math.max( 0, ( tr * tr ) / 4 - ( cxx * cyy - cxy * cxy ) ) );
				const half = 2 * Math.sqrt( tr / 2 + disc ) + 1;
				const width = 2 * Math.sqrt( Math.max( 0, tr / 2 - disc ) ) + 1;
				const across = Math.max( 1.2, width * 1.1 );
				pieces.push( {
					type: 'detail',
					k,
					x: mx,
					y: my,
					r: across,
					rot: 0.5 * Math.atan2( 2 * cxy, cxx - cyy ),
					aspect: Math.min( 3.5, Math.max( 1, ( half * 1.1 ) / across ) ),
					amount: 0.95,
					water: rng.range( 0.1, 0.18 ),
					flat: 0.05,
					follow: 0.97,
					level: 0,
					chaos: 0.15,
					requireDry: true,
					seed: rng.u32(),
					mass,
				} );
			}
		}
	}
	bestT = null;
	// Most visible gaps first, within what the hand can do in the window.
	pieces.sort( ( a, b ) => b.mass - a.mass );
	const chosen = pieces.slice( 0, budget );
	// Group by colour (light to dark), each walked nearest-first.
	const byK = new Map();
	for ( const p of chosen ) {
		if ( ! byK.has( p.k ) ) {
			byK.set( p.k, [] );
		}
		byK.get( p.k ).push( p );
	}
	const order = [ ...byK.keys() ].sort( ( a, b ) => pigments[ b ].L - pigments[ a ].L );
	const out = [];
	let hx = handX;
	let hy = handY;
	for ( const k of order ) {
		const list = byK.get( k );
		const used = new Uint8Array( list.length );
		for ( let n = 0; n < list.length; n++ ) {
			let best = -1;
			let bd = Infinity;
			for ( let j = 0; j < list.length; j++ ) {
				if ( ! used[ j ] ) {
					const d = Math.hypot( list[ j ].x - hx, list[ j ].y - hy );
					if ( d < bd ) {
						bd = d;
						best = j;
					}
				}
			}
			used[ best ] = 1;
			out.push( list[ best ] );
			hx = list[ best ].x;
			hy = list[ best ].y;
		}
	}
	return out;
}
