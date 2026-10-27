/**
 * ImageAnalyzer — Phase A.
 *
 * Builds a reduced-resolution representation of the reference:
 *  - linear RGB + OKLab maps, luminance
 *  - a watercolour palette: paints at their masstones, none the others mix
 *  - pigment absorbances (Beer–Lambert) and per-pigment target density maps
 *    obtained by per-pixel non-negative least squares over pigment pairs
 *  - edge, detail, importance and feature-scale maps
 *  - approximate segmentation (quantized labels -> mode filter -> components)
 *
 * Runs inside a Web Worker.
 */

import { SRGB_TO_LINEAR, linearToOklab, oklabToLinear, linearToSrgb, PAPER_LINEAR, toHex } from './color.js';
import { Rng } from './prng.js';

const MAX_DENSITY = 4;
// A paint the palette can already make, watered down or mixed, to within
// this (OKLab, about a just-noticeable difference) is not a new paint.
const REACH = 0.03;
// ...or mixed from two of its paints to within this: a mix is harder to
// lay exactly than one paint.
const REACH_MIX = 0.015;
// Choosing the palette, a colour made by mixing counts as this much
// further off (squared) than one made with a single paint.
const MIX_COST = 1.5;
// Colours whose absorbances lie within ~8° are one paint at two strengths.
const SAME_PAINT = Math.cos( ( 8 * Math.PI ) / 180 );
// Choosing the palette, a paint goes at most this far past its masstone.
const OVER_MASSTONE = 1.15;
// The darkest a masstone gets (absorbance in its strongest channel).
const MASSTONE_MAX = 3;
// The strengths at which a paint is compared: a quarter, half and full.
const TINTS = [ 0.25, 0.5, 1 ];
// A photograph's simplification: passes of edge-preserving smoothing, and how
// alike (OKLab) two colours must be to be smoothed together.
const SIMPLIFY_PASSES = 4;
const SIMPLIFY_RANGE = 0.05;
// Masking fluid for a small shape at least this much lighter (OKLab L) than
// the area around it, where that area makes up this share of what is
// around the shape.
const MASK_STEP = 0.05;
const MASK_SOLID = 0.7;
// ...and only a shape that is itself light (OKLab L): a dark grey speck in a
// black area is painted with less paint, not masked.
const MASK_MIN_L = 0.4;

/* ------------------------------------------------------------------ */
/* Filters                                                              */
/* ------------------------------------------------------------------ */

function boxH( src, dst, W, H, r ) {
	const inv = 1 / ( 2 * r + 1 );
	for ( let y = 0; y < H; y++ ) {
		const row = y * W;
		let acc = 0;
		for ( let k = -r; k <= r; k++ ) {
			acc += src[ row + Math.min( W - 1, Math.max( 0, k ) ) ];
		}
		for ( let x = 0; x < W; x++ ) {
			dst[ row + x ] = acc * inv;
			acc += src[ row + Math.min( W - 1, x + r + 1 ) ] - src[ row + Math.max( 0, x - r ) ];
		}
	}
}

function boxV( src, dst, W, H, r ) {
	const inv = 1 / ( 2 * r + 1 );
	for ( let x = 0; x < W; x++ ) {
		let acc = 0;
		for ( let k = -r; k <= r; k++ ) {
			acc += src[ Math.min( H - 1, Math.max( 0, k ) ) * W + x ];
		}
		for ( let y = 0; y < H; y++ ) {
			dst[ y * W + x ] = acc * inv;
			acc += src[ Math.min( H - 1, y + r + 1 ) * W + x ] - src[ Math.max( 0, y - r ) * W + x ];
		}
	}
}

export function boxBlur( src, W, H, r ) {
	const tmp = new Float32Array( src.length );
	const out = new Float32Array( src.length );
	boxH( src, tmp, W, H, r );
	boxV( tmp, out, W, H, r );
	return out;
}

/** Gaussian approximation: three box passes. */
export function gaussBlur( src, W, H, sigma ) {
	if ( sigma < 0.4 ) {
		return Float32Array.from( src );
	}
	const r = Math.max( 1, Math.round( ( Math.sqrt( 4 * sigma * sigma + 1 ) - 1 ) / 2 ) );
	const a = new Float32Array( src.length );
	const b = new Float32Array( src.length );
	boxH( src, a, W, H, r );
	boxV( a, b, W, H, r );
	boxH( b, a, W, H, r );
	boxV( a, b, W, H, r );
	boxH( b, a, W, H, r );
	boxV( a, b, W, H, r );
	return b;
}

/** Chamfer distance from each masked cell to the nearest unmasked cell. */
function chamferInside( mask, W, H ) {
	const N = W * H;
	const d = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		d[ i ] = mask[ i ] ? 1e9 : 0;
	}
	const S2 = Math.SQRT2;
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			const i = y * W + x;
			if ( d[ i ] ) {
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
	}
	for ( let y = H - 1; y >= 0; y-- ) {
		for ( let x = W - 1; x >= 0; x-- ) {
			const i = y * W + x;
			if ( d[ i ] ) {
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
				d[ i ] = v;
			}
		}
	}
	return d;
}

/** Separable local extremum with a square window of radius r. */
/**
 * Running min/max over a window of 2r+1 samples along one line (van Herk /
 * Gil-Werman): three comparisons per sample whatever the radius.
 * Reads n samples of src from o0 with stride st, writes dst the same way.
 */
function runLine( src, dst, o0, st, n, r, isMax, g, h ) {
	const w = 2 * r + 1;
	const get = ( i ) => src[ o0 + Math.min( n - 1, Math.max( 0, i ) ) * st ];
	// Pad by r on both sides (edge values), in blocks of w.
	const len = n + 2 * r;
	for ( let i = 0; i < len; i++ ) {
		const v = get( i - r );
		if ( 0 === i % w ) {
			g[ i ] = v;
		} else {
			g[ i ] = isMax ? Math.max( g[ i - 1 ], v ) : Math.min( g[ i - 1 ], v );
		}
	}
	for ( let i = len - 1; i >= 0; i-- ) {
		const v = get( i - r );
		if ( i === len - 1 || ( i + 1 ) % w === 0 ) {
			h[ i ] = v;
		} else {
			h[ i ] = isMax ? Math.max( h[ i + 1 ], v ) : Math.min( h[ i + 1 ], v );
		}
	}
	for ( let x = 0; x < n; x++ ) {
		// The window over padded indices x .. x + 2r.
		const a = h[ x ];
		const b = g[ x + 2 * r ];
		dst[ o0 + x * st ] = isMax ? ( a > b ? a : b ) : ( a < b ? a : b );
	}
}

function rankFilter( src, W, H, r, isMax ) {
	const tmp = new Float32Array( src.length );
	const out = new Float32Array( src.length );
	const L = Math.max( W, H ) + 2 * r + 1;
	const g = new Float32Array( L );
	const h = new Float32Array( L );
	for ( let y = 0; y < H; y++ ) {
		runLine( src, tmp, y * W, 1, W, r, isMax, g, h );
	}
	for ( let x = 0; x < W; x++ ) {
		runLine( tmp, out, x, W, H, r, isMax, g, h );
	}
	return out;
}

export function maxFilter( src, W, H, r ) {
	return rankFilter( src, W, H, r, true );
}
export function minFilter( src, W, H, r ) {
	return rankFilter( src, W, H, r, false );
}
export function percentile( arr, p ) {
	const step = Math.max( 1, Math.floor( arr.length / 20000 ) );
	const s = [];
	for ( let i = 0; i < arr.length; i += step ) {
		s.push( arr[ i ] );
	}
	s.sort( ( a, b ) => a - b );
	return s[ Math.min( s.length - 1, Math.floor( p * s.length ) ) ] || 0;
}

export function sobel( L, W, H ) {
	const out = new Float32Array( W * H );
	for ( let y = 0; y < H; y++ ) {
		const ym = Math.max( 0, y - 1 ) * W;
		const yc = y * W;
		const yp = Math.min( H - 1, y + 1 ) * W;
		for ( let x = 0; x < W; x++ ) {
			const xm = Math.max( 0, x - 1 );
			const xp = Math.min( W - 1, x + 1 );
			const gx = L[ ym + xp ] + 2 * L[ yc + xp ] + L[ yp + xp ] - L[ ym + xm ] - 2 * L[ yc + xm ] - L[ yp + xm ];
			const gy = L[ yp + xm ] + 2 * L[ yp + x ] + L[ yp + xp ] - L[ ym + xm ] - 2 * L[ ym + x ] - L[ ym + xp ];
			out[ yc + x ] = Math.sqrt( gx * gx + gy * gy );
		}
	}
	return out;
}

function normalize( arr, p ) {
	const v = percentile( arr, p ) || 1e-6;
	for ( let i = 0; i < arr.length; i++ ) {
		arr[ i ] = Math.min( 1, arr[ i ] / v );
	}
	return arr;
}

function channel( interleaved, c, n ) {
	const out = new Float32Array( n );
	for ( let i = 0; i < n; i++ ) {
		out[ i ] = interleaved[ i * 3 + c ];
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Palette                                                              */
/* ------------------------------------------------------------------ */

function kmeans( lab, N, K, rng ) {
	const S = Math.min( N, 16000 );
	const pts = new Float32Array( S * 3 );
	for ( let s = 0; s < S; s++ ) {
		const i = S === N ? s : rng.int( N );
		pts[ s * 3 ] = lab[ i * 3 ];
		pts[ s * 3 + 1 ] = lab[ i * 3 + 1 ] * 1.3;
		pts[ s * 3 + 2 ] = lab[ i * 3 + 2 ] * 1.3;
	}
	const C = new Float32Array( K * 3 );
	const dist = new Float32Array( S ).fill( Infinity );
	// k-means++ seeding.
	let first = rng.int( S );
	for ( let k = 0; k < K; k++ ) {
		const src = 0 === k ? first : -1;
		let pick = src;
		if ( pick < 0 ) {
			let total = 0;
			for ( let s = 0; s < S; s++ ) {
				total += dist[ s ];
			}
			let r = rng.float() * total;
			pick = S - 1;
			for ( let s = 0; s < S; s++ ) {
				r -= dist[ s ];
				if ( r <= 0 ) {
					pick = s;
					break;
				}
			}
		}
		C[ k * 3 ] = pts[ pick * 3 ];
		C[ k * 3 + 1 ] = pts[ pick * 3 + 1 ];
		C[ k * 3 + 2 ] = pts[ pick * 3 + 2 ];
		for ( let s = 0; s < S; s++ ) {
			const dl = pts[ s * 3 ] - C[ k * 3 ];
			const da = pts[ s * 3 + 1 ] - C[ k * 3 + 1 ];
			const db = pts[ s * 3 + 2 ] - C[ k * 3 + 2 ];
			const d = dl * dl + da * da + db * db;
			if ( d < dist[ s ] ) {
				dist[ s ] = d;
			}
		}
	}
	const assign = new Int32Array( S );
	const sums = new Float64Array( K * 4 );
	for ( let it = 0; it < 18; it++ ) {
		sums.fill( 0 );
		for ( let s = 0; s < S; s++ ) {
			let best = 0;
			let bd = Infinity;
			for ( let k = 0; k < K; k++ ) {
				const dl = pts[ s * 3 ] - C[ k * 3 ];
				const da = pts[ s * 3 + 1 ] - C[ k * 3 + 1 ];
				const db = pts[ s * 3 + 2 ] - C[ k * 3 + 2 ];
				const d = dl * dl + da * da + db * db;
				if ( d < bd ) {
					bd = d;
					best = k;
				}
			}
			assign[ s ] = best;
			dist[ s ] = bd;
			sums[ best * 4 ] += pts[ s * 3 ];
			sums[ best * 4 + 1 ] += pts[ s * 3 + 1 ];
			sums[ best * 4 + 2 ] += pts[ s * 3 + 2 ];
			sums[ best * 4 + 3 ] += 1;
		}
		for ( let k = 0; k < K; k++ ) {
			const n = sums[ k * 4 + 3 ];
			if ( n > 0 ) {
				C[ k * 3 ] = sums[ k * 4 ] / n;
				C[ k * 3 + 1 ] = sums[ k * 4 + 1 ] / n;
				C[ k * 3 + 2 ] = sums[ k * 4 + 2 ] / n;
			} else {
				// Empty cluster: move it to the worst-fitted sample.
				let far = 0;
				for ( let s = 1; s < S; s++ ) {
					if ( dist[ s ] > dist[ far ] ) {
						far = s;
					}
				}
				C[ k * 3 ] = pts[ far * 3 ];
				C[ k * 3 + 1 ] = pts[ far * 3 + 1 ];
				C[ k * 3 + 2 ] = pts[ far * 3 + 2 ];
				dist[ far ] = 0;
			}
		}
	}
	const centers = [];
	for ( let k = 0; k < K; k++ ) {
		centers.push( [ C[ k * 3 ], C[ k * 3 + 1 ] / 1.3, C[ k * 3 + 2 ] / 1.3 ] );
	}
	return centers;
}

/* ------------------------------------------------------------------ */
/* Photographs                                                          */
/* ------------------------------------------------------------------ */

/**
 * How much fine texture the image has (0 = flat illustration, ~0.25 = a
 * photograph): the share of pixels with a small, non-edge lightness wobble
 * (foliage, grain, sensor noise). Flat artwork scores below ~0.08.
 */
export function textureScore( lab, W, H ) {
	let tex = 0;
	let n = 0;
	for ( let y = 1; y < H - 1; y++ ) {
		for ( let x = 1; x < W - 1; x++ ) {
			const i = y * W + x;
			const c = lab[ i * 3 ];
			const lap = Math.abs( 4 * c - lab[ ( i - 1 ) * 3 ] - lab[ ( i + 1 ) * 3 ] - lab[ ( i - W ) * 3 ] - lab[ ( i + W ) * 3 ] ) / 4;
			n++;
			if ( lap > 0.009 && lap < 0.07 ) {
				tex++;
			}
		}
	}
	return n ? tex / n : 0;
}

/**
 * A round Gaussian kernel of radius r taps, its taps `step` cells apart:
 * [dx, dy, weight, ...].
 */
function sparseKernel( r, step ) {
	const ss = 2 * ( r * 0.8 ) ** 2;
	const out = [];
	for ( let dy = -r; dy <= r; dy++ ) {
		for ( let dx = -r; dx <= r; dx++ ) {
			if ( dx * dx + dy * dy <= r * r ) {
				out.push( dx * step, dy * step, Math.exp( -( dx * dx + dy * dy ) / ss ) );
			}
		}
	}
	return out;
}

/**
 * Simplifies a photograph into the shapes a painter would see: repeated
 * edge-preserving (bilateral) smoothing in OKLab flattens texture and noise
 * inside areas while keeping the edges between them. `amount` (0–1, from
 * the Detail setting): how much; a painter asked for more detail
 * simplifies less. Updates lab and lin.
 */
function simplifyPhoto( lab, lin, W, H, B, amount = 1 ) {
	const N = W * H;
	const passes = Math.round( SIMPLIFY_PASSES * amount );
	if ( ! passes ) {
		return;
	}
	// The texture to flatten has a size relative to the picture: the filter
	// spans ~B/140 cells, sampled sparsely so its cost per cell is the same
	// at every Detail setting.
	const spatial = sparseKernel( 3, Math.max( 1, Math.round( B / 400 ) ) );
	const sr = 2 * ( SIMPLIFY_RANGE * Math.sqrt( amount ) ) ** 2;
	let src = lab;
	let dst = new Float32Array( N * 3 );
	for ( let iter = 0; iter < passes; iter++ ) {
		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				const i = ( y * W + x ) * 3;
				const l0 = src[ i ];
				const a0 = src[ i + 1 ];
				const b0 = src[ i + 2 ];
				let sw = 0;
				let sl = 0;
				let sa = 0;
				let sb = 0;
				for ( let s = 0; s < spatial.length; s += 3 ) {
					const xx = x + spatial[ s ];
					const yy = y + spatial[ s + 1 ];
					if ( xx < 0 || yy < 0 || xx >= W || yy >= H ) {
						continue;
					}
					const j = ( yy * W + xx ) * 3;
					const dl = src[ j ] - l0;
					const da = src[ j + 1 ] - a0;
					const db = src[ j + 2 ] - b0;
					const w = spatial[ s + 2 ] * Math.exp( -( dl * dl + da * da + db * db ) / sr );
					sw += w;
					sl += w * src[ j ];
					sa += w * src[ j + 1 ];
					sb += w * src[ j + 2 ];
				}
				dst[ i ] = sl / sw;
				dst[ i + 1 ] = sa / sw;
				dst[ i + 2 ] = sb / sw;
			}
		}
		const t = src === lab ? new Float32Array( N * 3 ) : src;
		src = dst;
		dst = t;
	}
	lab.set( src );
	const tmp = [ 0, 0, 0 ];
	for ( let i = 0; i < N; i++ ) {
		oklabToLinear( lab[ i * 3 ], lab[ i * 3 + 1 ], lab[ i * 3 + 2 ], tmp );
		lin[ i * 3 ] = Math.max( 0, tmp[ 0 ] );
		lin[ i * 3 + 1 ] = Math.max( 0, tmp[ 1 ] );
		lin[ i * 3 + 2 ] = Math.max( 0, tmp[ 2 ] );
	}
}

/**
 * Smooths scalar maps inside the shapes of a guide image (joint bilateral):
 * neighbours of a similar colour are averaged, across an edge they are not.
 * Used on a photograph's pigment maps so each colour forms continuous areas
 * instead of a per-pixel speckle of alternating mixes.
 */
function smoothInShapes( fields, lab, W, H, r, step, sigmaR, iterations ) {
	const N = W * H;
	const F = fields.length;
	const sr = 2 * sigmaR * sigmaR;
	const offs = sparseKernel( r, step );
	// Weights depend only on the guide image: computed once per cell and
	// applied to every field.
	const out = fields.map( () => new Float32Array( N ) );
	const acc = new Float64Array( F );
	for ( let iter = 0; iter < iterations; iter++ ) {
		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				const i = y * W + x;
				const l0 = lab[ i * 3 ];
				const a0 = lab[ i * 3 + 1 ];
				const b0 = lab[ i * 3 + 2 ];
				let sw = 0;
				acc.fill( 0 );
				for ( let s = 0; s < offs.length; s += 3 ) {
					const xx = x + offs[ s ];
					const yy = y + offs[ s + 1 ];
					if ( xx < 0 || yy < 0 || xx >= W || yy >= H ) {
						continue;
					}
					const j = yy * W + xx;
					const dl = lab[ j * 3 ] - l0;
					const da = lab[ j * 3 + 1 ] - a0;
					const db = lab[ j * 3 + 2 ] - b0;
					const w = offs[ s + 2 ] * Math.exp( -( dl * dl + da * da + db * db ) / sr );
					sw += w;
					for ( let f = 0; f < F; f++ ) {
						acc[ f ] += w * fields[ f ][ j ];
					}
				}
				for ( let f = 0; f < F; f++ ) {
					out[ f ][ i ] = acc[ f ] / sw;
				}
			}
		}
		for ( let f = 0; f < F; f++ ) {
			fields[ f ].set( out[ f ] );
		}
	}
}

/* ------------------------------------------------------------------ */
/* A painter's palette for photographs                                  */
/* ------------------------------------------------------------------ */

/** Optical density (absorbance over paper) of a linear colour. */
function opticalDensity( r, g, b, out ) {
	out[ 0 ] = -Math.log( Math.min( 1, Math.max( 0.015, r / PAPER_LINEAR[ 0 ] ) ) );
	out[ 1 ] = -Math.log( Math.min( 1, Math.max( 0.015, g / PAPER_LINEAR[ 1 ] ) ) );
	out[ 2 ] = -Math.log( Math.min( 1, Math.max( 0.015, b / PAPER_LINEAR[ 2 ] ) ) );
	return out;
}

/** Absorbance of a pigment whose masstone is this OKLab colour. */
function pigmentAbsorbance( c ) {
	const tmp = [ 0, 0, 0 ];
	oklabToLinear( c[ 0 ], c[ 1 ], c[ 2 ], tmp );
	return tmp.map( ( v, ch ) => -Math.log( Math.min( 0.999, Math.max( 0.03, Math.max( 0, Math.min( 1, v ) ) / PAPER_LINEAR[ ch ] ) ) ) );
}

/**
 * Weighted least-squares fit of a density vector D by non-negative amounts
 * of 1, 2 or 3 pigments (absorbances As), each at most `cap` times its
 * absorbance. Returns the weighted error, and the amounts in x, or Infinity
 * when the best fit needs a negative amount.
 */
function fitMix( As, D, w, x, cap = MAX_DENSITY ) {
	const n = As.length;
	// Normal equations M x = c (n <= 3).
	const M = [ 0, 0, 0, 0, 0, 0, 0, 0, 0 ];
	const c = [ 0, 0, 0 ];
	for ( let p = 0; p < n; p++ ) {
		for ( let q = p; q < n; q++ ) {
			const v = w[ 0 ] * As[ p ][ 0 ] * As[ q ][ 0 ] + w[ 1 ] * As[ p ][ 1 ] * As[ q ][ 1 ] + w[ 2 ] * As[ p ][ 2 ] * As[ q ][ 2 ];
			M[ p * 3 + q ] = v;
			M[ q * 3 + p ] = v;
		}
		c[ p ] = w[ 0 ] * As[ p ][ 0 ] * D[ 0 ] + w[ 1 ] * As[ p ][ 1 ] * D[ 1 ] + w[ 2 ] * As[ p ][ 2 ] * D[ 2 ];
	}
	if ( 1 === n ) {
		x[ 0 ] = Math.min( cap, Math.max( 0, c[ 0 ] / M[ 0 ] ) );
	} else if ( 2 === n ) {
		const det = M[ 0 ] * M[ 4 ] - M[ 1 ] * M[ 1 ];
		if ( det < 1e-9 ) {
			return Infinity;
		}
		x[ 0 ] = ( c[ 0 ] * M[ 4 ] - c[ 1 ] * M[ 1 ] ) / det;
		x[ 1 ] = ( M[ 0 ] * c[ 1 ] - M[ 1 ] * c[ 0 ] ) / det;
	} else {
		const [ a, b, cc, d, e, f, g, h, k ] = M;
		const A0 = e * k - f * h;
		const A1 = -( d * k - f * g );
		const A2 = d * h - e * g;
		const det = a * A0 + b * A1 + cc * A2;
		if ( Math.abs( det ) < 1e-12 ) {
			return Infinity;
		}
		x[ 0 ] = ( A0 * c[ 0 ] + ( cc * h - b * k ) * c[ 1 ] + ( b * f - cc * e ) * c[ 2 ] ) / det;
		x[ 1 ] = ( A1 * c[ 0 ] + ( a * k - cc * g ) * c[ 1 ] + ( cc * d - a * f ) * c[ 2 ] ) / det;
		x[ 2 ] = ( A2 * c[ 0 ] + ( b * g - a * h ) * c[ 1 ] + ( a * e - b * d ) * c[ 2 ] ) / det;
	}
	let err = 0;
	const r = [ D[ 0 ], D[ 1 ], D[ 2 ] ];
	for ( let p = 0; p < n; p++ ) {
		if ( x[ p ] < 0 ) {
			return Infinity;
		}
		x[ p ] = Math.min( cap, x[ p ] );
		for ( let ch = 0; ch < 3; ch++ ) {
			r[ ch ] -= x[ p ] * As[ p ][ ch ];
		}
	}
	for ( let ch = 0; ch < 3; ch++ ) {
		err += w[ ch ] * r[ ch ] * r[ ch ];
	}
	return err;
}

/** Per-channel weights of a density fit: errors show more in light colours. */
function fitWeights( D ) {
	return [ Math.exp( -D[ 0 ] ) + 0.06, Math.exp( -D[ 1 ] ) + 0.06, Math.exp( -D[ 2 ] ) + 0.06 ];
}

/** A paint of absorbance A: its masstone's colours. */
function paintOf( A ) {
	const linC = A.map( ( v, ch ) => PAPER_LINEAR[ ch ] * Math.exp( -v ) );
	const lab = [ 0, 0, 0 ];
	linearToOklab( linC[ 0 ], linC[ 1 ], linC[ 2 ], lab );
	const srgb = linC.map( linearToSrgb );
	return { lab, srgb, hex: toHex( srgb ), A, L: lab[ 0 ], isPaper: Math.max( A[ 0 ], A[ 1 ], A[ 2 ] ) < 0.06 };
}

/**
 * A watercolour palette: K paints chosen for how well the picture can be
 * painted with them, watered down and mixed in pairs, as a painter stocks
 * one (a blue and a yellow make the greens) instead of taking the K most
 * common colours (a big sky would take most of the slots, in shades).
 *
 * Each candidate colour becomes a paint at its masstone: the strongest
 * shade of it the picture calls for (its colours that are the same paint,
 * absorbances within SAME_PAINT). Water only ever makes a paint lighter,
 * so the tube colour is the darkest of its shades and the light ones come
 * from it, never the other way round.
 *
 * Greedy: each step adds the paint that most reduces the colour error over
 * the picture, alone or mixed with one already chosen. A paint the palette
 * can already make (watered down to within REACH of it at each strength,
 * or mixed from two of its paints to within REACH_MIX) is never added, and one that a later
 * choice makes redundant is taken off again: its slot goes to the next
 * colour the picture needs. Returns the paints' absorbances (masstones).
 */
function watercolourPalette( candidates, lin, N, K, rng ) {
	const S = Math.min( N, 3000 );
	const Ds = [];
	const ws = [];
	const labs = [];
	const D = [ 0, 0, 0 ];
	for ( let s = 0; s < S; s++ ) {
		const i = S === N ? s : rng.int( N );
		opticalDensity( lin[ i * 3 ], lin[ i * 3 + 1 ], lin[ i * 3 + 2 ], D );
		if ( D[ 0 ] + D[ 1 ] + D[ 2 ] < 0.03 ) {
			continue;
		}
		Ds.push( [ D[ 0 ], D[ 1 ], D[ 2 ] ] );
		ws.push( fitWeights( D ) );
		const L = [ 0, 0, 0 ];
		linearToOklab( lin[ i * 3 ], lin[ i * 3 + 1 ], lin[ i * 3 + 2 ], L );
		labs.push( L );
	}
	// A mix is judged by how different it looks (OKLab), so a dark green is
	// not an acceptable dark brown even though their densities are close.
	const look = [ 0, 0, 0 ];
	const x = [ 0, 0, 0 ];
	const seen = ( As, t ) => {
		const o = [ 0, 0, 0 ];
		for ( let p = 0; p < As.length; p++ ) {
			for ( let ch = 0; ch < 3; ch++ ) {
				o[ ch ] += x[ p ] * As[ p ][ ch ];
			}
		}
		linearToOklab( PAPER_LINEAR[ 0 ] * Math.exp( -o[ 0 ] ), PAPER_LINEAR[ 1 ] * Math.exp( -o[ 1 ] ), PAPER_LINEAR[ 2 ] * Math.exp( -o[ 2 ] ), look );
		return ( look[ 0 ] - t[ 0 ] ) ** 2 + ( look[ 1 ] - t[ 1 ] ) ** 2 + ( look[ 2 ] - t[ 2 ] ) ** 2;
	};
	// Paints are laid up to a little past their masstone (a second glaze),
	// no further: a pale paint does not stand in for a dark one.
	const mixErr = ( As, d, w, t ) => ( fitMix( As, d, w, x, OVER_MASSTONE ) < Infinity ? seen( As, t ) : Infinity );

	/* Candidates at their masstones ---------------------------------- */
	const paints = [];
	for ( const c of candidates ) {
		const A = pigmentAbsorbance( c );
		const n = Math.hypot( A[ 0 ], A[ 1 ], A[ 2 ] );
		if ( Math.max( A[ 0 ], A[ 1 ], A[ 2 ] ) < 0.06 ) {
			continue; // bare paper
		}
		const u = A.map( ( v ) => v / n );
		const t = [];
		for ( const d of Ds ) {
			const along = d[ 0 ] * u[ 0 ] + d[ 1 ] * u[ 1 ] + d[ 2 ] * u[ 2 ];
			if ( along >= SAME_PAINT * Math.hypot( d[ 0 ], d[ 1 ], d[ 2 ] ) ) {
				t.push( along );
			}
		}
		t.sort( ( a, b ) => a - b );
		// Its strongest shade in the picture (a few stray cells aside).
		let s = Math.max( n, t.length >= 5 ? t[ Math.floor( 0.95 * ( t.length - 1 ) ) ] : 0 );
		s = Math.min( s, MASSTONE_MAX / Math.max( u[ 0 ], u[ 1 ], u[ 2 ] ) );
		const Am = u.map( ( v ) => v * s );
		const tints = TINTS.map( ( f ) => {
			const Dt = Am.map( ( v ) => v * f );
			return { D: Dt, w: fitWeights( Dt ), lab: paintOf( Dt ).lab };
		} );
		paints.push( { A: Am, u, L: paintOf( Am ).L, tints } );
	}

	/* Greedy choice --------------------------------------------------- */
	const P = paints.length;
	const chosen = [];
	const dropped = new Uint8Array( P );
	// Can the paints `among` make paint p, watered down or mixed in two, at
	// each of its strengths? (Dark colours all look alike, so the masstone
	// alone would say yes too readily.) Nearly the hue of one of them
	// (SAME_PAINT) and no darker, it is that paint watered down, whatever
	// the eye says: two of them would spend a slot twice, and the first
	// washes would lay one where the other belongs (see ColourLevels), the
	// wrong paint taking the darkness the right one needs (a sky's crimson
	// washed in magenta stays purple and too dark). A darker one is the
	// tube colour of the two: it comes in, and the lighter one goes.
	const reach = ( p, among ) => {
		const { u, L } = paints[ p ];
		for ( const a of among ) {
			const o = paints[ a ];
			if ( u[ 0 ] * o.u[ 0 ] + u[ 1 ] * o.u[ 1 ] + u[ 2 ] * o.u[ 2 ] >= SAME_PAINT && L >= o.L ) {
				return true;
			}
		}
		for ( const t of paints[ p ].tints ) {
			let ok = false;
			for ( let a = 0; a < among.length && ! ok; a++ ) {
				ok = mixErr( [ paints[ among[ a ] ].A ], t.D, t.w, t.lab ) < REACH * REACH;
				for ( let b = a + 1; b < among.length && ! ok; b++ ) {
					ok = mixErr( [ paints[ among[ a ] ].A, paints[ among[ b ] ].A ], t.D, t.w, t.lab ) < REACH_MIX * REACH_MIX;
				}
			}
			if ( ! ok ) {
				return false;
			}
		}
		return among.length > 0;
	};
	// Error of each sample with the chosen paints (bare paper to start),
	// and with each other paint added to them.
	const cur = new Float32Array( Ds.length );
	const best = paints.map( () => new Float32Array( Ds.length ) );
	const errors = () => {
		for ( let s = 0; s < Ds.length; s++ ) {
			let e = seen( [], labs[ s ] );
			for ( let a = 0; a < chosen.length; a++ ) {
				const Aa = paints[ chosen[ a ] ].A;
				e = Math.min( e, mixErr( [ Aa ], Ds[ s ], ws[ s ], labs[ s ] ) );
				for ( let b = a + 1; b < chosen.length; b++ ) {
					e = Math.min( e, MIX_COST * mixErr( [ Aa, paints[ chosen[ b ] ].A ], Ds[ s ], ws[ s ], labs[ s ] ) );
				}
			}
			cur[ s ] = e;
		}
		for ( let p = 0; p < P; p++ ) {
			if ( dropped[ p ] || chosen.includes( p ) ) {
				continue;
			}
			for ( let s = 0; s < Ds.length; s++ ) {
				let e = mixErr( [ paints[ p ].A ], Ds[ s ], ws[ s ], labs[ s ] );
				for ( const c of chosen ) {
					e = Math.min( e, MIX_COST * mixErr( [ paints[ p ].A, paints[ c ].A ], Ds[ s ], ws[ s ], labs[ s ] ) );
				}
				best[ p ][ s ] = e;
			}
		}
	};
	errors();
	for ( let step = 0; chosen.length < K && step < 3 * K; step++ ) {
		let pick = -1;
		let pickGain = 0;
		for ( let p = 0; p < P; p++ ) {
			if ( dropped[ p ] || chosen.includes( p ) ) {
				continue;
			}
			if ( reach( p, chosen ) ) {
				dropped[ p ] = 1;
				continue;
			}
			let gain = 0;
			for ( let s = 0; s < Ds.length; s++ ) {
				gain += Math.max( 0, cur[ s ] - best[ p ][ s ] );
			}
			if ( gain > pickGain ) {
				pickGain = gain;
				pick = p;
			}
		}
		if ( pick < 0 ) {
			break;
		}
		chosen.push( pick );
		// A paint chosen earlier that the others now make (a green, once its
		// blue and yellow are in) is taken off, and stays off.
		const redundant = chosen.filter( ( c ) => c !== pick && reach( c, chosen.filter( ( o ) => o !== c ) ) );
		for ( const c of redundant ) {
			chosen.splice( chosen.indexOf( c ), 1 );
			dropped[ c ] = 1;
		}
		if ( redundant.length ) {
			errors();
			continue;
		}
		for ( let s = 0; s < Ds.length; s++ ) {
			cur[ s ] = Math.min( cur[ s ], best[ pick ][ s ] );
		}
		for ( let p = 0; p < P; p++ ) {
			if ( dropped[ p ] || chosen.includes( p ) ) {
				continue;
			}
			for ( let s = 0; s < Ds.length; s++ ) {
				best[ p ][ s ] = Math.min( best[ p ][ s ], MIX_COST * mixErr( [ paints[ p ].A, paints[ pick ].A ], Ds[ s ], ws[ s ], labs[ s ] ) );
			}
		}
	}
	return chosen.map( ( p ) => paints[ p ].A );
}

/* ------------------------------------------------------------------ */
/* Main analysis                                                        */
/* ------------------------------------------------------------------ */

/**
 * Converts RGBA8 pixels to linear RGB composited over paper, and OKLab.
 */
export function pixelsToLabLinear( pixels, n ) {
	const lin = new Float32Array( n * 3 );
	const lab = new Float32Array( n * 3 );
	for ( let i = 0; i < n; i++ ) {
		const a = pixels[ i * 4 + 3 ] / 255;
		const r = SRGB_TO_LINEAR[ pixels[ i * 4 ] ] * a + PAPER_LINEAR[ 0 ] * ( 1 - a );
		const g = SRGB_TO_LINEAR[ pixels[ i * 4 + 1 ] ] * a + PAPER_LINEAR[ 1 ] * ( 1 - a );
		const b = SRGB_TO_LINEAR[ pixels[ i * 4 + 2 ] ] * a + PAPER_LINEAR[ 2 ] * ( 1 - a );
		lin[ i * 3 ] = r;
		lin[ i * 3 + 1 ] = g;
		lin[ i * 3 + 2 ] = b;
		linearToOklab( r, g, b, lab, i * 3 );
	}
	return { lin, lab };
}

export function analyzeImage( { width: W, height: H, pixels, K: K0, seed, exclude = [], remap = [], style = 'auto', simplify = 1 } ) {
	const times = {};
	let t = performance.now();
	const mark = ( name ) => {
		const now = performance.now();
		times[ name ] = now - t;
		t = now;
	};
	const N = W * H;
	const B = Math.max( W, H );
	const rng = new Rng( seed ^ 0x5bd1e995 );

	const { lin, lab } = pixelsToLabLinear( pixels, N );
	// Photographs are first simplified into painterly shapes; flat artwork
	// is painted as it is. 'auto' decides from the image's fine texture.
	const texture = textureScore( lab, W, H );
	const photo = 'photo' === style || ( 'auto' === style && texture > 0.12 );
	if ( photo ) {
		simplifyPhoto( lab, lin, W, H, B, simplify );
	}
	const L = channel( lab, 0, N );
	mark( 'normalize' );

	/* Structural maps ------------------------------------------------ */
	const edge = sobel( L, W, H );
	const ea = sobel( channel( lab, 1, N ), W, H );
	const eb = sobel( channel( lab, 2, N ), W, H );
	for ( let i = 0; i < N; i++ ) {
		edge[ i ] += 0.7 * ( ea[ i ] + eb[ i ] );
	}
	normalize( edge, 0.98 );

	const mu = boxBlur( L, W, H, 2 );
	const L2 = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		L2[ i ] = L[ i ] * L[ i ];
	}
	const mu2 = boxBlur( L2, W, H, 2 );
	const detail = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		detail[ i ] = Math.sqrt( Math.max( 0, mu2[ i ] - mu[ i ] * mu[ i ] ) );
	}
	normalize( detail, 0.97 );
	mark( 'structure' );

	/* Importance (perceptual saliency proxy) ------------------------ */
	const edgeDensity = normalize( gaussBlur( edge, W, H, B / 45 ), 0.98 );
	const sigC = B / 10;
	const bl = gaussBlur( L, W, H, sigC );
	const ba = gaussBlur( channel( lab, 1, N ), W, H, sigC );
	const bb = gaussBlur( channel( lab, 2, N ), W, H, sigC );
	const contrast = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		const dl = lab[ i * 3 ] - bl[ i ];
		const da = lab[ i * 3 + 1 ] - ba[ i ];
		const db = lab[ i * 3 + 2 ] - bb[ i ];
		contrast[ i ] = Math.sqrt( dl * dl + da * da + db * db );
	}
	normalize( contrast, 0.98 );
	const importance = new Float32Array( N );
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			const i = y * W + x;
			const dx = ( x / W - 0.5 ) / 0.32;
			const dy = ( y / H - 0.47 ) / 0.36;
			const center = Math.exp( -0.5 * ( dx * dx + dy * dy ) );
			importance[ i ] = 0.36 * edgeDensity[ i ] + 0.3 * contrast[ i ] + 0.2 * center + 0.14 * detail[ i ];
		}
	}
	normalize( importance, 0.99 );
	for ( let i = 0; i < N; i++ ) {
		importance[ i ] = 0.15 + 0.85 * importance[ i ];
	}
	mark( 'importance' );

	/* Palette ------------------------------------------------------- */
	// The picture's main colours (its shapes, see Segmentation), and the
	// paints to make them with, chosen as a watercolourist would (see
	// watercolourPalette) from those colours and a finer set. In an
	// illustration, bare paper keeps its own slot.
	const shades = kmeans( lab, N, K0, rng );
	const paperShade = photo ? null : shades.find( ( c ) => paintOf( pigmentAbsorbance( c ) ).isPaper );
	const paints = watercolourPalette( shades.concat( kmeans( lab, N, Math.min( 48, K0 * 3 ), rng ) ), lin, N, K0 - ( paperShade ? 1 : 0 ), rng );
	const all = paints.map( paintOf );
	if ( paperShade ) {
		all.push( paintOf( pigmentAbsorbance( paperShade ) ) );
	}
	all.sort( ( a, b ) => b.L - a.L );
	const tmp = [ 0, 0, 0 ];
	// Colours the user dragged onto another: wherever the image uses paint A
	// it now uses paint B, as much of it, keeping its light and shade.
	const mapTo = new Map( remap.filter( ( [ a, b ] ) => a !== b && all[ a ] && all[ b ] ) );
	if ( mapTo.size ) {
		const live = all.map( ( p, k ) => k ).filter( ( k ) => ! all[ k ].isPaper );
		const D = [ 0, 0, 0 ];
		const x = [ 0, 0, 0 ];
		for ( let i = 0; i < N; i++ ) {
			opticalDensity( lin[ i * 3 ], lin[ i * 3 + 1 ], lin[ i * 3 + 2 ], D );
			if ( D[ 0 ] + D[ 1 ] + D[ 2 ] < 0.03 ) {
				continue;
			}
			// The paints that make this cell: the best one, or two of the
			// three best.
			const w = fitWeights( D );
			const top = live.map( ( k ) => [ k, fitMix( [ all[ k ].A ], D, w, x ) ] ).sort( ( p, q ) => p[ 1 ] - q[ 1 ] ).slice( 0, 3 );
			if ( ! top.length ) {
				break;
			}
			let used = [ top[ 0 ][ 0 ] ];
			let err = top[ 0 ][ 1 ];
			for ( let p = 0; p < top.length; p++ ) {
				for ( let q = p + 1; q < top.length; q++ ) {
					const e = fitMix( [ all[ top[ p ][ 0 ] ].A, all[ top[ q ][ 0 ] ].A ], D, w, x ) * 1.04 + 1e-5;
					if ( e < err ) {
						err = e;
						used = [ top[ p ][ 0 ], top[ q ][ 0 ] ];
					}
				}
			}
			if ( ! used.some( ( k ) => mapTo.has( k ) ) ) {
				continue;
			}
			fitMix( used.map( ( k ) => all[ k ].A ), D, w, x );
			used.forEach( ( k, j ) => {
				const to = mapTo.get( k );
				if ( undefined !== to ) {
					for ( let ch = 0; ch < 3; ch++ ) {
						D[ ch ] += x[ j ] * ( all[ to ].A[ ch ] - all[ k ].A[ ch ] );
					}
				}
			} );
			for ( let ch = 0; ch < 3; ch++ ) {
				lin[ i * 3 + ch ] = PAPER_LINEAR[ ch ] * Math.exp( -Math.max( 0, D[ ch ] ) );
			}
			linearToOklab( lin[ i * 3 ], lin[ i * 3 + 1 ], lin[ i * 3 + 2 ], lab, i * 3 );
		}
	}
	// Colours the user took off the palette (or transformed into another):
	// the painter mixes those areas from the remaining pigments instead.
	let pigments = all.filter( ( p, i ) => ! exclude.includes( i ) && ! mapTo.has( i ) );
	if ( ! pigments.some( ( p ) => ! p.isPaper ) ) {
		pigments = all;
	}
	const K = pigments.length;
	const palette = all.map( ( p, i ) => ( {
		hex: p.hex,
		isPaper: p.isPaper,
		excluded: ! pigments.includes( p ) && ! mapTo.has( i ),
		mappedTo: mapTo.has( i ) ? mapTo.get( i ) : -1,
	} ) );
	mark( 'palette' );

	/* Per-pixel pigment decomposition (NNLS over pairs) -------------- */
	const T0 = pigments.map( () => new Float32Array( N ) );
	const active = [];
	pigments.forEach( ( p, k ) => {
		if ( ! p.isPaper ) {
			active.push( k );
		}
	} );
	const Dt = new Float32Array( N * 3 );
	const achievable = new Float32Array( N * 3 );
	let fitErr = 0;
	const singles = new Float32Array( K * 2 );
	for ( let i = 0; i < N; i++ ) {
		const D0 = -Math.log( Math.min( 1, Math.max( 0.015, lin[ i * 3 ] / PAPER_LINEAR[ 0 ] ) ) );
		const D1 = -Math.log( Math.min( 1, Math.max( 0.015, lin[ i * 3 + 1 ] / PAPER_LINEAR[ 1 ] ) ) );
		const D2 = -Math.log( Math.min( 1, Math.max( 0.015, lin[ i * 3 + 2 ] / PAPER_LINEAR[ 2 ] ) ) );
		Dt[ i * 3 ] = D0;
		Dt[ i * 3 + 1 ] = D1;
		Dt[ i * 3 + 2 ] = D2;
		if ( D0 + D1 + D2 < 0.03 || ! active.length ) {
			continue;
		}
		// Weight errors by transmittance: errors in light areas are more visible.
		const w0 = Math.exp( -D0 ) + 0.06;
		const w1 = Math.exp( -D1 ) + 0.06;
		const w2 = Math.exp( -D2 ) + 0.06;
		let b1 = -1;
		let b2 = -1;
		let b3 = -1;
		for ( const k of active ) {
			const A = pigments[ k ].A;
			const aa = w0 * A[ 0 ] * A[ 0 ] + w1 * A[ 1 ] * A[ 1 ] + w2 * A[ 2 ] * A[ 2 ];
			const ad = w0 * A[ 0 ] * D0 + w1 * A[ 1 ] * D1 + w2 * A[ 2 ] * D2;
			const x = Math.min( MAX_DENSITY, Math.max( 0, ad / aa ) );
			const r0 = D0 - x * A[ 0 ];
			const r1 = D1 - x * A[ 1 ];
			const r2 = D2 - x * A[ 2 ];
			singles[ k * 2 ] = x;
			singles[ k * 2 + 1 ] = w0 * r0 * r0 + w1 * r1 * r1 + w2 * r2 * r2;
			const e = singles[ k * 2 + 1 ];
			if ( b1 < 0 || e < singles[ b1 * 2 + 1 ] ) {
				b3 = b2;
				b2 = b1;
				b1 = k;
			} else if ( b2 < 0 || e < singles[ b2 * 2 + 1 ] ) {
				b3 = b2;
				b2 = k;
			} else if ( b3 < 0 || e < singles[ b3 * 2 + 1 ] ) {
				b3 = k;
			}
		}
		let bestErr = singles[ b1 * 2 + 1 ];
		let ka = b1;
		let kb = -1;
		let xa = singles[ b1 * 2 ];
		let xb = 0;
		// Any two paints: the palette leaves out what two of its paints mix
		// (see watercolourPalette), so a green may be its blue and its
		// yellow though neither fits well alone.
		const cands = active;
		for ( let p = 0; p < cands.length; p++ ) {
			for ( let q = p + 1; q < cands.length; q++ ) {
				const Ai = pigments[ cands[ p ] ].A;
				const Aj = pigments[ cands[ q ] ].A;
				const a11 = w0 * Ai[ 0 ] * Ai[ 0 ] + w1 * Ai[ 1 ] * Ai[ 1 ] + w2 * Ai[ 2 ] * Ai[ 2 ];
				const a22 = w0 * Aj[ 0 ] * Aj[ 0 ] + w1 * Aj[ 1 ] * Aj[ 1 ] + w2 * Aj[ 2 ] * Aj[ 2 ];
				const a12 = w0 * Ai[ 0 ] * Aj[ 0 ] + w1 * Ai[ 1 ] * Aj[ 1 ] + w2 * Ai[ 2 ] * Aj[ 2 ];
				const c1 = w0 * Ai[ 0 ] * D0 + w1 * Ai[ 1 ] * D1 + w2 * Ai[ 2 ] * D2;
				const c2 = w0 * Aj[ 0 ] * D0 + w1 * Aj[ 1 ] * D1 + w2 * Aj[ 2 ] * D2;
				const det = a11 * a22 - a12 * a12;
				if ( det < 1e-9 ) {
					continue;
				}
				const x1 = Math.min( MAX_DENSITY, ( c1 * a22 - c2 * a12 ) / det );
				const x2 = Math.min( MAX_DENSITY, ( a11 * c2 - a12 * c1 ) / det );
				if ( x1 < 0 || x2 < 0 ) {
					continue;
				}
				const r0 = D0 - x1 * Ai[ 0 ] - x2 * Aj[ 0 ];
				const r1 = D1 - x1 * Ai[ 1 ] - x2 * Aj[ 1 ];
				const r2 = D2 - x1 * Ai[ 2 ] - x2 * Aj[ 2 ];
				// Small bias toward single-pigment solutions keeps washes clean.
				const e = ( w0 * r0 * r0 + w1 * r1 * r1 + w2 * r2 * r2 ) * 1.04 + 1e-5;
				if ( e < bestErr ) {
					bestErr = e;
					ka = cands[ p ];
					kb = cands[ q ];
					xa = x1;
					xb = x2;
				}
			}
		}
		let kc = -1;
		let xc = 0;
		if ( photo && active.length > 2 ) {
			// A photo's palette is made to be mixed: try pairs and triples of
			// the five pigments that fit best on their own.
			const top = [ ...active ].sort( ( p, q ) => singles[ p * 2 + 1 ] - singles[ q * 2 + 1 ] ).slice( 0, 5 );
			const Dv = [ D0, D1, D2 ];
			const wv = [ w0, w1, w2 ];
			const xv = [ 0, 0, 0 ];
			for ( let p = 0; p < top.length; p++ ) {
				for ( let q = p + 1; q < top.length; q++ ) {
					const e2 = fitMix( [ pigments[ top[ p ] ].A, pigments[ top[ q ] ].A ], Dv, wv, xv ) * 1.04 + 1e-5;
					if ( e2 < bestErr ) {
						bestErr = e2;
						ka = top[ p ];
						kb = top[ q ];
						kc = -1;
						xa = xv[ 0 ];
						xb = xv[ 1 ];
					}
					for ( let r = q + 1; r < top.length; r++ ) {
						const e3 = fitMix( [ pigments[ top[ p ] ].A, pigments[ top[ q ] ].A, pigments[ top[ r ] ].A ], Dv, wv, xv ) * 1.08 + 2e-5;
						if ( e3 < bestErr ) {
							bestErr = e3;
							ka = top[ p ];
							kb = top[ q ];
							kc = top[ r ];
							xa = xv[ 0 ];
							xb = xv[ 1 ];
							xc = xv[ 2 ];
						}
					}
				}
			}
		}
		T0[ ka ][ i ] = xa;
		if ( kb >= 0 ) {
			T0[ kb ][ i ] = xb;
		}
		if ( kc >= 0 ) {
			T0[ kc ][ i ] = xc;
		}
		const Aa = pigments[ ka ].A;
		const Ab = kb >= 0 ? pigments[ kb ].A : [ 0, 0, 0 ];
		const Ac = kc >= 0 ? pigments[ kc ].A : [ 0, 0, 0 ];
		achievable[ i * 3 ] = xa * Aa[ 0 ] + xb * Ab[ 0 ] + xc * Ac[ 0 ];
		achievable[ i * 3 + 1 ] = xa * Aa[ 1 ] + xb * Ab[ 1 ] + xc * Ac[ 1 ];
		achievable[ i * 3 + 2 ] = xa * Aa[ 2 ] + xb * Ab[ 2 ] + xc * Ac[ 2 ];
		fitErr += bestErr;
	}
	if ( photo ) {
		// A photo's mixes flip from pixel to pixel; let each colour form areas.
		const passes = Math.round( 2 * simplify );
		if ( passes ) {
			smoothInShapes( T0, lab, W, H, 4, Math.max( 1, Math.round( B / 400 ) ), 0.08, passes );
		}
	}
	mark( 'decomposition' );

	// Coarse-to-fine targets, one per tool size. A broad gesture can only be
	// as precise as its tool: its target is the morphological opening of the
	// fine target at its own scale (erode, then dilate back). Large areas keep
	// their full extent right up to their borders, while shapes narrower than
	// the tool (letters, eyelids, strands) are left for the fine brush. An
	// opening is never darker than the original, so nothing overshoots.
	const level = ( m, r ) => maxFilter( minFilter( m, W, H, r ), W, H, r );
	const r1 = Math.max( 1, Math.round( B / 130 ) );
	const r2 = Math.max( 3, Math.round( B / 45 ) );
	const T1 = T0.map( ( m, k ) => ( pigments[ k ].isPaper ? m : level( m, r1 ) ) );
	const T2 = T0.map( ( m, k ) => ( pigments[ k ].isPaper ? m : level( m, r2 ) ) );
	mark( 'pyramid' );

	/* Segmentation -------------------------------------------------- */
	// Shapes: areas of one of the picture's main colours (so the light and
	// the dark of one paint stay apart), each labelled with the paint that
	// makes it, the one it takes the most of (or bare paper).
	const paperK = pigments.findIndex( ( p ) => p.isPaper );
	const strength = pigments.map( ( p ) => Math.max( p.A[ 0 ], p.A[ 1 ], p.A[ 2 ] ) );
	const bareShade = shades.map( ( c ) => paintOf( pigmentAbsorbance( c ) ).isPaper );
	// Cell key: shade * 32 + paint (K <= 17).
	let seg = new Uint16Array( N );
	for ( let i = 0; i < N; i++ ) {
		let sh = 0;
		let bd = Infinity;
		for ( let c = 0; c < shades.length; c++ ) {
			const d = ( lab[ i * 3 ] - shades[ c ][ 0 ] ) ** 2 + ( lab[ i * 3 + 1 ] - shades[ c ][ 1 ] ) ** 2 + ( lab[ i * 3 + 2 ] - shades[ c ][ 2 ] ) ** 2;
			if ( d < bd ) {
				bd = d;
				sh = c;
			}
		}
		let k = -1;
		if ( bareShade[ sh ] && paperK >= 0 ) {
			k = paperK;
		} else {
			let most = 0;
			for ( let j = 0; j < K; j++ ) {
				const v = pigments[ j ].isPaper ? 0 : T0[ j ][ i ] * strength[ j ];
				if ( v > most ) {
					most = v;
					k = j;
				}
			}
		}
		if ( k < 0 ) {
			// Nothing to paint: bare paper, or the nearest paint where there is none.
			k = paperK;
			if ( k < 0 ) {
				let kd = Infinity;
				for ( let j = 0; j < K; j++ ) {
					const c = pigments[ j ].lab;
					const d = ( lab[ i * 3 ] - c[ 0 ] ) ** 2 + ( lab[ i * 3 + 1 ] - c[ 1 ] ) ** 2 + ( lab[ i * 3 + 2 ] - c[ 2 ] ) ** 2;
					if ( d < kd ) {
						kd = d;
						k = j;
					}
				}
			}
		}
		seg[ i ] = sh * 32 + k;
	}
	// Ragged borders and specks go: a few passes of a 3x3 majority filter.
	const around = new Uint16Array( 9 );
	for ( let pass = 0; pass < 2; pass++ ) {
		const next = new Uint16Array( N );
		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				let n = 0;
				for ( let dy = -1; dy <= 1; dy++ ) {
					const yy = Math.min( H - 1, Math.max( 0, y + dy ) );
					for ( let dx = -1; dx <= 1; dx++ ) {
						around[ n++ ] = seg[ yy * W + Math.min( W - 1, Math.max( 0, x + dx ) ) ];
					}
				}
				let best = seg[ y * W + x ];
				let bestN = 0;
				for ( let p = 0; p < 9; p++ ) {
					let c = 0;
					for ( let q = 0; q < 9; q++ ) {
						c += around[ q ] === around[ p ] ? 1 : 0;
					}
					if ( c > bestN || ( c === bestN && around[ p ] === seg[ y * W + x ] ) ) {
						bestN = c;
						best = around[ p ];
					}
				}
				next[ y * W + x ] = best;
			}
		}
		seg = next;
	}
	const labels = Uint8Array.from( seg, ( v ) => v & 31 );
	const regionOf = new Int32Array( N ).fill( -1 );
	const regions = [];
	const stack = new Int32Array( N );
	for ( let s = 0; s < N; s++ ) {
		if ( regionOf[ s ] >= 0 ) {
			continue;
		}
		const id = regions.length;
		const lbl = seg[ s ];
		let sp = 0;
		stack[ sp++ ] = s;
		regionOf[ s ] = id;
		let area = 0;
		let sx = 0;
		let sy = 0;
		let imp = 0;
		let ed = 0;
		let minX = W;
		let minY = H;
		let maxX = 0;
		let maxY = 0;
		while ( sp > 0 ) {
			const i = stack[ --sp ];
			const x = i % W;
			const y = ( i / W ) | 0;
			area++;
			sx += x;
			sy += y;
			imp += importance[ i ];
			ed += edge[ i ];
			if ( x < minX ) {
				minX = x;
			}
			if ( x > maxX ) {
				maxX = x;
			}
			if ( y < minY ) {
				minY = y;
			}
			if ( y > maxY ) {
				maxY = y;
			}
			if ( x > 0 && regionOf[ i - 1 ] < 0 && seg[ i - 1 ] === lbl ) {
				regionOf[ i - 1 ] = id;
				stack[ sp++ ] = i - 1;
			}
			if ( x < W - 1 && regionOf[ i + 1 ] < 0 && seg[ i + 1 ] === lbl ) {
				regionOf[ i + 1 ] = id;
				stack[ sp++ ] = i + 1;
			}
			if ( y > 0 && regionOf[ i - W ] < 0 && seg[ i - W ] === lbl ) {
				regionOf[ i - W ] = id;
				stack[ sp++ ] = i - W;
			}
			if ( y < H - 1 && regionOf[ i + W ] < 0 && seg[ i + W ] === lbl ) {
				regionOf[ i + W ] = id;
				stack[ sp++ ] = i + W;
			}
		}
		regions.push( {
			id,
			label: lbl & 31,
			area,
			cx: sx / area,
			cy: sy / area,
			importance: imp / area,
			edge: ed / area,
			minX,
			minY,
			maxX,
			maxY,
		} );
	}
	mark( 'segmentation' );

	/* Feature scale + darkness --------------------------------------- */
	const fineness = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		fineness[ i ] = 0.6 * detail[ i ] + 0.55 * edge[ i ];
	}
	const fineBlur = normalize( gaussBlur( fineness, W, H, B / 70 ), 0.96 );
	const scale = new Float32Array( N );
	const darkness = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		const f = fineBlur[ i ];
		scale[ i ] = B * 0.008 + B * 0.05 * Math.pow( 1 - f, 1.6 );
		darkness[ i ] = Math.min( 1.5, ( Dt[ i * 3 ] + Dt[ i * 3 + 1 ] + Dt[ i * 3 + 2 ] ) / 3 );
	}
	mark( 'scale' );

	/* Masking fluid: only thin whites stay bare paper -------------------- */
	// A painter masks out white lettering and small highlights before washing
	// over them, never a big white shape (that is simply left unpainted).
	// White components whose thickest point is thin are reserved.
	const white = new Uint8Array( N );
	for ( let i = 0; i < N; i++ ) {
		white[ i ] = Dt[ i * 3 ] + Dt[ i * 3 + 1 ] + Dt[ i * 3 + 2 ] < 0.12 ? 1 : 0;
	}
	const thinMax = Math.max( 2.5, B * 0.02 );
	const reserve = new Uint8Array( N );
	let reserved = 0;
	// Masks the components of `mask` that are thin and small with `value`.
	const maskOut = ( mask, value, maxArea ) => {
		const depth = chamferInside( mask, W, H );
		const seen = new Uint8Array( N );
		const stack = new Int32Array( N );
		for ( let s0 = 0; s0 < N; s0++ ) {
			if ( ! mask[ s0 ] || seen[ s0 ] ) {
				continue;
			}
			let sp = 0;
			stack[ sp++ ] = s0;
			seen[ s0 ] = 1;
			const comp = [];
			let thickest = 0;
			while ( sp > 0 ) {
				const c = stack[ --sp ];
				comp.push( c );
				thickest = Math.max( thickest, depth[ c ] );
				const x = c % W;
				const y = ( c / W ) | 0;
				for ( const n of [ x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1 ] ) {
					if ( n >= 0 && mask[ n ] && ! seen[ n ] ) {
						seen[ n ] = 1;
						stack[ sp++ ] = n;
					}
				}
			}
			if ( thickest <= thinMax && comp.length < maxArea ) {
				for ( const c of comp ) {
					reserve[ c ] = value;
				}
				reserved += comp.length;
			}
		}
	};
	maskOut( white, 1, N * 0.02 );
	// Small light shapes in a darker area (flowers in the grass, lit windows,
	// a catchlight, light strands in dark hair) are masked too, but only
	// until the details: the washes and glazes go over the mask, then it is
	// rubbed off and they are painted in their own colour on clean paper. A
	// light colour laid over the grass's green or the hair's brown would stay
	// dark. Marked 2. Lighter, as the eye sees it, than the area around them:
	// than what opening (a min, then a max filter) leaves of the lightness
	// where they were, i.e. the area with its small light shapes taken out.
	// Only inside a solid darker area (hair around a strand, a wall around a
	// window): where the darker paint is the thin part (the branches of a
	// tree against the sky), the light is washed in first and the dark goes
	// on top, no mask needed.
	const closeR = Math.max( 1, Math.round( thinMax ) );
	const area = maxFilter( minFilter( L, W, H, closeR ), W, H, closeR );
	const ground = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		ground[ i ] = L[ i ] - area[ i ] <= MASK_STEP ? 1 : 0;
	}
	const solid = boxBlur( ground, W, H, 2 * closeR );
	const speck = new Uint8Array( N );
	for ( let i = 0; i < N; i++ ) {
		speck[ i ] = ! reserve[ i ] && L[ i ] >= MASK_MIN_L && L[ i ] - area[ i ] > MASK_STEP && solid[ i ] >= MASK_SOLID ? 1 : 0;
	}
	maskOut( speck, 2, ( B * 0.03 ) ** 2 );
	mark( 'reserve' );

	/* Room for a drop: distance to the nearest border -------------------- */
	// Drops are never clipped to a shape; the painter keeps them inside an
	// area by size and placement. Chamfer distance (cells) to the nearest
	// strong edge; the sheet border is not a border.
	const room = new Float32Array( N );
	for ( let i = 0; i < N; i++ ) {
		room[ i ] = edge[ i ] > 0.3 ? 0 : 1e9;
	}
	const D1 = 1;
	const D2 = Math.SQRT2;
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			const i = y * W + x;
			let v = room[ i ];
			if ( x > 0 ) {
				v = Math.min( v, room[ i - 1 ] + D1 );
			}
			if ( y > 0 ) {
				v = Math.min( v, room[ i - W ] + D1 );
				if ( x > 0 ) {
					v = Math.min( v, room[ i - W - 1 ] + D2 );
				}
				if ( x < W - 1 ) {
					v = Math.min( v, room[ i - W + 1 ] + D2 );
				}
			}
			room[ i ] = v;
		}
	}
	for ( let y = H - 1; y >= 0; y-- ) {
		for ( let x = W - 1; x >= 0; x-- ) {
			const i = y * W + x;
			let v = room[ i ];
			if ( x < W - 1 ) {
				v = Math.min( v, room[ i + 1 ] + D1 );
			}
			if ( y < H - 1 ) {
				v = Math.min( v, room[ i + W ] + D1 );
				if ( x < W - 1 ) {
					v = Math.min( v, room[ i + W + 1 ] + D2 );
				}
				if ( x > 0 ) {
					v = Math.min( v, room[ i + W - 1 ] + D2 );
				}
			}
			room[ i ] = Math.min( v, B );
		}
	}
	mark( 'room' );

	// Palette fidelity: how well can this palette reproduce the image at all?
	let paletteDE = 0;
	for ( let i = 0; i < N; i += 3 ) {
		const r = PAPER_LINEAR[ 0 ] * Math.exp( -achievable[ i * 3 ] );
		const g = PAPER_LINEAR[ 1 ] * Math.exp( -achievable[ i * 3 + 1 ] );
		const b = PAPER_LINEAR[ 2 ] * Math.exp( -achievable[ i * 3 + 2 ] );
		linearToOklab( r, g, b, tmp );
		const dl = tmp[ 0 ] - lab[ i * 3 ];
		const da = tmp[ 1 ] - lab[ i * 3 + 1 ];
		const db = tmp[ 2 ] - lab[ i * 3 + 2 ];
		paletteDE += Math.sqrt( dl * dl + da * da + db * db );
	}
	paletteDE = ( 100 * paletteDE ) / Math.ceil( N / 3 );

	return {
		W,
		H,
		B,
		K,
		palette,
		lab,
		pigments,
		T: [ T0, T1, T2 ],
		edge,
		detail,
		importance,
		scale,
		darkness,
		reserve,
		room,
		labels,
		regionOf,
		regions,
		stats: { paletteDE, fitErr: fitErr / N, regions: regions.length, reserved: reserved / N },
		photo,
		texture,
		times,
	};
}
