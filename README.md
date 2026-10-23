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

**Palette editing:** after analysis, click a colour in the palette to remove
it (the painter mixes that area from the remaining pigments), or drag a
colour onto another to paint it as that colour (a recolour in OKLab that
keeps the image's light and shade). Click a removed or transformed colour to
restore it.

URL options: `?sample=portrait|landscape|lowcolor|detailed|contrast|lettering`
loads a built-in test image; `?instant=1` (QA) applies paint without the
animated hand; `?bench=1&benchSpeed=16&benchRt=20` runs the benchmark
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
   posterised regions. **One target per tool size:** a broad gesture can
   only be as precise as its tool, so its target is the fine target
   *opened* at its own scale (erode, then dilate back): large areas keep
   their full extent right up to their borders, while shapes narrower than
   the tool are left out, and no gesture ever darkens past the final value.
   Lettering and small shapes appear only when the fine brush paints them. The analysis also produces edge, detail, importance
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
3. **Two acts.** Act 1 (about the first 30%) is drops and splashes: every
   object's colour is poured in as big drops sized to fit, with its other
   colours charged in wet-in-wet. Act 2 is the brush, which cuts in, washes
   and perfects whatever the drops left. A brush never pushes any cell past
   the image's darkness there, counting all paint already present; water
   spreading into dry paper carries little pigment (the front is mostly
   clear), so dark washes do not bleed.
3a. **Object by object, like a painter.** The big segmented areas (sky,
   hair, face, coat) are the objects. They are painted biggest first (the
   large masses), then light to dark, each in one go: a few big drops of
   its colour are poured in, then the brush pulls them out: cut in the edge with one
   continuous stroke that follows the contour (only where the image has a
   real edge), then carry a *graded* wash across the inside in gently
   wavering rows, top to bottom, with rounded turns, the tone following
   what the image needs as the brush moves. Each wash deliberately runs a
   little past its edge under the neighbours painted later (and into soft
   borders), so the next, darker colour defines the edge and no white gaps
   are left; the sheet edge is never a border. Secondary colours are
   charged into the wet wash, and the next object is never one touching a
   still-wet one. Every path is smoothed and evenly paced, like a hand.
3b. **Nothing is ever trimmed to the image.** A drop is one tone with its
   own ragged outline; a brush stroke paints exactly the ribbon its tip
   sweeps. Fidelity comes from *planning*, as a painter's does:
   - **Coverage planner:** each colour's area (where that pigment belongs)
     is filled by packing gestures largest-first at the deepest uncovered
     point, each sized so its whole footprint fits (plus a small seam so
     neighbouring washes meet). Big drops land in open interiors, brush
     washes near borders, in three glazes (coarse → fine).
   - **The tip stays in its colour:** brush paths only touch paper where
     their colour belongs; a touch too short to be a stroke is skipped.
   - **Spine strokes:** fine work (letters, brows, eyelids, gaps) is painted
     tip to tip in one stroke: the two points furthest apart *through* the
     shape are found and the shortest path between them, which stays inside
     it, becomes the stroke; its tip follows the local width; branches get
     their own strokes. Shapes are found across colours (a brow mixing two
     darks is one shape): the main pigment paints it and the other glazes
     along the same spine. A shape is painted whole or not at all.
   - **Step-back passes** (55%, 80%, 93%): the painter compares the canvas
     with the target. Where a colour is still bare *or clearly too light*,
     larger areas get a glaze sized to fit and the rest is painted along its
     centreline, colour by colour, nearest first, within the hand's time.
   - **Wicking:** dry paper next to a wet wash draws a little water, so
     neighbouring washes knit together instead of leaving a pale seam.
4. **Gestures in time.** Nothing is stamped instantly. Big masses arrive
   as heavy drops: the drop falls with a converging shadow, flattens on
   impact, and blooms radially into the shape of its region while a crown
   of satellite droplets flies out on arcs and blooms where each lands.
   Washes are painted by a round brush making back-and-forth passes, with
   the paint revealed exactly behind the tip. Wet-in-wet transitions lay
   clear water with the brush, then charge two pigments into it as drops.
   Lifts are a clean damp brush blotting the spot. Gestures run on a real-time clock, so they keep
   a natural pace at any playback speed; higher speed only makes the rain
   of drops denser. The artist has one hand: brush strokes are queued, the
   planner budgets detail and correction strokes to what one hand can paint
   (about one per second), detail strokes follow the contour, and when the
   hand is backed up the timeline waits rather than hurrying it.
   **One colour at a time, nearest area next:** the timeline is cut into
   sessions (duration / 8); each session works pigment by pigment, starting
   with the colour already on the brush. Each colour's marks are walked as
   a route from where the brush is (nearest first, then a 2-opt pass to
   uncross it), so the brush moves to the closest area needing that colour
   instead of jumping across the sheet. Corrections only use the colour on
   the brush and pick the nearest spot that needs it.
   **Detail is painted shape by shape:** for each colour, the leftover the
   washes could not give (fine target − opened target: a letter, a sliver of
   blue around a white letter, an eyelid) is found as connected shapes, and
   each gets one or more near-dry strokes sized and oriented to it
   (principal axes), most visible first, within the hand budget. Small
   whites next to edges are reserved with **masking fluid** (no water or
   pigment enters them), as a painter masks white lettering.
   A **Fine detail** setting (Soft → Maximum) raises the grid resolution
   (300 → 800 px) and the number and fineness of detail strokes.
   **Borders stay clean:** splashes land only in the background, satellite
   droplets stay inside their parent's colour area, blooms and lifts never
   happen near an edge, and single droplets are reserved for genuinely
   small features.
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
| Slow devices | Adaptive levels lower render scale, evaluation frequency, splash complexity and per-frame budgets; sim resolution is chosen up front with the Fine detail setting |

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
  reaches the target or exhausts its budget (7 ms at level 0, plus 3 ms
  for gesture deposits). Rendering happens every frame regardless.
- Duration is a slider (1–30 minutes; default 10). The planner lays every
  stage out over the chosen duration and sizes brushwork to it.
- Drying is natural everywhere. It is accelerated only locally, when the
  brush must return to a spot that is still wet; the stroke is re-scheduled
  a moment later, never blocking the canvas (after 6 tries it paints
  wet-on-wet). The painting finishes when the last wash has dried.
- FPS and per-subsystem times are measured live (Diagnostics panel) and by
  the benchmark. No number below is estimated.

## Measured results

See [BENCHMARK.md](BENCHMARK.md): measured results and how to rerun them.

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
