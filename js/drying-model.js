/**
 * DryingModel — natural drying, helped along only where it is needed.
 *
 * Paint dries at its own pace everywhere: when the brush moves on, the area
 * it left dries by itself. Drying is accelerated only locally, and only when
 * the brush must come back to an area that is still wet (a crisp detail over
 * a wash), as a painter would. States are derived from the water field and
 * the last time a tile was touched:
 *   fresh (just applied) · wet · drying · dry (stable, never resimulated)
 */

export const STATE = { DRY: 0, DRYING: 1, WET: 2, FRESH: 3 };

export class DryingModel {
	constructor( duration ) {
		this.setDuration( duration );
	}

	setDuration( duration ) {
		this.duration = duration;
	}

	/** Evaporation is natural everywhere; no global acceleration. */
	evapScale() {
		return 1;
	}

	/** Seconds of painting time to wait before re-checking a wet region. */
	retryDelay() {
		return 1;
	}

	/**
	 * The brush needs to return to (x, y) but it is still wet: dry just that
	 * spot faster for a couple of seconds.
	 */
	helpDry( model, x, y, r ) {
		model.addDryZone( x, y, Math.max( 3, r * 1.6 ), 2.5 );
	}

	stateAt( model, x, y ) {
		const i = Math.round( y ) * model.W + Math.round( x );
		const h = model.h[ i ];
		const t = model.tileTouch[ model.tileOf( x, y ) ];
		if ( model.time - t < 1.2 && h > 0.05 ) {
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
