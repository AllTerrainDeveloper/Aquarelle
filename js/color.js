/**
 * Color utilities: sRGB <-> linear <-> OKLab, and the paper color.
 * Physics (Beer–Lambert glazing) happens in linear RGB; similarity and
 * palette quantization happen in OKLab.
 */

export const SRGB_TO_LINEAR = new Float32Array( 256 );
for ( let i = 0; i < 256; i++ ) {
	const c = i / 255;
	SRGB_TO_LINEAR[ i ] = c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );
}

export function srgbToLinear( c ) {
	return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );
}

export function linearToSrgb( c ) {
	c = c < 0 ? 0 : c > 1 ? 1 : c;
	return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055;
}

export function linearToOklab( r, g, b, out, o = 0 ) {
	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
	const l_ = Math.cbrt( l );
	const m_ = Math.cbrt( m );
	const s_ = Math.cbrt( s );
	out[ o ] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
	out[ o + 1 ] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
	out[ o + 2 ] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
}

export function oklabToLinear( L, a, b, out, o = 0 ) {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	out[ o ] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	out[ o + 1 ] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	out[ o + 2 ] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

/** Cold-press paper, slightly warm. */
export const PAPER_SRGB = [ 0.972, 0.952, 0.912 ];
export const PAPER_LINEAR = PAPER_SRGB.map( srgbToLinear );

export function toHex( srgb ) {
	return '#' + srgb.map( ( c ) => Math.round( Math.max( 0, Math.min( 1, c ) ) * 255 ).toString( 16 ).padStart( 2, '0' ) ).join( '' );
}
