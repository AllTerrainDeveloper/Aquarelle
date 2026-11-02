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
	{ id: 'drops', name: 'Drops & splashes', t0: 0.0, t1: 0.3, chaos: 1.0 },
	{ id: 'washes', name: 'Brush: cutting in & washes', t0: 0.3, t1: 0.45, chaos: 0.5 },
	{ id: 'washes2', name: 'Brush: washes', t0: 0.45, t1: 0.62, chaos: 0.7 },
	{ id: 'glazes', name: 'Glazes', t0: 0.6, t1: 0.64, chaos: 1.1 },
	{ id: 'details', name: 'Details', t0: 0.62, t1: 0.88, chaos: 0.3 },
	{ id: 'accents', name: 'Accents', t0: 0.86, t1: 0.95, chaos: 1.4 },
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

/* ---------------------------------------------------------------------- */
/* Shared painting geometry                                                */
/* ---------------------------------------------------------------------- */

/**
 * Chamfer distance from each masked cell to the nearest unmasked cell
 * (0 outside). The sheet edge is not a border.
 */
export function depthInside( mask, W, H, cap = Infinity ) {
	const N = W * H;
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
			d[ i ] = Math.min( v, cap );
		}
	}
	return d;
}

/**
 * packDiscs over one patch (`cells`, sheet indices), worked out on its
 * bounding box (plus a margin) instead of the whole sheet: the same discs,
 * in sheet coordinates, for a fraction of the work. Nothing outside the
 * patch is covered beforehand.
 */
export function packDiscsIn( cells, W, H, cap, opts ) {
	let x0 = W;
	let y0 = H;
	let x1 = -1;
	let y1 = -1;
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		x0 = Math.min( x0, x );
		x1 = Math.max( x1, x );
		y0 = Math.min( y0, y );
		y1 = Math.max( y1, y );
	}
	if ( x1 < 0 ) {
		return [];
	}
	// A disc's centre moves off its cell by under its depth: a few cells of
	// margin keep it from the box's edge (the sheet's edge stays where it is).
	const m = 3;
	const bx = Math.max( 0, x0 - m );
	const by = Math.max( 0, y0 - m );
	const bw = Math.min( W - 1, x1 + m ) - bx + 1;
	const bh = Math.min( H - 1, y1 + m ) - by + 1;
	const mask = new Uint8Array( bw * bh );
	for ( const i of cells ) {
		mask[ ( ( ( i / W ) | 0 ) - by ) * bw + ( i % W ) - bx ] = 1;
	}
	// The sheet's edge is not a border: where the box stops short of it, it
	// must not become one either.
	const depth = depthInside( mask, bw, bh, cap );
	const discs = packDiscs( mask, depth, new Uint8Array( bw * bh ), { ...opts, W: bw, H: bh } );
	for ( const d of discs ) {
		d.x += bx;
		d.y += by;
	}
	return discs;
}

/**
 * Largest-first packing: the deepest uncovered cell gets the biggest gesture
 * whose footprint fits (plus a seam so neighbouring washes meet).
 */
export function packDiscs( mask, depth, covered, { W, H, maxR, minR, jitter, seam, rng, limit = Infinity } ) {
	const N = W * H;
	const cand = [];
	for ( let i = 0; i < N; i++ ) {
		if ( mask[ i ] && depth[ i ] * 0.9 >= minR ) {
			cand.push( i );
		}
	}
	cand.sort( ( a, b ) => depth[ b ] - depth[ a ] );
	const discs = [];
	for ( const c of cand ) {
		if ( covered[ c ] || discs.length >= limit ) {
			continue;
		}
		const cx = c % W;
		const cy = ( c / W ) | 0;
		const ang = rng.range( 0, Math.PI * 2 );
		const off = jitter * depth[ c ] * rng.float();
		const x = Math.min( W - 1, Math.max( 0, cx + Math.cos( ang ) * off ) );
		const y = Math.min( H - 1, Math.max( 0, cy + Math.sin( ang ) * off ) );
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
}

/**
 * Centreline strokes for one shape (a list of cell indices): the shape's
 * spine is covered by discs that fit its local width (deepest first), then
 * chained nearest-first into brush paths that follow its curves. The brush
 * lifts between separate parts. Each path is [x, y, r] triples; the tip
 * radius follows the local half-width, like pressure on a round brush.
 */
export function centrelineStrokes( cells, W, { minR = 0.7, maxSamples = 160 } = {} ) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		x0 = Math.min( x0, x );
		y0 = Math.min( y0, y );
		x1 = Math.max( x1, x );
		y1 = Math.max( y1, y );
	}
	// Local grid with a one-cell border so the shape edge counts as outside.
	const lw = x1 - x0 + 3;
	const lh = y1 - y0 + 3;
	const local = new Uint8Array( lw * lh );
	for ( const i of cells ) {
		local[ ( ( ( i / W ) | 0 ) - y0 + 1 ) * lw + ( ( i % W ) - x0 + 1 ) ] = 1;
	}
	const depth = depthInside( local, lw, lh );
	const order = [];
	for ( let i = 0; i < local.length; i++ ) {
		if ( local[ i ] ) {
			order.push( i );
		}
	}
	order.sort( ( a, b ) => depth[ b ] - depth[ a ] );
	const covered = new Uint8Array( local.length );
	const discs = [];
	for ( const c of order ) {
		if ( covered[ c ] ) {
			continue;
		}
		const cx = c % lw;
		const cy = ( c / lw ) | 0;
		const r = Math.max( minR, depth[ c ] * 0.95 );
		discs.push( { x: cx + x0 - 1, y: cy + y0 - 1, r } );
		const rc = Math.max( 1, r );
		for ( let yy = Math.max( 0, Math.floor( cy - rc ) ); yy <= Math.min( lh - 1, Math.ceil( cy + rc ) ); yy++ ) {
			for ( let xx = Math.max( 0, Math.floor( cx - rc ) ); xx <= Math.min( lw - 1, Math.ceil( cx + rc ) ); xx++ ) {
				if ( ( xx - cx ) ** 2 + ( yy - cy ) ** 2 <= rc * rc ) {
					covered[ yy * lw + xx ] = 1;
				}
			}
		}
	}
	if ( ! discs.length ) {
		return [];
	}
	// Start at an extremity (furthest from the centroid), then walk nearest-first.
	let mx = 0;
	let my = 0;
	for ( const d of discs ) {
		mx += d.x;
		my += d.y;
	}
	mx /= discs.length;
	my /= discs.length;
	let start = 0;
	let far = -1;
	discs.forEach( ( d, n ) => {
		const dd = Math.hypot( d.x - mx, d.y - my );
		if ( dd > far ) {
			far = dd;
			start = n;
		}
	} );
	const used = new Uint8Array( discs.length );
	const chains = [];
	let chain = [ discs[ start ] ];
	used[ start ] = 1;
	let cur = discs[ start ];
	for ( let n = 1; n < discs.length; n++ ) {
		let best = -1;
		let bd = Infinity;
		for ( let j = 0; j < discs.length; j++ ) {
			if ( ! used[ j ] ) {
				const dd = Math.hypot( discs[ j ].x - cur.x, discs[ j ].y - cur.y );
				if ( dd < bd ) {
					bd = dd;
					best = j;
				}
			}
		}
		used[ best ] = 1;
		const nxt = discs[ best ];
		// Lift the brush rather than drag it across bare paper.
		if ( bd > ( cur.r + nxt.r ) * 1.6 + 1 ) {
			chains.push( chain );
			chain = [];
		}
		chain.push( nxt );
		cur = nxt;
	}
	chains.push( chain );
	// Densify each chain into a smooth path of tip samples.
	const strokes = [];
	for ( const ch of chains ) {
		const pts = [];
		for ( let n = 0; n < ch.length; n++ ) {
			const a = ch[ n ];
			const b = ch[ n + 1 ];
			pts.push( a.x, a.y, a.r );
			if ( b ) {
				const dist = Math.hypot( b.x - a.x, b.y - a.y );
				const steps = Math.floor( dist / Math.max( 0.5, 0.5 * Math.min( a.r, b.r ) ) );
				for ( let q = 1; q < steps; q++ ) {
					const t = q / steps;
					pts.push( a.x + ( b.x - a.x ) * t, a.y + ( b.y - a.y ) * t, a.r + ( b.r - a.r ) * t );
				}
			}
		}
		// Smooth, evenly paced path; long chains become several strokes.
		const smooth = pts.length >= 9 ? smoothPath( pts, Math.max( 0.6, ( pts.reduce( ( a2, v, q ) => ( 2 === q % 3 ? a2 + v : a2 ), 0 ) / ( pts.length / 3 ) ) * 0.45 ) ) : pts;
		pts.length = 0;
		pts.push( ...smooth );
		for ( let o = 0; o < pts.length; o += maxSamples * 3 ) {
			const part = pts.slice( o, o + maxSamples * 3 + 3 );
			let len = 0;
			let rs = 0;
			for ( let q = 0; q < part.length; q += 3 ) {
				rs += part[ q + 2 ];
				if ( q ) {
					len += Math.hypot( part[ q ] - part[ q - 3 ], part[ q + 1 ] - part[ q - 2 ] );
				}
			}
			strokes.push( { pts: Float32Array.from( part ), len, r: rs / ( part.length / 3 ), x: part[ 0 ], y: part[ 1 ] } );
		}
	}
	return strokes;
}

/**
 * Cells within `margin` of a shape (outside it) that `accept` allows: where a
 * wash may deliberately run past its edge, under a neighbour painted later.
 */
export function expandCells( cells, W, H, margin, accept ) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		x0 = Math.min( x0, x );
		y0 = Math.min( y0, y );
		x1 = Math.max( x1, x );
		y1 = Math.max( y1, y );
	}
	const m = Math.ceil( margin ) + 1;
	const bx = Math.max( 0, x0 - m );
	const by = Math.max( 0, y0 - m );
	const lw = Math.min( W - 1, x1 + m ) - bx + 1;
	const lh = Math.min( H - 1, y1 + m ) - by + 1;
	// Distance from each outside cell to the shape: depth of the complement.
	const outside = new Uint8Array( lw * lh ).fill( 1 );
	for ( const i of cells ) {
		outside[ ( ( ( i / W ) | 0 ) - by ) * lw + ( ( i % W ) - bx ) ] = 0;
	}
	const dist = depthInside( outside, lw, lh );
	const out = [];
	for ( let ly = 0; ly < lh; ly++ ) {
		for ( let lx = 0; lx < lw; lx++ ) {
			const li = ly * lw + lx;
			if ( outside[ li ] && dist[ li ] <= margin ) {
				const i = ( ly + by ) * W + ( lx + bx );
				if ( accept( i ) ) {
					out.push( i );
				}
			}
		}
	}
	return out;
}

/**
 * Strokes that follow a shape's spine the way a hand would: from one tip to
 * the other in one go. The two points furthest apart *through* the shape
 * are found (two breadth-first passes inside it), and the shortest path
 * between them, which never leaves the shape, becomes the stroke. Its tip
 * follows the local half-width. Parts it does not cover (branches, like the
 * bar of an "e") get their own strokes the same way.
 *
 * @return {Object[]} strokes { pts: [x, y, r]..., len, r, x, y }
 */
export function spineStrokes( cells, W, { minR = 0.7, maxStrokes = 60 } = {} ) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		x0 = Math.min( x0, x );
		y0 = Math.min( y0, y );
		x1 = Math.max( x1, x );
		y1 = Math.max( y1, y );
	}
	const lw = x1 - x0 + 3;
	const lh = y1 - y0 + 3;
	const local = new Uint8Array( lw * lh );
	for ( const i of cells ) {
		local[ ( ( ( i / W ) | 0 ) - y0 + 1 ) * lw + ( ( i % W ) - x0 + 1 ) ] = 1;
	}
	const depth = depthInside( local, lw, lh );
	const covered = new Uint8Array( lw * lh );
	const dist = new Int32Array( lw * lh );
	const parent = new Int32Array( lw * lh );
	const queue = new Int32Array( lw * lh );
	const NB = [ -1, 1, -lw, lw, -lw - 1, -lw + 1, lw - 1, lw + 1 ];
	// Breadth-first search inside the shape (and not yet covered) from `src`.
	const bfs = ( src ) => {
		dist.fill( -1 );
		let head = 0;
		let tail = 0;
		queue[ tail++ ] = src;
		dist[ src ] = 0;
		parent[ src ] = -1;
		let far = src;
		while ( head < tail ) {
			const c = queue[ head++ ];
			if ( dist[ c ] > dist[ far ] ) {
				far = c;
			}
			for ( const o of NB ) {
				const n = c + o;
				if ( local[ n ] && ! covered[ n ] && dist[ n ] < 0 ) {
					dist[ n ] = dist[ c ] + 1;
					parent[ n ] = c;
					queue[ tail++ ] = n;
				}
			}
		}
		return far;
	};
	const strokes = [];
	for ( let s = 0; s < maxStrokes; s++ ) {
		// Start from the deepest uncovered cell of what remains.
		let seed = -1;
		let best = 0;
		let left = 0;
		for ( let c = 0; c < local.length; c++ ) {
			if ( local[ c ] && ! covered[ c ] ) {
				left++;
				if ( depth[ c ] > best ) {
					best = depth[ c ];
					seed = c;
				}
			}
		}
		if ( seed < 0 || left < 4 ) {
			break;
		}
		const a = bfs( seed );
		const b = bfs( a );
		// The tip-to-tip path, inside the shape.
		const path = [];
		for ( let c = b; c >= 0; c = parent[ c ] ) {
			path.push( c );
		}
		// A painter draws a branch out from where it joins: start the stroke
		// at the end that touches what is already painted.
		const touches = ( c ) => NB.some( ( o ) => covered[ c + o ] );
		if ( s > 0 && path.length > 1 && touches( path[ path.length - 1 ] ) && ! touches( path[ 0 ] ) ) {
			path.reverse();
		}
		// The first stroke goes from the thicker end to the thinner one (a
		// trunk upward, a brow from its root), as the brush loads and lifts.
		if ( 0 === s && path.length > 1 ) {
			const ends = ( from ) => {
				let d = 0;
				const n = Math.min( path.length, 6 );
				for ( let q = 0; q < n; q++ ) {
					d += depth[ path[ from ? path.length - 1 - q : q ] ];
				}
				return d / n;
			};
			if ( ends( true ) > ends( false ) ) {
				path.reverse();
			}
		}
		if ( path.length < 2 && s > 0 ) {
			// A speck left over: cover it and go on to the next branch.
			covered[ path[ 0 ] ] = 1;
			continue;
		}
		// Light smoothing (a 5-cell moving average) keeps it inside thin shapes.
		const pts = [];
		for ( let q = 0; q < path.length; q++ ) {
			let sx = 0;
			let sy = 0;
			let sr = 0;
			let n = 0;
			for ( let d = -2; d <= 2; d++ ) {
				const c = path[ Math.min( path.length - 1, Math.max( 0, q + d ) ) ];
				sx += c % lw;
				sy += ( c / lw ) | 0;
				sr += depth[ c ];
				n++;
			}
			pts.push( sx / n + x0 - 1, sy / n + y0 - 1, Math.max( minR, ( sr / n ) * 0.95 ) );
		}
		// Mark what this stroke covers.
		for ( const c of path ) {
			const cx = c % lw;
			const cy = ( c / lw ) | 0;
			const rc = Math.max( 1, depth[ c ] ) + 0.5;
			for ( let yy = Math.max( 0, Math.floor( cy - rc ) ); yy <= Math.min( lh - 1, Math.ceil( cy + rc ) ); yy++ ) {
				for ( let xx = Math.max( 0, Math.floor( cx - rc ) ); xx <= Math.min( lw - 1, Math.ceil( cx + rc ) ); xx++ ) {
					if ( ( xx - cx ) ** 2 + ( yy - cy ) ** 2 <= rc * rc ) {
						covered[ yy * lw + xx ] = 1;
					}
				}
			}
		}
		const sm = pts.length >= 9 ? smoothPath( pts, Math.max( 0.6, ( pts.reduce( ( a2, v, q ) => ( 2 === q % 3 ? a2 + v : a2 ), 0 ) / ( pts.length / 3 ) ) * 0.45 ), 1 ) : pts;
		let len = 0;
		let rs = 0;
		for ( let q = 0; q < sm.length; q += 3 ) {
			rs += sm[ q + 2 ];
			if ( q ) {
				len += Math.hypot( sm[ q ] - sm[ q - 3 ], sm[ q + 1 ] - sm[ q - 2 ] );
			}
		}
		strokes.push( { pts: Float32Array.from( sm ), len, r: rs / ( sm.length / 3 ), x: sm[ 0 ], y: sm[ 1 ] } );
	}
	return strokes;
}

/**
 * Turn a polyline of [x, y, r] triples into a hand-like path: corners are
 * cut (Chaikin) so turns become curves, then the path is resampled at even
 * spacing so the tip moves at a steady pace. Width changes smoothly too.
 */
export function smoothPath( pts, spacing, iterations = 3 ) {
	let p = Array.from( pts );
	for ( let it = 0; it < iterations && p.length >= 9; it++ ) {
		const q = [ p[ 0 ], p[ 1 ], p[ 2 ] ];
		for ( let k = 0; k + 5 < p.length; k += 3 ) {
			for ( const t of [ 0.25, 0.75 ] ) {
				q.push( p[ k ] + ( p[ k + 3 ] - p[ k ] ) * t, p[ k + 1 ] + ( p[ k + 4 ] - p[ k + 1 ] ) * t, p[ k + 2 ] + ( p[ k + 5 ] - p[ k + 2 ] ) * t );
			}
		}
		q.push( p[ p.length - 3 ], p[ p.length - 2 ], p[ p.length - 1 ] );
		p = q;
	}
	// Resample by arc length.
	const out = [ p[ 0 ], p[ 1 ], p[ 2 ] ];
	let carry = 0;
	for ( let k = 3; k < p.length; k += 3 ) {
		const ax = p[ k - 3 ];
		const ay = p[ k - 2 ];
		const ar = p[ k - 1 ];
		const seg = Math.hypot( p[ k ] - ax, p[ k + 1 ] - ay );
		let d = spacing - carry;
		while ( d <= seg ) {
			const t = seg > 0 ? d / seg : 0;
			out.push( ax + ( p[ k ] - ax ) * t, ay + ( p[ k + 1 ] - ay ) * t, ar + ( p[ k + 2 ] - ar ) * t );
			d += spacing;
		}
		carry = seg - ( d - spacing );
	}
	if ( p.length > 3 ) {
		out.push( p[ p.length - 3 ], p[ p.length - 2 ], p[ p.length - 1 ] );
	}
	return out;
}

/**
 * How a painter washes one object: cut in the edge where the image really
 * has an edge (strokes along the contour), then carry the wash across in
 * gently wavering rows from top to bottom, alternating direction with
 * rounded turns, so the bead flows and dries evenly. Where the object meets
 * a neighbour softly, or the edge of the sheet, there is no cut-in: the
 * rows simply run on (into the overlap, or off the paper).
 *
 * @param {Object} o { H, edgeNear (strong edge within reach), rng }
 */
export function sweepStrokes( cells, W, w, seam, o, maxSamples = 260 ) {
	const { H, edgeNear, rng } = o;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		x0 = Math.min( x0, x );
		y0 = Math.min( y0, y );
		x1 = Math.max( x1, x );
		y1 = Math.max( y1, y );
	}
	const lw = x1 - x0 + 3;
	const lh = y1 - y0 + 3;
	const local = new Uint8Array( lw * lh );
	for ( const i of cells ) {
		local[ ( ( ( i / W ) | 0 ) - y0 + 1 ) * lw + ( ( i % W ) - x0 + 1 ) ] = 1;
	}
	// The sheet edge is not a border: extend the shape past it.
	for ( let ly = 1; ly < lh - 1; ly++ ) {
		if ( 0 === x0 && local[ ly * lw + 1 ] ) {
			local[ ly * lw ] = 1;
		}
		if ( W - 1 === x1 && local[ ly * lw + lw - 2 ] ) {
			local[ ly * lw + lw - 1 ] = 1;
		}
	}
	for ( let lx = 0; lx < lw; lx++ ) {
		if ( 0 === y0 && local[ lw + lx ] ) {
			local[ lx ] = 1;
		}
		if ( H - 1 === y1 && local[ ( lh - 2 ) * lw + lx ] ) {
			local[ ( lh - 1 ) * lw + lx ] = 1;
		}
	}
	const depth = depthInside( local, lw, lh );
	const at = ( lx, ly ) => {
		const xi = Math.min( lw - 1, Math.max( 0, Math.round( lx ) ) );
		const yi = Math.min( lh - 1, Math.max( 0, Math.round( ly ) ) );
		return yi * lw + xi;
	};
	const strong = ( lx, ly ) => edgeNear[ Math.min( H - 1, Math.max( 0, Math.round( ly + y0 - 1 ) ) ) * W + Math.min( W - 1, Math.max( 0, Math.round( lx + x0 - 1 ) ) ) ];

	// Cut in only along real edges.
	const bandW = w * 0.9;
	const band = [];
	for ( let ly = 1; ly < lh - 1; ly++ ) {
		for ( let lx = 1; lx < lw - 1; lx++ ) {
			const li = ly * lw + lx;
			if ( local[ li ] && depth[ li ] <= bandW && strong( lx, ly ) ) {
				band.push( ( ly + y0 - 1 ) * W + ( lx + x0 - 1 ) );
			}
		}
	}
	const finish = ( raw, edge ) => {
		const sm = smoothPath( raw, Math.max( 0.6, w * 0.45 ) );
		const out = [];
		for ( let o2 = 0; o2 < sm.length; o2 += maxSamples * 3 ) {
			const part = sm.slice( o2, o2 + maxSamples * 3 + 3 );
			if ( part.length < 6 ) {
				continue;
			}
			let len = 0;
			for ( let q = 3; q < part.length; q += 3 ) {
				len += Math.hypot( part[ q ] - part[ q - 3 ], part[ q + 1 ] - part[ q - 2 ] );
			}
			out.push( { pts: Float32Array.from( part ), len, r: w, x: part[ 0 ], y: part[ 1 ], edge } );
		}
		return out;
	};
	const strokes = [];
	if ( band.length ) {
		// One continuous line along the contour, half a band inside the edge
		// (an iso-line of the distance to the edge), ordered into long paths.
		const mid = bandW * 0.5;
		const iso = [];
		for ( let ly = 1; ly < lh - 1; ly++ ) {
			for ( let lx = 1; lx < lw - 1; lx++ ) {
				const li = ly * lw + lx;
				if ( local[ li ] && Math.abs( depth[ li ] - mid ) < 0.75 && strong( lx, ly ) ) {
					iso.push( lx, ly );
				}
			}
		}
		const n = iso.length / 2;
		const used = new Uint8Array( n );
		// Grid buckets for nearest-point lookup along the line.
		const cell = 3;
		const gw = Math.ceil( lw / cell );
		const buckets = new Map();
		for ( let q = 0; q < n; q++ ) {
			const key = Math.floor( iso[ q * 2 ] / cell ) + gw * Math.floor( iso[ q * 2 + 1 ] / cell );
			if ( ! buckets.has( key ) ) {
				buckets.set( key, [] );
			}
			buckets.get( key ).push( q );
		}
		const nearest = ( x, y, maxD ) => {
			let best = -1;
			let bd = maxD;
			const bx = Math.floor( x / cell );
			const by = Math.floor( y / cell );
			const reach = Math.ceil( maxD / cell );
			for ( let dy = -reach; dy <= reach; dy++ ) {
				for ( let dx = -reach; dx <= reach; dx++ ) {
					for ( const q of buckets.get( bx + dx + gw * ( by + dy ) ) || [] ) {
						if ( ! used[ q ] ) {
							const d = Math.hypot( iso[ q * 2 ] - x, iso[ q * 2 + 1 ] - y );
							if ( d < bd ) {
								bd = d;
								best = q;
							}
						}
					}
				}
			}
			return best;
		};
		const tip = Math.max( 0.9, bandW * 0.6 );
		for ( let s0 = 0; s0 < n; s0++ ) {
			if ( used[ s0 ] ) {
				continue;
			}
			// Walk both ways from the seed so the line is not split in the middle.
			const walkFrom = ( q0 ) => {
				const seq = [];
				let q = q0;
				while ( q >= 0 ) {
					used[ q ] = 1;
					seq.push( q );
					q = nearest( iso[ q * 2 ], iso[ q * 2 + 1 ], 2.5 );
				}
				return seq;
			};
			used[ s0 ] = 1;
			const fwd = walkFrom( nearest( iso[ s0 * 2 ], iso[ s0 * 2 + 1 ], 2.5 ) );
			const back = walkFrom( nearest( iso[ s0 * 2 ], iso[ s0 * 2 + 1 ], 2.5 ) );
			const order = back.filter( ( q ) => q >= 0 ).reverse().concat( [ s0 ], fwd.filter( ( q ) => q >= 0 ) );
			if ( order.length < 4 ) {
				continue;
			}
			const raw = [];
			for ( const q of order ) {
				raw.push( iso[ q * 2 ] + x0 - 1, iso[ q * 2 + 1 ] + y0 - 1, tip );
			}
			strokes.push( ...finish( raw, true ) );
		}
	}
	// A cell can take the full tip if it is deep inside, or if the border
	// near it is soft (no real edge): there the wash simply runs on.
	const roomy = ( lx, ly ) => {
		const li = at( lx, ly );
		return local[ li ] && ( depth[ li ] >= w * 0.5 || ! strong( lx, ly ) );
	};
	// Whether the straight line between two local points leaves the shape.
	const leaves = ( ax, ay, bx, by ) => {
		const n = Math.ceil( Math.hypot( bx - ax, by - ay ) );
		for ( let q = 1; q < n; q++ ) {
			if ( ! local[ at( ax + ( ( bx - ax ) * q ) / n, ay + ( ( by - ay ) * q ) / n ) ] ) {
				return true;
			}
		}
		return false;
	};
	let raw = [];
	let lastX = 0;
	let lastY = 0;
	let row = 0;
	const flush = () => {
		if ( raw.length >= 6 ) {
			strokes.push( ...finish( raw, false ) );
		}
		raw = [];
	};
	const phase = rng.range( 0, Math.PI * 2 );
	const wave = rng.range( 0.012, 0.03 );
	for ( let ly = 1 + w * 0.6; ly < lh - 1; ly += w * rng.range( 1.25, 1.55 ), row++ ) {
		const runs = [];
		let start = -1;
		for ( let lx = 0; lx < lw; lx++ ) {
			const on = roomy( lx, ly );
			if ( on && start < 0 ) {
				start = lx;
			}
			if ( ( ! on || lx === lw - 1 ) && start >= 0 ) {
				runs.push( [ start, on ? lx : lx - 1 ] );
				start = -1;
			}
		}
		if ( row & 1 ) {
			runs.reverse();
		}
		for ( const [ a0, a1 ] of runs ) {
			const from = row & 1 ? a1 : a0;
			const to = row & 1 ? a0 : a1;
			const gy = ly + y0 - 1;
			// The brush lifts between two runs that are far apart, or whose
			// straight join leaves the shape (a notch of sky between two tall
			// buildings): carried across, it would paint the gap.
			if ( raw.length && ( Math.hypot( from + x0 - 1 - lastX, gy - lastY ) > w * 3 || leaves( lastX - x0 + 1, lastY - y0 + 1, from, ly ) ) ) {
				flush();
			}
			const n = Math.max( 1, Math.ceil( Math.abs( to - from ) / Math.max( 0.6, w * 0.5 ) ) );
			for ( let q = 0; q <= n; q++ ) {
				const lx = from + ( ( to - from ) * q ) / n;
				// The row wavers a little, as a hand does.
				const wy = ly + Math.sin( ( lx + x0 ) * wave + phase + row ) * w * 0.22;
				const li = at( lx, wy );
				// The tip never reaches past the (already expanded) shape.
				const r = Math.min( w, depth[ li ] + seam * 0.5 );
				lastX = lx + x0 - 1;
				lastY = wy + y0 - 1;
				raw.push( lastX, lastY, Math.max( 0.8, r ) );
			}
		}
	}
	flush();
	return strokes;
}

export function planComposition( an, { duration, seed, density = 1, fineDetail = { strokes: 1, fine: 1 } } ) {
	const t0 = performance.now();
	const rng = new Rng( ( seed ^ 0x9e3779b9 ) >>> 0 );
	const { W, H, B, pigments, T, edge, detail, importance, scale, darkness, labels, regions, regionOf, reserve } = an;
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
	const depthIn = ( mask ) => depthInside( mask, W, H, B );
	const pack = ( mask, depth, covered, maxR, minR, jitter ) => packDiscs( mask, depth, covered, { W, H, maxR, minR, jitter, seam, rng } );
	const seam = Math.max( 2, B * 0.015 );
	const leftover = []; // per pigment: cells no object covered (for stage 4)
	const fixedOps = []; // object sweeps and charges, already timed

	/* Object by object, like a painter: back to front, light to dark ---- */
	// The large segmented regions are the objects (sky, hair, face, coat).
	// Background objects (touching the sheet edge, unimportant, big) and light
	// ones come first; the subject and darks come later. Each object is
	// painted in one go: its main colour carried down in wet-edge sweeps,
	// then its secondary colours and shadow charged in while it is still wet.
	// The next object is never one that touches a still-wet object.
	const minObj = Math.max( 30, ( B * 0.035 ) ** 2 );
	const objects = [];
	const objOf = new Int32Array( N ).fill( -1 );
	const regIndex = new Int32Array( regions.length ).fill( -1 );
	regions.forEach( ( reg, r ) => {
		if ( reg.area >= minObj && ! pigments[ reg.label ].isPaper ) {
			regIndex[ r ] = objects.length;
			objects.push( { reg, cells: [] } );
		}
	} );
	for ( let i = 0; i < N; i++ ) {
		const o = regIndex[ regionOf[ i ] ];
		if ( o >= 0 ) {
			objOf[ i ] = o;
			objects[ o ].cells.push( i );
		}
	}
	const adj = objects.map( () => new Set() );
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			const i = y * W + x;
			const a = objOf[ i ];
			if ( a < 0 ) {
				continue;
			}
			for ( const j2 of [ x < W - 1 ? i + 1 : -1, y < H - 1 ? i + W : -1 ] ) {
				const b = j2 >= 0 ? objOf[ j2 ] : -1;
				if ( b >= 0 && b !== a ) {
					adj[ a ].add( b );
					adj[ b ].add( a );
				}
			}
		}
	}
	for ( const ob of objects ) {
		const reg = ob.reg;
		// Main colour: the pigment the object calls for most.
		const sums = new Float64Array( K );
		for ( const i of ob.cells ) {
			for ( let k = 0; k < K; k++ ) {
				sums[ k ] += T[ 0 ][ k ][ i ];
			}
		}
		let main = reg.label;
		for ( let k = 0; k < K; k++ ) {
			if ( ! pigments[ k ].isPaper && sums[ k ] > sums[ main ] ) {
				main = k;
			}
		}
		ob.main = main;
		ob.sums = sums;
		const border = reg.minX <= 1 || reg.minY <= 1 || reg.maxX >= W - 2 || reg.maxY >= H - 2;
		// Biggest colour areas first, as a painter lays in the big masses; then
		// light before dark and background before subject.
		ob.key = -3 * ( reg.area / N ) + 0.5 * ( 1 - pigments[ main ].L ) + 0.2 * reg.importance - ( border ? 0.1 : 0 );
	}
	const pending = objects.map( ( o, n ) => n ).sort( ( a, b ) => objects[ a ].key - objects[ b ].key );
	const sequence = [];
	const recent = [];
	while ( pending.length ) {
		let pick = pending.findIndex( ( o ) => ! recent.some( ( r ) => adj[ o ].has( r ) ) );
		if ( pick < 0 ) {
			pick = 0;
		}
		const o = pending.splice( pick, 1 )[ 0 ];
		sequence.push( o );
		recent.push( o );
		if ( recent.length > 2 ) {
			recent.shift();
		}
	}
	// Where the image has a real edge within reach (cut-in happens only there).
	const edgeNear = new Uint8Array( N );
	{
		const er = Math.max( 2, Math.ceil( B * 0.012 ) );
		const strongEdge = new Uint8Array( N );
		for ( let i = 0; i < N; i++ ) {
			strongEdge[ i ] = edge[ i ] > 0.3 ? 1 : 0;
		}
		const far = depthInside( strongEdge.map( ( v ) => 1 - v ), W, H, B );
		for ( let i = 0; i < N; i++ ) {
			edgeNear[ i ] = far[ i ] <= er ? 1 : 0;
		}
	}
	const orderPos = new Int32Array( objects.length ).fill( -1 );
	sequence.forEach( ( o, n ) => ( orderPos[ o ] = n ) );
	const whiteish = ( i ) => bestT[ i ] < 0.05 || reserve[ i ];
	// Build the sweeps; pick brush sizes so the whole sequence fits the time
	// one hand has (about the first 55% of the painting).
	const window = 0.32 * duration;
	const speedOf = ( w ) => Math.max( B * 0.35, w * 14 );
	let brushScale = 1;
	let plan = null;
	for ( let attempt = 0; attempt < 3; attempt++ ) {
		plan = [];
		let total = 0;
		for ( const o of sequence ) {
			const ob = objects[ o ];
			const main = ob.main;
			const own = ob.cells.filter( ( i ) => T[ 0 ][ main ][ i ] >= 0.35 * bestT[ i ] && T[ 0 ][ main ][ i ] > 0.08 );
			if ( own.length < 6 ) {
				continue;
			}
			const thick = Math.sqrt( own.length / Math.PI );
			// Near-white colours barely show: a big brush, quickly.
			const faint = Math.max( ...pigments[ main ].A ) < 0.6;
			const w = Math.min( B * ( faint ? 0.09 : 0.05 ), Math.max( B * 0.01, thick * ( faint ? 0.8 : 0.45 ) * brushScale ) );
			// Run deliberately past the edge, under neighbours painted later (and
			// small unassigned bits), never under earlier ones or into whites.
			const pos = orderPos[ o ];
			const margin = Math.max( 3, w * 1.2 );
			let dark = 0;
			for ( const i of own ) {
				dark += darkness[ i ];
			}
			dark /= own.length;
			const extra = expandCells( own, W, H, margin, ( i ) => {
				// Never spill into a clearly lighter area (that reads as a dark halo).
				if ( whiteish( i ) || darkness[ i ] < dark - 0.08 ) {
					return false;
				}
				const other = objOf[ i ];
				// Under later neighbours always; under earlier ones only where the
				// border is soft (no real edge), so gradients blend.
				return other < 0 || orderPos[ other ] > pos || ! edgeNear[ i ];
			} );
			const cells = own.concat( extra );
			const strokes = sweepStrokes( cells, W, w, seam, { H, edgeNear, rng } );
			let secs = 0;
			for ( const st of strokes ) {
				secs += 0.45 + st.len / speedOf( w );
			}
			total += secs;
			plan.push( { o, own, cells, w, strokes, secs } );
		}
		if ( total <= window * 0.92 ) {
			break;
		}
		brushScale *= Math.sqrt( total / ( window * 0.92 ) );
	}
	// Two acts, like a painter blocking in loosely and then refining:
	// act 1 (about the first 30%) is drops — every object's pours with its
	// colours charged in wet-in-wet; act 2 is the brush, which then cuts in,
	// washes and perfects whatever the drops left (it measures need against
	// the dried paint).
	let td = duration * 0.01;
	let tc = duration * 0.3;
	for ( const item of plan ) {
		const ob = objects[ item.o ];
		const main = ob.main;
		const stage = tc < duration * 0.45 ? 1 : 2;
		// Pour first: a few big drops of the object's colour land inside it
		// (sized to fit), then the brush pulls them out into the wash.
		{
			const m = new Uint8Array( N );
			for ( const i of item.own ) {
				m[ i ] = 1;
			}
			const pours = packDiscs( m, depthInside( m, W, H, B ), new Uint8Array( N ), { W, H, maxR: B * 0.1, minR: B * 0.02, jitter: 0.3, seam: 0, rng, limit: 4 + rng.int( 5 ) } );
			for ( const d of pours ) {
				fixedOps.push( {
					type: 'wash',
					k: main,
					x: d.x,
					y: d.y,
					r: d.fit / 1.25,
					fit: d.fit,
					drop: true,
					level: 1,
					amount: 0.6,
					// Darks rich and dry, lights wet: dark paint must not wick out.
					water: ( 0.35 + 0.5 * pigments[ main ].L ) * rng.range( 0.9, 1.1 ),
					chaos: 0.2,
					stage: 0,
					t: td,
					seed: rng.u32(),
					fixed: true,
				} );
				td += rng.range( 0.5, 0.9 );
			}
		}
		for ( const st of item.strokes ) {
			const secs = 0.45 + st.len / speedOf( item.w );
			fixedOps.push( {
				type: 'sweep',
				k: main,
				x: st.x,
				y: st.y,
				r: item.w,
				path: st.pts,
				speed: speedOf( item.w ),
				// All rows of one object's wash share what is already painted.
				wash: item.o,
				level: 1,
				amount: 0.8,
				// Darks are mixed richer and drier, lights wetter.
				water: ( 0.3 + 0.4 * pigments[ main ].L ) * rng.range( 0.9, 1.1 ),
				chaos: 0.1,
				stage,
				t: tc,
				seed: rng.u32(),
				fixed: true,
			} );
			tc += secs;
		}
		// Charge while wet: secondary colours and the darker side of the main
		// colour dropped into the fresh wash, where the object calls for them.
		const charges = [];
		const meanMain = ob.sums[ main ] / ob.cells.length;
		for ( let k = 0; k < K; k++ ) {
			if ( pigments[ k ].isPaper ) {
				continue;
			}
			// Secondary colours, and the darker side of the main colour, are
			// dropped into the wet wash.
			const isMain = k === main;
			if ( ! isMain && ob.sums[ k ] < 0.15 * ob.sums[ main ] ) {
				continue;
			}
			const sub = new Uint8Array( N );
			let cnt = 0;
			for ( const i of ob.cells ) {
				const v = T[ 0 ][ k ][ i ];
				if ( isMain ? v > meanMain * 1.2 : v >= 0.35 * bestT[ i ] && v > 0.05 ) {
					sub[ i ] = 1;
					cnt++;
				}
			}
			if ( cnt < 8 ) {
				continue;
			}
			for ( const d of packDiscs( sub, depthInside( sub, W, H, B ), new Uint8Array( N ), { W, H, maxR: B * 0.06, minR: B * 0.012, jitter: 0.25, seam: 0, rng, limit: isMain ? 3 : 5 } ) ) {
				charges.push( { k, d } );
			}
		}
		let tw = td;
		for ( const { k, d } of charges ) {
			tw += rng.range( 0.25, 0.7 );
			fixedOps.push( {
				type: 'wash',
				k,
				x: d.x,
				y: d.y,
				r: d.fit / 1.25,
				fit: d.fit,
				drop: true,
				level: 0,
				amount: 0.5,
				// Charged into wet paint: lots of water so it melts in softly.
				water: ( 0.35 + 0.55 * pigments[ k ].L ) * rng.range( 0.9, 1.1 ),
				soft: 0.75,
				chaos: 0.15,
				stage: 0,
				t: Math.max( 0, tw ),
				seed: rng.u32(),
				fixed: true,
			} );
		}
		// A breath before the next object.
		td = tw + rng.range( 0.4, 1.0 );
		tc += rng.range( 0.4, 1.0 );
	}

	// Whatever no object covered (small regions, slivers) goes to the fine
	// brush in stage 4.
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		const area = areaOf( k, T[ 1 ][ k ] );
		const rest = new Uint8Array( N );
		for ( let i = 0; i < N; i++ ) {
			rest[ i ] = area[ i ] && objOf[ i ] < 0 ? 1 : 0;
		}
		leftover[ k ] = rest;
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
	// Transitions now happen as wet-in-wet charges inside each object.
	const n3 = 0;
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
	// white letter, an eyelid), plus what no packed wash reached. Each such
	// shape is painted with near-dry strokes that follow its centreline, the
	// tip widening and narrowing with it. One hand, natural pace: strokes fit
	// in the time the stage allows, most visible first; the rest is left to
	// the step-back passes and corrections.
	// One shape is one shape whatever pigments mix in it (a brow is two
	// darks): shapes are found across colours, the main pigment paints the
	// spine and a secondary one glazes along it. A shape is painted whole or
	// not at all.
	const resid = ( k, i ) => {
		const v = T[ 0 ][ k ][ i ];
		if ( v <= 0.08 ) {
			return 0;
		}
		const r = v - T[ 1 ][ k ][ i ];
		return r > 0.05 ? r : leftover[ k ] && leftover[ k ][ i ] ? v : 0;
	};
	const inShape = ( i ) => {
		for ( let k = 0; k < K; k++ ) {
			if ( ! pigments[ k ].isPaper && resid( k, i ) > 0 ) {
				return true;
			}
		}
		return false;
	};
	const shapes = [];
	const seen = new Uint8Array( N );
	const stack = new Int32Array( N );
	for ( let s0 = 0; s0 < N; s0++ ) {
		if ( seen[ s0 ] || ! inShape( s0 ) ) {
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
			const nb = [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1 ];
			for ( const j2 of nb ) {
				if ( j2 >= 0 && ! seen[ j2 ] && inShape( j2 ) ) {
					seen[ j2 ] = 1;
					stack[ sp++ ] = j2;
				}
			}
		}
		if ( cells.length < 4 ) {
			continue;
		}
		const masses = new Float64Array( K );
		let imp = 0;
		for ( const c of cells ) {
			imp += importance[ c ];
			for ( let k = 0; k < K; k++ ) {
				if ( ! pigments[ k ].isPaper ) {
					masses[ k ] += resid( k, c );
				}
			}
		}
		let k1 = -1;
		let k2 = -1;
		for ( let k = 0; k < K; k++ ) {
			if ( k1 < 0 || masses[ k ] > masses[ k1 ] ) {
				k2 = k1;
				k1 = k;
			} else if ( k2 < 0 || masses[ k ] > masses[ k2 ] ) {
				k2 = k;
			}
		}
		const strokes = spineStrokes( cells, W );
		let len = 0;
		let rr = 0;
		for ( const st of strokes ) {
			len += st.len;
			rr += st.r;
		}
		rr /= Math.max( 1, strokes.length );
		// No fiddly dabs: the shape as a whole must make a real stroke.
		if ( ! strokes.length || len < Math.max( 3 * rr, B * 0.02 ) ) {
			continue;
		}
		const glaze = k2 >= 0 && masses[ k2 ] >= 0.3 * masses[ k1 ] ? k2 : -1;
		let secs = 0;
		for ( const st of strokes ) {
			secs += ( 0.55 + st.len / ( B * 0.3 ) ) * ( glaze >= 0 ? 2 : 1 );
		}
		shapes.push( { k: k1, glaze, strokes, secs, mass: masses[ k1 ] * ( imp / cells.length ) } );
	}
	// Most visible shapes first, within the time one hand has in this stage.
	shapes.sort( ( a, b ) => b.mass - a.mass );
	const handSeconds = ( STAGES[ 4 ].t1 - STAGES[ 4 ].t0 ) * duration * 0.5 * fineDetail.strokes * density;
	let used = 0;
	for ( const sh of shapes ) {
		if ( used + sh.secs > handSeconds ) {
			continue;
		}
		used += sh.secs;
		const order = darkness[ at( sh.strokes[ 0 ].x, sh.strokes[ 0 ].y ) ] + rng.range( 0, 0.2 );
		for ( const st of sh.strokes ) {
			add( 4, {
				type: 'detail',
				k: sh.k,
				x: st.x,
				y: st.y,
				r: st.r,
				path: st.pts,
				trust: true,
				amount: 0.95,
				water: rng.range( 0.1, 0.16 ),
				level: 0,
				chaos: 0.1,
				requireDry: true,
				order,
			} );
			if ( sh.glaze >= 0 ) {
				// A second, thin layer along the same spine with the other dark.
				add( 4, {
					type: 'detail',
					k: sh.glaze,
					x: st.x,
					y: st.y,
					r: st.r * 0.85,
					path: st.pts,
					trust: true,
					amount: 0.85,
					water: rng.range( 0.1, 0.16 ),
					level: 0,
					chaos: 0.1,
					requireDry: true,
					order: order + 0.05,
				} );
			}
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
		// Splashes belong to the loose first act, with the drops.
		add( 0, {
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

	ops.push( ...fixedOps );

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
	const nC = Math.min( Math.round( ops.length * 0.2 ), Math.round( 0.41 * duration * 0.12 * Math.sqrt( fineDetail.strokes ) ) );
	for ( let j = 0; j < nC; j++ ) {
		const u = ( j + rng.float() ) / nC;
		const t = duration * ( 0.56 + 0.41 * Math.pow( u, 0.85 ) );
		ops.push( { type: 'correct', stage: stageAt( t / duration ), seed: rng.u32(), t, chaos: 0.5 } );
	}

	ops.sort( ( a, b ) => a.t - b.t );
	// Object sweeps keep their own order and timing; sessions apply to the rest.
	const all = ops;
	const free = ops.filter( ( o ) => ! o.fixed );

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
	for ( let i = 0; i < free.length; ) {
		const tEnd = free[ i ].t + sessionLen;
		let j = i;
		while ( j < free.length && free[ j ].t < tEnd ) {
			j++;
		}
		const chunk = free.slice( i, j );
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
			free[ i + n ] = o;
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

	all.sort( ( a, b ) => a.t - b.t );

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
 * Step-back pass: look at the painting as it is, find where each colour is
 * still bare or clearly too light, glaze the larger such areas with washes
 * sized to fit and paint the rest along its centreline. Returned grouped by
 * colour and walked nearest-first from the brush. `budget` is hand seconds.
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
	const seam = Math.max( 2, B * 0.015 );
	for ( let k = 0; k < K; k++ ) {
		if ( pigments[ k ].isPaper ) {
			continue;
		}
		const Tk = T0[ k ];
		const dk = model.d[ k ];
		const gk = model.g[ k ];
		// Still bare, or clearly too light (shadows, modelling), where k belongs.
		const mask = new Uint8Array( N );
		let any = 0;
		for ( let i = 0; i < N; i++ ) {
			const need = Tk[ i ] - dk[ i ] - gk[ i ];
			if ( Tk[ i ] > 0.06 && Tk[ i ] >= 0.35 * bestT[ i ] && ! model.reserve[ i ] && need > Math.max( 0.04, 0.3 * Tk[ i ] ) ) {
				mask[ i ] = 1;
				any++;
			}
		}
		if ( any < 4 ) {
			continue;
		}
		// Larger areas get a glaze sized to fit (a drop or a brush wash) ...
		const covered = new Uint8Array( N );
		const discs = packDiscs( mask, depthInside( mask, W, H, B ), covered, { W, H, maxR: B * 0.06, minR: B * 0.03, jitter: 0.2, seam, rng, limit: 40 } );
		for ( const d of discs ) {
			const i = Math.round( d.y ) * W + Math.round( d.x );
			pieces.push( {
				type: 'wash',
				k,
				x: d.x,
				y: d.y,
				r: d.fit / 1.25,
				fit: d.fit,
				level: 0,
				amount: 0.85,
				water: rng.range( 0.35, 0.55 ),
				chaos: 0.15,
				seed: rng.u32(),
				mass: Tk[ i ] * importance[ i ] * d.fit * d.fit,
				hand: 0.4 + d.fit / ( B * 0.06 ),
			} );
		}
		// ... and what remains is painted along its centreline.
		const rest = ( i ) => mask[ i ] && ! covered[ i ];
		seen.fill( 0 );
		for ( let s0 = 0; s0 < N; s0++ ) {
			if ( seen[ s0 ] || ! rest( s0 ) ) {
				continue;
			}
			let sp = 0;
			stack[ sp++ ] = s0;
			seen[ s0 ] = 1;
			const cells = [];
			let mass = 0;
			while ( sp > 0 ) {
				const i = stack[ --sp ];
				cells.push( i );
				mass += Tk[ i ] * importance[ i ];
				const x = i % W;
				const y = ( i / W ) | 0;
				const nb = [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1 ];
				for ( const j2 of nb ) {
					if ( j2 >= 0 && ! seen[ j2 ] && rest( j2 ) ) {
						seen[ j2 ] = 1;
						stack[ sp++ ] = j2;
					}
				}
			}
			if ( cells.length < 4 ) {
				continue;
			}
			const strokes = spineStrokes( cells, W );
			let total = 0;
			for ( const st of strokes ) {
				total += st.len;
			}
			if ( total < B * 0.02 ) {
				continue;
			}
			for ( const st of strokes ) {
				pieces.push( {
					trust: true,
					type: 'detail',
					k,
					x: st.x,
					y: st.y,
					r: st.r,
					path: st.pts,
					amount: 0.95,
					water: rng.range( 0.1, 0.18 ),
					level: 0,
					chaos: 0.1,
					requireDry: true,
					seed: rng.u32(),
					mass: mass / strokes.length,
					hand: 0.55 + st.len / ( B * 0.3 ),
				} );
			}
		}
	}
	bestT = null;
	// Most visible gaps first, within the seconds the hand has in the window.
	pieces.sort( ( a, b ) => b.mass - a.mass );
	const chosen = [];
	let used = 0;
	for ( const p of pieces ) {
		if ( used + p.hand <= budget ) {
			used += p.hand;
			chosen.push( p );
		}
	}
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

/**
 * sweepStrokes with the rows running at an angle (radians; 0 = horizontal):
 * the shape is turned so its painting direction is horizontal, swept, and
 * the strokes are turned back. A painter follows the form: down a cypress,
 * along a frame, across a field.
 */
export function orientedSweepStrokes( cells, W, w, seam, o, angle, maxSamples ) {
	if ( Math.abs( Math.sin( angle ) ) < 0.08 ) {
		return sweepStrokes( cells, W, w, seam, o, maxSamples );
	}
	const { H, edgeNear } = o;
	const c = Math.cos( angle );
	const s = Math.sin( angle );
	const inShape = new Set( cells );
	let u0 = Infinity;
	let v0 = Infinity;
	let u1 = -Infinity;
	let v1 = -Infinity;
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		const u = x * c + y * s;
		const v = -x * s + y * c;
		u0 = Math.min( u0, u );
		v0 = Math.min( v0, v );
		u1 = Math.max( u1, u );
		v1 = Math.max( v1, v );
	}
	// Padding keeps the turned shape off the virtual sheet's edges.
	const pad = 3;
	const VW = Math.ceil( u1 - u0 ) + 2 * pad + 1;
	const VH = Math.ceil( v1 - v0 ) + 2 * pad + 1;
	const vEdge = new Uint8Array( VW * VH );
	const vcells = [];
	const toX = ( vu, vv ) => ( vu + u0 - pad ) * c - ( vv + v0 - pad ) * s;
	const toY = ( vu, vv ) => ( vu + u0 - pad ) * s + ( vv + v0 - pad ) * c;
	for ( let vv = 0; vv < VH; vv++ ) {
		for ( let vu = 0; vu < VW; vu++ ) {
			const x = Math.round( toX( vu, vv ) );
			const y = Math.round( toY( vu, vv ) );
			if ( x < 0 || y < 0 || x >= W || y >= H ) {
				continue;
			}
			const i = y * W + x;
			vEdge[ vv * VW + vu ] = edgeNear[ i ];
			if ( inShape.has( i ) ) {
				vcells.push( vv * VW + vu );
			}
		}
	}
	const strokes = sweepStrokes( vcells, VW, w, seam, { ...o, H: VH, edgeNear: vEdge }, maxSamples );
	for ( const st of strokes ) {
		const p = st.pts;
		for ( let q = 0; q < p.length; q += 3 ) {
			const x = toX( p[ q ], p[ q + 1 ] );
			const y = toY( p[ q ], p[ q + 1 ] );
			p[ q ] = Math.min( W - 1, Math.max( 0, x ) );
			p[ q + 1 ] = Math.min( H - 1, Math.max( 0, y ) );
		}
		st.x = p[ 0 ];
		st.y = p[ 1 ];
	}
	return strokes;
}

/**
 * The direction a painter would stroke a shape (radians, 0 = horizontal):
 * along the image's own texture where it has a clear direction (structure
 * tensor of lightness), else along the shape's long axis, else across.
 */
export function strokeAngle( cells, W, gx, gy ) {
	let jxx = 0;
	let jxy = 0;
	let jyy = 0;
	let mx = 0;
	let my = 0;
	for ( const i of cells ) {
		jxx += gx[ i ] * gx[ i ];
		jxy += gx[ i ] * gy[ i ];
		jyy += gy[ i ] * gy[ i ];
		mx += i % W;
		my += ( i / W ) | 0;
	}
	const tr = jxx + jyy;
	if ( tr > 1e-9 ) {
		const coh = Math.sqrt( ( jxx - jyy ) ** 2 + 4 * jxy * jxy ) / tr;
		if ( coh > 0.25 ) {
			// Strokes run along the edges and grain: across the gradient.
			return 0.5 * Math.atan2( 2 * jxy, jxx - jyy ) + Math.PI / 2;
		}
	}
	mx /= cells.length;
	my /= cells.length;
	let cxx = 0;
	let cxy = 0;
	let cyy = 0;
	for ( const i of cells ) {
		const dx = ( i % W ) - mx;
		const dy = ( ( i / W ) | 0 ) - my;
		cxx += dx * dx;
		cxy += dx * dy;
		cyy += dy * dy;
	}
	const d = Math.sqrt( ( cxx - cyy ) ** 2 + 4 * cxy * cxy );
	const l1 = ( cxx + cyy + d ) / 2;
	const l2 = ( cxx + cyy - d ) / 2;
	if ( l1 > 2.5 * Math.max( 1e-6, l2 ) ) {
		return 0.5 * Math.atan2( 2 * cxy, cxx - cyy );
	}
	return 0;
}

/**
 * The soft borders of a shape (where the image has no real edge), traced
 * as continuous lines for a damp, clean brush: run along the edge while the
 * shape is still wet, it lets the colour fade out instead of stopping hard.
 * Returns strokes like sweepStrokes ({ pts: [x, y, r, ...], len, r, x, y }).
 */
export function softEdgeStrokes( cells, W, H, edgeNear, tip, maxSamples = 260 ) {
	const inShape = new Set( cells );
	// Border cells on a soft edge (not on the sheet's own edge).
	const pts = [];
	const key = new Map();
	for ( const i of cells ) {
		const x = i % W;
		const y = ( i / W ) | 0;
		if ( x === 0 || y === 0 || x === W - 1 || y === H - 1 || edgeNear[ i ] ) {
			continue;
		}
		if ( ! inShape.has( i - 1 ) || ! inShape.has( i + 1 ) || ! inShape.has( i - W ) || ! inShape.has( i + W ) ) {
			key.set( i, pts.length );
			pts.push( i );
		}
	}
	const used = new Uint8Array( pts.length );
	const next = ( i ) => {
		const x = i % W;
		for ( const d of [ 1, -1, W, -W, W + 1, W - 1, -W + 1, -W - 1 ] ) {
			const j = i + d;
			const q = key.get( j );
			if ( undefined !== q && ! used[ q ] && Math.abs( ( j % W ) - x ) <= 1 ) {
				return q;
			}
		}
		return -1;
	};
	const strokes = [];
	for ( let s0 = 0; s0 < pts.length; s0++ ) {
		if ( used[ s0 ] ) {
			continue;
		}
		// Walk both ways from the seed so a line is not split in the middle.
		const walk = ( q0 ) => {
			const seq = [];
			let q = q0;
			while ( q >= 0 ) {
				used[ q ] = 1;
				seq.push( q );
				q = next( pts[ q ] );
			}
			return seq;
		};
		used[ s0 ] = 1;
		const fwd = walk( next( pts[ s0 ] ) );
		const back = walk( next( pts[ s0 ] ) );
		const order = back.filter( ( q ) => q >= 0 ).reverse().concat( [ s0 ], fwd.filter( ( q ) => q >= 0 ) );
		if ( order.length < 6 ) {
			continue;
		}
		const raw = [];
		for ( const q of order ) {
			raw.push( pts[ q ] % W, ( pts[ q ] / W ) | 0, tip );
		}
		const sm = smoothPath( raw, Math.max( 0.6, tip * 0.45 ) );
		for ( let o = 0; o < sm.length; o += maxSamples * 3 ) {
			const part = sm.slice( o, o + maxSamples * 3 + 3 );
			if ( part.length < 6 ) {
				continue;
			}
			let len = 0;
			for ( let q = 3; q < part.length; q += 3 ) {
				len += Math.hypot( part[ q ] - part[ q - 3 ], part[ q + 1 ] - part[ q - 2 ] );
			}
			strokes.push( { pts: Float32Array.from( part ), len, r: tip, x: part[ 0 ], y: part[ 1 ], edge: false } );
		}
	}
	return strokes;
}
