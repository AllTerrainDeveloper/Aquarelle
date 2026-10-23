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

**Controls:** pick a sample or drop an image; settings (colours, detail,
duration) apply as soon as they change. **Paint** plays the painting in
real time over the chosen duration; **Quick draw** time-lapses the painting
(its planned duration plays in about 20 seconds) with no time limits: no
shape, detail or gap is trimmed to fit, so it runs until everything is
painted, every drop, splash and stroke. **Real time** is the painter's own
pace: 1× with every animation, no time limits and no waiting (each layer
starts as soon as the last is done). Whenever the painter can only wait
for paint to dry (strokes queued for a wet area, the final drying), the
clock runs 10× faster and the header shows "Drying ×10". The Duration slider does not apply to it. Speed, seed and
the reference view are under *More options*.

**Photos:** *Image type* is detected automatically (shown as "Auto
(photo)" or "Auto (illustration)") and can be forced. A photograph is
painted the way a painter simplifies one: the image is first reduced to
flat shapes (repeated edge-preserving smoothing in OKLab, and pigment maps
smoothed within those shapes). The big passes (first wash, mid-tones,
glazes) paint the picture *without* its fine detail: each colour's small
holes are closed and its small specks removed, so a building block goes
down whole without its windows and a field without its flowers. The first
wash is laid in broad colour zones (sky, glow, ground), the glazes take the
big dark masses to full depth, and strokes follow the form. Only then does
the details layer add the fine work: it lifts the paint off spots that must
be lighter (lit windows) with a damp brush, and dabs in windows, flowers
and other dot-sized details with the brush tip. A last pass fills anything
still bare.

Pigments for a photo are chosen for how well they mix into its colours
(judged by how different the mixes look in OKLab), not as its most common
colours, and each area may mix up to three of them. Detection uses the share of pixels with fine,
non-edge texture (photos ≈0.25–0.3, flat artwork < 0.08). A higher Detail
setting keeps finer shapes: the photo filters span a fixed share of the
picture, sampled sparsely so analysis stays fast (≈0.7 s at Balanced,
≈2.5 s at Maximum).

**Palette editing:** after analysis, click a colour in the palette to remove
it (the painter mixes that area from the remaining pigments), or drag a
colour onto another to paint it as that colour (a recolour in OKLab that
keeps the image's light and shade). Click a removed or transformed colour to
restore it.

URL options: `?sample=portrait|landscape|lowcolor|detailed|contrast|lettering`
loads a built-in test image; `?dev=1` shows the developer panel (live
similarity and FPS, per-subsystem timings, wet-area and error views, the
benchmark button), which is hidden otherwise; `?instant=1` (QA) applies paint without the
animated hand; `?bench=1&benchSpeed=16&benchRt=20` runs the benchmark
(each image is timed at 1× for `benchRt` seconds, then finished at
`benchSpeed`×).

## Technical proposal

### 1. Painting method: layers of value, like a watercolourist

The painting is built the way a watercolourist works, in layers of value
across the whole sheet. Each layer is planned (in a worker) when the painter
reaches it, from what is actually on the paper. The painting clock pauses
for that moment of stepping back.

0. **Read the values.** Analysis (worker) finds a limited palette (k-means++
   in OKLab), decomposes every pixel into pigment amounts (Beer–Lambert,
   non-negative least squares over pigment pairs), and finds the big areas,
   real edges, and the thin whites to mask (lettering, highlights).
1. **First wash: light and loose.** Every big area, biggest first, gets its
   lightest version: big drops poured in (sized to fit), spread with a broad
   wet brush, its other colours dropped in while wet, plus a few splashes.
2. **Mid-tones, shape by shape.** One colour at a time (biggest colour
   first), nearest shape next. One confident wash per shape: cut in along
   real edges with one continuous stroke, then gently wavering rows top to
   bottom with rounded turns.
3. **Shadow glazes.** The same pigments again, only over the parts that
   should be darker (the shadow masses), so values build in steps and a few
   pigments make gradients. Edges are not retraced.
4. **Darks and details.** A small brush for thin or small shapes, ranked by
   how important and dark they are (eyes, brows, lettering first). Each is
   one stroke from tip to tip along the shape's spine; a pupil gets a short
   touch.
5. **Finish.** Lift a highlight or two where the paper went too dark.

Each layer has its own **value target**: the image with every cell's
pigment mix scaled so it is no darker than the layer's value (light, then
mid, then shadow masses, then everything). The pigment model enforces it
per cell, counting all paint already there, so a gesture can only bring
the paper up to the layer's value, never past it. Nothing is trimmed to the
image: drops are one tone with their own ragged outline, brush strokes paint
exactly the ribbon the tip sweeps, and gestures are sized and placed so they
fit. Water spreading into dry paper carries little pigment, so washes do not
bleed. The brush never mimes: a stroke with nothing to paint is skipped
before it is drawn. If a layer would not fit its time, the most important
shapes are kept; a layer that starts late is compressed into the time left.

**Simulation.** This is a simplified Curtis et al. (1997) model on a CPU
grid (see the research basis below). Only wet tiles are simulated. Water
flow, pigment advection and diffusion, rim evaporation (edge darkening),
granulation and backruns all emerge from it.

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
- FPS and per-subsystem times are measured live (developer panel, `?dev=1`) and by
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
