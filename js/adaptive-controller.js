/**
 * AdaptiveController — measures real frame times and per-subsystem cost,
 * and trades simulation work for responsiveness. Rendering always wins.
 *
 * Knobs (per quality level): simulation budget per frame, render scale,
 * similarity evaluation interval, splash complexity, max ops per frame.
 * Separately, the simulation timestep grows (dtScale) when the timeline
 * falls behind, so the painting keeps its artistic duration.
 */

const LEVELS = [
	{ simBudget: 7, gestureBudget: 3, maxGestures: 160, renderScale: 1, evalInterval: 3000, complexity: 1, maxOps: 4 },
	{ simBudget: 6, gestureBudget: 2.5, maxGestures: 120, renderScale: 0.85, evalInterval: 4500, complexity: 0.8, maxOps: 3 },
	{ simBudget: 4.5, gestureBudget: 2, maxGestures: 90, renderScale: 0.72, evalInterval: 6000, complexity: 0.6, maxOps: 2 },
	{ simBudget: 3.5, gestureBudget: 1.5, maxGestures: 60, renderScale: 0.6, evalInterval: 9000, complexity: 0.4, maxOps: 2 },
];

const SUBSYSTEMS = [ 'ops', 'sim', 'composite', 'upload', 'render', 'evalCopy' ];
// At the best level the simulation may take what the rest of a frame leaves,
// less this margin (the browser's own work, the GPU), up to SIM_MAX ms.
const FRAME_MARGIN = 4;
const SIM_MAX = 11;

export class AdaptiveController {
	constructor() {
		this.reset();
	}

	reset() {
		this.level = 0;
		this.dtScale = 1;
		this.hold = false;
		this.fps = 0;
		this.frames = 0;
		this.secondStart = 0;
		this.history = [];
		this.frameTimes = [];
		this.longFrames = 0;
		this.totalFrames = 0;
		this.badSeconds = 0;
		this.goodSeconds = 0;
		this.ema = {};
		this.totals = {};
		for ( const s of SUBSYSTEMS ) {
			this.ema[ s ] = 0;
			this.totals[ s ] = 0;
		}
		this.onLevelChange = this.onLevelChange || null;
	}

	get q() {
		return LEVELS[ this.level ];
	}

	/**
	 * The simulation's share of this frame (ms): its level's budget, or at
	 * the best level whatever the rest of the frame leaves, so time the frame
	 * would spend idle goes to painting (a slow device keeps its level's).
	 */
	simBudget() {
		const q = this.q;
		if ( this.level > 0 ) {
			return q.simBudget;
		}
		const frame = 1000 / Math.max( 60, this.fps || 60 );
		const rest = this.ema.ops + this.ema.composite + this.ema.upload + this.ema.render + this.ema.evalCopy;
		return Math.max( q.simBudget, Math.min( SIM_MAX, frame - FRAME_MARGIN - rest ) );
	}

	record( name, ms ) {
		this.ema[ name ] = this.ema[ name ] * 0.9 + ms * 0.1;
		this.totals[ name ] += ms;
	}

	work() {
		let s = 0;
		for ( const k of SUBSYSTEMS ) {
			s += this.ema[ k ];
		}
		return s;
	}

	/** Called once per rAF with the real frame interval. */
	frame( now, dtMs, measuring ) {
		if ( ! this.secondStart ) {
			this.secondStart = now;
		}
		this.frames++;
		if ( measuring ) {
			this.totalFrames++;
			this.frameTimes.push( dtMs );
			if ( this.frameTimes.length > 20000 ) {
				this.frameTimes.splice( 0, 5000 );
			}
			// A frame that took longer than ~1.5 vsync intervals dropped at least one frame.
			if ( dtMs > 25 ) {
				this.longFrames++;
			}
		}
		if ( now - this.secondStart < 1000 ) {
			return;
		}
		this.fps = ( this.frames * 1000 ) / ( now - this.secondStart );
		this.frames = 0;
		this.secondStart = now;
		if ( measuring ) {
			this.history.push( this.fps );
		}
		// Simulation is self-limited by its budget, so only degrade on real
		// frame drops or when main-thread work approaches the 16.7 ms frame.
		const work = this.work();
		if ( this.fps < 55 || work > 16.5 ) {
			this.badSeconds++;
			this.goodSeconds = 0;
		} else if ( this.fps >= 58 && work < 13 ) {
			this.goodSeconds++;
			this.badSeconds = 0;
		}
		if ( this.hold ) {
			// Lockstep: the quality level stays where it is.
			return;
		}
		if ( this.badSeconds >= 2 && this.level < LEVELS.length - 1 ) {
			this.level++;
			this.badSeconds = 0;
			this.onLevelChange?.( this.level );
		} else if ( this.goodSeconds >= 6 && this.level > 0 ) {
			this.level--;
			this.goodSeconds = 0;
			this.onLevelChange?.( this.level );
		}
	}

	/** Timeline lag (painting seconds behind) -> coarser/finer sim steps. */
	reportLag( lag ) {
		if ( lag > 0.8 ) {
			this.dtScale = Math.min( 4, this.dtScale * 1.15 );
		} else if ( lag < 0.15 ) {
			this.dtScale = Math.max( 1, this.dtScale * 0.97 );
		}
	}

	summary() {
		const h = this.history.slice().sort( ( a, b ) => a - b );
		const ft = this.frameTimes.slice().sort( ( a, b ) => a - b );
		const avg = h.length ? h.reduce( ( a, b ) => a + b, 0 ) / h.length : 0;
		const perFrame = {};
		for ( const s of SUBSYSTEMS ) {
			perFrame[ s ] = this.totalFrames ? this.totals[ s ] / this.totalFrames : 0;
		}
		return {
			avgFps: avg,
			minFps: h.length ? h[ 0 ] : 0,
			p5Fps: h.length ? h[ Math.floor( h.length * 0.05 ) ] : 0,
			secondsBelow55: h.filter( ( f ) => f < 55 ).length,
			seconds: h.length,
			p95FrameMs: ft.length ? ft[ Math.floor( ft.length * 0.95 ) ] : 0,
			longFrames: this.longFrames,
			totalFrames: this.totalFrames,
			perFrameMs: perFrame,
			finalLevel: this.level,
		};
	}
}
