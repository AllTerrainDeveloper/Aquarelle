/**
 * DryingModel — time compression and per-region drying states.
 *
 * Drying is compressed so a full painting fits the chosen duration: the
 * evaporation rate scales with 600 / duration (a 2-minute painting dries
 * five times faster than the 10-minute default). States are derived from
 * the water field and the last time a tile was touched:
 *   fresh (just applied) · wet · drying · dry (stable, never resimulated)
 */

export const STATE = { DRY: 0, DRYING: 1, WET: 2, FRESH: 3 };

export class DryingModel {
	constructor( duration ) {
		this.setDuration( duration );
	}

	setDuration( duration ) {
		this.duration = duration;
		this.compression = Math.min( 6, Math.max( 0.6, 600 / duration ) );
	}

	/** Evaporation multiplier for the current point of the timeline. */
	evapScale( progress, finishing ) {
		if ( finishing ) {
			return 8;
		}
		// The last stage dries the sheet so it stabilises before the end.
		return this.compression * ( progress > 0.95 ? 2.5 : 1 );
	}

	/** Seconds of painting time to wait before re-checking a wet region. */
	retryDelay() {
		return 1.5 / this.compression;
	}

	stateAt( model, x, y ) {
		const i = Math.round( y ) * model.W + Math.round( x );
		const h = model.h[ i ];
		const t = model.tileTouch[ model.tileOf( x, y ) ];
		if ( model.time - t < 1.2 / this.compression && h > 0.05 ) {
			return STATE.FRESH;
		}
		if ( h > 0.15 ) {
			return STATE.WET;
		}
		if ( h > 0.004 ) {
			return STATE.DRYING;
		}
		return STATE.DRY;
	}

	/** Dry-brush ops need the region dry (or nearly) to keep crisp edges. */
	isDryEnough( model, x, y, r ) {
		return model.meanWater( x, y, Math.max( 2, r ) ) < 0.03;
	}

	/** Blooms only happen when clear water meets a damp (not soaked) wash. */
	isDamp( model, x, y, r ) {
		const m = model.meanWater( x, y, r );
		return m > 0.012 && m < 0.5;
	}

	summary( model ) {
		return {
			wetFraction: model.wetCells / model.N,
			activeTiles: model.activeTiles,
		};
	}
}
