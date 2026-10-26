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
// Real time: how much faster the clock runs while the painter only waits
// for paint to dry.
const DRY_FAST = 10;
// Open-ended modes: the longest pause between two planned gestures.
const MAX_IDLE = 1.5;
// Endless: how many rounds in a row may find nothing to do before the
// painting is finished.
const EMPTY_RUN = 3;
// With a similarity goal: how long (real seconds of painting) the score may
// stay the same, to its first decimal, before that counts as the goal: the
// painting has gone as far as it will.
const PLATEAU_SECS = 30 * 60;

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
		this.setMode( 'paint' );
		this.last = 0;
		this._loop = this._loop.bind( this );
		requestAnimationFrame( this._loop );
	}

	load( { analysis, plan, model, splash, drying, animator } ) {
		this.animator = animator;
		animator.cinematic = 'cinematic' === this.mode;
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
		this.ready = [];
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
		this.layerExec0 = 0;
		this.layerCount = 0;
		this.dryingWait = false;
		this.round = 0;
		this.converged = false;
		this.reachedTarget = false;
		this.emptyRun = 0;
		this.offSheet = null;
		// Real seconds painted, and since when the score has stood where it
		// is (to its first decimal).
		this.paintedReal = 0;
		this.plateau = null;
		this.plateaued = false;
		this.plateauSecs = PLATEAU_SECS;
		this.waitEval = null;
		this.evalCount = this.evalCount || 0;
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
	 * How the painting is played:
	 * - 'paint': fits the chosen duration, at the playback speed.
	 * - 'quick': Quick draw, a time-lapse (the planned duration plays in
	 *   about `quickSeconds`); nothing is trimmed, it runs until done.
	 * - 'realtime': the painter's own pace, 1x with every animation; nothing
	 *   is trimmed and nothing waits (each layer starts as soon as the last
	 *   one is done); the duration does not apply.
	 * - 'cinematic': Real time, filmed: the camera follows the brush, which
	 *   goes to the water jar and the palette between colours (see Director).
	 * In 'quick' the simulation and every gesture speed up together, so the
	 * drops, splashes and strokes all still show.
	 * Endless (any mode): after the layers, keep refining in rounds against
	 * the paper as it is, each stricter than the last, until rounds find
	 * nothing left to improve. In 'paint' the refining carries on past the
	 * chosen duration, at the playback speed.
	 * `target` (similarity, %): with endless, stop as soon as the painting
	 * scores that much (the "until similarity" option, in every tab).
	 */
	setMode( mode, quickSeconds = 20, endless = false, target = 0 ) {
		this.mode = mode;
		this.targetSim = endless ? target : 0;
		this.timelapse = 'quick' === mode ? quickSeconds : 0;
		// Open-ended: no time budget and no schedule, only the work.
		this.openEnded = 'paint' !== mode;
		this.endless = endless;
		this.animator && ( this.animator.cinematic = 'cinematic' === mode );
	}

	/** At the painter's own pace (Real time and Cinematic). */
	get realtime() {
		return 'realtime' === this.mode || 'cinematic' === this.mode;
	}

	/** Painting seconds per real second. */
	get rate() {
		if ( 'quick' === this.mode && this.duration ) {
			return this.duration / this.timelapse;
		}
		if ( this.realtime ) {
			// Waiting only for paint to dry: fast-forward until there is work.
			return this.dryingWait ? DRY_FAST : 1;
		}
		return this.speed;
	}

	/**
	 * Cells a refinement round leaves alone: the border Cinematic leaves
	 * unpainted on purpose (null when there is none).
	 */
	_offSheet() {
		const border = this.splash?.border;
		if ( ! border ) {
			return null;
		}
		if ( ! this.offSheet ) {
			const { W, H } = this.model;
			this.offSheet = new Uint8Array( W * H );
			for ( let y = 0; y < H; y++ ) {
				for ( let x = 0; x < W; x++ ) {
					this.offSheet[ y * W + x ] = border.room( x, y ) < 0 ? 1 : 0;
				}
			}
		}
		return this.offSheet;
	}

	/** What the header says when a layered painting is done. */
	_doneLabel() {
		const sim = this.lastScores ? this.lastScores.similarity.toFixed( 1 ) : '—';
		if ( this.plateaued ) {
			const held = this.plateauSecs >= 60 ? `${ Math.round( this.plateauSecs / 60 ) } minutes` : `${ this.plateauSecs } seconds`;
			return `Finished: ${ sim }% similar, unchanged for ${ held }, so taken as the target (${ this.targetSim }%)`;
		}
		if ( this.reachedTarget ) {
			return `Finished: ${ sim }% similar, target ${ this.targetSim }% reached`;
		}
		if ( this.targetSim && this.converged ) {
			return `Finished at ${ sim }%: nothing left to improve, target ${ this.targetSim }% not reached`;
		}
		return this.converged ? `Finished: nothing left to improve after ${ this.round } rounds` : 'Finished';
	}

	/** Feed a new error map from the evaluator. */
	setError( res ) {
		this.evalPending = false;
		this.evalCount = ( this.evalCount || 0 ) + 1;
		this.lastScores = res.scores;
		const shown = res.scores.similarity.toFixed( 1 );
		if ( ! this.plateau || this.plateau.sim !== shown ) {
			this.plateau = { sim: shown, since: this.paintedReal };
		}
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
				// Ignore errors that are already within a perceptual tolerance, and
				// the border Cinematic leaves unpainted on purpose.
				const border = this.splash?.border && this.splash.border.room( bx * 2, by * 2 ) < 0;
				if ( border && signed ) {
					signed[ b ] = 0;
				}
				const e = border ? 0 : Math.max( 0, err[ b ] - 3.5 );
				weight[ b ] = e * e * wetPenalty * edgeCalm;
				acc += weight[ b ];
				cdf[ b ] = acc;
			}
		}
		this.errorField = { err, de: res.de, signed, weight, cdf, total: acc, EW, EH, used: new Float32Array( EW * EH ).fill( 1 ) };
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

	/**
	 * A mark whose time has come. Open-ended modes do not paint it at once:
	 * it joins a small pool the painter picks from as the hand frees up (see
	 * _paintFromPool), so the brush works its way across the sheet instead of
	 * hopping to wherever the next mark happens to be due.
	 */
	_dispatch( op ) {
		if ( this.openEnded && this.splash.animator ) {
			this.ready.push( op );
		} else {
			this._execute( op );
		}
	}

	/**
	 * Paints marks from the pool while the hand is nearly free: among those
	 * planned for the next moment (so layers and big-to-small still hold),
	 * the one in the colour on the brush and nearest to where the last stroke
	 * ended.
	 */
	_paintFromPool( budget ) {
		const anim = this.animator;
		const B = this.an.B;
		const window = 1.5 * Math.max( 1, this.rate );
		let n = 0;
		while ( this.ready.length && n < budget && anim.backlog( anim.clock ) < 0.8 ) {
			let t0 = Infinity;
			for ( const op of this.ready ) {
				t0 = Math.min( t0, op.t );
			}
			const hx = anim.lastEnd ? anim.lastEnd.x : this.splash.handX;
			const hy = anim.lastEnd ? anim.lastEnd.y : this.splash.handY;
			let best = 0;
			let bs = Infinity;
			this.ready.forEach( ( op, j ) => {
				if ( op.t > t0 + window ) {
					return;
				}
				const x = 'number' === typeof op.x ? op.x : op.path ? op.path[ 0 ] : hx;
				const y = 'number' === typeof op.y ? op.y : op.path ? op.path[ 1 ] : hy;
				// Changing colour costs about a trip across the sheet.
				const score = Math.hypot( x - hx, y - hy ) + ( undefined !== op.k && op.k !== anim.brushK ? B * 0.6 : 0 );
				if ( score < bs ) {
					bs = score;
					best = j;
				}
			} );
			this._execute( this.ready.splice( best, 1 )[ 0 ] );
			n++;
		}
		return n;
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
		if ( ! layers || this.layerPending ) {
			return;
		}
		let idx = this.layerIdx;
		const refine = idx >= layers.length;
		if ( refine && ( ! this.endless || this.converged ) ) {
			return;
		}
		const handFree = this.animator.brushFreeAt - this.animator.clock < 0.5;
		// Open-ended modes start a layer as soon as the last one is done.
		const due = refine || this.openEnded || this.simTime >= layers[ idx ].t0 * this.duration;
		if ( ! due || this.deferred.length || this.ready.length || ! handFree ) {
			return;
		}
		// Endless: after the layers, refinement rounds over the whole picture,
		// each on a fresh score taken after the last one: the planner finds
		// every problem, weighs a fix for each, and makes the ones that gain
		// the most for their time (see refineArea). Mostly against the finish
		// layer's target, every third round the details layer's.
		if ( refine ) {
			if ( null === this.waitEval ) {
				this.waitEval = this.evalCount + ( this.evalPending ? 1 : 0 );
			}
			if ( ! this.errorField || this.evalCount <= this.waitEval ) {
				this.lastEvalReal = -Infinity; // evaluate now
				return;
			}
			this.waitEval = null;
			// With a target, a fresh score that reaches it ends the painting.
			if ( this.targetSim && this.lastScores && this.lastScores.similarity >= this.targetSim ) {
				this.reachedTarget = true;
				this.converged = true;
				return;
			}
			// ...and so does a score that has not moved (to its first decimal)
			// for half an hour: as far as the painting will go.
			if ( this.targetSim && this.plateau && this.paintedReal - this.plateau.since >= this.plateauSecs ) {
				this.reachedTarget = true;
				this.plateaued = true;
				this.converged = true;
				return;
			}
			idx = 2 === this.round % 3 ? 3 : 4;
		}
		const L = layers[ idx ];
		this.layerPending = true;
		const cur = this.model.snapshotPigment();
		const epoch = this.epoch = ( this.epoch || 0 ) + 1;
		// Open-ended modes plan without time limits: they paint everything.
		this.planLayer( { layer: idx, cur: cur.buffer, handX: this.splash.handX, handY: this.splash.handY, seed: refine ? 100 + this.round : idx, loaded: this.splash.loaded, unlimited: !! this.openEnded || refine, round: refine ? Math.min( 4, 1 + Math.floor( this.round / 8 ) ) : 0, fresh: refine && ! this.round, region: refine ? { x0: 0, x1: this.model.W - 1, y0: 0, y1: this.model.H - 1 } : null, off: refine ? this._offSheet() : null, signed: refine ? this.errorField.signed.slice() : null, de: refine ? ( this.errorField.de || this.errorField.err ).slice() : null, EW: this.errorField?.EW, EH: this.errorField?.EH }, [ cur.buffer ] ).then( ( res ) => {
			if ( epoch !== this.epoch ) {
				return; // restarted meanwhile
			}
			this.model.setLayer( res.target, res.dens );
			const base = this.simTime;
			// If this layer starts late, fit its gestures into the time it has
			// left, so later layers are never pushed past the end.
			const span = res.ops.length ? res.ops[ res.ops.length - 1 ].t : 0;
			const avail = Math.max( 0.04 * this.duration, L.t1 * this.duration - base );
			const squeeze = span > avail && ! this.openEnded && ! refine ? avail / span : 1;
			// Open-ended modes never sit idle: a long empty wait between two
			// gestures (a splash planned late in the layer's time slot) is cut
			// short. Brushwork queues on the hand anyway.
			if ( this.openEnded || refine ) {
				res.ops.sort( ( a, b ) => a.t - b.t );
				let prev = 0;
				let shift = 0;
				for ( const op of res.ops ) {
					const gap = op.t - prev;
					prev = op.t;
					if ( gap > MAX_IDLE ) {
						shift += gap - MAX_IDLE;
					}
					op.t -= shift;
				}
			}
			for ( const op of res.ops ) {
				op.t = base + op.t * squeeze;
				op.stage = idx;
				this.deferred.push( op );
			}
			if ( refine ) {
				this.round++;
				this.layerName = `Refining, round ${ this.round }`;
				// What it found and what it chose for it (e.g. "glaze 2, soften 1").
				const tools = Object.entries( res.tools || {} ).map( ( [ k, n ] ) => `${ k } ${ n }` ).join( ', ' );
				if ( tools ) {
					this.layerName += ` · ${ tools }`;
				}
				if ( this.targetSim && this.lastScores ) {
					this.layerName += ` · ${ this.lastScores.similarity.toFixed( 1 ) }% of ${ this.targetSim }%`;
				}
				// When round after round finds nothing worth doing, the painting
				// is done.
				if ( res.ops.length ) {
					this.emptyRun = 0;
				} else {
					this.emptyRun++;
					if ( this.emptyRun >= EMPTY_RUN ) {
						this.converged = true;
					}
				}
				this.layerPending = false;
				this.layerOps = ( this.layerOps || 0 ) + res.ops.length;
				return;
			}
			this.layerName = L.name;
			this.layerIdx = idx + 1;
			// For progress in open-ended modes.
			this.layerExec0 = this.executed;
			this.layerCount = res.ops.length;
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
				this._dispatch( ops[ this.cursor++ ] );
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
					this._dispatch( o );
					opsThisFrame++;
				}
			}
			opsThisFrame += this._paintFromPool( q.maxOps - opsThisFrame );
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
			this.paintedReal += dtReal;
			// Nothing in the painter's hands and nothing being planned, only
			// strokes waiting for wet paint (or the final drying): in Real time
			// that wait is fast-forwarded.
			this.dryingWait = this.realtime && ! this.animator.busy && ! this.layerPending && ( this.finishing || this.deferred.some( ( o ) => o.defers > 0 ) );
			// In a time-lapse the gestures speed up with everything else.
			const rate = this.rate;
			const lapse = 'quick' === this.mode ? rate : 1;
			this.animator.tick( dtReal * lapse );
			// The hand never hurries: while brushwork is backed up, the timeline
			// waits; it also waits while the painter steps back to plan a layer.
			const handBusy = this.animator.backlog( this.animator.clock ) > 2.5 * lapse;
			const dtPaint = handBusy || this.layerPending ? 0 : dtReal * rate;
			// Open-ended modes have no end time: they end when the work is done.
			const atEnd = this.openEnded || this.simTime >= this.duration - BASE_DT * this.adaptive.dtScale;
			const layersDone = ! this.plan.layers || ( this.layerIdx >= this.plan.layers.length && ! this.layerPending && ( ! this.endless || this.converged ) );
			const planDone = this.cursor >= this.plan.ops.length && 0 === this.deferred.length && 0 === this.ready.length && ! this.animator.busy && layersDone;
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
				// A goal met (either way): Cinematic's camera steps back to the
				// whole painting.
				if ( this.reachedTarget && this.director?.active ) {
					this.director.showWhole();
				}
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
		if ( this.director && this.director.active ) {
			// Cinematic: the camera, the desk and the brush.
			this.director.frame( dtMs / 1000, this.animator.clock );
		} else if ( this.overlay ) {
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
		let u = Math.min( 1, this.simTime / this.duration );
		if ( this.openEnded && this.plan.layers ) {
			// Progress by work done: layers finished, plus the current one's ops.
			const n = this.plan.layers.length;
			const frac = this.layerCount ? Math.min( 1, ( this.executed - ( this.layerExec0 || 0 ) ) / this.layerCount ) : 0;
			u = Math.min( 1, ( Math.max( 0, this.layerIdx - 1 ) + frac ) / n );
			if ( this.endless ) {
				// Layers fill most of the bar; refinement creeps toward the end.
				u = this.round ? 0.8 + 0.2 * ( 1 - Math.exp( -this.round / 5 ) ) : u * 0.8;
			}
		}
		const stage = 'done' === this.state ? STAGES.length - 1 : stageAt( u );
		const layered = !! this.plan.layers;
		return {
			state: this.state,
			simTime: this.openEnded ? this.simTime : Math.min( this.simTime, this.duration ),
			// Open-ended modes have no set duration.
			duration: this.openEnded ? 0 : this.duration,
			progress: 'done' === this.state ? 1 : u * 0.995,
			stage: layered ? ( 'done' === this.state ? this._doneLabel() : this.finishing ? 'Drying' : this.layerName ) : STAGES[ stage ].name,
			target: this.targetSim,
			endless: !! this.endless,
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
			// Fast-forward factor while only waiting for paint to dry (0 = not).
			dryingFast: this.dryingWait && 'painting' === this.state ? DRY_FAST : 0,
			corrections: this.corrections,
		};
	}
}
