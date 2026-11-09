# Tesserocta — agent brief

**Tesserocta** — a 4D puzzle in eight views: a small, **mobile-first playable game** of a
**3×3×3×3 twisty tesseract**. Pure
client-side vanilla JS (ES modules, WebGL 1.0), no build step, no dependencies. It makes
the 4D puzzle *readable* through an interactive 3D projection — there is no solver.

The screen is **9 synchronized views**: the big main tesseract projection plus 8 small
cell sub-views (4 top + 4 bottom), each showing one cell as a plain 3×3×3 twisty cube.
You twist the **centred** cell by **swiping across it** in the main view (the primary input)
or with on-canvas icon buttons (layer turns + whole-cube rotation, in groups around the
cube), and tap a sub-view to bring a different cell to centre. All 9 views share one
turntable orientation.

This file is the orientation for a future session. It records the **current** design and
the non-obvious decisions behind it. Read the rationale before changing the
projection or coloring — most of it is the result of long iteration and looks arbitrary
out of context.

> **Status: under construction.** The paragraphs above describe the target design. The
> sections below are added as each part lands, so what they document is what exists.

## Run & test

```bash
npm install && npx playwright install chromium   # one-time setup on a fresh clone
npm start            # dev server (scripts/serve.js) at http://localhost:8791
npm test             # Playwright e2e (auto-starts the server); specs in tests/
npm run lint         # ESLint
```

No build step — `index.html` loads `src/*.js` as ES modules directly. There are no unit
tests; correctness is verified by driving the real app (Playwright). The app exposes
`window.__app` for introspection/control:

```js
const a = window.__app;
a.viewYaw = -0.6; a.viewPitch = 0.5; a.viewZoom = 1.4; a.viewRot = a._composeViewRot();
a.anim.speedFactor = 0.1;           // slow animations down to capture mid-transition
a.executeMove(2, 'XW', +1);         // cellIndex, planeName, sign (any cell/plane)
a.selectCentralCell(4);             // animated, stable recentering
a.setCentralMode('wire');           // focused layer: 'solid' | 'wire'
a.setSideMode('none');              // side cells: 'semi' | 'solid' | 'wire' | 'none'
a.setCoreWire(true);               // core-tesseract wireframe overlay on/off
a.coreFrame;                        // current 4D frame {e:[e0,e1,e2], eF} — at rest, a canonical frame
```
To capture a specific moment in a turn, poll `a.anim.active` and compute progress from
`(performance.now() - active.startTime) / (active.duration / a.anim.speedFactor)`. The
canvas uses `preserveDrawingBuffer`, so it can be read back via a 2D canvas in tests.

**Remote/cloud sessions** (Claude Code web containers): Chromium is pre-installed under
`/opt/pw-browsers` and `npx playwright install` is unavailable; if its revision doesn't
match the repo's pinned Playwright, point the launch at it for the session — in
`playwright.config.js` add `launchOptions: { executablePath:
'/opt/pw-browsers/chromium_headless_shell-<rev>/chrome-linux/headless_shell' }` (revert
before committing). Use the **headless shell**, not the full `chromium` binary: the full
browser requests `/favicon.ico` (the repo ships none) and the 404 console error fails
every `errors == []` assertion in the specs.

## Files

- `index.html` / `style.css` — the page shell. Mobile-first, `dvh` + safe-area insets; `#app` width = `min(100vw,100dvh)` (square-capped).
- `src/main.js` — `App`: state, render loop (`_loop`/`_render`, dirty-flag redraw), view (yaw/pitch/zoom). Bootstraps `window.__app`.
- `src/math4d.js` — 4×4 / 3×3 matrix + 4D vector helpers (`mat4PlaneRotation`, `mat4MulVec4`, `PLANE_AXES`, …) **+ the SO(4) geodesic** (`so4Slerp`, `so4Decompose`, `mat4Det`, `mat4FromCols`) used by stable centering.
- `src/puzzle.js` — cubie model, `CELLS` (the 8 cells + colors), `executeMove`/`undoMove`.
- `src/projection.js` — **the heart**: 4D→3D projection, cubie geometry, color fade, wireframes (solid `computeCells` / wireframe `computeWireframe`, both keyed off the focused-layer weight `solidWeight` so they double as sub-views on a cell's own frame), canonical frames + `slerpFrame`, and the core-tesseract wireframe (`computeCoreWireframe`). Almost all design decisions live here.
- `src/renderer.js` — WebGL: opaque, depth-tested, **no back-face culling**. `beginFrame()` clears the whole canvas; `drawView(cells, viewRot, segments, camDist, rect, zoom)` renders one scissored viewport (`zoom` crops/magnifies without moving the camera) — called once per view.
- `src/animation.js` — `AnimationEngine`: move queue, easing, per-frame state. `MOVE_DURATION=360ms`, `speedFactor`.
- `src/controls.js` — pointer + keyboard input and the DOM builders for the game shell (cell tiles, twist buttons).
- `src/shaders.js` — GLSL. Two-sided lambert (`abs(dot(n,light))`), `u_ambient=0.42`; screen-door dither `discard` via an **ordered Bayer 8×8** threshold (uniform frosted stipple, not noise) — keeps each fragment with probability `a_opacity`, for the solid→wireframe dissolve and the translucent semitransparent side cells.
- `scripts/serve.js` — zero-dep static dev server (sets ESM MIME types). `tests/` — Playwright specs. `playwright.config.js`, `eslint.config.js`, `package.json` — infra.

## Puzzle model (`puzzle.js`)

- 81 logical cubies, `pos4 ∈ {-1,0,1}⁴`. Each carries `pos4`, `solvedPos4`, `stickers`
  (`{faceDir, cellIndex}`, `faceDir` is a LOCAL axis), `faceDirs` (current world dirs),
  and `orient` (a 4×4 matrix = the cubie's own 4D orientation).
- 8 **cells** = the tesseract's 3D facets, one per ±axis. `CELLS[i]` (i matches keys 1–8):
  `+X`red `-X`orange `+Y`green `-Y`blue `+Z`yellow `-Z`white `+W`purple `-W`cyan.
- A cubie belongs to every cell where `|pos4[axis]|==1` (1–4 stickers: cell-center →
  hyper-corner). Cells genuinely **share** cubies; a move on one cell moves shared cubies.
- **A cell turn is an absolute 4D rotation of the affected cubies** (`executeMove` rotates
  `pos4`, `faceDirs`, and `orient` by `mat4PlaneRotation`). It never touches the frame.
  Legal planes per cell axis: ±X→YZ,YW,ZW · ±Y→XZ,XW,ZW · ±Z→XY,XW,YW · ±W→XY,XZ,YZ.

## Projection model (`projection.js`) — read this before touching rendering

> **Central tension:** a 4D rotation's 3D shadow can't be both a rigid constant-size
> cube *and* smoothly reveal/hide the colors it swaps. We keep the cube rigid and pay
> for the reveal in color, not shape. The long-form rationale, the collision analysis
> behind the color fade, and the approaches we tried and dropped live in
> [docs/model-notes.md](docs/model-notes.md) — read it before reworking the projection
> or coloring.

Two distinct 4D→3D projections coexist on purpose:

**1. The core frame** `{ e:[e0,e1,e2], eF }` — three orthonormal "free" axes mapped to
screen x/y/z, plus a depth axis `eF` (the central-cell direction). `project(p) =
[p·e0, p·e1, p·e2] · depthR(p·eF)`, with `depthR(w)=2.8−1.45w` (w=1→1.35 inner, 0→2.8,
−1→4.25 outer). This is a Schlegel-style 4D perspective: the central cell is the small
inner cube, the opposite cell the big enclosing one, the 6 others spread between.
- **Centering is a 4D rotation of the FRAME**, not the cubies. Cubies hold still in 4D;
  the viewpoint sweeps inside-out. `_render` interpolates `coreFrame` via `slerpFrame`;
  `_onCentralComplete` commits it.
- **Stable centering (the key invariant):** every cell has a fixed **canonical frame**
  `frameForCell(i)`, forced right-handed (det +1) so any cell→cell move is a *proper* SO(4)
  rotation. Centering interpolates along the **SO(4) geodesic** (`slerpFrame` → `so4Slerp`,
  a double-quaternion / van Elfrinkhof factorization — smooth at every angle, including the
  180° opposite-cell hop) and **commits the destination's canonical frame exactly**. So
  revisiting a cell always lands on the identical orientation (A→B→A is bit-exact).
  (**Single-plane centering was rejected:** composing one plane rotation per hop and
  committing the composed frame let the free axes drift — A→B→A could return with a different
  face forward — and the 180° opposite-cell hop was not smooth. Don't reintroduce it.)
- Cubies with <2 nonzero coords are hidden (`isHidden`): the 8 cell-centers + 1 core
  cubie. So **72 cubies render**, not 80.

**Sub-views.** Each of the 8 cell tiles renders the **same** `computeCells` / `computeWireframe`
as the main view, just on that cell's own canonical frame (`frameForCell(i)`): with the cell's
axis as depth only its cubies have a high focused-layer weight, so its 6 side stickers form the
cube faces and the along-axis cells read dark — the centred-cell look, isolated. A sub-view is
effectively "central, side = none": it follows the **Central cell** mode (solid or wireframe),
and a cubie sliding out during a neighbour's turn **fades to nothing via the same dither** as
the main view instead of popping. Sub-views share the **one `viewRot`** (synchronized turntable)
but never animate centering; they do animate turns (shared `getState`), so a twist of the centred
cell rigidly spins its own cube while scrambling the neighbours'. All 9 views are drawn into
scissored viewports of one canvas.

**2. Each cubie is its OWN little Schlegel tesseract** (`cubieBoxes`), *placed* at its
core position but *shaped* independently (so it doesn't inherit core distortion — it reads
as a clean cube, not a "shard of the core"). 8 cells per cubie: inner small cube, outer
big cube, 6 side frustums, via `cubiePersp(dz)=1−PERSP_SLOPE·dz`. `CUBE_S=0.41` so a side
cell's outer face lands ~0.58 (the cube-face size). Each cell is inset toward its centroid
by `CUBIE_SHRINK=0.9` — and because the **outer cell is inside-out** (centroid at the
cubie center, far from its faces) the same inset pulls it well behind the side stickers, so
it self-hides without z-fighting.

### Coloring & the snap-hiding fade (the subtle part)

Only side cells should show sticker color; the inner/outer cells must read dark. But a
depth-involving turn rotates cells through the depth axis, and solid faces swapping depth
order make colors "snap." The fix is to **time color to the cell's depth facing** so every
swap hands off black-to-black, *without* ever blacking the whole puzzle:

- `df = (orient·cellAxis)·eF` — current depth facing (±1 inner/outer, 0 side).
- `dft` — the same at the **committed** (end-of-turn) orientation. Comparing `|dft|` to
  `|df|` tells which way the cell is heading.
- `colorWeight(df, dft)`: **settled/stationary side** (|dft|≈|df|) → painted; **hiding**
  (|dft|>|df|) → stay painted, fade out late; **revealing** (|dft|<|df|) → stay black,
  paint late (outer-side reveal, `df<0`, paints latest). Color lerps DARK↔sticker by this.
- Net: stationary sides stay lit, only the transitioning faces go dark through their
  crossover. The trade (accepted): the moving cell vs *stationary side* collisions still
  snap, but the puzzle is never all-black. Centering uses the symmetric settled fade.

### Presentation: focused layer vs side cells (three independent settings)

How the tesseract reads is **three independent menu settings**, all hung off one quantity —
the focused-layer weight `solidWeight = smoothstep(0.4, 0.9, pos4·eF)` (1 = central layer,
→0 outward), which slides continuously as the frame sweeps (centering) or a cubie crosses the
layer (a turn whose plane includes the central axis):

- **Central cell** = `solid` (default) or `wire` — how the `sw≈1` cubies draw.
- **Side cells** = `semi` (default) / `solid` / `wire` / `none` — how the `sw≈0` cubies draw. `semi`
  draws them as **translucent solids** (the whole tesseract reads as nested frosted cubes); `solid`
  draws them **fully opaque** (`SIDE_FLOOR.solid=1.0` — the floor path with α=1; needed for the
  authentic classic view); `wire` as edges; `none` hides them.
- **Core tesseract** wireframe = on/off — the separate `computeCoreWireframe` overlay (default off).

The default (solid centre, semitransparent sides, no core) shows the focused 3×3×3 as a clean
opaque 3×3×3 cube with the rest of the tesseract as see-through frosted cubes around it (`wire`
sides gives a solid cube inside an edges-only surround). `computeCells` takes `{sideAlpha, centralSolid}`: with `sideAlpha=0`
(default) only the focused layer is solid (`opacity=sw`, skips `sw≤0.02`); with `sideAlpha>0` and a
solid centre the sides are floored translucent (`opacity=max(sw, sideAlpha)`, `SIDE_ALPHA=0.4`); with
`sideAlpha>0` and a wire centre the solid is the side role only (`opacity=sideAlpha·(1−sw)`), fading
out as a cubie reaches the focused layer. `computeWireframe` options — `skipSolid` drops the cubies
the solid centre fully covers (`sw≥0.98`), `fade` sets `opacity=sw` so a *wireframe* cubie can
dissolve out too.

Every **central→side hand-off is carried by the screen-door dither** (the shader keeps each
fragment — face *or* line — with probability `opacity`, no alpha blending, depth buffer
untouched):

| central → side | how it transitions |
|---|---|
| solid → semi | solid faces dither down to a translucent floor (`sw`→`SIDE_ALPHA`) — never vanish *(default)* |
| solid → wire | solid faces dither out over a full-opacity side wireframe *(solid cube in an edges-only surround)* |
| solid → none | solid faces dither out **into nothing** |
| wire → semi | side solids dither out as the central wireframe fades in |
| wire → wire | edges stay at full opacity throughout — **no** transition |
| wire → none | edges dither out **into nothing** (`fade`) |

Each main-view combo picks the right `computeWireframe` call (see `_render`). **Sub-views reuse
this exactly** on the cell's own frame as "central, side = none", so a cubie leaving the cell
fades instead of popping. Steady state needs no blending (every cubie is cleanly solid, wireframe,
or absent).

### Other rendering facts

- **No back-face culling** (`renderer.js`). The depth buffer handles occlusion; culling
  used to delete a face as it went edge-on, leaving see-through holes between the cubie's
  separate cell boxes. Removing it makes cubies stay solid at grazing angles.
- `DARK=[0.10,0.10,0.13]` for non-sticker faces; background `[0.04,0.04,0.06]`.
- **Core-tesseract wireframe** (the *Core tesseract* checkbox; `W` toggles the Central cell
  mode solid↔wire) — `computeCoreWireframe` draws the 8 core cells as cube outlines, the active
  cell spinning during a turn, all rotating during centering. The core cell corners sit exactly
  on the corner-cubie centers (`CORE_EXT=1`); side cells inset inward, the inside-out outer cell
  insets **outward** so it encloses its cubies. It's an independent overlay now, so a full
  wireframe inspection = Central `wire` + Side `wire` + Core on. (Only the **main view** shows
  the core overlay; sub-views never do.)

## View, modes, controls

- **View** is a turntable shared by all 9 views: independent `viewYaw`/`viewPitch`
  (recomposed by `_composeViewRot`, pitch clamped to ±90°) so horizontal drag never
  introduces roll. `viewZoom` sets the camera distance (`MAIN_CAM/zoom`) shared by all 9
  views; sub-views additionally crop-zoom in (`SUBVIEW_ZOOM`) to fill their tile (same
  perspective as the main view). View changes never touch puzzle state.

