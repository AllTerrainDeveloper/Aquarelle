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
import { STAGES, stageAt } from './composition-planner.js';

const BASE_DT = 1 / 30; // painting seconds per simulation step

export class AnimationController {
	constructor( { renderer, adaptive, evaluate, onStats, onDone } ) {
		this.renderer = renderer;
		this.adaptive = adaptive;
		this.evaluate = evaluate;
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
	}

	pause() {
		if ( 'painting' === this.state ) {
			this.state = 'paused';
		}
	}

	resume() {
		if ( 'paused' === this.state ) {
			this.state = 'painting';
		}
	}

	setSpeed( s ) {
		this.speed = s;
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
				// Ignore errors that are already within a perceptual tolerance.
				const e = Math.max( 0, err[ b ] - 3.5 );
				weight[ b ] = e * e * wetPenalty;
				acc += weight[ b ];
				cdf[ b ] = acc;
			}
		}
		this.errorField = { err, signed, weight, cdf, total: acc, EW, EH, used: new Float32Array( EW * EH ).fill( 1 ) };
		this.renderer.uploadError( res.errU8, EW, EH );
	}

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
			// Discourage piling corrections on the same spot before the next evaluation.
			const bx = lo % f.EW;
			const by = ( lo / f.EW ) | 0;
			for ( let dy = -3; dy <= 3; dy++ ) {
				for ( let dx = -3; dx <= 3; dx++ ) {
					const x = bx + dx;
					const y = by + dy;
					if ( x >= 0 && y >= 0 && x < f.EW && y < f.EH ) {
						f.used[ y * f.EW + x ] *= 0.55;
					}
				}
			}
			return { x: ( bx + rng.float() ) * 2, y: ( by + rng.float() ) * 2, signed: f.signed[ lo ], err: f.err[ lo ] };
		}
		return null;
	}

	/** Correction slot -> concrete op (paint, lift, or nothing). */
	_materialize( slot ) {
		const rng = new Rng( slot.seed );
		// Prefer a spot that needs the colour already on the brush.
		let p = null;
		for ( let tries = 0; tries < 6; tries++ ) {
			const c = this._sampleError( rng );
			if ( ! c ) {
				break;
			}
			if ( ! p ) {
				p = c;
			}
			if ( c.signed >= -5 && this.splash.loaded >= 0 && this.splash.autoPigment( c.x, c.y, 0 ) === this.splash.loaded ) {
				p = c;
				break;
			}
		}
		if ( ! p ) {
			return null;
		}
		const an = this.an;
		const progress = this.simTime / this.duration;
		const i = Math.min( an.H - 1, Math.round( p.y ) ) * an.W + Math.min( an.W - 1, Math.round( p.x ) );
		const r = Math.max( 1.3, an.scale[ i ] * ( 1.5 - 0.9 * progress ) ) * rng.range( 0.8, 1.2 );
		if ( p.signed < -5 ) {
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
		return {
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

	_simulate( frameStart ) {
		const q = this.adaptive.q;
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
		this.adaptive.reportLag( lag / Math.max( 1, this.speed ) );
		// Never accumulate unbounded debt on slow devices.
		if ( lag > 3 * Math.max( 1, this.speed ) ) {
			this.target = this.simTime + 3 * Math.max( 1, this.speed );
		}
	}

	_maybeEvaluate( now ) {
		if ( this.evalPending || now - this.lastEvalReal < this.adaptive.q.evalInterval / Math.max( 1, Math.sqrt( this.speed ) ) ) {
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
			this.animator.tick( dtReal );
			const dtPaint = dtReal * this.speed;
			const atEnd = this.simTime >= this.duration - BASE_DT * this.adaptive.dtScale;
			const planDone = this.cursor >= this.plan.ops.length && 0 === this.deferred.length && ! this.animator.busy;
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
		return {
			state: this.state,
			simTime: Math.min( this.simTime, this.duration ),
			duration: this.duration,
			progress: 'done' === this.state ? 1 : u * 0.995,
			stage: STAGES[ stage ].name,
			fps: this.adaptive.fps,
			level: this.adaptive.level,
			dtScale: this.adaptive.dtScale,
			ema: this.adaptive.ema,
			executed: this.executed,
			total: this.plan.ops.length,
			cursor: this.cursor,
			deferred: this.deferred.length,
			wet: this.drying.summary( this.model ),
			scores: this.lastScores,
			corrections: this.corrections,
		};
	}
}
