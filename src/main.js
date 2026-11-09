import { mat3Mul, mat3AxisRotation } from './math4d.js';
import { buildSolvedPuzzle, undoMove, CELLS } from './puzzle.js';
import { computeCells, computeWireframe, computeCoreWireframe,
         frameForCell, cloneFrame, slerpFrame, centralFromFrame } from './projection.js';
import { Renderer } from './renderer.js';
import { AnimationEngine } from './animation.js';
import { Controls, buildCellTiles, setCenteredTile } from './controls.js';

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
    this.anim.queueMove(this.cubies, desc.cellIndex, desc.planeName, desc.sign);
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
