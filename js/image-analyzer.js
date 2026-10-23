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

/** Separable local extremum with a square window of radius r. */
function rankFilter( src, W, H, r, pick ) {
	const tmp = new Float32Array( src.length );
	const out = new Float32Array( src.length );
	for ( let y = 0; y < H; y++ ) {
		const row = y * W;
		for ( let x = 0; x < W; x++ ) {
			let m = src[ row + x ];
			const x0 = Math.max( 0, x - r );
			const x1 = Math.min( W - 1, x + r );
			for ( let k = x0; k <= x1; k++ ) {
				m = pick( m, src[ row + k ] );
			}
			tmp[ row + x ] = m;
		}
	}
	for ( let x = 0; x < W; x++ ) {
		for ( let y = 0; y < H; y++ ) {
			let m = tmp[ y * W + x ];
			const y0 = Math.max( 0, y - r );
			const y1 = Math.min( H - 1, y + r );
			for ( let k = y0; k <= y1; k++ ) {
				m = pick( m, tmp[ k * W + x ] );
			}
			out[ y * W + x ] = m;
		}
	}
	return out;
}

/** Dilation (local maximum). */
export function maxFilter( src, W, H, r ) {
	return rankFilter( src, W, H, r, Math.max );
}

/** Erosion (local minimum) with a square window of radius r. */
export function minFilter( src, W, H, r ) {
	return rankFilter( src, W, H, r, Math.min );
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

export function analyzeImage( { width: W, height: H, pixels, K, seed } ) {
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
	const centers = kmeans( lab, N, K, rng );
	centers.sort( ( a, b ) => b[ 0 ] - a[ 0 ] );
	const tmp = [ 0, 0, 0 ];
	const pigments = centers.map( ( c ) => {
		oklabToLinear( c[ 0 ], c[ 1 ], c[ 2 ], tmp );
		const linC = tmp.map( ( v ) => Math.max( 0, Math.min( 1, v ) ) );
		const A = linC.map( ( v, ch ) => -Math.log( Math.min( 0.999, Math.max( 0.03, v / PAPER_LINEAR[ ch ] ) ) ) );
		const srgb = linC.map( linearToSrgb );
		const strength = Math.max( A[ 0 ], A[ 1 ], A[ 2 ] );
		return { lab: c, srgb, hex: toHex( srgb ), A, L: c[ 0 ], isPaper: strength < 0.06 };
	} );
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

	/* Masking fluid: small whites next to edges stay bare paper ---------- */
	// A painter masks out white lettering and highlights before washing over
	// them. Paper-white cells within a few cells of a strong edge are reserved.
	const nearEdge = new Uint8Array( N );
	const ER = Math.max( 2, Math.round( B / 260 ) );
	for ( let y = 0; y < H; y++ ) {
		for ( let x = 0; x < W; x++ ) {
			if ( edge[ y * W + x ] > 0.35 ) {
				for ( let dy = -ER; dy <= ER; dy++ ) {
					const yy = y + dy;
					if ( yy < 0 || yy >= H ) {
						continue;
					}
					for ( let dx = -ER; dx <= ER; dx++ ) {
						const xx = x + dx;
						if ( xx >= 0 && xx < W ) {
							nearEdge[ yy * W + xx ] = 1;
						}
					}
				}
			}
		}
	}
	const reserve = new Uint8Array( N );
	let reserved = 0;
	for ( let i = 0; i < N; i++ ) {
		if ( nearEdge[ i ] && Dt[ i * 3 ] + Dt[ i * 3 + 1 ] + Dt[ i * 3 + 2 ] < 0.12 ) {
			reserve[ i ] = 1;
			reserved++;
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
		times,
	};
}
