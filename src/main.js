import { mat3Mul, mat3AxisRotation, mat3MulVec3 } from './math4d.js';
import { buildSolvedPuzzle, undoMove, CELLS } from './puzzle.js';
import { computeCells, computeWireframe, computeCoreWireframe,
         frameForCell, cloneFrame, slerpFrame, centralFromFrame } from './projection.js';
import { Renderer } from './renderer.js';
import { AnimationEngine } from './animation.js';
import { Controls, buildCellTiles, buildTurnControls, setCenteredTile, setControlSet } from './controls.js';

const AXIS_LETTERS = ['X', 'Y', 'Z', 'W'];   // 4D axis index → plane-name letter
const DEFAULT_YAW  = -Math.PI / 5.5;         // resting turntable yaw; also the reference the twist
                                             // buttons orient against (their icons read right here)
const MAIN_CAM     = 15;                      // camera distance at zoom 1 (main view default)
const SUBVIEW_ZOOM = 2.4;                     // sub-views share the main camera distance and only
                                             // crop-zoom in to fill the tile (no distortion). Tuned
                                             // for zoom 1; sub-cubes scale with the main zoom.
// View presentation = three independent settings (see _render). The central layer draws
// solid or as wireframe; the side cells draw translucent, opaque, as wireframe or not at
// all; the core-tesseract wireframe is a separate overlay.
const CENTRAL_MODES = ['solid', 'wire'];
const SIDE_MODES    = ['semi', 'solid', 'wire', 'none'];
const SIDE_ALPHA    = 0.4;                     // opacity floor for the 'semi' side cells —
                                              // carried order-independently by the shader's
                                              // ordered (Bayer) screen-door dither
// Per side mode, the opacity floor passed to computeCells: 'semi' = translucent frosted
// floor, 'solid' = fully opaque side cells (needed for the authentic classic view), and
// 'wire'/'none' use 0 (handled by the wireframe/skip paths instead).
const SIDE_FLOOR    = { semi: SIDE_ALPHA, solid: 1.0, wire: 0, none: 0 };

// Direct-manipulation swipe (turn the centred cube by dragging across its stickers).
// A central-cell cubie always projects to a clean grid: pos4·eF = 1 → depthR(1) = 1.35
// constant, so its free-axis coords land at (g·1.35) along screen x/y/z. We model the
// centred 3×3×3 as that idealized cube and project it through the renderer's exact camera.
const STICKER_GRID  = 1.35;                  // central-cube cubie spacing in projected 3D
const STICKER_FOV   = Math.PI / 3.2;         // must match renderer's perspective FOV
const MIN_STICKER_FRAC = 0.0006;             // drop stickers smaller than this fraction of the
                                             // main-view area (edge-on / heavily foreshortened);
                                             // ~0.0006 keeps all 27 readable at rest, dropping only
                                             // slivers as a face turns toward edge-on

class App {
  constructor() {
    this.cubies = buildSolvedPuzzle();
    this.centralCellIndex = 0;
    this.coreFrame = frameForCell(this.centralCellIndex);    // explicit 4D core orientation
    this.subFrames = CELLS.map((_, i) => frameForCell(i));   // fixed canonical frame per sub-view
    this.pendingCenter = null;                 // active centering { fromFrame, toFrame, toCi }
    // Three independent presentation settings, defaulting to a solid centre,
    // semitransparent sides and no core overlay.
    this.centralMode = 'solid';
    this.sideMode    = 'semi';
    this.coreWire    = false;
    this.controlSet = 'central';

    // Turntable view: independent yaw/pitch so horizontal drag never leaks into roll.
    this.viewYaw   = DEFAULT_YAW;
    this.viewPitch =  Math.PI / 7;
    this.viewZoom  = 1.0;
    this.viewRot = this._composeViewRot();

    this.undoStack = [];
    this.redoStack = [];

    this.anim = new AnimationEngine();
    this.anim.onMoveComplete = (desc) => this._onMoveComplete(desc);
    this.anim.onCentralComplete = () => this._onCentralComplete();

    this.dirty = true;                         // redraw flag (render only when needed)

    this.canvas = document.getElementById('glcanvas');
    this.renderer = new Renderer(this.canvas);
    this.stageEl = document.getElementById('stage');

    buildCellTiles();
    buildTurnControls(this);
    setControlSet(this.controlSet);
    this.tileEls = [];
    document.querySelectorAll('.cell-tile').forEach(el => { this.tileEls[+el.dataset.cell] = el; });
    setCenteredTile(this.centralCellIndex);

    this.controls = new Controls(this.canvas, this);

    window.addEventListener('resize', () => this.markDirty());
    window.addEventListener('orientationchange', () => this.markDirty());
    // iOS Safari ignores user-scalable=no, so block its pinch gesture from zooming the
    // page (we handle zoom on the canvas ourselves; double-tap zoom is off via touch-action).
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(ev, e => e.preventDefault(), { passive: false });
    }

    requestAnimationFrame(ts => this._loop(ts));
  }

  markDirty() { this.dirty = true; }

  // ── Render loop ──────────────────────────────────────────────────────────────

  _loop(timestamp) {
    const frame = this.anim.tick(timestamp, this.cubies, this.centralCellIndex);

    const busy = !this.anim.isIdle() || !!this.pendingCenter;
    if (this.dirty || busy) {
      this._render(frame);
      this.dirty = false;
    }
    requestAnimationFrame(ts => this._loop(ts));
  }

  _render(frame) {
    // Core frame for this instant (interpolated during a centering animation).
    let coreFrame = this.coreFrame;
    if (frame && frame.type === 'central' && this.pendingCenter) {
      coreFrame = slerpFrame(this.pendingCenter.fromFrame, this.pendingCenter.toFrame, easeInOut(frame.t));
    }
    const getState = frame && frame.type === 'move' ? frame.getState : null;

    // Main view geometry, from the three presentation settings. The focused (central)
    // layer is solid faces or wireframe edges; the side cells are translucent solids,
    // wireframe edges, or nothing; the dither carries every central→side hand-off:
    //   solid centre     → side semi : side cells are translucent solids (max(sw, α))
    //   solid centre     → side wire : solid fades out over a full side wireframe
    //   solid centre     → side none : solid fades out into nothing
    //   wireframe centre → side semi : side solids fade out as the wireframe fades in
    //   wireframe centre → side wire : edges at full opacity throughout — no transition
    //   wireframe centre → side none : edges fade out into nothing
    const centralWire = this.centralMode === 'wire';
    const sideWire = this.sideMode === 'wire';
    const sideFloor = SIDE_FLOOR[this.sideMode] || 0;     // 'semi'/'solid' opacity floor (else 0)
    let cells = [];
    let segments = [];
    if (sideFloor > 0) {
      // Floored side cells (translucent 'semi' or fully opaque 'solid'), order-independent
      // via the screen-door dither. The centre stays a clean opaque solid, or — if set to
      // wireframe — the side solids fade out as a cubie reaches the focused layer while its
      // wireframe fades in.
      cells = computeCells(this.cubies, coreFrame, getState, { sideAlpha: sideFloor, centralSolid: !centralWire });
      if (centralWire) segments = computeWireframe(this.cubies, coreFrame, getState, { fade: true });
    } else {
      cells = centralWire ? [] : computeCells(this.cubies, coreFrame, getState);
      if (centralWire && sideWire) segments = computeWireframe(this.cubies, coreFrame, getState);
      else if (centralWire)        segments = computeWireframe(this.cubies, coreFrame, getState, { fade: true });
      else if (sideWire)           segments = computeWireframe(this.cubies, coreFrame, getState, { skipSolid: true });
    }
    if (this.coreWire) {
      const spinCell = frame && frame.type === 'move' ? frame.cellIndex : -1;
      const spinR    = frame && frame.type === 'move' ? frame.R : null;
      segments = segments.concat(computeCoreWireframe(coreFrame, [0, 1, 2, 3, 4, 5, 6, 7], spinCell, spinR));
    }

    const r = this.renderer;
    const canvasRect = this.canvas.getBoundingClientRect();
    r.beginFrame();
    const H = this.canvas.height, dpr = window.devicePixelRatio || 1;
    const rectOf = el => this._glRect(el, canvasRect, dpr, H);

    // Main tesseract view.
    const camDist = MAIN_CAM / this.viewZoom;
    r.drawView(cells, this.viewRot, segments, camDist, rectOf(this.stageEl));
    // 8 cell sub-views — each cell rendered on its own canonical frame (so only its cubies
    // have weight), sharing the same viewRot AND camera distance as the main view (identical
    // perspective), cropped to fill the tile. A sub-view is "central, side = none": it follows
    // the central-cell mode (solid or wireframe) and a cubie sliding out during a neighbour's
    // turn fades to nothing via the same dither.
    for (let i = 0; i < 8; i++) {
      if (centralWire) {
        const seg = computeWireframe(this.cubies, this.subFrames[i], getState, { fade: true });
        r.drawView([], this.viewRot, seg, camDist, rectOf(this.tileEls[i]), SUBVIEW_ZOOM);
      } else {
        const sub = computeCells(this.cubies, this.subFrames[i], getState);
        r.drawView(sub, this.viewRot, null, camDist, rectOf(this.tileEls[i]), SUBVIEW_ZOOM);
      }
    }
  }

  // DOM element → GL device-pixel rect (origin bottom-left), relative to the canvas.
  _glRect(el, canvasRect, dpr, H) {
    const b = el.getBoundingClientRect();
    const w = Math.round(b.width * dpr), h = Math.round(b.height * dpr);
    const x = Math.round((b.left - canvasRect.left) * dpr);
    const y = H - Math.round((b.top - canvasRect.top) * dpr) - h;
    return { x, y, w, h };
  }

  // ── View ─────────────────────────────────────────────────────────────────────

  _composeViewRot() {
    return mat3Mul(mat3AxisRotation(0, this.viewPitch), mat3AxisRotation(1, this.viewYaw));
  }

  orbit(dYaw, dPitch) {
    const maxPitch = Math.PI / 2;
    this.viewYaw += dYaw;
    this.viewPitch = Math.max(-maxPitch, Math.min(maxPitch, this.viewPitch + dPitch));
    this.viewRot = this._composeViewRot();
    this.markDirty();
  }

  zoomBy(factor) {
    this.viewZoom = Math.max(0.5, Math.min(2.2, this.viewZoom * factor));
    this.markDirty();
  }

  resetView() {
    this.viewYaw = DEFAULT_YAW;
    this.viewPitch = Math.PI / 7;
    this.viewZoom = 1.0;
    this.viewRot = this._composeViewRot();
    this.markDirty();
  }

  // ── Centering (stable: always commits the destination's canonical frame) ──────

  selectCentralCell(cellIndex) {
    if (this.anim.isBusy()) return;
    if (cellIndex === this.centralCellIndex && !this.pendingCenter) return;
    this.pendingCenter = {
      fromFrame: cloneFrame(this.coreFrame),
      toFrame: frameForCell(cellIndex),
      toCi: cellIndex,
    };
    this.anim.queueCentralCell(this.centralCellIndex, cellIndex);
    this.centralCellIndex = cellIndex;
    setCenteredTile(cellIndex);
    this.markDirty();
  }

  _onCentralComplete() {
    if (!this.pendingCenter) return;
    this.coreFrame = this.pendingCenter.toFrame;     // commit the exact canonical frame
    this.centralCellIndex = centralFromFrame(this.coreFrame);
    this.pendingCenter = null;
    this.markDirty();
  }

  // ── Turns (only the centred cell; mapped from a screen-plane button) ──────────

  // The twist buttons name a move by SCREEN axes (e0→x, e1→y, e2→z). At rest those
  // map to the centred cell's canonical frame, but the user can yaw the turntable —
  // so a button's "front-left / front-right" face is no longer the canonical one. This
  // returns the frame the buttons should resolve against: the canonical frame with its
  // two HORIZONTAL axes (e0,e2) rotated by the view's nearest yaw quarter-turn (relative
  // to DEFAULT_YAW), so e0 stays on whichever face currently sits in the front-left slot
  // and e2 in the front-right slot. The vertical axis e1 (top) and depth eF are kept —
  // top is deliberately static. It's a proper 90°-quantised rotation, so det stays +1 and
  // every icon-arrow sign convention still holds; at the resting view (k=0) it's exactly
  // the canonical frame. (Swipes don't use this — they read true on-screen geometry.)
  _buttonFrame() {
    const f = frameForCell(this.centralCellIndex);
    let k = Math.round((DEFAULT_YAW - this.viewYaw) / (Math.PI / 2)) % 4;
    if (k < 0) k += 4;
    let e0 = f.e[0], e2 = f.e[2];
    for (let i = 0; i < k; i++) { const t = e0; e0 = e2.map(v => -v); e2 = t; }   // (e0,e2) → (−e2, e0)
    return { e: [e0, f.e[1], e2], eF: f.eF };
  }

  // A twist button names a screen-plane via two indices into the core frame basis
  // (e0→x, e1→y, e2→z) and a direction. Resolve it to the centred cell's concrete
  // (planeName, sign) using `frame` (the buttons pass `_buttonFrame()`; the swipe and
  // anything else default to the canonical frame), so the on-screen spin matches the
  // icon's arrow regardless of which cell is centred or how the view is turned.
  turnScreenPlane(iIdx, jIdx, dir, frame = null) {
    if (this.anim.isBusy()) return;
    const f = frame || frameForCell(this.centralCellIndex);
    const { planeName, sign } = this._screenPlaneMove(f, iIdx, jIdx, dir);
    this.executeMove(this.centralCellIndex, planeName, sign);
  }

  // Rotate a FACE-LAYER of the central cube — i.e. turn the SIDE CELL on that face,
  // the same move family the shuffle uses. `kScreen` is the face-normal screen axis
  // (0/1/2 ↔ e0/e1/e2), `sSide` ±1 which of the two faces. The turn plane is the other
  // two screen axes (so it avoids the depth axis — an ordinary cube face turn).
  turnFace(kScreen, sSide, dir, frame = null) {
    if (this.anim.isBusy()) return;
    const f = frame || frameForCell(this.centralCellIndex);
    const eN = f.e[kScreen];
    const fAxis = nonzeroAxis(eN);
    const ci = CELLS.findIndex(c => c.axis === fAxis && c.val === sSide * Math.sign(eN[fAxis]));
    const [i, j] = [0, 1, 2].filter(k => k !== kScreen);
    const { planeName, sign } = this._screenPlaneMove(f, i, j, dir);
    this.executeMove(ci, planeName, sign);
  }

  // Map a screen-plane (the two screen axes iIdx,jIdx) under frame `f` to a concrete 4D
  // (planeName, sign). `dir=+1` is a right-handed CCW turn about the THIRD screen axis
  // e[k] (k = the missing index), so it matches the icon's arrow. `par` is the parity of
  // (iIdx,jIdx,k): the (0,2) plane is cyclically odd, so without it the Y axis (yaw /
  // top-bottom faces) would come out inverted relative to roll/pitch.
  _screenPlaneMove(f, iIdx, jIdx, dir) {
    const ei = f.e[iIdx], ej = f.e[jIdx];
    const p = nonzeroAxis(ei), si = Math.sign(ei[p]);
    const q = nonzeroAxis(ej), sj = Math.sign(ej[q]);
    const a = Math.min(p, q), b = Math.max(p, q);
    const k = 3 - iIdx - jIdx;
    const par = Math.sign((jIdx - iIdx) * (k - iIdx) * (k - jIdx));
    return { planeName: AXIS_LETTERS[a] + AXIS_LETTERS[b], sign: dir * (p < q ? 1 : -1) * si * sj * par };
  }

  // Turn the MIDDLE layer of the central cube along screen axis `kScreen` (a true
  // middle slice — only the centred cube's middle ring moves; see executeMiddleMove).
  turnMiddle(kScreen, dir, frame = null) {
    if (this.anim.isBusy() || this.anim.moveQueue.length >= 3) return;
    const f = frame || frameForCell(this.centralCellIndex);
    const fAxis = nonzeroAxis(f.e[kScreen]);
    const [i, j] = [0, 1, 2].filter(x => x !== kScreen);
    const { planeName, sign } = this._screenPlaneMove(f, i, j, dir);
    this.anim.queueMiddle(this.cubies, this.centralCellIndex, fAxis, planeName, sign);
    this.redoStack = [];
    this.markDirty();
  }

  // ── Direct manipulation: swipe across the stickers to turn a layer ─────────────

  // The interaction surface: the ≤27 visible stickers of the centred cube, as idealized
  // quads projected to CLIENT pixels through the renderer's exact camera (so they track
  // orientation + zoom). Returns [] while busy — the caller falls back to orbiting.
  centralStickers() {
    if (this.anim.isBusy() || this.pendingCenter) return [];
    const rect = this.stageEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return [];
    const aspect = rect.width / rect.height;
    const fcam = 1 / Math.tan(STICKER_FOV / 2);
    const camDist = MAIN_CAM / this.viewZoom;
    const R = this.viewRot;
    const proj = (p) => {
      const w = mat3MulVec3(R, p);
      const inv = 1 / (camDist - w[2]);                 // perspective divide (clip.w = camDist − z)
      return {
        x: rect.left + (fcam / aspect * w[0] * inv * 0.5 + 0.5) * rect.width,
        y: rect.top  + (0.5 - fcam * w[1] * inv * 0.5) * rect.height,
        zc: camDist - w[2],
      };
    };
    const minArea = rect.width * rect.height * MIN_STICKER_FRAC;
    const out = [];
    // One sticker quad: centre `fc` (projected 3D), face-normal axis `a` (sign `sa`),
    // in-face tangent axes t0/t1 with half-size `half`, logical lattice coord `g`.
    const pushQuad = (fc, a, sa, t0, t1, half, g, cluster) => {
      const nWorld = mat3MulVec3(R, axisVec(a, sa));    // face normal, view-rotated
      const cWorld = mat3MulVec3(R, fc);
      const toCam = [-cWorld[0], -cWorld[1], camDist - cWorld[2]];
      if (nWorld[0]*toCam[0] + nWorld[1]*toCam[1] + nWorld[2]*toCam[2] <= 0) return;  // back-facing
      const poly = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([du, dv]) => {
        const c = fc.slice(); c[t0] += du * half; c[t1] += dv * half;
        return proj(c);
      });
      if (polyArea2(poly) < minArea) return;            // edge-on / too small to target
      out.push({ g, a, sa, t: [t0, t1], poly, zc: proj(fc).zc, c3: fc, cluster });
    };
    const half = STICKER_GRID / 2;                      // half a cell → stickers tile continuously
    for (let a = 0; a < 3; a++) for (const sa of [1, -1]) {
      const [t0, t1] = [0, 1, 2].filter(x => x !== a);
      for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) {
        const g = [0, 0, 0]; g[a] = sa; g[t0] = u; g[t1] = v;
        const fc = [g[0] * STICKER_GRID, g[1] * STICKER_GRID, g[2] * STICKER_GRID];
        fc[a] += sa * half;                             // out to the cube surface
        pushQuad(fc, a, sa, t0, t1, half, g, null);
      }
    }
    return out;
  }

  // Resolve a swipe into a layer turn from the start sticker plus the point `(x, y)` the
  // finger has reached — specifically, which EDGE of the start sticker the swipe exits
  // through. That single piece of information is enough and sidesteps two awkward cases of
  // a "two-sticker" scheme: a swipe that wraps over a cube edge onto another face of the
  // same cubie, and one that runs off into empty space — both still classify cleanly.
  //
  // We express the displacement from the sticker centre in the sticker's own in-face
  // tangent basis (read perspective-correctly off its projected quad): components `a0`,`a1`
  // along +t0,+t1 in cell units. The dominant one is the drag axis; the OTHER tangent is the
  // rotation axis; `start`'s coord along it is the slab; its sign fixes the turn direction so
  // the grabbed sticker travels the way the finger went. Returns true iff a turn was issued.
  applyCentralSwipe(start, x, y) {
    const [t0, t1] = start.t, c = start.poly;
    const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
    const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
    // Screen-space directions of +t0 and +t1 (opposite edge midpoints of the quad).
    const ux = (c[1].x + c[2].x - c[0].x - c[3].x) / 2, uy = (c[1].y + c[2].y - c[0].y - c[3].y) / 2;
    const vx = (c[2].x + c[3].x - c[0].x - c[1].x) / 2, vy = (c[2].y + c[3].y - c[0].y - c[1].y) / 2;
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-6) return false;
    const dx = x - cx, dy = y - cy;
    const a0 = (dx * vy - dy * vx) / det;     // exit component along +t0
    const a1 = (ux * dy - uy * dx) / det;     // exit component along +t1
    const useT0 = Math.abs(a0) >= Math.abs(a1);
    const delta = Math.sign(useT0 ? a0 : a1);
    if (!delta) return false;
    const tIdx = useT0 ? t0 : t1;             // axis the drag ran along
    const r    = useT0 ? t1 : t0;             // rotation axis = the other tangent
    // Drift sign: the sticker's slab rotates rigidly about the r̂ SCREEN axis (through
    // the origin), so its velocity is dir·(r̂ × c3) — pick dir so the component along the
    // dragged tangent matches the finger.
    const cr = cross3v(axisVec(r, 1), start.c3);
    const dirSign = Math.sign(cr[tIdx]);
    if (!dirSign) return false;               // degenerate (never for real stickers)
    const dir = delta * dirSign;
    const slab = start.g[r];
    if (slab === 0) this.turnMiddle(r, dir);
    else this.turnFace(r, slab, dir);
    return true;
  }

  executeMove(cellIndex, planeName, sign) {
    if (this.anim.moveQueue.length >= 3) return;   // queue up to 3 ahead
    this.anim.queueMove(this.cubies, cellIndex, planeName, sign);
    this.redoStack = [];
    this.markDirty();
  }

  _onMoveComplete(descriptor) {
    if (descriptor) {
      this.undoStack.push(descriptor);
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    this.markDirty();
  }

  undo() {
    if (this.anim.isBusy() || this.undoStack.length === 0) return;
    const desc = this.undoStack.pop();
    undoMove(this.cubies, desc);
    this.redoStack.push(desc);
    this.markDirty();
  }

  redo() {
    if (this.anim.isBusy() || this.redoStack.length === 0) return;
    const desc = this.redoStack.pop();
    if (desc.type === 'middle') this.anim.queueMiddle(this.cubies, desc.centralCellIndex, desc.fAxis, desc.planeName, desc.sign);
    else this.anim.queueMove(this.cubies, desc.cellIndex, desc.planeName, desc.sign);
    this.markDirty();
  }

  // ── Presentation settings (central / side / core) ─────────────────────────────

  setCentralMode(mode) {
    if (!CENTRAL_MODES.includes(mode)) return;
    this.centralMode = mode;
    this.markDirty();
  }

  setSideMode(mode) {
    if (!SIDE_MODES.includes(mode)) return;
    this.sideMode = mode;
    this.markDirty();
  }

  setCoreWire(on) {
    this.coreWire = !!on;
    this.markDirty();
  }

  // Keyboard W toggles the central layer between solid and wireframe — the primary
  // visual switch (side/core stay where the menu left them).
  cycleViewMode() {
    this.setCentralMode(this.centralMode === 'solid' ? 'wire' : 'solid');
  }

  setControlSet(set) {
    this.controlSet = set;
    setControlSet(set);                        // module helper: show/hide the button groups
  }
}

// A signed unit 3-vector along one screen axis.
function axisVec(axis, sign) { const v = [0, 0, 0]; v[axis] = sign; return v; }

function cross3v(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

// Twice the signed area of a screen polygon (shoelace) — magnitude only, for thresholding.
function polyArea2(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

function nonzeroAxis(v) {
  let k = 0, best = 0;
  for (let i = 0; i < 4; i++) if (Math.abs(v[i]) > best) { best = Math.abs(v[i]); k = i; }
  return k;
}

function easeInOut(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2; }

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  try {
    window.__app = new App();
  } catch (e) {
    console.error('App failed to start:', e);
    document.body.innerHTML = `<div style="color:red;padding:20px;font-family:monospace">
      <b>Error starting app:</b><br>${e.message}<br><pre>${e.stack}</pre>
    </div>`;
  }
});
