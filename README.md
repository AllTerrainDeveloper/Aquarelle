# Aquarelle — generative watercolor reconstruction

A browser app that repaints a reference image as a watercolor, live, through
procedural painting gestures: heavy drops that bloom, crowns of satellite
droplets, brush sweeps, wet-in-wet charges, blooms and lifts. It is
not a filter. Every mark comes from a planned operation with a spatial and
chromatic objective, executed with seeded randomness on a pigment/water
simulation.

Static site, no build step and no dependencies: serve the folder and open
`index.html` (ES modules and module workers need http, not `file://`).

```bash
python3 -m http.server 8765
```

URL options: `?sample=portrait|landscape|lowcolor|detailed|contrast` loads a
built-in test image; `?bench=1&benchSpeed=12&benchRt=20` runs the benchmark
(each image is timed at 1× for `benchRt` seconds, then finished at
`benchSpeed`×).

## Technical proposal

### 1. Base algorithm: plan → gesture → simulate → evaluate → correct

1. **Analysis (worker).** Normalises the image to a working grid (280–448 px
   long side) and builds a palette by k-means++ in OKLab. Each palette
   colour becomes a *pigment* with a Beer–Lambert absorbance
   `A_k = −ln(colour/paper)`. Each pixel's optical density is decomposed by
   non-negative least squares over pairs of pigments (weighted by
   transmittance), which yields one **target density map per pigment**,
   blurred at three scales (fine, mid, coarse). The decomposition keeps
   continuous tones, so quantisation never flattens the image into
   posterised regions. The analysis also produces edge, detail, importance
   (edge density, colour contrast, centre prior, detail), feature-scale and
   darkness maps, plus a segmentation (labels → mode filter → connected
   components).
2. **Composition plan (worker).** A coarse-to-fine timeline of about 800–1,700
   operations across 7 stages: large masses (big drops, light to dark
   loosely) → silhouettes/structure (per-region washes) → secondary regions
   → wet-in-wet transitions on soft borders → shadows & detail (dry-brush,
   darks last) → splashes & accents → final drying. Positions are
   importance-sampled from the relevant maps, never uniform. About 38% of
   the slots are **correction slots** that are filled at runtime.
3. **Gestures (controlled chaos).** Each op lands with a Gaussian offset
   scaled by its size and the stage's chaos, and shrunk by up to 85% on
   strong edges. Its shape is an irregular polar profile (random harmonics),
   aspect and rotation, with ±15% amount variation. The **pigment amount
   is driven by the remaining need** of its target map (`T_k − deposited −
   suspended`), and the shape can follow where that need is. So randomness
   changes *how* paint lands, never *whether* the subject gets painted.
   Satellite droplets deposit only where they are needed, plus a small
   decorative spatter allowance that is non-zero only in low-importance
   areas. The pigment-mass rule above caps every stamp at the remaining
   need, so pigment overshoot only comes from flow; dark mistakes are
   corrected by lifting.
4. **Gestures in time.** Nothing is stamped instantly. Big masses arrive
   as heavy drops: the drop falls with a converging shadow, flattens on
   impact, and blooms radially into the shape of its region while a crown
   of satellite droplets flies out on arcs and blooms where each lands.
   Washes are painted by a round brush making back-and-forth passes, with
   the paint revealed exactly behind the tip. Wet-in-wet transitions lay
   clear water with the brush, then charge two pigments into it as drops.
   Lifts are a clean damp brush blotting the spot. Gestures run on a real-time clock, so they keep
   a natural pace at any playback speed; higher speed only makes the rain
   of gestures denser. The artist has one hand: brush strokes are queued,
   and when the hand is busy the paint is dropped instead.
5. **Simulation.** A simplified Curtis et al. (1997) model on a CPU grid
   (see the research basis below). Wet paint flows while it is being
   placed.
6. **Evaluation and correction.** A worker scores the current densities against
   the reference (see §4) and returns an error map. Correction slots
   importance-sample that map (errors under ~3.5 ΔE are ignored, and wet
   areas are down-weighted). They paint with the pigment that best reduces
   the residual, or *lift* where the painting went too dark.

### 2. Rendering architecture

- **CPU (main thread), typed arrays:** water `h`, suspended `g_k` and
  deposited `d_k` per pigment, paper height. Only 16×16 tiles that are wet
  (plus a one-tile ring) are simulated. Dry tiles are a stable layer and
  are never recomputed. Changed tiles are folded into one RGBA32F field
  `(ΣA_k(d_k+g_k), water)`.
- **GPU (WebGL2):** only the dirty rows of that field are uploaded each
  frame. A single fragment shader upsamples it and composes the look:
  Beer–Lambert glazing over a cold-press sheet (tooth lit from the upper
  left, fibres, uneven sizing; subtractive mixing: yellow over blue reads
  green), domain-warped edges (crisp, organic borders far
  above grid resolution), granulation in paper valleys, pigment mottling,
  pooling on density fronts, paper relief lighting, and a wet sheen.
- **2D overlay:** draws the artist's hand: falling drops with converging
  shadows, satellite droplets flying on arcs, a round brush (lacquered
  handle, crimped ferrule, a pigment-loaded hair belly that bends behind
  the motion and flattens under pressure; clean for lifting). Paint never
  comes from the overlay.
- **Workers:** analysis, planning, similarity evaluation, paper texture.
- **Export:** the same shader renders off-screen at 2–4× the simulation grid,
  so the PNG is a genuinely higher-resolution render. Video uses
  `MediaRecorder` on the canvas.

Modules: `ImageAnalyzer`, `CompositionPlanner`, `SplashGenerator`,
`GestureAnimator` (drops, particles, brush), `PigmentModel`, `DryingModel`, `WatercolorRenderer`,
`SimilarityEvaluator`, `AdaptiveController`, `AnimationController`,
`ExportManager` (all in `js/`).

### 3. Main performance risks and mitigations

| Risk | Mitigation |
|---|---|
| Full-grid simulation every step | Tile activity: only wet tiles and their ring are simulated; per-tile pigment bitmasks skip absent pigments |
| Large texture uploads | Row-range `texSubImage2D` of dirty rows only |
| Perceptual metrics in the render loop | Worker-side evaluation every 3–9 s; the main thread only copies a density snapshot (~0.01 ms/frame amortised) |
| Big stamps / many gestures in one frame | Ops per frame, sim time per frame and gesture-deposit time per frame are capped by the adaptive level; blooming drops only scan the radius reached so far |
| Gesture pile-up at high speed | Backpressure: above a cap on gestures in flight, new ops wait (the timeline slows, frames don't) |
| Fast playback (×8–×64) | Simulation step size grows (`dtScale` up to 4×); if still behind, the timeline slows rather than the UI |
| Slow devices | Adaptive levels lower render scale, evaluation frequency, splash complexity and per-frame budgets; sim resolution is chosen up front (Auto/High/Medium/Low) |

### 4. Visual similarity

The loss is computed in a worker on the painting's optical density converted
to OKLab:

- **colour:** OKLab ΔE (×100) at 1×, ½ and ¼ scale (multiscale composition error)
- **structure:** SSIM on lightness averaged at ½ and ¼ scale, plus Sobel
  edge-magnitude correlation. Paper grain is part of the medium, so full
  resolution is left to the colour terms.
- **error map** (½ resolution): multiscale ΔE weighted by importance, plus
  edge disagreement on important areas. It also carries a signed
  lightness map (too light → paint, too dark → lift).
- **similarity score (0–100):** `35%·(1−ΔE/30) + 30%·SSIM + 15%·edge r + 20%·(1−ΔE¼/25)`.

The final score is measured on the **rendered** artwork (paper texture
included), drawn at 2× grid resolution, against the full-resolution
reference.

### 5. Hitting 60 FPS and the chosen duration

- Simulation time is the master clock. The wall clock × speed sets a
  target. The frame interleaves due ops and fixed 1/30 s steps until it
  reaches the target or exhausts its budget (9 ms at level 0). Rendering
  happens every frame regardless.
- Duration is a parameter (minutes; default 10). The planner lays every
  stage out over the chosen duration. Drying compresses with it
  (evaporation × 600/duration), and gestures get brisker for short
  paintings.
- Dry-brush ops that land on wet paint are re-scheduled after a short
  delay, never blocking the canvas. After 6 deferrals they paint wet-on-wet.
- FPS and per-subsystem times are measured live (Diagnostics panel) and by
  the benchmark. No number below is estimated.

## Measured results

See `BENCHMARK.md` (generated from the in-app benchmark).

## Research basis

- Curtis, Anderson, Seims, Fleischer, Salesin — *Computer-Generated
  Watercolor* (SIGGRAPH 1997). Source of the water/pigment layers, edge
  darkening by rim evaporation, backruns and granulation. The fluid solver
  here is reduced to height-difference flux with a dry-paper capacity gate,
  instead of a shallow-water velocity solve.
- Bousseau, Kaplan, Thollot, Sillion — *Interactive Watercolor Rendering with
  Temporal Coherence and Abstraction* (NPAR 2006). Source of the paper-texture
  modulation, edge darkening on density gradients, and noise-warped edges in
  the shader.
- Beer–Lambert / Kubelka–Munk glazing for subtractive mixing; Mixbox
  (Sochorová & Jamriška 2021) as a reference for why RGB interpolation is
  avoided.
- Björn Ottosson — *OKLab* (2020) for perceptual distances.

No SPH/PBF solver is used. The grid model gives the characteristic watercolor
cues (rims, blooms, granulation, wet blending) at under 1 ms per step.

## Licence

MIT — see [LICENSE](LICENSE).
