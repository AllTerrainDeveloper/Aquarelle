/**
 * AnimationController — the painting timeline.
 *
 * Simulation time is the master clock of the painting. Each frame the
 * wall clock (x speed) sets a target time; the controller interleaves due
 * ops and fixed-size simulation steps until it reaches the target or runs
 * out of its per-frame budget. Rendering happens every frame regardless,
 * so a slow device stretches simulation detail, not the interface.
 *
 * Correction slots planned by the CompositionPlanner are materialised here
 * from the latest SimilarityEvaluator error map (Phase D).
 */

import { Rng } from './prng.js';
import { STAGES, stageAt, planGapStrokes } from './composition-planner.js';

const BASE_DT = 1 / 30; // painting seconds per simulation step

export class AnimationController {
	constructor( { renderer, adaptive, evaluate, planLayer, onStats, onDone } ) {
		this.renderer = renderer;
		this.adaptive = adaptive;
		this.evaluate = evaluate;
		this.planLayer = planLayer;
		this.onStats = onStats;
		this.onDone = onDone;
		this.state = 'idle';
		this.speed = 1;
		this.last = 0;
		this._loop = this._loop.bind( this );
		requestAnimationFrame( this._loop );
	}

	load( { analysis, plan, model, splash, drying, animator } ) {
		this.animator = animator;
		this.an = analysis;
		this.plan = plan;
		this.model = model;
		this.splash = splash;
		this.drying = drying;
		this.duration = plan.duration;
		this.reset();
	}

	reset() {
		this.model.reset();
		this.animator.reset();
		this.splash._washes = null;
		this.simTime = 0;
		this.target = 0;
		this.cursor = 0;
		this.deferred = [];
		this.executed = 0;
		this.skipped = 0;
		this.corrections = { paint: 0, lift: 0, skip: 0 };
		this.errorField = null;
		this.evalPending = false;
		this.lastEvalReal = 0;
		this.lastScores = null;
		this.finishing = false;
		// The layered method replaces step-back passes and corrections.
		this.gapPasses = [];
		this.gapStrokes = 0;
		// Layers: each planned when the painter reaches it, from the paper.
		this.layerIdx = 0;
		this.layerPending = false;
		this.layerOps = 0;
		this.epoch = ( this.epoch || 0 ) + 1;
		this.layerName = 'Reading the values';
		this.model.setLayer( null );
		this.state = 'ready';
		this.adaptive.reset();
		this.renderer.needsDraw = true;
	}

	start() {
		if ( 'done' === this.state ) {
			this.reset();
		}
		this.state = 'painting';
		this.startedAt = performance.now();
		this.pausedMs = 0;
	}

	pause() {
		if ( 'painting' === this.state ) {
			this.state = 'paused';
			this.pausedAt = performance.now();
		}
	}

	resume() {
		if ( 'paused' === this.state ) {
			this.state = 'painting';
			this.pausedMs = ( this.pausedMs || 0 ) + performance.now() - this.pausedAt;
		}
	}

	setSpeed( s ) {
		this.speed = s;
	}

	/**
	 * Time-lapse (Quick draw): play the painting fast enough that its planned
	 * duration takes about `seconds` of real time (0 turns it off). Nothing
	 * is trimmed to fit: it runs at that speed until everything is painted.
	 * The simulation and every gesture speed up together, so the drops,
	 * splashes and strokes all still show.
	 */
	setTimelapse( seconds ) {
		this.timelapse = seconds;
	}

	/** Painting seconds per real second. */
	get rate() {
		if ( this.timelapse && this.duration ) {
			return this.duration / this.timelapse;
		}
		return this.speed;
	}

	/** Feed a new error map from the evaluator. */
	setError( res ) {
		this.evalPending = false;
		this.lastScores = res.scores;
		const { err, signed, EW, EH } = res;
		// Damp regions that are still wet: wait for them to settle first.
		const model = this.model;
		const W = model.W;
		const weight = new Float32Array( EW * EH );
		const cdf = new Float64Array( EW * EH );
		let acc = 0;
		for ( let by = 0; by < EH; by++ ) {
			for ( let bx = 0; bx < EW; bx++ ) {
				const b = by * EW + bx;
				const i = Math.min( model.H - 1, by * 2 ) * W + Math.min( W - 1, bx * 2 );
				const wetPenalty = model.h[ i ] > 0.05 ? 0.35 : 1;
				// Silhouettes are where blind corrections do the most harm:
				// a border that is slightly off reads better than one reworked.
				const edgeCalm = 1 - 0.75 * this.an.edge[ i ];
				// Ignore errors that are already within a perceptual tolerance.
				const e = Math.max( 0, err[ b ] - 3.5 );
				weight[ b ] = e * e * wetPenalty * edgeCalm;
				acc += weight[ b ];
				cdf[ b ] = acc;
			}
		}
		this.errorField = { err, signed, weight, cdf, total: acc, EW, EH, used: new Float32Array( EW * EH ).fill( 1 ) };
		this.renderer.uploadError( res.errU8, EW, EH );
	}

	/** Samples a block from the error field (no side effects). */
	_sampleError( rng ) {
		const f = this.errorField;
		if ( ! f || f.total <= 0 ) {
			return null;
		}
		for ( let tries = 0; tries < 8; tries++ ) {
			const r = rng.float() * f.total;
			let lo = 0;
			let hi = f.cdf.length - 1;
			while ( lo < hi ) {
				const mid = ( lo + hi ) >> 1;
				if ( f.cdf[ mid ] < r ) {
					lo = mid + 1;
				} else {
					hi = mid;
				}
			}
			if ( rng.float() > f.used[ lo ] ) {
				continue;
			}
			const bx = lo % f.EW;
			const by = ( lo / f.EW ) | 0;
			return { b: lo, x: ( bx + rng.float() ) * 2, y: ( by + rng.float() ) * 2, signed: f.signed[ lo ], err: f.err[ lo ] };
		}
		return null;
	}

	/** Discourage piling corrections on the same spot before the next evaluation. */
	_useBlock( b ) {
		const f = this.errorField;
		const bx = b % f.EW;
		const by = ( b / f.EW ) | 0;
		for ( let dy = -3; dy <= 3; dy++ ) {
			for ( let dx = -3; dx <= 3; dx++ ) {
				const x = bx + dx;
				const y = by + dy;
				if ( x >= 0 && y >= 0 && x < f.EW && y < f.EH ) {
					f.used[ y * f.EW + x ] *= 0.4;
				}
			}
		}
	}

	/** Correction slot -> concrete op (paint, lift, or nothing). */
	_materialize( slot ) {
		const rng = new Rng( slot.seed );
		const loaded = this.splash.loaded;
		// Corrections only use the colour already on the brush. If no spot needs
		// it, the slot passes; the planned sessions bring every colour back in turn.
		// Among the spots needing that colour, go to the nearest one (weighted by
		// how wrong it is) instead of jumping across the sheet.
		let p = null;
		let first = null;
		let bestScore = -Infinity;
		const hx = this.splash.handX;
		const hy = this.splash.handY;
		const reach = this.an.B * 0.12;
		for ( let tries = 0; tries < 18; tries++ ) {
			const c = this._sampleError( rng );
			if ( ! c ) {
				break;
			}
			first = first || c;
			if ( loaded >= 0 && c.signed >= -5 && this.splash.autoPigment( c.x, c.y, 0, -1 ) === loaded ) {
				const score = Math.log( 1 + c.err ) - Math.hypot( c.x - hx, c.y - hy ) / reach;
				if ( score > bestScore ) {
					bestScore = score;
					p = c;
				}
			}
		}
		if ( ! p && loaded >= 0 ) {
			// Too-dark spots are lifted with a clean brush, whatever the colour.
			p = first && first.signed < -5 ? first : null;
		}
		p = p || ( loaded < 0 ? first : null );
		if ( ! p ) {
			this.corrections.skip++;
			return null;
		}
		this._useBlock( p.b );
		const an = this.an;
		const progress = this.simTime / this.duration;
		const i = Math.min( an.H - 1, Math.round( p.y ) ) * an.W + Math.min( an.W - 1, Math.round( p.x ) );
		const r = Math.max( 1.3, an.scale[ i ] * ( 1.5 - 0.9 * progress ) ) * rng.range( 0.8, 1.2 );
		const edge = an.edge[ i ];
		if ( p.signed < -5 ) {
			// Lifting on or near a silhouette leaves pale beads: let edges be.
			if ( edge > 0.3 || this.splash.edgeNear( p.x, p.y, r * 1.2 ) > 0.25 ) {
				this.corrections.skip++;
				return null;
			}
			this.corrections.lift++;
			return { type: 'lift', x: p.x, y: p.y, r: r * 1.2, strength: Math.min( 0.7, -p.signed / 25 ), seed: slot.seed, chaos: 0.3 };
		}
		const level = r > an.B * 0.04 ? 1 : 0;
		const k = this.splash.autoPigment( p.x, p.y, level );
		if ( k < 0 ) {
			this.corrections.skip++;
			return null;
		}
		this.corrections.paint++;
		const small = r < an.B * 0.03;
		// Sized to the spot, never trimmed: room to the nearest border plus a seam.
		const fit = Math.min( r * 1.2, this.splash.roomAt( p.x, p.y ) + Math.max( 2, an.B * 0.015 ) );
		return {
			fit: small ? undefined : fit,
			type: small ? 'detail' : 'wash',
			k,
			x: p.x,
			y: p.y,
			r,
			level,
			amount: 0.8,
			water: small ? 0.3 : 0.55,
			flat: 0.25,
			follow: 0.9,
			chaos: slot.chaos,
			requireDry: small,
			// Corrections are deliberate brushwork, never splashes.
			brushOnly: true,
			seed: slot.seed,
		};
	}

	_execute( op ) {
		let concrete = op;
		if ( 'correct' === op.type ) {
			if ( ! this.errorField ) {
				// No error map yet: retry shortly.
				op.t = this.simTime + 2;
				this.deferred.push( op );
				return;
			}
			concrete = this._materialize( op );
			if ( ! concrete ) {
				this.skipped++;
				return;
			}
			concrete.stage = op.stage;
		}
		const ok = this.splash.execute( concrete );
		if ( ok ) {
			this.executed++;
			return;
		}
		// Region still wet: reschedule this op without blocking the canvas.
		concrete.defers = ( concrete.defers || 0 ) + 1;
		if ( concrete.defers > 6 ) {
			concrete.force = true;
		}
		concrete.t = this.simTime + this.drying.retryDelay() * ( 1 + Math.random() * 0.5 );
		this.deferred.push( concrete );
	}

	/** Plan fine strokes for the gaps that are still bare, over the next window. */
	_stepBack() {
		const u = this.gapPasses.shift();
		const window = ( ( this.gapPasses[ 0 ] ?? 0.99 ) - u ) * this.duration * 0.85;
		const ops = planGapStrokes( this.model, this.an, {
			budget: Math.max( 6, window * 0.55 ),
			seed: ( this.plan.ops.length * 7919 + Math.round( u * 1000 ) ) >>> 0,
			handX: this.splash.handX,
			handY: this.splash.handY,
		} );
		ops.forEach( ( op, n ) => {
			op.t = this.simTime + 0.5 + ( ( n + 0.5 ) / ops.length ) * window;
			op.stage = stageAt( op.t / this.duration );
			this.deferred.push( op );
		} );
		this.gapStrokes += ops.length;
	}

	/**
	 * Step up to the next layer when its time comes and the previous layer's
	 * strokes are done: snapshot the paper and have the worker plan it.
	 */
	_maybeNextLayer() {
		const layers = this.plan.layers;
		if ( ! layers || this.layerPending || this.layerIdx >= layers.length ) {
			return;
		}
		const L = layers[ this.layerIdx ];
		const handFree = this.animator.brushFreeAt - this.animator.clock < 0.5;
		if ( this.simTime < L.t0 * this.duration || this.deferred.length || ! handFree ) {
			return;
		}
		this.layerPending = true;
		const idx = this.layerIdx;
		const cur = this.model.snapshotPigment();
		const epoch = this.epoch = ( this.epoch || 0 ) + 1;
		// Quick draw plans without time limits: it paints everything.
		this.planLayer( { layer: idx, cur: cur.buffer, handX: this.splash.handX, handY: this.splash.handY, seed: idx, unlimited: !! this.timelapse }, [ cur.buffer ] ).then( ( res ) => {
			if ( epoch !== this.epoch ) {
				return; // restarted meanwhile
			}
			this.model.setLayer( res.target, res.dens );
			const base = this.simTime;
			// If this layer starts late, fit its gestures into the time it has
			// left, so later layers are never pushed past the end.
			const span = res.ops.length ? res.ops[ res.ops.length - 1 ].t : 0;
			const avail = Math.max( 0.04 * this.duration, L.t1 * this.duration - base );
			const squeeze = span > avail && ! this.timelapse ? avail / span : 1;
			for ( const op of res.ops ) {
				op.t = base + op.t * squeeze;
				op.stage = idx;
				this.deferred.push( op );
			}
			this.layerName = L.name;
			this.layerIdx = idx + 1;
			this.layerPending = false;
			this.layerOps = ( this.layerOps || 0 ) + res.ops.length;
		} );
	}

	_simulate( frameStart ) {
		const q = this.adaptive.q;
		this._maybeNextLayer();
		const deadline = frameStart + q.simBudget;
		const ops = this.plan.ops;
		const dt = BASE_DT * this.adaptive.dtScale;
		let opsThisFrame = 0;
		let opMs = 0;
		let simMs = 0;
		while ( this.simTime + dt <= this.target ) {
			const ta = performance.now();
			if ( ta > deadline ) {
				break;
			}
			// Due ops first (planned order), then deferred ones.
			// Backpressure: with too many gestures in flight, let the timeline wait.
			const saturated = this.animator.actions.length > q.maxGestures;
			while ( ! saturated && this.cursor < ops.length && ops[ this.cursor ].t <= this.simTime && opsThisFrame < q.maxOps ) {
				this._execute( ops[ this.cursor++ ] );
				opsThisFrame++;
			}
			if ( this.deferred.length && opsThisFrame < q.maxOps ) {
				const due = [];
				this.deferred = this.deferred.filter( ( o ) => ( o.t <= this.simTime ? ( due.push( o ), false ) : true ) );
				for ( const o of due ) {
					if ( opsThisFrame >= q.maxOps ) {
						this.deferred.push( o );
						continue;
					}
					this._execute( o );
					opsThisFrame++;
				}
			}
			const tb = performance.now();
			opMs += tb - ta;
			if ( this.cursor < ops.length && ops[ this.cursor ].t <= this.simTime && ( saturated || opsThisFrame >= q.maxOps ) ) {
				// Ops are queued up; let the next frame continue instead of racing ahead.
				break;
			}
			const progress = this.simTime / this.duration;
			this.model.step( dt, this.drying.evapScale( progress, this.finishing ) );
			this.simTime += dt;
			simMs += performance.now() - tb;
		}
		// Gestures advance once per frame: their deposits are progressive anyway.
		const tg = performance.now();
		this.animator.update( this.animator.clock, this.adaptive.q.gestureBudget );
		opMs += performance.now() - tg;
		this.adaptive.record( 'ops', opMs );
		this.adaptive.record( 'sim', simMs );
		const lag = this.target - this.simTime;
		const rate = Math.max( 1, this.rate );
		this.adaptive.reportLag( lag / rate );
		// Never accumulate unbounded debt on slow devices.
		if ( lag > 3 * rate ) {
			this.target = this.simTime + 3 * rate;
		}
	}

	_maybeEvaluate( now ) {
		if ( this.evalPending || now - this.lastEvalReal < this.adaptive.q.evalInterval / Math.max( 1, Math.sqrt( this.rate ) ) ) {
			return;
		}
		const t = performance.now();
		const D = this.model.snapshotDensity();
		this.adaptive.record( 'evalCopy', performance.now() - t );
		this.evalPending = true;
		this.lastEvalReal = now;
		this.evaluate( D ).then( ( res ) => this.setError( res ) );
	}

	_loop( now ) {
		requestAnimationFrame( this._loop );
		const dtMs = this.last ? Math.min( 250, now - this.last ) : 16.7;
		this.last = now;
		const painting = 'painting' === this.state;
		this.adaptive.frame( now, dtMs, painting );
		if ( ! this.model ) {
			return;
		}
		const frameStart = performance.now();
		if ( painting ) {
			const dtReal = Math.min( dtMs, 100 ) / 1000;
			// In a time-lapse the gestures speed up with everything else.
			const rate = this.rate;
			const lapse = this.timelapse ? rate : 1;
			this.animator.tick( dtReal * lapse );
			// The hand never hurries: while brushwork is backed up, the timeline
			// waits; it also waits while the painter steps back to plan a layer.
			const handBusy = this.animator.brushFreeAt - this.animator.clock > 2.5 * lapse;
			const dtPaint = handBusy || this.layerPending ? 0 : dtReal * rate;
			const atEnd = this.simTime >= this.duration - BASE_DT * this.adaptive.dtScale;
			const layersDone = ! this.plan.layers || ( this.layerIdx >= this.plan.layers.length && ! this.layerPending );
			const planDone = this.cursor >= this.plan.ops.length && 0 === this.deferred.length && ! this.animator.busy && layersDone;
			if ( atEnd && planDone ) {
				this.finishing = true;
			}
			// Past the end, keep going only to flush queued ops and dry the sheet.
			const cap = atEnd ? Infinity : this.duration;
			this.target = Math.min( cap, this.target + dtPaint );
			this._simulate( frameStart );
			this._maybeEvaluate( now );
			if ( this.finishing && 0 === this.model.activeTiles ) {
				this.state = 'done';
				this.onDone?.();
			}
		}
		let t = performance.now();
		this.model.updateComposite();
		this.adaptive.record( 'composite', performance.now() - t );
		t = performance.now();
		this.renderer.upload( this.model );
		this.adaptive.record( 'upload', performance.now() - t );
		t = performance.now();
		if ( this.renderer.needsDraw ) {
			this.renderer.draw();
		}
		if ( this.overlay ) {
			const c = this.overlay.canvas;
			this.animator.draw( this.overlay, this.animator.clock, c.width / this.model.W, c.height / this.model.H, c.width / ( c.clientWidth || c.width ) );
		}
		this.adaptive.record( 'render', performance.now() - t );
		if ( now - ( this._lastStats || 0 ) > 250 ) {
			this._lastStats = now;
			this.onStats?.( this.stats() );
		}
	}

	stats() {
		const u = Math.min( 1, this.simTime / this.duration );
		const stage = 'done' === this.state ? STAGES.length - 1 : stageAt( u );
		const layered = !! this.plan.layers;
		return {
			state: this.state,
			simTime: Math.min( this.simTime, this.duration ),
			duration: this.duration,
			progress: 'done' === this.state ? 1 : u * 0.995,
			stage: layered ? ( 'done' === this.state ? 'Finished' : this.finishing ? 'Drying' : this.layerName ) : STAGES[ stage ].name,
			fps: this.adaptive.fps,
			level: this.adaptive.level,
			dtScale: this.adaptive.dtScale,
			ema: this.adaptive.ema,
			executed: this.executed,
			total: this.plan.ops.length + ( this.layerOps || 0 ),
			cursor: this.cursor,
			deferred: this.deferred.length,
			wet: this.drying.summary( this.model ),
			scores: this.lastScores,
			corrections: this.corrections,
		};
	}
}
