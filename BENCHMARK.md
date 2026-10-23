# Benchmark

All numbers were measured in Chrome (Claude desktop browser pane, Apple Silicon Mac,
60 Hz display) with the built-in benchmark or the Diagnostics panel. Nothing here is
estimated. Similarity is the 0–100 score described in the README (the final score is
measured on the rendered artwork, paper texture included, against the reference at
2× grid resolution). "Blank" is the score of an unpainted sheet.

Run it yourself: open `index.html?bench=1&benchSpeed=16&benchRt=20` and keep the tab
in the foreground (background tabs throttle `requestAnimationFrame`).

## Full run — 5 test images (early build, before gestures)

10-minute duration, Balanced grid (≈400 px). Each image: first 20 s at 1×, then
finished at 12×.

| Image | Grid | Analysis | Plan | FPS at 1× (min) | Seconds < 55 fps | Long frames | FPS at 12× (min) | Similarity: blank → final |
|---|---|---|---|---|---|---|---|---|
| Portrait | 320×400 | 170 ms | 45 ms | 60.1 (60.0) | 0 | 0 | 60.0 (59.9) | 22.0 → 61.4 |
| Landscape | 400×267 | 131 ms | 32 ms | 60.1 (60.0) | 0 | 0 | 60.0 (59.9) | 20.3 → 61.4 |
| Low-color | 400×400 | 195 ms | 53 ms | 60.1 (60.0) | 0 | 0 | 60.0 (59.9) | 30.5 → 73.7 |
| Detailed | 400×311 | 179 ms | 38 ms | 60.1 (59.9) | 0 | 0 | 60.0 (59.9) | 7.0 → 42.0 |
| High-contrast | 400×267 | 163 ms | 33 ms | 60.1 (60.0) | 0 | 0 | 60.0 (59.9) | 18.6 → 65.0 |

Per-frame main-thread cost at 1× (portrait): simulation 0.63 ms, composite 0.54 ms,
ops 0.03 ms, texture upload 0.02 ms, render submit 0.01 ms.

## Spot checks on the current build

The current build adds animated gestures (real-time hand), colour sessions with
nearest-area routing, natural drying, opening-based targets per tool size,
shape-based detail strokes and masking fluid. A full six-image run on this build is
still to be recorded (see "Run it yourself").

| Check | Result |
|---|---|
| Portrait, 16× playback, gestures on | 60 fps, minimum 59.9; 22 brush colour changes over 152 strokes; finished 10:23 (last wash dried naturally) |
| Portrait, untrimmed gestures + centreline strokes + step-back glazes (instant mode) | similarity 59.2 (ΔE 8.9, SSIM 0.433, edge r 0.55); 252 step-back gestures |
| Lettering, same build, Balanced (400 px) | similarity 71.8 (ΔE 8.2, SSIM 0.701, edge r 0.78) |
| Previous untrimmed build (straight detail strokes, gaps only) | portrait 54.4, lettering 68.0 |
| Earlier build that trimmed gestures to the target (for comparison) | portrait 69.0 — higher score, but drops and strokes took the target's exact shapes |
| Lettering, Maximum detail (800×800), 16× | analysis 450 ms; minimum 49 fps during the busiest stage |
| Synthetic headless test (Node, 360×270) | 9,000 steps, 1.5 ms average per step |

## Known limits

- The Detailed image (a dense flower field and city windows) is the weakest: at
  ≈400 px the grid cannot hold that much fine structure. Use Fine detail → Fine or above.
- Maximum detail (800 px) can dip below 55 fps on busy frames; Balanced holds 60.
