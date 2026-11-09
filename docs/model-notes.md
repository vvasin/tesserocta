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
z-fighting.
