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

export function planComposition( an, { duration, seed, density = 1 } ) {
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

	/* 0. Large color masses, light pigments first ------------------- */
	const rBig = B * 0.1;
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		const Tc = T[ 2 ][ k ];
		let area = 0;
		for ( let i = 0; i < N; i++ ) {
			area += smooth( 0.04, 0.25, Tc[ i ] );
		}
		if ( area < 0.004 * N ) {
			continue;
		}
		const n = Math.max( 1, Math.min( 28, Math.round( ( 2.6 * area ) / ( Math.PI * rBig * rBig ) * density ) ) );
		const sampler = new MapSampler( ( i ) => Tc[ i ] * ( 0.5 + importance[ i ] ), W, H );
		for ( let j = 0; j < n; j++ ) {
			const p = sampler.sample( rng );
			if ( ! p ) {
				break;
			}
			add( 0, {
				type: 'wash',
				k,
				x: p.x,
				y: p.y,
				r: rBig * rng.range( 0.7, 1.3 ),
				amount: 0.34,
				water: rng.range( 0.85, 1.1 ),
				flat: 0.6,
				follow: 0.8,
				level: 2,
				// Light to dark, loosely: colour arrives early, darks still come last.
				order: 0.6 * ( 1 - pigments[ k ].L ) + rng.range( 0, 0.4 ),
			} );
		}
	}

	/* 1. Silhouettes & structure: one or more washes per region ------ */
	const minArea = Math.max( 12, ( B * 0.018 ) ** 2 );
	const structural = regions
		.filter( ( r ) => r.area >= minArea && ! pigments[ r.label ].isPaper )
		.map( ( r ) => ( { r, score: Math.sqrt( r.area ) / B + 0.6 * r.importance + 0.4 * r.edge } ) )
		.sort( ( a, b ) => b.score - a.score );
	let budget1 = Math.round( 420 * density );
	for ( const { r: reg, score } of structural ) {
		if ( budget1 <= 0 ) {
			break;
		}
		const rad = Math.min( B * 0.085, Math.max( B * 0.022, Math.sqrt( reg.area ) * 0.42 ) );
		const n = Math.max( 1, Math.min( 14, budget1, Math.round( ( reg.area / ( Math.PI * rad * rad ) ) * 1.3 ) ) );
		budget1 -= n;
		for ( let j = 0; j < n; j++ ) {
			let p = null;
			for ( let tries = 0; tries < 40 && ! p; tries++ ) {
				const x = rng.range( reg.minX, reg.maxX + 1 );
				const y = rng.range( reg.minY, reg.maxY + 1 );
				if ( regionOf[ at( x, y ) ] === reg.id ) {
					p = { x, y };
				}
			}
			if ( ! p ) {
				p = { x: reg.cx, y: reg.cy };
			}
			add( 1, {
				type: 'wash',
				k: reg.label,
				x: p.x,
				y: p.y,
				r: rad * rng.range( 0.8, 1.15 ),
				amount: 0.62,
				water: rng.range( 0.55, 0.8 ),
				flat: 0.45,
				follow: 0.9,
				level: 1,
				chaos: 0.9,
				order: -score + rng.range( 0, 0.2 ),
			} );
		}
	}

	/* 2. Secondary regions: medium scale, per pigment ----------------- */
	const mass = new Float64Array( K );
	let massTotal = 0;
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		const m = T[ 1 ][ k ];
		for ( let i = 0; i < N; i += 2 ) {
			mass[ k ] += m[ i ];
		}
		massTotal += mass[ k ];
	}
	const n2 = Math.round( Math.min( 520, Math.max( 170, ( N / ( Math.PI * ( B * 0.03 ) ** 2 ) ) * 0.9 ) ) * density );
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper || massTotal <= 0 ) {
			continue;
		}
		const n = Math.round( ( n2 * mass[ k ] ) / massTotal );
		const m = T[ 1 ][ k ];
		const sampler = new MapSampler( ( i ) => m[ i ] * ( 0.4 + importance[ i ] ) * ( 0.5 + detail[ i ] ), W, H );
		for ( let j = 0; j < n; j++ ) {
			const p = sampler.sample( rng );
			if ( ! p ) {
				break;
			}
			const r = Math.min( B * 0.05, Math.max( B * 0.014, scale[ at( p.x, p.y ) ] * 1.3 ) ) * rng.range( 0.8, 1.2 );
			add( 2, {
				type: r > B * 0.025 ? 'wash' : 'drop',
				k,
				x: p.x,
				y: p.y,
				r,
				amount: 0.7,
				water: rng.range( 0.45, 0.65 ),
				flat: 0.3,
				follow: 0.85,
				level: 1,
				order: rng.float(),
			} );
		}
	}

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

	/* 4. Shadows, contrast & detail: small dry-brush marks, darks last  */
	let edgeMass = 0;
	for ( let i = 0; i < N; i++ ) {
		if ( edge[ i ] > 0.25 ) {
			edgeMass++;
		}
	}
	const n4 = Math.round( Math.min( 1500, Math.max( 150, ( edgeMass / ( Math.PI * ( B * 0.012 ) ** 2 ) ) * 0.9 ) ) * density );
	const dSampler = new MapSampler(
		( i ) => ( 0.65 * Math.pow( edge[ i ], 1.3 ) + 0.35 * detail[ i ] ) * ( 0.35 + importance[ i ] ) * ( 0.4 + Math.min( 1, darkness[ i ] ) ),
		W,
		H
	);
	for ( let j = 0; j < n4; j++ ) {
		const p = dSampler.sample( rng );
		if ( ! p ) {
			break;
		}
		const i = at( p.x, p.y );
		add( 4, {
			type: 'detail',
			k: -1,
			x: p.x,
			y: p.y,
			r: Math.min( B * 0.03, Math.max( 1.3, scale[ i ] * 0.75 ) ) * rng.range( 0.8, 1.2 ),
			amount: 0.9,
			water: rng.range( 0.22, 0.32 ),
			flat: 0.12,
			follow: 0.95,
			level: 0,
			requireDry: true,
			order: darkness[ i ] + rng.range( 0, 0.35 ),
		} );
	}

	/* 5. Splashes & accents: decorative, near silhouettes and outskirts */
	const nSplash = Math.round( ( 30 + rng.int( 20 ) ) * density );
	const edgeOut = new MapSampler( ( i ) => edge[ i ] * ( 1 - 0.6 * importance[ i ] ), W, H );
	const outskirts = new MapSampler( ( i ) => ( 1 - importance[ i ] ) ** 2, W, H );
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
	const midSampler = new MapSampler( ( i ) => importance[ i ] * ( 0.3 + detail[ i ] ), W, H );
	for ( let j = 0; j < Math.round( 24 * density ); j++ ) {
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
	const nC = Math.round( ops.length * 0.38 );
	for ( let j = 0; j < nC; j++ ) {
		const u = ( j + rng.float() ) / nC;
		const t = duration * ( 0.3 + 0.67 * Math.pow( u, 0.85 ) );
		ops.push( { type: 'correct', stage: stageAt( t / duration ), seed: rng.u32(), t, chaos: 0.5 } );
	}

	ops.sort( ( a, b ) => a.t - b.t );
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
