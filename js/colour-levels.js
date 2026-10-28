/**
 * ColourLevels — the picture as a painter first sees it: the palette's few
 * most prominent colours in big areas, then more of the palette in smaller
 * areas, and only at the end every colour with every detail.
 *
 * The palette's pigments are ranked by how much of the picture each one
 * leads (the cells where it is the main colour). A level allows only the
 * first few of them: every other pigment's paint goes to the allowed one
 * closest to it in colour, at the same darkness, so the level is painted in
 * palette colours only. But paint stays: a colour may only stand in for
 * another that is nearly the same paint (see fits), which the true colour
 * glazed on top later turns into the right one (a face is never washed in
 * the sky's grey-green to be painted pink later). A group of colours with
 * no stand-in in the level comes in with its own most prominent colour if,
 * together, it leads as much of the picture as a colour of the level does
 * (a face in four skin tones); a smaller one is left white and painted at a
 * later level. Each cell then belongs to its main allowed colour, and any
 * patch of a colour too small or too thin for that level (the
 * windows of a distant building, a thin branch, a speck) is given to the
 * neighbouring colour it shares the most border with, so the building is
 * one grey block. The level's paint targets are its (remapped) mixes,
 * smoothed within each colour area only (gradients survive, edges stay
 * put) and leaving out the absorbed cells: the windows take the colour of
 * the wall around them.
 */

import { gaussBlur, minFilter, maxFilter } from './image-analyzer.js';

/**
 * Watercolour only goes darker: a light patch painted over cannot be had
 * back (short of scrubbing it out). So the clean-up only gives a small or
 * thin patch to a colour no darker than itself (within this share): a dark
 * line or a dark window waits for the details, but a light one (the sky
 * between two buildings, a lit window) is kept, and every pass paints
 * around it as a painter reserves it.
 */
const LIGHT_KEEP = 0.15;
/** Most distinct labels (pigments) the majority filter counts. */
const MAX_LABELS = 64;
/**
 * How far apart two paints may be for one to be painted where the other
 * belongs: the angle between their absorbances (per red, green, blue), so
 * the same paint at any strength is one colour. Within it, the true colour
 * glazed over the first later still comes out right (a pale skin tone under
 * a deeper one); further apart, the first shows through for good (skin over
 * a grey-green wash stays grey, over the hair's brown stays dull).
 */
const HUE_NEAR = Math.cos( ( 8 * Math.PI ) / 180 );
/**
 * ...or for a pale colour, how much off-colour paint (absorbance) the first
 * may leave: a pale cream under a pale grey hardly shows.
 */
const FAINT = 0.05;
/**
 * A patch may also join a colour of another hue if that colour is this much
 * lighter than the patch: the patch's own, darker colour covers it later.
 */
const COVER = 0.5;
/** A patch set aside: left white at this level, painted at a later one. */
const ASIDE = -2;

/** How alike two paints' absorbances are (the cosine of their angle). */
function alike( a, b ) {
	const [ r1, g1, b1 ] = a.A;
	const [ r2, g2, b2 ] = b.A;
	const n = Math.hypot( r1, g1, b1 ) * Math.hypot( r2, g2, b2 );
	return n ? ( r1 * r2 + g1 * g2 + b1 * b2 ) / n : 1;
}

/** Whether paint `a` may be laid where `b` belongs (HUE_NEAR, FAINT). */
function fits( a, b ) {
	const c = alike( a, b );
	return c >= HUE_NEAR || ( ( b.A[ 0 ] + b.A[ 1 ] + b.A[ 2 ] ) / 3 ) * Math.sqrt( 1 - c * c ) <= FAINT;
}

/**
 * Builds the colour levels.
 *
 * @param {Object} an        image analysis (W, H, T, pigments, reserve)
 * @param {Object[]} specs   per level, coarse to fine: { share (of the
 *                           palette's colours), minArea, minDepth (cells),
 *                           keepArea (smallest light patch kept, cells),
 *                           sigma (smoothing, cells) }
 * @return {{ order: number[], levels: { colours: number, allowed: number[], label: Int16Array, maps: Float32Array[] }[] }}
 */
export function colourLevels( an, specs ) {
	const { W, H, T, pigments, reserve } = an;
	const T0 = T[ 0 ];
	const N = W * H;
	const K = pigments.length;
	const dark = pigments.map( ( p ) => ( p.A[ 0 ] + p.A[ 1 ] + p.A[ 2 ] ) / 3 );
	// The palette by prominence: the cells each pigment leads.
	const lead = new Float64Array( K );
	for ( let i = 0; i < N; i++ ) {
		if ( ! reserve[ i ] ) {
			const k = mainColour( T0, dark, pigments, i, K, null );
			if ( k >= 0 ) {
				lead[ k ]++;
			}
		}
	}
	const paint = [ ...Array( K ).keys() ].filter( ( k ) => ! pigments[ k ].isPaper );
	const order = paint.sort( ( a, b ) => lead[ b ] - lead[ a ] );
	const levels = specs.map( ( spec ) => {
		const share = Math.max( Math.min( 2, order.length ), Math.min( order.length, Math.round( order.length * spec.share ) ) );
		const allowed = order.slice( 0, share );
		// Every other pigment's paint goes to the allowed one nearest in
		// colour, at the same darkness, among those of nearly its hue.
		const to = new Int16Array( K );
		const nearest = ( k ) => {
			let best = -1;
			let bd = Infinity;
			for ( const a of allowed ) {
				if ( fits( pigments[ a ], pigments[ k ] ) ) {
					const [ l1, a1, b1 ] = pigments[ k ].lab;
					const [ l2, a2, b2 ] = pigments[ a ].lab;
					const d = Math.hypot( l1 - l2, a1 - a2, b1 - b2 );
					if ( d < bd ) {
						bd = d;
						best = a;
					}
				}
			}
			return best;
		};
		// Pigments with no stand-in, grouped by hue (most prominent first):
		// a group leading as much as a colour of the level brings its leader
		// in; the others' paint waits for a later level (-1).
		const groups = [];
		for ( const k of order ) {
			if ( ! allowed.includes( k ) && nearest( k ) < 0 ) {
				const g = groups.find( ( q ) => alike( pigments[ q.lead ], pigments[ k ] ) >= HUE_NEAR );
				if ( g ) {
					g.cells += lead[ k ];
				} else {
					groups.push( { lead: k, cells: lead[ k ] } );
				}
			}
		}
		const least = lead[ allowed[ allowed.length - 1 ] ];
		for ( const g of groups ) {
			if ( g.cells >= least ) {
				allowed.push( g.lead );
			}
		}
		const colours = allowed.length;
		for ( let k = 0; k < K; k++ ) {
			to[ k ] = pigments[ k ].isPaper || allowed.includes( k ) ? k : nearest( k );
		}
		const mixes = T0.map( ( m, k ) => ( to[ k ] === k ? Float32Array.from( m ) : new Float32Array( N ) ) );
		for ( let k = 0; k < K; k++ ) {
			if ( to[ k ] >= 0 && to[ k ] !== k ) {
				const f = dark[ k ] / Math.max( 1e-3, dark[ to[ k ] ] );
				const src = T0[ k ];
				const dst = mixes[ to[ k ] ];
				for ( let i = 0; i < N; i++ ) {
					dst[ i ] += src[ i ] * f;
				}
			}
		}
		const own = new Int16Array( N );
		for ( let i = 0; i < N; i++ ) {
			own[ i ] = reserve[ i ] ? -1 : mainColour( mixes, dark, pigments, i, K, K );
		}
		// How dark each cell truly is, and each colour's areas on average: a
		// patch may only join a colour that is not darker than itself (see
		// may). True, not the level's: a colour left out of it (its paint
		// waits) does not make its cells light.
		const value = new Float32Array( N );
		const sum = new Float64Array( K + 1 );
		const cnt = new Float64Array( K + 1 );
		for ( let i = 0; i < N; i++ ) {
			for ( let k = 0; k < K; k++ ) {
				value[ i ] += T0[ k ][ i ] * dark[ k ];
			}
			if ( own[ i ] >= 0 ) {
				sum[ own[ i ] ] += value[ i ];
				cnt[ own[ i ] ]++;
			}
		}
		const tone = Float32Array.from( sum, ( v, l ) => ( cnt[ l ] ? v / cnt[ l ] : 0 ) );
		const may = ( l, v ) => tone[ l ] <= v * ( 1 + LIGHT_KEEP ) + LIGHT_KEEP / 3;
		// ...and only one its true colour (`truth`), glazed on top later,
		// turns right: nearly its hue, or much lighter than it (bare paper
		// always is).
		const truth = new Int16Array( N );
		for ( let i = 0; i < N; i++ ) {
			truth[ i ] = mainColour( T0, dark, pigments, i, K, K );
		}
		const over = ( l, m, v ) => l >= K || m >= K || fits( pigments[ l ], pigments[ m ] ) || tone[ l ] <= v * COVER;
		const label = majority( own, W, H, 2 );
		// Both rules only bind a patch big enough to paint around (the same
		// size at every level: paint laid over light paper early is there for
		// good): specks (lit windows, white flowers) still go, and come back
		// with the details.
		const rules = { value, truth, may, over, keep: spec.keepArea };
		dropThin( label, W, H, Math.floor( spec.minDepth / 2 ), rules );
		absorbSmall( label, W, H, spec.minArea, rules, K );
		return { colours, allowed, label, maps: smoothWithin( mixes, W, H, label, own, spec.sigma ) };
	} );
	return { order, levels };
}

/**
 * The pigment that gives a cell most of its colour (by darkness); bare
 * cells give `bare` (K marks plain paper as an area of its own).
 */
function mainColour( maps, dark, pigments, i, K, bare ) {
	let best = bare ?? -1;
	let bv = 0.02;
	for ( let k = 0; k < K; k++ ) {
		if ( ! pigments[ k ].isPaper ) {
			const v = maps[ k ][ i ] * dark[ k ];
			if ( v > bv ) {
				bv = v;
				best = k;
			}
		}
	}
	return best;
}

/** A few passes of a 3x3 majority filter: ragged borders and specks go. */
function majority( src, W, H, passes ) {
	let a = Int16Array.from( src );
	let b = new Int16Array( a.length );
	const votes = new Float32Array( MAX_LABELS + 2 );
	const seen = new Int16Array( 9 );
	for ( let p = 0; p < passes; p++ ) {
		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				const i = y * W + x;
				const me = a[ i ];
				if ( me < 0 ) {
					b[ i ] = me;
					continue;
				}
				let n = 0;
				let best = me;
				let bv = 0;
				for ( let dy = -1; dy <= 1; dy++ ) {
					const yy = y + dy;
					if ( yy < 0 || yy >= H ) {
						continue;
					}
					for ( let dx = -1; dx <= 1; dx++ ) {
						const xx = x + dx;
						if ( xx < 0 || xx >= W ) {
							continue;
						}
						const l = a[ yy * W + xx ];
						if ( l < 0 ) {
							continue;
						}
						if ( ! votes[ l ] ) {
							seen[ n++ ] = l;
						}
						// Ties keep the cell's own colour.
						votes[ l ] += l === me ? 1.01 : 1;
						if ( votes[ l ] > bv ) {
							bv = votes[ l ];
							best = l;
						}
					}
				}
				for ( let q = 0; q < n; q++ ) {
					votes[ seen[ q ] ] = 0;
				}
				b[ i ] = best;
			}
		}
		[ a, b ] = [ b, a ];
	}
	return a;
}

/**
 * Every part of a colour area narrower than 2r+1 cells (a gap between two
 * buildings, a line, a thin spur), wherever it is, even when it hangs off a
 * big area (the gaps reach down into the field): what an opening of the
 * area's mask takes away. Those cells take the colour around them, growing
 * in from their neighbours, most common first, but never a darker one: a
 * cell with only darker colours around it keeps its own. (A thin part is a
 * line or a gap, painted over later in its own, darker colour or kept
 * light: the colour under a line does not show.)
 */
function dropThin( label, W, H, r, { value, may, keep } ) {
	if ( r < 1 ) {
		return;
	}
	const N = W * H;
	const orphan = new Uint8Array( N );
	const ids = [ ...new Set( label ) ].filter( ( l ) => l >= 0 );
	const mask = new Float32Array( N );
	for ( const l of ids ) {
		let any = false;
		for ( let i = 0; i < N; i++ ) {
			// Reserved cells (left white) belong to whatever is around them:
			// a field strewn with white flowers is not full of narrow gaps.
			mask[ i ] = label[ i ] === l || label[ i ] < 0 ? 1 : 0;
			any = any || label[ i ] === l;
		}
		if ( ! any ) {
			continue;
		}
		const opened = maxFilter( minFilter( mask, W, H, r ), W, H, r );
		for ( let i = 0; i < N; i++ ) {
			if ( label[ i ] === l && opened[ i ] < 0.5 ) {
				orphan[ i ] = 1;
			}
		}
	}
	const cut = Int16Array.from( label );
	// Each cut-off piece's size: only a piece big enough to paint around may
	// stay light.
	const piece = new Int32Array( N );
	{
		const stack = [];
		const seen = new Uint8Array( N );
		for ( let s = 0; s < N; s++ ) {
			if ( ! orphan[ s ] || seen[ s ] ) {
				continue;
			}
			const cells = [];
			seen[ s ] = 1;
			stack.push( s );
			while ( stack.length ) {
				const i = stack.pop();
				cells.push( i );
				const x = i % W;
				for ( const j of [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < N ? i + W : -1 ] ) {
					if ( j >= 0 && orphan[ j ] && ! seen[ j ] && cut[ j ] === cut[ i ] ) {
						seen[ j ] = 1;
						stack.push( j );
					}
				}
			}
			for ( const i of cells ) {
				piece[ i ] = cells.length;
			}
		}
	}
	const votes = new Float32Array( MAX_LABELS + 2 );
	let left = orphan.reduce( ( a, b ) => a + b, 0 );
	for ( let step = 0; step < 4 * r + 8 && left; step++ ) {
		const next = orphan.slice();
		for ( let i = 0; i < N; i++ ) {
			if ( ! orphan[ i ] ) {
				continue;
			}
			const x = i % W;
			let best = -1;
			let bv = 0;
			let same = false;
			let darker = false;
			for ( const j of [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < N ? i + W : -1 ] ) {
				if ( j >= 0 && ! orphan[ j ] && label[ j ] >= 0 ) {
					// Not the colour it was cut from (the spur would grow back
					// from where it joins its area), unless nothing else is near.
					if ( label[ j ] === cut[ i ] ) {
						same = true;
						continue;
					}
					if ( piece[ i ] >= keep && ! may( label[ j ], value[ i ] ) ) {
						darker = true;
						continue;
					}
					const v = ++votes[ label[ j ] ];
					if ( v > bv ) {
						bv = v;
						best = label[ j ];
					}
				}
			}
			votes.fill( 0 );
			// Only darker colours around (the sky between two buildings): it
			// stays as it is.
			if ( best < 0 && ( darker || ( same && step > 2 * r + 4 ) ) ) {
				best = cut[ i ];
			}
			if ( best >= 0 ) {
				label[ i ] = best;
				next[ i ] = 0;
				left--;
			}
		}
		orphan.set( next );
	}
}

/**
 * Patches of a colour smaller than `minArea` cells join the neighbouring
 * colour they share the most border with, if it is not darker than the
 * patch (a lit window stays); smallest first, repeated until none is left.
 * A patch with only neighbours of another hue around it (see `over`) is set
 * aside: left white now, it gets its own colour at a later level.
 */
function absorbSmall( label, W, H, minArea, { value, truth, may, over, keep }, K ) {
	const N = W * H;
	const comp = new Int32Array( N );
	const count = new Int32Array( K + 1 );
	for ( let sweep = 0; sweep < 8; sweep++ ) {
		comp.fill( -1 );
		const parts = [];
		const stack = [];
		for ( let s = 0; s < N; s++ ) {
			if ( comp[ s ] >= 0 || label[ s ] < 0 ) {
				continue;
			}
			const id = parts.length;
			const cells = [];
			comp[ s ] = id;
			stack.push( s );
			while ( stack.length ) {
				const i = stack.pop();
				cells.push( i );
				const x = i % W;
				for ( const j of [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < N ? i + W : -1 ] ) {
					if ( j >= 0 && comp[ j ] < 0 && label[ j ] === label[ i ] ) {
						comp[ j ] = id;
						stack.push( j );
					}
				}
			}
			parts.push( cells );
		}
		const small = [];
		for ( let id = 0; id < parts.length; id++ ) {
			const cells = parts[ id ];
			if ( cells.length < minArea ) {
				small.push( id );
			}
		}
		if ( ! small.length || small.length === parts.length ) {
			return;
		}
		small.sort( ( a, b ) => parts[ a ].length - parts[ b ].length );
		const done = new Uint8Array( parts.length );
		const border = new Map();
		let changed = 0;
		for ( const id of small ) {
			border.clear();
			let v = 0;
			for ( const i of parts[ id ] ) {
				v += value[ i ] / parts[ id ].length;
			}
			for ( const i of parts[ id ] ) {
				const x = i % W;
				for ( const j of [ x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < N ? i + W : -1 ] ) {
					if ( j >= 0 && label[ j ] >= 0 && label[ j ] !== label[ i ] ) {
						border.set( label[ j ], ( border.get( label[ j ] ) || 0 ) + 1 );
					}
				}
			}
			// The patch's true colour: most of its cells'.
			count.fill( 0 );
			let own = K;
			for ( const i of parts[ id ] ) {
				if ( truth[ i ] >= 0 && ++count[ truth[ i ] ] > count[ own ] ) {
					own = truth[ i ];
				}
			}
			const big = parts[ id ].length >= keep;
			let to = -1;
			let bn = 0;
			let aside = false;
			for ( const [ l, n ] of border ) {
				if ( n > bn && ( ! big || may( l, v ) ) ) {
					if ( big && ! over( l, own, v ) ) {
						aside = true;
						continue;
					}
					bn = n;
					to = l;
				}
			}
			if ( to < 0 && aside ) {
				to = ASIDE;
			}
			if ( to !== -1 ) {
				for ( const i of parts[ id ] ) {
					label[ i ] = to;
				}
				done[ id ] = 1;
				changed++;
			}
		}
		if ( ! changed ) {
			return;
		}
	}
}

/**
 * Per pigment, the image's mixes smoothed within each colour area, from the
 * cells that are truly that colour (not the absorbed ones); an area with no
 * such cell nearby takes the area's mean mix. Reserved cells keep the image,
 * and cells set aside stay white. The smoothing evens a colour out but never
 * brings in paint from further away: a true cell gets no more of a pigment
 * than the picture has close by (a sky glow next to the hair is not painted
 * brown because both are mostly that brown).
 * The smoothing is wide, so it runs on a grid a few times coarser (block
 * sums) and is read back bilinearly.
 */
function smoothWithin( T0, W, H, label, own, sigma ) {
	const N = W * H;
	const K = T0.length;
	const f = Math.max( 1, Math.round( sigma / 2 ) );
	const w2 = Math.ceil( W / f );
	const h2 = Math.ceil( H / f );
	const s2 = sigma / f;
	// Each cell's position on the coarse grid (bilinear corners and weights).
	const gx0 = new Int32Array( W );
	const gx1 = new Int32Array( W );
	const fx = new Float32Array( W );
	for ( let x = 0; x < W; x++ ) {
		const u = Math.min( w2 - 1, Math.max( 0, ( x + 0.5 ) / f - 0.5 ) );
		gx0[ x ] = Math.floor( u );
		gx1[ x ] = Math.min( w2 - 1, gx0[ x ] + 1 );
		fx[ x ] = u - gx0[ x ];
	}
	// Each cell's block on the coarse grid.
	const block = new Int32Array( N );
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			block[ y * W + x ] = ( ( y / f ) | 0 ) * w2 + ( ( x / f ) | 0 );
		}
	}
	// Block sums of `src` (or of 1) over an area's true cells, then blurred.
	const down = ( cells, w, src ) => {
		const out = new Float32Array( w2 * h2 );
		for ( const i of cells ) {
			if ( w[ i ] ) {
				out[ block[ i ] ] += src ? src[ i ] : 1;
			}
		}
		return gaussBlur( out, w2, h2, s2 );
	};
	const at = ( g, x, y ) => {
		const v = Math.min( h2 - 1, Math.max( 0, ( y + 0.5 ) / f - 0.5 ) );
		const y0 = Math.floor( v );
		const y1 = Math.min( h2 - 1, y0 + 1 );
		const fy = v - y0;
		const a = g[ y0 * w2 + gx0[ x ] ] * ( 1 - fx[ x ] ) + g[ y0 * w2 + gx1[ x ] ] * fx[ x ];
		const b = g[ y1 * w2 + gx0[ x ] ] * ( 1 - fx[ x ] ) + g[ y1 * w2 + gx1[ x ] ] * fx[ x ];
		return a + ( b - a ) * fy;
	};
	const maps = T0.map( ( m ) => Float32Array.from( m ) );
	const reach = Math.max( 1, Math.round( sigma / 4 ) );
	const caps = new Array( K );
	const cap = ( k ) => ( caps[ k ] ??= maxFilter( T0[ k ], W, H, reach ) );
	// The cells of each colour area, listed once.
	const buckets = new Map();
	for ( let i = 0; i < N; i++ ) {
		if ( label[ i ] >= 0 ) {
			let b = buckets.get( label[ i ] );
			if ( ! b ) {
				buckets.set( label[ i ], ( b = [] ) );
			}
			b.push( i );
		}
	}
	for ( let i = 0; i < N; i++ ) {
		if ( ASIDE === label[ i ] ) {
			for ( let k = 0; k < K; k++ ) {
				maps[ k ][ i ] = 0;
			}
		}
	}
	const w = new Uint8Array( N );
	for ( const [ l, cells ] of buckets ) {
		if ( l >= K ) {
			// Bare paper stays bare.
			for ( const i of cells ) {
				for ( let k = 0; k < K; k++ ) {
					maps[ k ][ i ] = 0;
				}
			}
			continue;
		}
		const mean = new Float64Array( K );
		const peak = new Float32Array( K );
		let n = 0;
		for ( const i of cells ) {
			w[ i ] = own[ i ] === l ? 1 : 0;
			n += w[ i ];
			for ( let k = 0; k < K; k++ ) {
				mean[ k ] += T0[ k ][ i ];
				if ( w[ i ] && T0[ k ][ i ] > peak[ k ] ) {
					peak[ k ] = T0[ k ][ i ];
				}
			}
		}
		for ( let k = 0; k < K; k++ ) {
			mean[ k ] /= cells.length;
		}
		// Where the true cells are, at the coarse scale (a weight, 0..f*f).
		const den = n ? down( cells, w, null ) : null;
		const floor = 0.02 * f * f;
		for ( let k = 0; k < K; k++ ) {
			const out = maps[ k ];
			const src = T0[ k ];
			// A pigment hardly in this area at all: none of it (no blur needed).
			const none = den && peak[ k ] < 0.01;
			const num = den && ! none ? down( cells, w, src ) : null;
			const most = none ? null : cap( k );
			for ( const i of cells ) {
				if ( none ) {
					out[ i ] = 0;
					continue;
				}
				const x = i % W;
				const y = ( i / W ) | 0;
				const d = den ? at( den, x, y ) : 0;
				out[ i ] = d > floor ? at( num, x, y ) / d : mean[ k ];
				if ( w[ i ] ) {
					out[ i ] = Math.min( out[ i ], most[ i ] * ( 1 + LIGHT_KEEP ) + 0.01 );
				}
			}
		}
	}
	return maps;
}
