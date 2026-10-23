/**
 * Hash-based value noise, fBm and a tileable watercolor-paper texture.
 */

export function hash2( ix, iy, seed ) {
	let h = Math.imul( ix, 374761393 ) ^ Math.imul( iy, 668265263 ) ^ Math.imul( seed, 1274126177 );
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	h ^= h >>> 16;
	return ( h >>> 0 ) / 4294967295;
}

export function valueNoise( x, y, seed ) {
	const ix = Math.floor( x );
	const iy = Math.floor( y );
	const fx = x - ix;
	const fy = y - iy;
	const u = fx * fx * ( 3 - 2 * fx );
	const v = fy * fy * ( 3 - 2 * fy );
	const a = hash2( ix, iy, seed );
	const b = hash2( ix + 1, iy, seed );
	const c = hash2( ix, iy + 1, seed );
	const d = hash2( ix + 1, iy + 1, seed );
	return a + ( b - a ) * u + ( c - a ) * v + ( a - b - c + d ) * u * v;
}

export function fbm( x, y, seed, octaves = 4 ) {
	let sum = 0;
	let amp = 0.5;
	let freq = 1;
	let norm = 0;
	for ( let o = 0; o < octaves; o++ ) {
		sum += amp * valueNoise( x * freq, y * freq, seed + o * 101 );
		norm += amp;
		amp *= 0.5;
		freq *= 2;
	}
	return sum / norm;
}

/** Value noise whose lattice wraps every (px, py) cells: tileable. */
function periodicNoise( x, y, px, py, seed ) {
	const ix = Math.floor( x );
	const iy = Math.floor( y );
	const fx = x - ix;
	const fy = y - iy;
	const u = fx * fx * ( 3 - 2 * fx );
	const v = fy * fy * ( 3 - 2 * fy );
	const x0 = ( ( ix % px ) + px ) % px;
	const y0 = ( ( iy % py ) + py ) % py;
	const x1 = ( x0 + 1 ) % px;
	const y1 = ( y0 + 1 ) % py;
	const a = hash2( x0, y0, seed );
	const b = hash2( x1, y0, seed );
	const c = hash2( x0, y1, seed );
	const d = hash2( x1, y1, seed );
	return a + ( b - a ) * u + ( c - a ) * v + ( a - b - c + d ) * u * v;
}

/**
 * Tileable paper texture, RGBA8:
 *  R: paper height (grain + fibers), used for granulation and relief lighting
 *  G, B: low-frequency noise used to warp wash edges
 *  A: fine fiber noise used for pigment mottling
 */
export function makePaperTexture( size, seed ) {
	const n = size * size;
	const height = new Float32Array( n );
	let min = Infinity;
	let max = -Infinity;
	for ( let y = 0; y < size; y++ ) {
		const v = y / size;
		for ( let x = 0; x < size; x++ ) {
			const u = x / size;
			let h = 0.4 * periodicNoise( u * 24, v * 24, 24, 24, seed );
			h += 0.26 * periodicNoise( u * 56, v * 56, 56, 56, seed + 1 );
			h += 0.18 * periodicNoise( u * 128, v * 128, 128, 128, seed + 2 );
			h += 0.1 * periodicNoise( u * 256, v * 256, 256, 256, seed + 3 );
			// Paper fibers: noise stretched along two directions.
			h += 0.08 * periodicNoise( u * 12, v * 160, 12, 160, seed + 4 );
			h += 0.08 * periodicNoise( u * 160, v * 12, 160, 12, seed + 5 );
			height[ y * size + x ] = h;
			if ( h < min ) {
				min = h;
			}
			if ( h > max ) {
				max = h;
			}
		}
	}
	const out = new Uint8Array( n * 4 );
	const inv = 1 / ( max - min );
	for ( let y = 0; y < size; y++ ) {
		const v = y / size;
		for ( let x = 0; x < size; x++ ) {
			const u = x / size;
			const i = y * size + x;
			let h = ( height[ i ] - min ) * inv;
			// Cold-press: emphasise the tooth.
			h = h * h * ( 3 - 2 * h );
			out[ i * 4 ] = h * 255;
			out[ i * 4 + 1 ] = periodicNoise( u * 6, v * 6, 6, 6, seed + 6 ) * 255;
			out[ i * 4 + 2 ] = periodicNoise( u * 6, v * 6, 6, 6, seed + 7 ) * 255;
			out[ i * 4 + 3 ] = periodicNoise( u * 72, v * 72, 72, 72, seed + 8 ) * 255;
		}
	}
	return out;
}
