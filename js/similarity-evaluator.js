/**
 * SimilarityEvaluator — Phase D (runs in the worker).
 *
 * Loss = multiscale perceptual color difference (OKLab ΔE at 1x, 1/2, 1/4)
 *      + luminance structure (SSIM on L)
 *      + edge/structure agreement (Sobel magnitude correlation and abs diff)
 * weighted by the perceptual importance map. Produces a half-resolution
 * error map that drives where the painter corrects next, plus a signed
 * lightness map (too light → add pigment, too dark → lift).
 */

import { linearToOklab, PAPER_LINEAR, SRGB_TO_LINEAR } from './color.js';
import { boxBlur, sobel, percentile } from './image-analyzer.js';

function down2( lab, W, H ) {
	const w = Math.ceil( W / 2 );
	const h = Math.ceil( H / 2 );
	const out = new Float32Array( w * h * 3 );
	for ( let y = 0; y < h; y++ ) {
		for ( let x = 0; x < w; x++ ) {
			const x0 = Math.min( W - 1, x * 2 );
			const x1 = Math.min( W - 1, x * 2 + 1 );
			const y0 = Math.min( H - 1, y * 2 );
			const y1 = Math.min( H - 1, y * 2 + 1 );
			for ( let c = 0; c < 3; c++ ) {
				out[ ( y * w + x ) * 3 + c ] =
					0.25 * ( lab[ ( y0 * W + x0 ) * 3 + c ] + lab[ ( y0 * W + x1 ) * 3 + c ] + lab[ ( y1 * W + x0 ) * 3 + c ] + lab[ ( y1 * W + x1 ) * 3 + c ] );
			}
		}
	}
	return { lab: out, W: w, H: h };
}

function deltaE( a, b, n, out ) {
	let sum = 0;
	for ( let i = 0; i < n; i++ ) {
		const dl = a[ i * 3 ] - b[ i * 3 ];
		const da = a[ i * 3 + 1 ] - b[ i * 3 + 1 ];
		const db = a[ i * 3 + 2 ] - b[ i * 3 + 2 ];
		const d = 100 * Math.sqrt( dl * dl + da * da + db * db );
		if ( out ) {
			out[ i ] = d;
		}
		sum += d;
	}
	return sum / n;
}

function lightness( lab, n ) {
	const L = new Float32Array( n );
	for ( let i = 0; i < n; i++ ) {
		L[ i ] = lab[ i * 3 ];
	}
	return L;
}

/** Mean SSIM over 7x7 windows on OKLab lightness (dynamic range 1). */
function ssim( X, Y, W, H, pre ) {
	const n = W * H;
	const r = 3;
	const mx = pre ? pre.mx : boxBlur( X, W, H, r );
	const xx = new Float32Array( n );
	const yy = new Float32Array( n );
	const xy = new Float32Array( n );
	for ( let i = 0; i < n; i++ ) {
		xx[ i ] = X[ i ] * X[ i ];
		yy[ i ] = Y[ i ] * Y[ i ];
		xy[ i ] = X[ i ] * Y[ i ];
	}
	const my = boxBlur( Y, W, H, r );
	const sxx = pre ? pre.sxx : boxBlur( xx, W, H, r );
	const syy = boxBlur( yy, W, H, r );
	const sxy = boxBlur( xy, W, H, r );
	const C1 = 0.01 * 0.01;
	const C2 = 0.03 * 0.03;
	let sum = 0;
	for ( let i = 0; i < n; i++ ) {
		const vx = sxx[ i ] - mx[ i ] * mx[ i ];
		const vy = syy[ i ] - my[ i ] * my[ i ];
		const cov = sxy[ i ] - mx[ i ] * my[ i ];
		sum += ( ( 2 * mx[ i ] * my[ i ] + C1 ) * ( 2 * cov + C2 ) ) / ( ( mx[ i ] * mx[ i ] + my[ i ] * my[ i ] + C1 ) * ( vx + vy + C2 ) );
	}
	return { value: sum / n, mx, sxx };
}

function correlation( a, b, n ) {
	let ma = 0;
	let mb = 0;
	for ( let i = 0; i < n; i++ ) {
		ma += a[ i ];
		mb += b[ i ];
	}
	ma /= n;
	mb /= n;
	let cov = 0;
	let va = 0;
	let vb = 0;
	for ( let i = 0; i < n; i++ ) {
		const da = a[ i ] - ma;
		const db = b[ i ] - mb;
		cov += da * db;
		va += da * da;
		vb += db * db;
	}
	return cov / Math.sqrt( va * vb + 1e-12 );
}

function down2L( L, W, H ) {
	const w = Math.ceil( W / 2 );
	const h = Math.ceil( H / 2 );
	const out = new Float32Array( w * h );
	for ( let y = 0; y < h; y++ ) {
		const y0 = Math.min( H - 1, y * 2 ) * W;
		const y1 = Math.min( H - 1, y * 2 + 1 ) * W;
		for ( let x = 0; x < w; x++ ) {
			const x0 = Math.min( W - 1, x * 2 );
			const x1 = Math.min( W - 1, x * 2 + 1 );
			out[ y * w + x ] = 0.25 * ( L[ y0 + x0 ] + L[ y0 + x1 ] + L[ y1 + x0 ] + L[ y1 + x1 ] );
		}
	}
	return { L: out, W: w, H: h };
}

/**
 * Structure at perceptual scales: SSIM averaged over 1/2 and 1/4 of the
 * grid, and Sobel-magnitude correlation at 1/2. Paper grain and pigment
 * mottling are part of the medium, not structural error, so the full
 * resolution is left to the ΔE terms.
 */
function structure( Lt, Lc, W, H ) {
	const t2 = down2L( Lt, W, H );
	const c2 = down2L( Lc, W, H );
	const t4 = down2L( t2.L, t2.W, t2.H );
	const c4 = down2L( c2.L, c2.W, c2.H );
	const s = 0.5 * ( ssim( t2.L, c2.L, t2.W, t2.H ).value + ssim( t4.L, c4.L, t4.W, t4.H ).value );
	const edgeCorr = correlation( sobel( c2.L, c2.W, c2.H ), sobel( t2.L, t2.W, t2.H ), t2.W * t2.H );
	return { ssim: s, edgeCorr };
}

export function combineScore( { deltaE: dE, deltaE4, ssim: s, edgeCorr } ) {
	return (
		100 *
		( 0.35 * ( 1 - Math.min( 1, dE / 30 ) ) +
			0.3 * Math.max( 0, s ) +
			0.15 * Math.max( 0, edgeCorr ) +
			0.2 * ( 1 - Math.min( 1, deltaE4 / 25 ) ) )
	);
}

export class SimilarityEvaluator {
	constructor( { W, H, lab, importance, refW, refH, refLab } ) {
		this.W = W;
		this.H = H;
		this.N = W * H;
		this.lab = lab;
		this.importance = importance;
		this.L = lightness( lab, this.N );
		this.p2 = down2( lab, W, H );
		this.p4 = down2( this.p2.lab, this.p2.W, this.p2.H );
		this.edge = sobel( this.L, W, H );
		this.edgeScale = percentile( this.edge, 0.98 ) || 1;
		this.EW = this.p2.W;
		this.EH = this.p2.H;
		this.cur = new Float32Array( this.N * 3 );
		this.dE1 = new Float32Array( this.N );
		this.dE2 = new Float32Array( this.EW * this.EH );
		this.dE4 = new Float32Array( this.p4.W * this.p4.H );
		this.ref = refLab ? { W: refW, H: refH, lab: refLab, L: lightness( refLab, refW * refH ) } : null;
	}

	/**
	 * @param {Float32Array} D optical density (3 per cell) of the painting.
	 */
	evaluate( D ) {
		const t0 = performance.now();
		const { W, H, N, cur, EW, EH } = this;
		for ( let i = 0; i < N; i++ ) {
			linearToOklab(
				PAPER_LINEAR[ 0 ] * Math.exp( -D[ i * 3 ] ),
				PAPER_LINEAR[ 1 ] * Math.exp( -D[ i * 3 + 1 ] ),
				PAPER_LINEAR[ 2 ] * Math.exp( -D[ i * 3 + 2 ] ),
				cur,
				i * 3
			);
		}
		const dE = deltaE( cur, this.lab, N, this.dE1 );
		const c2 = down2( cur, W, H );
		const dE2 = deltaE( c2.lab, this.p2.lab, EW * EH, this.dE2 );
		const c4 = down2( c2.lab, c2.W, c2.H );
		const dE4 = deltaE( c4.lab, this.p4.lab, c4.W * c4.H, this.dE4 );
		const Lc = lightness( cur, N );
		const st = structure( this.L, Lc, W, H );
		const ec = sobel( Lc, W, H );

		const err = new Float32Array( EW * EH );
		const signed = new Float32Array( EW * EH );
		// Plain colour difference as the eye sees it (no importance weighting,
		// no edge-alignment term): what Endless uses to pick where to work.
		const de = new Float32Array( EW * EH );
		const errU8 = new Uint8Array( EW * EH );
		const W4 = c4.W;
		let wsum = 0;
		let wde = 0;
		for ( let by = 0; by < EH; by++ ) {
			for ( let bx = 0; bx < EW; bx++ ) {
				const b = by * EW + bx;
				let e1 = 0;
				let st = 0;
				let imp = 0;
				let sl = 0;
				let n = 0;
				for ( let dy = 0; dy < 2; dy++ ) {
					const y = Math.min( H - 1, by * 2 + dy );
					for ( let dx = 0; dx < 2; dx++ ) {
						const x = Math.min( W - 1, bx * 2 + dx );
						const i = y * W + x;
						e1 += this.dE1[ i ];
						st += Math.abs( ec[ i ] - this.edge[ i ] ) / this.edgeScale;
						imp += this.importance[ i ];
						sl += cur[ i * 3 ] - this.lab[ i * 3 ];
						n++;
					}
				}
				e1 /= n;
				st /= n;
				imp /= n;
				const e4 = this.dE4[ ( by >> 1 ) * W4 + ( bx >> 1 ) ];
				const e = ( 0.45 * e1 + 0.3 * this.dE2[ b ] + 0.25 * e4 ) * ( 0.45 + imp ) + 12 * Math.min( 1, st ) * imp;
				err[ b ] = e;
				de[ b ] = 0.45 * e1 + 0.3 * this.dE2[ b ] + 0.25 * e4;
				signed[ b ] = ( 100 * sl ) / n;
				errU8[ b ] = Math.min( 255, e * 5 );
				wsum += imp;
				wde += e1 * imp;
			}
		}
		const scores = {
			deltaE: dE,
			deltaEWeighted: wde / wsum,
			deltaE2: dE2,
			deltaE4: dE4,
			ssim: st.ssim,
			edgeCorr: st.edgeCorr,
		};
		scores.similarity = combineScore( scores );
		scores.ms = performance.now() - t0;
		return { err, de, signed, errU8, EW, EH, scores };
	}

	/**
	 * Final evaluation of the rendered artwork (paper texture included)
	 * against the higher-resolution original reference.
	 */
	evaluateRendered( rgba, w, h ) {
		const ref = this.ref;
		if ( ! ref || ref.W !== w || ref.H !== h ) {
			throw new Error( 'Rendered size does not match reference' );
		}
		const n = w * h;
		const lab = new Float32Array( n * 3 );
		for ( let i = 0; i < n; i++ ) {
			linearToOklab( SRGB_TO_LINEAR[ rgba[ i * 4 ] ], SRGB_TO_LINEAR[ rgba[ i * 4 + 1 ] ], SRGB_TO_LINEAR[ rgba[ i * 4 + 2 ] ], lab, i * 3 );
		}
		const dE = deltaE( lab, ref.lab, n );
		const a2 = down2( lab, w, h );
		const b2 = down2( ref.lab, w, h );
		const a4 = down2( a2.lab, a2.W, a2.H );
		const b4 = down2( b2.lab, b2.W, b2.H );
		const dE4 = deltaE( a4.lab, b4.lab, a4.W * a4.H );
		const L = lightness( lab, n );
		const st = structure( ref.L, L, w, h );
		const scores = { deltaE: dE, deltaE4: dE4, ssim: st.ssim, edgeCorr: st.edgeCorr, width: w, height: h };
		scores.similarity = combineScore( scores );
		return scores;
	}
}
