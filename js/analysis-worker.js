/**
 * Background worker: image analysis, composition planning, similarity
 * evaluation and paper texture generation. Keeps the UI thread free.
 */

import { analyzeImage, pixelsToLabLinear } from './image-analyzer.js';
import { LAYERS, layerContext, planLayer } from './layer-planner.js';
import { SimilarityEvaluator } from './similarity-evaluator.js';
import { makePaperTexture } from './noise.js';

let evaluator = null;
// Image-only context kept in the worker so each layer can be planned
// against the paper as it is when the painter reaches it.
let layerCtx = null;

self.onmessage = ( e ) => {
	const msg = e.data;
	const reply = ( data, transfer = [] ) => self.postMessage( { id: msg.id, ...data }, transfer );
	try {
		switch ( msg.type ) {
			case 'paper': {
				const tex = makePaperTexture( msg.size, msg.seed );
				reply( { tex }, [ tex.buffer ] );
				break;
			}
			case 'analyze': {
				const t0 = performance.now();
				const an = analyzeImage( {
					width: msg.width,
					height: msg.height,
					pixels: new Uint8ClampedArray( msg.pixels ),
					K: msg.K,
					seed: msg.seed,
					exclude: msg.exclude || [],
					remap: msg.remap || [],
					style: msg.style || 'auto',
				} );
				const t1 = performance.now();
				// The worker keeps its own copies of what layer planning reads; the
				// originals are transferred to the main thread below.
				const ctxAn = {
					...an,
					T: [ an.T[ 0 ].map( ( m ) => m.slice() ) ],
					importance: an.importance.slice(),
					reserve: an.reserve.slice(),
					room: an.room.slice(),
				};
				layerCtx = layerContext( ctxAn, { duration: msg.duration, seed: msg.seed, fineDetail: msg.detail } );
				const plan = { ops: [], layers: LAYERS, duration: msg.duration, byType: {}, layered: true };
				const t2 = performance.now();
				plan.planMs = t2 - t1;
				const ref = pixelsToLabLinear( new Uint8ClampedArray( msg.refPixels ), msg.refW * msg.refH );
				evaluator = new SimilarityEvaluator( {
					W: an.W,
					H: an.H,
					lab: an.lab,
					importance: Float32Array.from( an.importance ),
					refW: msg.refW,
					refH: msg.refH,
					refLab: ref.lab,
				} );
				const baseline = evaluator.evaluate( new Float32Array( an.W * an.H * 3 ) );
				const t3 = performance.now();
				const transfer = [];
				for ( const level of an.T ) {
					for ( const m of level ) {
						if ( ! transfer.includes( m.buffer ) ) {
							transfer.push( m.buffer );
						}
					}
				}
				transfer.push( an.edge.buffer, an.detail.buffer, an.importance.buffer, an.scale.buffer, an.darkness.buffer, an.reserve.buffer, an.room.buffer );
				const labels = Uint8Array.from( an.labels );
				transfer.push( labels.buffer );
				const { lab, labels: _l, regionOf, regions, ...rest } = an;
				reply(
					{
						analysis: { ...rest, labels, regionCount: regions.length },
						plan,
						baseline,
						timings: { analysis: t1 - t0, plan: t2 - t1, evaluator: t3 - t2, total: t3 - t0, steps: an.times },
					},
					transfer
				);
				break;
			}
			case 'planLayer': {
				const res = planLayer( layerCtx, msg.layer, { cur: new Float32Array( msg.cur ), handX: msg.handX, handY: msg.handY, seed: msg.seed, loaded: msg.loaded, unlimited: msg.unlimited, round: msg.round, fresh: msg.fresh, region: msg.region, off: msg.off, signed: msg.signed ? new Float32Array( msg.signed ) : null, de: msg.de ? Float32Array.from( msg.de ) : null, EW: msg.EW, EH: msg.EH } );
				reply( res, [ res.target.buffer, res.dens.buffer ] );
				break;
			}
			case 'evaluate': {
				const res = evaluator.evaluate( new Float32Array( msg.D ) );
				reply( res, [ res.err.buffer, res.de.buffer, res.signed.buffer, res.errU8.buffer ] );
				break;
			}
			case 'setMargin': {
				evaluator.setMargin( msg.share );
				reply( {} );
				break;
			}
			case 'evaluateRendered': {
				reply( { scores: evaluator.evaluateRendered( new Uint8Array( msg.pixels ), msg.w, msg.h ) } );
				break;
			}
		}
	} catch ( err ) {
		reply( { error: String( err && err.stack ? err.stack : err ) } );
	}
};
