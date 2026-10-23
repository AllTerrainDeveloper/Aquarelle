/**
 * Seeded pseudorandom number generation (mulberry32).
 * Every random decision in the app flows from a seed so that the same
 * configuration reproduces the same composition.
 */

export function mulberry32( seed ) {
	let a = seed >>> 0;
	return function () {
		a = ( a + 0x6d2b79f5 ) >>> 0;
		let t = a;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
}

export class Rng {
	constructor( seed ) {
		this.next = mulberry32( seed );
		this._spare = null;
	}

	float() {
		return this.next();
	}

	range( a, b ) {
		return a + ( b - a ) * this.next();
	}

	int( n ) {
		return Math.floor( this.next() * n );
	}

	u32() {
		return ( this.next() * 4294967296 ) >>> 0;
	}

	/** Standard normal via Box–Muller. */
	normal() {
		if ( null !== this._spare ) {
			const s = this._spare;
			this._spare = null;
			return s;
		}
		let u = 0;
		while ( 0 === u ) {
			u = this.next();
		}
		const v = this.next();
		const m = Math.sqrt( -2 * Math.log( u ) );
		this._spare = m * Math.sin( 2 * Math.PI * v );
		return m * Math.cos( 2 * Math.PI * v );
	}
}
