# Model notes — the 4D→3D projection

Long-form rationale behind `src/projection.js`. CLAUDE.md is the brief — *what* the
code does today. This is the *why*: the decisions, the analysis that justifies them,
and a couple of approaches we tried and dropped so a future session doesn't re-tread
them. Read CLAUDE.md first; this assumes its vocabulary (`eF`, `df`, side/inner/outer
cells, the per-cubie Schlegel).

---

## 1. The central tension

A 4D rotation's 3D shadow cannot be **both** a rigid, constant-size cube **and**
smoothly reveal/hide the colors that the rotation swaps. Smooth reveal *requires*
shape change — if the cube never deforms, a face that should appear can only do so by
a hard depth-order flip (a "snap").

The decision: keep the cube **rigid** (constant size, never deformed — an invariant),
and pay for the reveal in **color**, not shape. Faces lerp between their sticker color
and `DARK`, timed so every depth-order swap happens while the swapping faces are
already dark. You trade a brief, local darkening for a stable cube. Almost every
choice below is a consequence of sitting on this trade.

---

## 2. Two projections, decoupled on purpose

There are two independent 4D→3D maps (see CLAUDE.md §Projection model):

1. **The core frame** — a global Schlegel projection (`project()` with
   `depthR(w)=2.8−1.45w`). It *places* every cubie: central cell → small inner shell,
   opposite cell → big outer shell, the 6 others spread between. This is the nested
   "tesseract diagram."
2. **Each cubie's own little Schlegel** (`cubieBoxes`, `cubiePersp`) — it *shapes* the
   cubie locally, anchored at its placed position.

**Why two, not one.** The first thing we tried was carving the single
core tesseract into 80 pieces and calling them cubies. They came out crooked: each
cubie inherited the core's nonlinear depth distortion, so cubes near the shells
sheared. Decoupling *placement* (global) from *shape* (local, per-cubie) is the fix —
every cubie reads as a clean cube regardless of where it sits, while still nesting like
the core. **Position and shape are deliberately separate maps.** Don't re-merge them.

The local map still uses a Schlegel *style* (inner small cube, outer big cube, 6 side
frustums) so a cubie is self-similar to the core. The outer cell is **inside-out** (its
center projects to the cubie center, its corners to the far hull); the `CUBIE_SHRINK`
inset toward each cell's centroid therefore pulls the outer cell's faces *inward* far
more than the side faces move, so it self-hides behind the side stickers with no
z-fighting. That same inside-out property is used *inverted* for the wireframe core,
where the outer cell must **enclose** its cubies, so it insets outward.

---

## 3. The coloring problem: snaps, and the collision model

Only side cells should show color; inner/outer must read dark. A depth-involving turn
rotates cells *through* the depth axis, so solid faces swap depth order and colors
snap. To time the color fade correctly we mapped out exactly what collides and when.

**Setup.** A depth turn is a rotation by θ:0→90° in the plane `(eF, e0)` — the depth
axis and one screen axis. Write `R(eF)=cosθ·eF + sinθ·e0`. Of the cubie's 8 cells, the
4 whose axis lies in that plane swap roles (the **actors**); the other 4 (`±e1, ±e2`)
keep their role but rotate internally (the **stationary sides**).

| actor | role 0°→90° | `df(θ)` = axis·eF | persp (size) | nature |
|---|---|---|---|---|
| **A1** | inner → side | `cosθ`  : 1→0  | 0.58→1.0 grows | **reveal** |
| **A2** | outer → side | `−cosθ` : −1→0 | 1.42→1.0 shrinks | **reveal** |
| **A3** | side → outer | `−sinθ` : 0→−1 | 1.0→1.42 grows | **hide** |
| **A4** | side → inner | `sinθ`  : 0→1  | 1.0→0.58 shrinks | **hide** |
| **S1–S4** | side → side | `0` throughout | 1.0 | stationary |

Who is dark when (✗ dark / ■ lit), under the current fade:

```
θ:            0°   15°  30°  45°  60°  75°  90°
A1 inner→side ✗    ✗    ✗    ✗    ✗    ■    ■    reveals at the end
A2 outer→side ✗    ✗    ✗    ✗    ✗    ■    ■    reveals at the end (latest)
A3 side→outer ■    ■    ✗    ✗    ✗    ✗    ✗    hides from ~30° on
A4 side→inner ■    ■    ✗    ✗    ✗    ✗    ✗    hides from ~30° on
S1–S4 sides   ■    ■    ■    ■    ■    ■    ■    always lit
```

**The key result.** Pair up every collision and check whether both parties are already
dark on their own:

- A1 reveal ↔ A3 hide, A2 reveal ↔ A4 hide, A4 hide ↔ A3 hide — **all self-hide**: the
  revealers are dark early-to-mid, the hiders dark mid-to-late, overlapping in the
  middle where the swap happens.
- A3 (becoming outer) and A2 (becoming side) crossing the **stationary sides** — these
  do **not** self-hide, because the stationary sides stay lit.

So the *only* collisions that snap are actor-vs-stationary-side. That single fact
drives the whole design (§4) and bounds what's improvable (§6).

---

## 4. The current solution: `colorWeight(df, dft)`

We time each cell's color to **which way it is heading**, read by comparing its current
depth facing `df` to its committed (end-of-turn) depth facing `dft`:

- **stationary side** (`|dft|≈|df|`) → always painted.
- **hiding** (`|dft|>|df|`) → stay painted, fade out *late* (`1−smoothstep(0.55,0.92,|df|)`).
  It's still side-like through the early part of its slide into depth.
- **revealing** (`|dft|<|df|`) → stay **black** until it has emerged, then paint
  (`1−smoothstep(lo,hi,|df|)`). The outer-side reveal (`df<0`, A2 — it has to clear the
  stationary sides too) uses a lower threshold so it paints **latest** of all.

`dft` comes for free during a turn: the logical move is committed at animation *start*,
so `cubie.orient` already holds the end state while `getState()` supplies the animated
one. Centering has no per-cubie target during a frame sweep, so it falls back to the
symmetric settled fade (`sideColorWeight`).

**Why this and not the simpler options:** see §5. The net is what §3 demands — the
self-hiding collisions are covered by the directional timing, and the cube is **never
all-black**: at any instant only the specific hiding/revealing faces are dark, the
stationary sides keep their color. The accepted cost is in §7.

---

## 5. Dead ends worth recording

**Whole-cubie blackout** (`transitionWeight(align)`). We darkened the *entire* cubie
while it was mid-turn (no axis aligned to `eF`), so every crossover was black-to-black.
It worked and hid *all* snaps — but it darkened too much, and was catastrophic for
**recentering**, where every cubie transitions at once → the whole puzzle blacks out
together. Replaced by the directional `colorWeight`, which only darkens the actual
hiding/revealing faces. *Lesson: scope the darkening to the faces that snap, not the
cubie.*

**Per-face `pdf` fade** — fade a face by how much its own normal aligns with `eF`.
Sounds right (depth-facing faces are where things break through), and it's tempting
because it would avoid darkening whole cells. It **failed for a counterintuitive
reason**: a side cell's *visible sticker* is the frustum's **outer-end** face, whose 4D
normal points *along* the depth axis (`pdf≈1`) even though it renders as a flat outward
square. So "fade faces that align with depth" blacked out exactly the stickers we
wanted lit. *Lesson: a face's 4D normal direction is not its 3D screen orientation.*

**Earlier attempts:** cubies-as-pieces-of-one-core (crooked, §2);
transparency for depth (unreadable "translucent hell"); per-axis "lobe" rendering
(read as 18 cells per cell). All abandoned for opaque depth-nesting + the color fade.

**Hashed dither.** The screen-door threshold was first a per-pixel hash. Fine for a brief
dissolve, but at a steady partial coverage it reads as TV static; replaced by the ordered
Bayer 8×8 threshold (§8).

---

## 6. Counterintuitive geometric facts (each cost real time)

- **A side cell's sticker face has `pdf≈1`.** It's the frustum's outer-end face; its 4D
  normal lies along `eF`. Its flat outward screen appearance is unrelated to its 4D
  normal. (This is what sank the per-face fade.)
- **The outer cell is inside-out.** Center → projection origin, corners → far hull. So
  shrinking it *toward* its centroid moves its visible boundary *outward*. Used as a
  feature (cubie outer cell self-hides) and inverted for the wireframe core (must
  enclose).
- **Inflating a depth coordinate through `depthR` inverts sizing.** The `CORE_EXT=1.5`
  wireframe bug: feeding `val·1.5` (instead of `±1`) into the nonlinear `depthR` made
  the inner core cell *shrink* and the outer one *balloon*. Fix: `CORE_EXT=1`, so core
  cell corners are the *same* projected points as the corner-cubie centers.

---

## 7. Accepted trade-offs (deliberate, not bugs)

- **Stationary-side collisions still snap.** Given §3, hiding them would require
  darkening the lit stationary sides — i.e. back toward the whole-cubie blackout. We
  chose snaps over an all-black puzzle.
- **Centering snaps more than turns.** It uses the symmetric settled fade (no
  directional target available mid frame-sweep). Threading the target frame's `eF`
  through would give it the same hide/reveal timing — open if it ever bothers us.
- **No back-face culling.** The depth buffer handles occlusion; culling deleted faces
  as they went edge-on, leaving see-through holes between a cubie's separate cell
  boxes. Safe to drop now that inner/outer cells are dark + shrunk behind the stickers.

---

## 8. Focused layer solid, outer layers see-through

The full opaque render is a wall of cubes — the outer shells occlude the central cell you
care about. So only the **central cell is solid**; in the `wire` side mode every outer-layer
cubie becomes **wireframe** (the default `semi` mode is described below). This is the "transparency" the translucent-fills approach (§5)
failed to deliver — but as structural *edges*, not blended fills, so it stays readable.

`solidWeight = smoothstep(0.4, 0.9, pos4·eF)` is the central-ness: it's `pos4`'s depth
along the central axis, already continuous through both events that change membership
(centering sweeps `eF`; a layer-crossing turn moves the animated `center4`). In steady
state every cubie is cleanly 0 or 1 — so **no blending is needed there**; only the
mid-animation band has both representations at once.

For that handoff we chose **screen-door dither** over an alpha cross-fade: the shader
`discard`s fragments with probability `1−solidWeight`, so the fading solid pokes holes
that reveal the wireframe (drawn just behind it, slightly shrunk). It needs no back-to-
front sorting and leaves the opaque depth pipeline untouched — the alpha route would have
re-introduced the sorting/blending fragility we spent §1–§7 avoiding. The dither pattern
is screen-space and stable per pixel, so a cubie dissolves cleanly rather than sparkling.

### Semitransparent side cells (the default) — same dither, lower floor

The `none` (hide sides) and `wire` (edges only) side modes left a gap: a *translucent*
look where the whole tesseract reads as nested frosted cubes. The naive version — render
every cubie's 8 cell boxes with true alpha — is exactly the "translucent hell" of §5: with
72 cubies × 8 nested cells × 6 faces there is no correct back-to-front order (the inner and
outer cells of one cubie interpenetrate), and near-coplanar cubies colliding during a
central↔side transition z-fight. **Weighted-blended OIT** would solve the ordering and
(with depth writes off) kill the z-fight, but it needs MRT + half-float targets — risky on
mobile WebGL 1 and a lot of framebuffer machinery for a no-build project.

So `semi` reuses the **same screen-door dither**, just with a floor: side cubies draw as
solids at `opacity = max(sw, SIDE_ALPHA)` (`SIDE_ALPHA=0.4`) instead of being dropped. It's
order-independent for free (writes depth, no blend), and the stochastic discard turns the
transition z-fight into a stipple rather than a shimmering plane — it *mitigates* the fight
without eliminating it (depth is still written; true elimination would need OIT with depth
writes off). To make 40% coverage read as **frosted glass instead of TV static**, the
shader's per-pixel hash was replaced with an **ordered Bayer 8×8** threshold (recursive
2→4→8, no array indexing — WebGL-1 friendly). The handoff stays continuous: a cubie leaving
the focused layer fades `sw`→`SIDE_ALPHA` and never vanishes. (With a *wireframe* centre the
side solid instead fades to nothing as the centre wireframe fades in: `opacity =
SIDE_ALPHA·(1−sw)`.) If the stipple ever proves unacceptable, WBOIT is the documented
upgrade path.

---

## 9. The game: 9 views + stable centering

The single projection became a **mobile-first game** of 9 synchronized views — the main
tesseract plus 8 cell sub-views, all sharing one turntable `viewRot`. Two notes for a
future session, because both look arbitrary out of context.

**Sub-views.** A cell shown "as if central" with *only its own cubies* is already a clean
3×3×3 twisty cube — that falls straight out of the existing model: with `frame =
frameForCell(i)` the cell's 27 cubies sit at depth +1 (the inner cube), so only they have a
high focused-layer weight (`solidWeight ≈ 1`), their along-axis (inner/outer) mini-cells read
dark, and the 6 side stickers become the cube faces. So a sub-view is literally the main view's
`computeCells` (or `computeWireframe`, following the Central-cell mode) on the sub-frame — no
separate sub-view cube builder (one existed; it duplicated the look and made cubies pop). During a neighbouring cell's turn, cubies slide in/out of the cell;
because the sub-view is "central, side = none", a leaving cubie's `sw` falls to 0 and it **dithers
out into nothing** via the same screen-door dissolve as the main view, instead of popping. No new
projection — the sub-view *is* the main view's central look, isolated.

**Stable centering (canonical frames + SO(4) geodesic).** The first centering composed a
single-plane frame rotation per hop and committed the *composed* frame, so the free axes drifted:
A→B→A could come back with a different face forward. Fix: each cell has a fixed **canonical
frame** `frameForCell(i)`, forced right-handed (det +1 — swap the last two free axes when
the naive frame is left-handed) so that *every* cell→cell relation is a proper SO(4)
rotation. Centering interpolates that rotation along its geodesic via a **double-quaternion
(van Elfrinkhof) factorization** `M = L(λ)·R(ρ)`, slerping λ and ρ from identity
(`so4Decompose`/`so4Slerp` in `math4d.js`). This is smooth at *every* angle — crucially the
180° opposite-cell hop, where a naive matrix/vector lerp passes through the zero vector and
collapses. The animation **commits the destination's canonical frame exactly**, so revisits
are bit-identical. Why all-same-handedness matters: mixed handedness would make some pairs
an improper rotation (a reflection) with no continuous SO(4) path — uniform det +1 removes
that. Single-plane centering is rejected for those two reasons (drift on revisits, no smooth
180° hop); don't reintroduce it.

---

## 10. The swipe surface: idealized quads, not rendered geometry

Direct manipulation (`centralStickers`/`applyCentralSwipe`) never reads back what was
drawn. The hit surface is an **idealized model** of where the stickers are — a handful
of quads projected to client pixels through the renderer's *exact* camera parameters
(frame, `viewRot`, zoom, FOV). This works because the relevant geometry is exactly
predictable: a central-layer cubie always projects to a clean grid (`pos4·eF = 1` →
constant `depthR(1)`), and classic's pull/group offsets are closed-form. Rebuilding
~27 quads per pointer-down is negligible; hit-testing rendered geometry would mean
occlusion queries or CPU-side replication of `cubieBoxes` — all cost, no benefit.

Three properties make the tiny model sufficient:

- **Logical lattice coords, not positions, drive the move.** Each quad carries `g` =
  the cubie's `pos4·e` along the 3 screen axes. The swipe resolver needs only: drag
  axis (dominant in-face tangent), rotation axis (the *other* tangent), slab (`g`
  along it: 0 → `turnMiddle`, ±1 → `turnFace`). Where the quad *sits* is irrelevant to
  *which* move fires — position only decides which quad you grabbed and the sign.
- **Every reachable move is a rigid rotation of a hyper-slab about a screen axis
  through the origin.** So the "grabbed sticker travels with the finger" sign test is
  one cross product: `dir = sign((r̂ × c3)[dragAxis])` with `c3` the quad's true
  projected-3D centre. On the centred cube this is *provably identical* to the older
  face-normal test `r̂ × n̂` (only the face-normal component of `c3` survives along the
  drag axis) — but the position form also holds for quads that sit **off** the rotation
  axis, which is what classic relocation needs. If you ever add swipe targets anywhere
  else, keep the `c3` form; the normal form silently breaks off-axis (that is how the
  first classic attempt got the far-side caps wrong).
- **Only camera-oriented faces are emitted** (per-quad `normal·toCam > 0`, plus the
  `MIN_STICKER_FRAC` sliver cull). In classic the exploded layout has see-through gaps —
  you can *see* the far cells' stickers from behind; they must not react. Culling at
  emission time keeps `_pickSticker` a dumb nearest-`zc` point-in-poly scan.

**The classic-sync design question — and two rejected generalizations.** When classic
relocates the side stickers, where should the controls go? Two "cover everything you
can see" models were built and then **dropped**:

1. **Grouped clusters as full swipe cubes** — each grouped side cell modelled as its
   own idealized 3×3×3 (all 6 faces). It works, and its side faces even gave a natural
   "spin this cell in place" gesture (rotation axis = the cell's facing axis — legal
   because a cell turn moves the whole cell, so every sticker of a cluster shares
   `g[facing] = cell sign`). Rejected: it multiplied targets (~150 quads), covered the
   view (killing orbit space), and didn't match the ungrouped layout at all.
2. **Ungrouped layer sheets** — each side cell as three radially-facing 3×3 sheets
   (tangential spread `depthR(d)` per depth layer). Also works; also rejected — 81+
   targets, and middle/outer-layer stickers became controls that have no counterpart
   in normal mode.

**The final model is the spec the game actually wants:** the control areas are *always
the same ≤27 stickers* — the central-layer cubies' side stickers. Normal mode: they
tile the centred cube's 3 visible faces. Classic (settled): the *same* areas relocate
with those stickers to the **inner sheet** of each side cell — sticker plane
`1.5·STICKER_GRID` → `+ PULL_DIST`, tangential spacing sliding `STICKER_GRID →
PULL_DIST` with the **live** `groupT` (one lerp covers grouped, ungrouped, and the
grouping animation in between). Same count, same identity, same slab/axis/sign per
area; the old cube-face locations stop being controls (the centre region orbits), and
middle/outer-layer stickers never react. *Lesson: "synchronize the controls" meant
"move the existing controls", not "add controls to everything visible" — the ≤27
invariant is the design, matching normal mode's mental model exactly.*

Related earlier decision, same shape: the **exit-edge** gesture model (which edge of
the start sticker the drag leaves through) was chosen over "start sticker + end
sticker" because it classifies cleanly when a swipe wraps over a cube edge onto
another face of the same cubie, or runs off into empty space. Press-time decides the
gesture: a drag born on a sticker never orbits.
