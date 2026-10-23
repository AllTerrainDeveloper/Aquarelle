/**
 * LayerPlanner — paints the way a watercolourist works: in layers of value
 * across the whole sheet, each layer planned against what is actually on
 * the paper when the painter steps up to it.
 *
 *   0  First wash: everything light, loose and wet. Every big area gets its
 *      lightest version poured in as drops, spread with a broad brush, its
 *      other colours charged in while wet; a few splashes.
 *   1  Mid-tones, shape by shape: one colour at a time, biggest colour
 *      first, nearest shape next; one confident wash per shape, cutting in
 *      only along real edges. Thin shapes get one stroke from tip to tip.
 *   2  Shadow glazes: the same pigments again, only over the parts that
 *      should be darker, so values build in steps and a few pigments make
 *      gradients.
 *   3  Darks and details with a small brush: few, deliberate strokes along
 *      each shape's spine.
 *   4  Finish: lift a highlight or two where the paper went too dark, a
 *      couple of accents.
 *
 * Each layer has its own value target: the image with every cell's pigment
 * mix scaled so its darkness does not exceed the layer's value. Gestures in a
 * layer can only bring the paper up to that layer's value, never past it.
 * Nothing is trimmed to the image: gestures are sized and placed to fit.
 */

import { Rng } from './prng.js';
import { depthInside, packDiscs, sweepStrokes, spineStrokes } from './composition-planner.js';
import { minFilter, maxFilter } from './image-analyzer.js';

export const LAYERS = [
	{ id: 'wash', name: 'First wash: light and loose', t0: 0.0, t1: 0.24 },
	{ id: 'mid', name: 'Mid-tones, shape by shape', t0: 0.27, t1: 0.55 },
	{ id: 'glaze', name: 'Shadow glazes', t0: 0.58, t1: 0.75 },
	{ id: 'detail', name: 'Darks & details', t0: 0.77, t1: 0.92 },
	{ id: 'finish', name: 'Finish', t0: 0.93, t1: 0.97 },
];

/** Value ceilings (mean optical density) of the first two layers. */
const V_WASH = 0.35;
const V_MID = 1.0;

/**
 * Shared, image-only context computed once (worker side).
 */
export function layerContext( an, { duration, seed, fineDetail = { strokes: 1, fine: 1 } } ) {
	const { W, H, B, pigments, T, edge } = an;
	const N = W * H;
	const K = pigments.length;
	const meanA = pigments.map( ( p ) => ( p.A[ 0 ] + p.A[ 1 ] + p.A[ 2 ] ) / 3 );
	// Target darkness per cell (all pigments).
	const D = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		let d = 0;
		for ( let k = 0; k < K; k++ ) {
			d += T[ 0 ][ k ][ i ] * meanA[ k ];
		}
		D[ i ] = d;
	}
	// Where the image has a real edge within reach (cut-in happens only there).
	const strongOff = new Uint8Array( N );
	for ( let i = 0; i < N; i++ ) {
		strongOff[ i ] = edge[ i ] > 0.3 ? 0 : 1;
	}
	const far = depthInside( strongOff, W, H, B );
	const er = Math.max( 2, Math.ceil( B * 0.012 ) );
	const edgeNear = new Uint8Array( N );
	for ( let i = 0; i < N; i++ ) {
		edgeNear[ i ] = far[ i ] <= er ? 1 : 0;
	}
	// Shadow masses: the full target opened at a modest scale (no fine detail).
	const rs = Math.max( 2, Math.round( B / 90 ) );
	const shadow = T[ 0 ].map( ( m, k ) => ( pigments[ k ].isPaper ? m : maxFilter( minFilter( m, W, H, rs ), W, H, rs ) ) );
	return { an, W, H, B, N, K, meanA, D, edgeNear, shadow, duration, seed, fineDetail };
}

/** The value target of a layer, per pigment (K arrays) and as density. */
function layerTarget( ctx, layer ) {
	const { an, N, K, meanA, D, shadow } = ctx;
	const T0 = an.T[ 0 ];
	const target = new Float32Array( K * N );
	for ( let k = 0; k < K; k++ ) {
		const off = k * N;
		const t0 = T0[ k ];
		for ( let i = 0; i < N; i++ ) {
			let v;
			if ( 0 === layer ) {
				v = t0[ i ] * Math.min( 1, V_WASH / Math.max( 1e-3, D[ i ] ) );
			} else if ( 1 === layer ) {
				v = t0[ i ] * Math.min( 1, V_MID / Math.max( 1e-3, D[ i ] ) );
			} else if ( 2 === layer ) {
				v = Math.max( shadow[ k ][ i ], t0[ i ] * Math.min( 1, V_MID / Math.max( 1e-3, D[ i ] ) ) );
			} else {
				v = t0[ i ];
			}
			target[ off + i ] = v;
		}
	}
	const dens = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		let d = 0;
		for ( let k = 0; k < K; k++ ) {
			d += target[ k * N + i ] * meanA[ k ];
		}
		dens[ i ] = d * 1.04 + 0.02;
	}
	return { target, dens };
}

/** Connected components (4-neighbour) of a mask, as lists of cells. */
function components( mask, W, H, minSize ) {
	const N = W * H;
	const seen = new Uint8Array( N );
	const stack = new Int32Array( N );
	const out = [];
	for ( let s0 = 0; s0 < N; s0++ ) {
		if ( ! mask[ s0 ] || seen[ s0 ] ) {
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
			if ( x > 0 && mask[ i - 1 ] && ! seen[ i - 1 ] ) {
				seen[ i - 1 ] = 1;
				stack[ sp++ ] = i - 1;
			}
			if ( x < W - 1 && mask[ i + 1 ] && ! seen[ i + 1 ] ) {
				seen[ i + 1 ] = 1;
				stack[ sp++ ] = i + 1;
			}
			if ( y > 0 && mask[ i - W ] && ! seen[ i - W ] ) {
				seen[ i - W ] = 1;
				stack[ sp++ ] = i - W;
			}
			if ( y < H - 1 && mask[ i + W ] && ! seen[ i + W ] ) {
				seen[ i + W ] = 1;
				stack[ sp++ ] = i + W;
			}
		}
		if ( cells.length >= minSize ) {
			out.push( cells );
		}
	}
	return out;
}

const centroid = ( cells, W ) => {
	let sx = 0;
	let sy = 0;
	for ( const i of cells ) {
		sx += i % W;
		sy += ( i / W ) | 0;
	}
	return { x: sx / cells.length, y: sy / cells.length };
};

/** Order items (with x, y) as a nearest-first walk from (hx, hy). */
function walk( items, hx, hy ) {
	const out = [];
	const used = new Uint8Array( items.length );
	for ( let n = 0; n < items.length; n++ ) {
		let best = -1;
		let bd = Infinity;
		for ( let j = 0; j < items.length; j++ ) {
			if ( ! used[ j ] ) {
				const d = Math.hypot( items[ j ].x - hx, items[ j ].y - hy );
				if ( d < bd ) {
					bd = d;
					best = j;
				}
			}
		}
		used[ best ] = 1;
		out.push( items[ best ] );
		hx = items[ best ].x;
		hy = items[ best ].y;
	}
	return out;
}

const brushSpeed = ( B, w ) => Math.max( B * 0.35, w * 14 );
// Real hand time: the stroke itself plus lifting, moving and landing again.
const strokeSecs = ( B, st, w ) => 0.6 + st.len / brushSpeed( B, w );

/**
 * Plan one layer against the paper as it is.
 *
 * @param {Object} ctx    layerContext()
 * @param {number} layer  index into LAYERS
 * @param {Object} state  { cur: Float32Array(K*N) pigment on paper, handX, handY, seed }
 * @return {{ ops: Object[], target: Float32Array, dens: Float32Array }}
 *         op.t is painting seconds from the start of the layer.
 */
export function planLayer( ctx, layer, state ) {
	const { an, W, H, B, N, K, meanA, edgeNear } = ctx;
	const { pigments, importance, regions, regionOf, reserve } = an;
	const rng = new Rng( ( ctx.seed * 31 + layer * 7919 + ( state.seed || 0 ) ) >>> 0 );
	const L = LAYERS[ layer ];
	const window = ( L.t1 - L.t0 ) * ctx.duration;
	const { target, dens } = layerTarget( ctx, layer );
	const cur = state.cur;
	// What each pigment still needs here for this layer.
	const need = ( k, i ) => Math.max( 0, target[ k * N + i ] - cur[ k * N + i ] );
	// How much darker this cell may still get in this layer (density).
	const room = ( i ) => {
		let have = 0;
		for ( let k = 0; k < K; k++ ) {
			have += cur[ k * N + i ] * meanA[ k ];
		}
		return dens[ i ] - have;
	};
	const seam = Math.max( 2, B * 0.012 );
	const ops = [];
	let hx = state.handX;
	let hy = state.handY;

	if ( 0 === layer ) {
		/* First wash ---------------------------------------------------- */
		// Big areas, biggest first; each poured with its light colour, spread
		// with a broad wet brush, other colours dropped in while wet.
		const minObj = Math.max( 30, ( B * 0.035 ) ** 2 );
		const objs = regions.filter( ( r ) => r.area >= minObj ).sort( ( a, b ) => b.area - a.area );
		const byReg = new Map();
		objs.forEach( ( r ) => byReg.set( r.id, [] ) );
		for ( let i = 0; i < N; i++ ) {
			const list = byReg.get( regionOf[ i ] );
			if ( list && ! reserve[ i ] ) {
				list.push( i );
			}
		}
		const plan = [];
		for ( const reg of objs ) {
			const cells = byReg.get( reg.id );
			const sums = new Float64Array( K );
			for ( const i of cells ) {
				for ( let k = 0; k < K; k++ ) {
					sums[ k ] += need( k, i );
				}
			}
			let main = -1;
			for ( let k = 0; k < K; k++ ) {
				if ( ! pigments[ k ].isPaper && ( main < 0 || sums[ k ] > sums[ main ] ) ) {
					main = k;
				}
			}
			if ( main < 0 || sums[ main ] / cells.length < 0.02 ) {
				continue;
			}
			const own = cells.filter( ( i ) => need( main, i ) > 0.01 );
			if ( own.length < 8 ) {
				continue;
			}
			plan.push( { reg, cells, own, main, sums } );
		}
		// Size the broad brush so the whole wash fits the layer's time.
		let scale = 1;
		let built = [];
		for ( let attempt = 0; attempt < 3; attempt++ ) {
			built = [];
			let total = 0;
			for ( const p of plan ) {
				const thick = Math.sqrt( p.own.length / Math.PI );
				const w = Math.min( B * 0.08, Math.max( B * 0.015, thick * 0.6 * scale ) );
				const strokes = sweepStrokes( p.own, W, w, seam, { H, edgeNear: ctx.edgeNear, rng } ).filter( ( s ) => ! s.edge );
				let secs = 0;
				for ( const st of strokes ) {
					secs += strokeSecs( B, st, w );
				}
				total += secs + 3;
				built.push( { ...p, w, strokes } );
			}
			if ( total <= window * 0.72 ) {
				break;
			}
			scale *= Math.sqrt( total / ( window * 0.72 ) );
		}
		let t = 0.5;
		for ( const p of built ) {
			const m = new Uint8Array( N );
			for ( const i of p.own ) {
				m[ i ] = 1;
			}
			// Pour: big drops of its light colour, sized to fit.
			const pours = packDiscs( m, depthInside( m, W, H, B ), new Uint8Array( N ), { W, H, maxR: B * 0.11, minR: B * 0.025, jitter: 0.3, seam: 0, rng, limit: 3 + rng.int( 4 ) } );
			for ( const d of pours ) {
				ops.push( drop( p.main, d, t, pigments, rng, 0.8 ) );
				t += rng.range( 0.5, 0.9 );
			}
			// Spread it with a broad, wet brush.
			for ( const st of p.strokes ) {
				ops.push( sweep( p.main, st, p.w, t, p.reg.id, 1, 0.55 + 0.4 * pigments[ p.main ].L, B, rng ) );
				t += strokeSecs( B, st, p.w );
			}
			// Charge its other colours into the wet wash.
			for ( let k = 0; k < K; k++ ) {
				if ( k === p.main || pigments[ k ].isPaper || p.sums[ k ] < 0.2 * p.sums[ p.main ] ) {
					continue;
				}
				const sub = new Uint8Array( N );
				let cnt = 0;
				for ( const i of p.cells ) {
					if ( need( k, i ) > 0.02 ) {
						sub[ i ] = 1;
						cnt++;
					}
				}
				if ( cnt < 8 ) {
					continue;
				}
				for ( const d of packDiscs( sub, depthInside( sub, W, H, B ), new Uint8Array( N ), { W, H, maxR: B * 0.06, minR: B * 0.015, jitter: 0.25, seam: 0, rng, limit: 3 } ) ) {
					ops.push( drop( k, d, t - rng.range( 0.3, 1.0 ), pigments, rng, 0.7 ) );
				}
			}
			t += rng.range( 0.5, 1.2 );
			hx = p.own.length ? centroid( p.own, W ).x : hx;
		}
		// A few loose splashes in quiet areas.
		const quiet = [];
		for ( let i = 0; i < N; i += 7 ) {
			if ( importance[ i ] < 0.3 && ! edgeNear[ i ] && ! reserve[ i ] && dens[ i ] > 0.1 ) {
				quiet.push( i );
			}
		}
		for ( let j = 0; j < Math.min( 6, quiet.length ); j++ ) {
			const i = quiet[ rng.int( quiet.length ) ];
			ops.push( {
				type: 'splash',
				k: -1,
				x: i % W,
				y: ( i / W ) | 0,
				r: B * rng.range( 0.012, 0.025 ),
				amount: 0.6,
				water: 0.7,
				flat: 0.5,
				follow: 0.3,
				level: 0,
				satellites: 6 + rng.int( 10 ),
				dir: rng.range( 0, Math.PI * 2 ),
				spread: rng.range( 0.6, 2 ),
				chaos: 1,
				seed: rng.u32(),
				t: rng.range( 0.2, 0.9 ) * window,
			} );
		}
	} else if ( 1 === layer || 2 === layer ) {
		/* Mid-tones / shadow glazes: one colour at a time ----------------- */
		const glaze = 2 === layer;
		const minShape = Math.max( 12, ( B * ( glaze ? 0.02 : 0.025 ) ) ** 2 );
		const colours = [];
		for ( let k = 0; k < K; k++ ) {
			if ( pigments[ k ].isPaper ) {
				continue;
			}
			// Where this colour still clearly needs to be darker.
			const mask = new Uint8Array( N );
			let total = 0;
			for ( let i = 0; i < N; i++ ) {
				const nd = need( k, i );
				if ( ! reserve[ i ] && nd > Math.max( 0.04, 0.2 * target[ k * N + i ] ) && room( i ) > 0.05 ) {
					mask[ i ] = 1;
					total += nd;
				}
			}
			const shapes = components( mask, W, H, minShape ).map( ( cells ) => ( { cells, ...centroid( cells, W ) } ) );
			if ( shapes.length ) {
				colours.push( { k, total, shapes } );
			}
		}
		// Biggest colour first.
		colours.sort( ( a, b ) => b.total - a.total );
		let scale = 1;
		let built = [];
		for ( let attempt = 0; attempt < 5; attempt++ ) {
			built = [];
			let total = 0;
			let px = hx;
			let py = hy;
			for ( const c of colours ) {
				for ( const sh of walk( c.shapes, px, py ) ) {
					const m = new Uint8Array( N );
					for ( const i of sh.cells ) {
						m[ i ] = 1;
					}
					let deepest = 0;
					const depth = depthInside( m, W, H, B );
					for ( const i of sh.cells ) {
						deepest = Math.max( deepest, depth[ i ] );
					}
					const w = Math.min( B * ( glaze ? 0.035 : 0.05 ), Math.max( B * 0.008, deepest * 0.8 * scale ) );
					// Mid-tones and glazes are washes; thin shapes are left for the
					// darks-and-details layer, as a painter would.
					const thin = deepest < B * 0.012;
					if ( thin ) {
						continue;
					}
					// Edges are cut in once, with the mid-tones; glazes do not retrace
					// them (that would draw an outline).
					let strokes = sweepStrokes( sh.cells, W, w, seam, { H, edgeNear: ctx.edgeNear, rng } );
					if ( glaze ) {
						strokes = strokes.filter( ( st ) => ! st.edge );
					}
					let secs = 0;
					for ( const st of strokes ) {
						secs += strokeSecs( B, st, thin ? st.r : w );
					}
					let mass = 0;
					for ( const i of sh.cells ) {
						mass += need( c.k, i ) * importance[ i ];
					}
					total += secs;
					built.push( { k: c.k, sh, w, thin, strokes, secs, mass } );
					px = sh.x;
					py = sh.y;
				}
			}
			if ( total <= window * 0.72 ) {
				break;
			}
			scale *= Math.sqrt( total / ( window * 0.72 ) );
		}
		// Still too much for the time: keep the shapes that matter most (most
		// paint needed where it is most visible), in their painting order.
		{
			let total = 0;
			for ( const b of built ) {
				total += b.secs;
			}
			if ( total > window * 0.72 ) {
				const keep = new Set();
				let used = 0;
				for ( const b of [ ...built ].sort( ( x, y ) => y.mass - x.mass ) ) {
					if ( used + b.secs <= window * 0.72 ) {
						used += b.secs;
						keep.add( b );
					}
				}
				built = built.filter( ( b ) => keep.has( b ) );
			}
		}
		let t = 0.3;
		let id = 0;
		for ( const b of built ) {
			const wash = layer * 1e5 + id++;
			for ( const st of b.strokes ) {
				if ( b.thin ) {
					ops.push( spine( b.k, st, t, glaze ? 0.9 : 0.95, 0.15, rng ) );
					t += strokeSecs( B, st, st.r );
				} else {
					ops.push( sweep( b.k, st, b.w, t, wash, 1, glaze ? 0.3 + 0.2 * pigments[ b.k ].L : 0.4 + 0.35 * pigments[ b.k ].L, B, rng ) );
					t += strokeSecs( B, st, b.w );
				}
			}
			t += rng.range( 0.2, 0.6 );
		}
	} else if ( 3 === layer ) {
		/* Darks & details: few, deliberate strokes ------------------------- */
		// Shapes across colours (a brow mixing two darks is one shape); the
		// main pigment paints its spine. Most visible first, within the time.
		const mask = new Uint8Array( N );
		for ( let i = 0; i < N; i++ ) {
			if ( reserve[ i ] || room( i ) < 0.08 ) {
				continue;
			}
			for ( let k = 0; k < K; k++ ) {
				if ( ! pigments[ k ].isPaper && need( k, i ) > Math.max( 0.08, 0.3 * target[ k * N + i ] ) ) {
					mask[ i ] = 1;
					break;
				}
			}
		}
		const shapes = [];
		const addShape = ( cells ) => {
			const sums = new Float64Array( K );
			let imp = 0;
			for ( const i of cells ) {
				imp += importance[ i ];
				for ( let k = 0; k < K; k++ ) {
					sums[ k ] += need( k, i );
				}
			}
			let k1 = 0;
			for ( let k = 1; k < K; k++ ) {
				if ( sums[ k ] > sums[ k1 ] ) {
					k1 = k;
				}
			}
			const strokes = spineStrokes( cells, W );
			let len = 0;
			let rr = 0;
			for ( const st of strokes ) {
				len += st.len;
				rr = Math.max( rr, st.r );
			}
			// A short touch is right for small round features (a pupil, an iris);
			// only skip specks that are neither important nor dark.
			const avgImp = imp / cells.length;
			const avgNeed = sums[ k1 ] / cells.length;
			if ( ! strokes.length || ( len < B * 0.02 && ( cells.length < 5 || ( avgImp < 0.45 && avgNeed < 0.4 ) ) ) ) {
				return;
			}
			// Only details here: thin or small shapes. Big leftovers belong to
			// the glazes, not to the small brush.
			if ( rr >= B * 0.02 && cells.length > ( B * 0.06 ) ** 2 ) {
				return;
			}
			let secs = 0;
			for ( const st of strokes ) {
				secs += strokeSecs( B, st, st.r );
			}
			// What a painter refines first: important, dark, detailed shapes
			// (eyes, brows, lettering), not whatever leftover patch is biggest.
			const thin = rr < B * 0.015;
			const priority = avgNeed * avgImp * avgImp * ( thin ? 2 : 1 ) * Math.sqrt( Math.min( 1, len / ( B * 0.05 ) ) );
			shapes.push( { k: k1, strokes, secs, mass: priority, ...centroid( cells, W ) } );
		};
		// A feature is often several colours side by side (an eye: lid line,
		// iris, pupil). Each cell goes to the colour it needs most; close
		// colours (two darks in one brow) stay one shape, distinct ones are
		// painted as their own shapes, each with its own colour.
		const owner = new Int16Array( N );
		const sub = new Uint8Array( N );
		for ( const cells of components( mask, W, H, 5 ) ) {
			const total = new Float64Array( K );
			for ( const i of cells ) {
				let best = -1;
				let bn = 0;
				for ( let k = 0; k < K; k++ ) {
					const n = pigments[ k ].isPaper ? 0 : need( k, i );
					if ( n > bn ) {
						bn = n;
						best = k;
					}
				}
				owner[ i ] = best;
				if ( best >= 0 ) {
					total[ best ] += bn;
				}
			}
			// Families: each colour joins the strongest close colour.
			const byMass = [ ...total.keys() ].filter( ( k ) => total[ k ] > 0 ).sort( ( x, y ) => total[ y ] - total[ x ] );
			const family = new Int16Array( K ).fill( -1 );
			for ( const k of byMass ) {
				family[ k ] = k;
				for ( const h of byMass ) {
					if ( h === k ) {
						break;
					}
					const [ l1, a1, b1 ] = pigments[ k ].lab;
					const [ l2, a2, b2 ] = pigments[ h ].lab;
					if ( family[ h ] === h && Math.hypot( l1 - l2, a1 - a2, b1 - b2 ) < 0.1 ) {
						family[ k ] = h;
						break;
					}
				}
			}
			for ( const f of byMass.filter( ( k ) => family[ k ] === k ) ) {
				for ( const i of cells ) {
					sub[ i ] = owner[ i ] >= 0 && family[ owner[ i ] ] === f ? 1 : 0;
				}
				for ( const part of components( sub, W, H, 3 ) ) {
					addShape( part );
				}
				for ( const i of cells ) {
					sub[ i ] = 0;
				}
			}
		}
		shapes.sort( ( a, b ) => b.mass - a.mass );
		const chosen = [];
		let used = 0;
		const budget = window * 0.72 * ( ctx.fineDetail.strokes || 1 );
		for ( const s of shapes ) {
			if ( used + s.secs <= budget ) {
				used += s.secs;
				chosen.push( s );
			}
		}
		// One colour at a time (light to dark), nearest next.
		const order = [ ...new Set( chosen.map( ( s ) => s.k ) ) ].sort( ( a, b ) => pigments[ b ].L - pigments[ a ].L );
		let t = 0.3;
		for ( const k of order ) {
			for ( const s of walk( chosen.filter( ( c ) => c.k === k ), hx, hy ) ) {
				for ( const st of s.strokes ) {
					ops.push( spine( k, st, t, 0.95, 0.12, rng ) );
					t += strokeSecs( B, st, st.r );
				}
				hx = s.x;
				hy = s.y;
			}
		}
	} else {
		/* Finish: lift where it went too dark, a couple of accents --------- */
		const over = new Uint8Array( N );
		for ( let i = 0; i < N; i++ ) {
			if ( room( i ) < -0.5 && an.room[ i ] > 3 ) {
				over[ i ] = 1;
			}
		}
		const blots = components( over, W, H, 6 ).sort( ( a, b ) => b.length - a.length ).slice( 0, 6 );
		let t = 0.3;
		for ( const cells of blots ) {
			const c = centroid( cells, W );
			ops.push( { type: 'lift', x: c.x, y: c.y, r: Math.min( B * 0.03, Math.sqrt( cells.length / Math.PI ) ), strength: 0.5, seed: rng.u32(), chaos: 0.2, t } );
			t += 1.2;
		}
	}
	ops.sort( ( a, b ) => a.t - b.t );
	return { ops, target, dens };
}

function drop( k, d, t, pigments, rng, amount ) {
	return {
		type: 'wash',
		k,
		x: d.x,
		y: d.y,
		r: d.fit / 1.25,
		fit: d.fit,
		drop: true,
		level: 0,
		amount,
		// Darks rich and dry, lights wet.
		water: ( 0.35 + 0.55 * pigments[ k ].L ) * rng.range( 0.9, 1.1 ),
		chaos: 0.2,
		seed: rng.u32(),
		t: Math.max( 0, t ),
	};
}

function sweep( k, st, w, t, wash, amount, water, B, rng ) {
	return {
		type: 'sweep',
		k,
		x: st.x,
		y: st.y,
		r: w,
		path: st.pts,
		speed: brushSpeed( B, w ),
		wash,
		level: 0,
		amount,
		water: water * rng.range( 0.9, 1.1 ),
		chaos: 0.1,
		seed: rng.u32(),
		t,
	};
}

function spine( k, st, t, amount, water, rng ) {
	return {
		type: 'detail',
		k,
		x: st.x,
		y: st.y,
		r: st.r,
		path: st.pts,
		trust: true,
		amount,
		water: water * rng.range( 0.85, 1.15 ),
		level: 0,
		chaos: 0.1,
		requireDry: true,
		seed: rng.u32(),
		t,
	};
}
