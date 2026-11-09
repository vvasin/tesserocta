import { mat3Mul, mat3AxisRotation } from './math4d.js';
import { buildSolvedPuzzle, undoMove } from './puzzle.js';
import { computeCells,
         frameForCell, cloneFrame, slerpFrame, centralFromFrame } from './projection.js';
import { Renderer } from './renderer.js';
import { AnimationEngine } from './animation.js';

const DEFAULT_YAW  = -Math.PI / 5.5;         // resting turntable yaw; also the reference the twist
                                             // buttons orient against (their icons read right here)
const MAIN_CAM     = 15;                      // camera distance at zoom 1 (main view default)

class App {
  constructor() {
    this.cubies = buildSolvedPuzzle();
    this.centralCellIndex = 0;
    this.coreFrame = frameForCell(this.centralCellIndex);    // explicit 4D core orientation
    this.pendingCenter = null;                 // active centering { fromFrame, toFrame, toCi }

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

    window.addEventListener('resize', () => this.markDirty());
    window.addEventListener('orientationchange', () => this.markDirty());

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

    const cells = computeCells(this.cubies, coreFrame, getState);

    const r = this.renderer;
    const canvasRect = this.canvas.getBoundingClientRect();
    r.beginFrame();
    const H = this.canvas.height, dpr = window.devicePixelRatio || 1;
    const rectOf = el => this._glRect(el, canvasRect, dpr, H);

    // Main tesseract view.
    const camDist = MAIN_CAM / this.viewZoom;
    r.drawView(cells, this.viewRot, null, camDist, rectOf(this.stageEl));
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
