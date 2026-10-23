/**
 * ImageAnalyzer — Phase A.
 *
 * Builds a reduced-resolution representation of the reference:
 *  - linear RGB + OKLab maps, luminance
 *  - limited pigment palette (k-means++ in OKLab)
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
 * inside areas while keeping the edges between them. Updates lab and lin.
 */
function simplifyPhoto( lab, lin, W, H, B ) {
	const N = W * H;
	// The texture to flatten has a size relative to the picture: the filter
	// spans ~B/140 cells, sampled sparsely so its cost per cell is the same
	// at every Detail setting.
	const spatial = sparseKernel( 3, Math.max( 1, Math.round( B / 400 ) ) );
	const sr = 2 * 0.05 ** 2;
	let src = lab;
	let dst = new Float32Array( N * 3 );
	for ( let iter = 0; iter < 4; iter++ ) {
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

export function analyzeImage( { width: W, height: H, pixels, K: K0, seed, exclude = [], remap = [], style = 'auto' } ) {
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
		simplifyPhoto( lab, lin, W, H, B );
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
	const centers = kmeans( lab, N, K0, rng );
	centers.sort( ( a, b ) => b[ 0 ] - a[ 0 ] );
	const tmp = [ 0, 0, 0 ];
	const all = centers.map( ( c ) => {
		oklabToLinear( c[ 0 ], c[ 1 ], c[ 2 ], tmp );
		const linC = tmp.map( ( v ) => Math.max( 0, Math.min( 1, v ) ) );
		const A = linC.map( ( v, ch ) => -Math.log( Math.min( 0.999, Math.max( 0.03, v / PAPER_LINEAR[ ch ] ) ) ) );
		const srgb = linC.map( linearToSrgb );
		const strength = Math.max( A[ 0 ], A[ 1 ], A[ 2 ] );
		return { lab: c, srgb, hex: toHex( srgb ), A, L: c[ 0 ], isPaper: strength < 0.06 };
	} );
	// Colours the user dragged onto another: wherever the image uses colour A
	// it now uses colour B, keeping its light and shade (shift in OKLab).
	const mapTo = new Map( remap.filter( ( [ a, b ] ) => a !== b && all[ a ] && all[ b ] ) );
	if ( mapTo.size ) {
		for ( let i = 0; i < N; i++ ) {
			let best = 0;
			let bd = Infinity;
			for ( let c = 0; c < all.length; c++ ) {
				const dl = lab[ i * 3 ] - all[ c ].lab[ 0 ];
				const da = lab[ i * 3 + 1 ] - all[ c ].lab[ 1 ];
				const db = lab[ i * 3 + 2 ] - all[ c ].lab[ 2 ];
				const d = dl * dl + da * da + db * db;
				if ( d < bd ) {
					bd = d;
					best = c;
				}
			}
			const to = mapTo.get( best );
			if ( undefined === to ) {
				continue;
			}
			for ( let ch = 0; ch < 3; ch++ ) {
				lab[ i * 3 + ch ] += all[ to ].lab[ ch ] - all[ best ].lab[ ch ];
			}
			oklabToLinear( lab[ i * 3 ], lab[ i * 3 + 1 ], lab[ i * 3 + 2 ], tmp );
			for ( let ch = 0; ch < 3; ch++ ) {
				lin[ i * 3 + ch ] = Math.max( 0, Math.min( 1, tmp[ ch ] ) );
			}
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
		const cands = [ b1, b2, b3 ].filter( ( k ) => k >= 0 );
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
		T0[ ka ][ i ] = xa;
		if ( kb >= 0 ) {
			T0[ kb ][ i ] = xb;
		}
		const Aa = pigments[ ka ].A;
		const Ab = kb >= 0 ? pigments[ kb ].A : [ 0, 0, 0 ];
		achievable[ i * 3 ] = xa * Aa[ 0 ] + xb * Ab[ 0 ];
		achievable[ i * 3 + 1 ] = xa * Aa[ 1 ] + xb * Ab[ 1 ];
		achievable[ i * 3 + 2 ] = xa * Aa[ 2 ] + xb * Ab[ 2 ];
		fitErr += bestErr;
	}
	if ( photo ) {
		// A photo's mixes flip from pixel to pixel; let each colour form areas.
		smoothInShapes( T0, lab, W, H, 4, Math.max( 1, Math.round( B / 400 ) ), 0.08, 2 );
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
	let labels = new Uint8Array( N );
	for ( let i = 0; i < N; i++ ) {
		let best = 0;
		let bd = Infinity;
		for ( let k = 0; k < K; k++ ) {
			const c = pigments[ k ].lab;
			const dl = lab[ i * 3 ] - c[ 0 ];
			const da = lab[ i * 3 + 1 ] - c[ 1 ];
			const db = lab[ i * 3 + 2 ] - c[ 2 ];
			const d = dl * dl + da * da + db * db;
			if ( d < bd ) {
				bd = d;
				best = k;
			}
		}
		labels[ i ] = best;
	}
	const counts = new Uint16Array( K );
	for ( let pass = 0; pass < 2; pass++ ) {
		const next = new Uint8Array( N );
		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				counts.fill( 0 );
				for ( let dy = -1; dy <= 1; dy++ ) {
					const yy = Math.min( H - 1, Math.max( 0, y + dy ) );
					for ( let dx = -1; dx <= 1; dx++ ) {
						const xx = Math.min( W - 1, Math.max( 0, x + dx ) );
						counts[ labels[ yy * W + xx ] ]++;
					}
				}
				let best = labels[ y * W + x ];
				for ( let k = 0; k < K; k++ ) {
					if ( counts[ k ] > counts[ best ] ) {
						best = k;
					}
				}
				next[ y * W + x ] = best;
			}
		}
		labels = next;
	}
	const regionOf = new Int32Array( N ).fill( -1 );
	const regions = [];
	const stack = new Int32Array( N );
	for ( let s = 0; s < N; s++ ) {
		if ( regionOf[ s ] >= 0 ) {
			continue;
		}
		const id = regions.length;
		const lbl = labels[ s ];
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
			if ( x > 0 && regionOf[ i - 1 ] < 0 && labels[ i - 1 ] === lbl ) {
				regionOf[ i - 1 ] = id;
				stack[ sp++ ] = i - 1;
			}
			if ( x < W - 1 && regionOf[ i + 1 ] < 0 && labels[ i + 1 ] === lbl ) {
				regionOf[ i + 1 ] = id;
				stack[ sp++ ] = i + 1;
			}
			if ( y > 0 && regionOf[ i - W ] < 0 && labels[ i - W ] === lbl ) {
				regionOf[ i - W ] = id;
				stack[ sp++ ] = i - W;
			}
			if ( y < H - 1 && regionOf[ i + W ] < 0 && labels[ i + W ] === lbl ) {
				regionOf[ i + W ] = id;
				stack[ sp++ ] = i + W;
			}
		}
		regions.push( {
			id,
			label: lbl,
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
	const wDepth = chamferInside( white, W, H );
	const thinMax = Math.max( 2.5, B * 0.02 );
	const reserve = new Uint8Array( N );
	const wSeen = new Uint8Array( N );
	const wStack = new Int32Array( N );
	let reserved = 0;
	for ( let s0 = 0; s0 < N; s0++ ) {
		if ( ! white[ s0 ] || wSeen[ s0 ] ) {
			continue;
		}
		let sp = 0;
		wStack[ sp++ ] = s0;
		wSeen[ s0 ] = 1;
		const comp = [];
		let thickest = 0;
		while ( sp > 0 ) {
			const c = wStack[ --sp ];
			comp.push( c );
			thickest = Math.max( thickest, wDepth[ c ] );
			const x = c % W;
			const y = ( c / W ) | 0;
			for ( const n of [ x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1 ] ) {
				if ( n >= 0 && white[ n ] && ! wSeen[ n ] ) {
					wSeen[ n ] = 1;
					wStack[ sp++ ] = n;
				}
			}
		}
		if ( thickest <= thinMax && comp.length < N * 0.02 ) {
			for ( const c of comp ) {
				reserve[ c ] = 1;
			}
			reserved += comp.length;
		}
	}
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
