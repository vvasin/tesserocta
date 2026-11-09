// 4D → 3D projection driven by an explicit CORE FRAME.
//
// The core tesseract's orientation is a 4D frame: three "free" unit axes
// (e0,e1,e2 → screen x,y,z) and a depth axis eF (the central-cell direction).
// A cell turn is an absolute 4D rotation of the affected cubies (it never
// touches the frame). Centering is a 4D rotation of the FRAME (the cubies hold
// still in 4D; only the viewpoint sweeps), giving the inside-out motion for free.
//
// Cubies are drawn as constant-size cubes at depth-nested centres; each face is
// coloured by whichever sticker currently points along that free axis.

import { CELLS } from './puzzle.js';
import { mat4MulVec4, mat4FromCols, mat4Transpose, mat4Mul, mat4Det, so4Slerp } from './math4d.js';

// Cubies are drawn as their OWN little Schlegel tesseract (same projection style as
// the core): inner cell → small central cube, outer cell → big enclosing cube,
// 6 side cells → frustums. CUBE_S is tuned so a side cell's outer face lands ~0.58
// (the cube-face size). PERSP_SLOPE sets the inner/outer size ratio.
export const CUBE_S = 0.41;            // intrinsic half-size of every cubie
const PERSP_SLOPE = 0.42;              // local depth perspective: +depth smaller, −depth bigger
const CUBIE_SHRINK = 0.9;              // inset toward each cell's centroid (kills shared-face z-fight)
const DARK = [0.10, 0.10, 0.13];       // internal (non-sticker) faces

// Per-corner depth perspective for a cubie's local tesseract. Clamped so a
// depth-involving turn can never blow a cell up or invert it.
function cubiePersp(dz) {
  const s = 1 - PERSP_SLOPE * dz;
  return s < 0.3 ? 0.3 : (s > 1.7 ? 1.7 : s);
}

function smoothstep(lo, hi, x) {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

// How much sticker colour a cell shows (solid mode), as a function of its current
// depth facing `df` and its committed (end-of-turn) depth facing `dft`. Comparing the
// two tells us which way the cell is heading, so we can time colour to the collisions
// instead of blacking the whole cubie:
//
//   • side cell, not transitioning (|dft| ≈ |df|): always painted (the S1–S4 group).
//   • HIDING (|dft| > |df|, becoming inner/outer): stay painted, fade out late — it's
//     still side-like through the early part of its slide into depth.
//   • REVEALING (|dft| < |df|, becoming a side cell): stay BLACK until it has emerged,
//     then paint. The outer-side reveal (df<0, the old outer cell breaking through the
//     stationary sides too) paints latest of all.
//
// Net effect: hiders and revealers are never both lit during a crossover, yet the
// stationary sides stay coloured — so the puzzle is never all-black, snaps and all.
const SIDE_FADE_HI = 0.5;              // |df| at/above which a settled cell is black
function sideColorWeight(df) {
  return 1 - smoothstep(0, SIDE_FADE_HI, Math.abs(df));
}
function colorWeight(df, dft) {
  const a = Math.abs(df), at = Math.abs(dft);
  if (at > a + 1e-4) return 1 - smoothstep(0.55, 0.92, a);          // hiding: paint, fade out late
  if (at < a - 1e-4) {                                             // revealing: black, paint late
    const lo = df < 0 ? 0.12 : 0.30, hi = df < 0 ? 0.42 : 0.60;    // outer-side reveal paints latest
    return 1 - smoothstep(lo, hi, a);
  }
  return sideColorWeight(df);                                       // settled / stationary side
}

// Centre radius vs depth (cubies keep constant size, so deeper shells just
// spread out → gaps you can see the inner layers through).
function depthR(w) { return 2.8 - 1.45 * w; }   // w=1→1.35, 0→2.8, −1→4.25

// ── 4D vector helpers ─────────────────────────────────────────────────────────

function dot4(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]; }
function unit4(axis, val) { const v = [0,0,0,0]; v[axis] = val; return v; }
function sub3(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function cross3(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function norm3(v) { const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }

// ── Core frame ────────────────────────────────────────────────────────────────

// Canonical, axis-aligned frame that makes `cellIndex` central. It is forced to be
// right-handed (det +1) so that every cell→cell centering is a PROPER 4D rotation
// with a clean geodesic, and so revisiting a cell always lands on the same
// orientation (the stable-centering guarantee). Swap the last two free axes when the
// naive frame is left-handed.
export function frameForCell(cellIndex) {
  const ax = CELLS[cellIndex].axis, val = CELLS[cellIndex].val;
  const free = [0,1,2,3].filter(a => a !== ax);
  let e = [unit4(free[0], 1), unit4(free[1], 1), unit4(free[2], 1)];
  if (mat4Det(mat4FromCols(e[0], e[1], e[2], unit4(ax, val))) < 0) {
    e = [e[0], e[2], e[1]];
  }
  return { e, eF: unit4(ax, val) };
}

// Frame ↔ column-major 4×4 (columns = e0,e1,e2,eF).
function frameToMat(f) { return mat4FromCols(f.e[0], f.e[1], f.e[2], f.eF); }
function matToFrame(M) {
  return {
    e: [[M[0],M[1],M[2],M[3]], [M[4],M[5],M[6],M[7]], [M[8],M[9],M[10],M[11]]],
    eF: [M[12],M[13],M[14],M[15]],
  };
}

// Geodesic interpolation of the core frame from `fromFrame` to `toFrame` by t∈[0,1].
// Both are signed-permutation frames; the SO(4) geodesic is smooth at every angle
// (including the 180° opposite-cell case) and lands EXACTLY on toFrame at t=1.
export function slerpFrame(fromFrame, toFrame, t) {
  const Mf = frameToMat(fromFrame), Mt = frameToMat(toFrame);
  const Rt = so4Slerp(mat4Mul(Mt, mat4Transpose(Mf)), t);   // world rotation from→to, eased by t
  return matToFrame(mat4Mul(Rt, Mf));
}

export function cloneFrame(f) {
  return { e: f.e.map(v => v.slice()), eF: f.eF.slice() };
}

// Which cell is central for a (rest) frame: the axis eF points along.
export function centralFromFrame(f) {
  let ax = 0, best = 0;
  for (let k = 0; k < 4; k++) if (Math.abs(f.eF[k]) > Math.abs(best)) { best = f.eF[k]; ax = k; }
  const val = best > 0 ? 1 : -1;
  return CELLS.findIndex(c => c.axis === ax && c.val === val);
}

// ── Projection ────────────────────────────────────────────────────────────────

// Project a 4D point through the frame → { pos3:[x,y,z], depth }.
function project(p, frame) {
  const d = dot4(p, frame.eF);
  const R = depthR(d);
  return [dot4(p, frame.e[0]) * R, dot4(p, frame.e[1]) * R, dot4(p, frame.e[2]) * R];
}

function isHidden(pos4) {
  let nz = 0;
  for (let i = 0; i < 4; i++) if (pos4[i] !== 0) nz++;
  return nz < 2;
}

// Free-axis 3D components of a 4D vector (its position in the projected cube).
function freeComps(v, frame) {
  return [dot4(v, frame.e[0]), dot4(v, frame.e[1]), dot4(v, frame.e[2])];
}

// The 6 faces of a box, corner index b = p0|p1<<1|p2<<2 over the 3 perp axes.
const BOX_FACES = [[1,3,7,5],[0,2,6,4],[2,3,7,6],[0,1,5,4],[4,5,7,6],[0,1,3,2]];

// Internal: the 8 projected cell BOXES of one cubie, drawn as the cubie's own
// little Schlegel tesseract (inner small cube, outer big cube, 6 side frustums),
// each inset toward its centroid. color is the sticker colour or null (unused).
//
// The outer cell self-hides: it shares each outer face with a side cell, but its
// centroid is the cubie centre (far from those faces), so the SAME inset pulls its
// faces well inward while the side cells' big faces barely move — the side faces
// win the depth test and the inner/outer cells stay tucked behind them.
function cubieBoxes(cubie, center, orient, frame, targetOrient = orient, classic = null) {
  const cubieC = project(center, frame);
  const colorOf = {};
  for (const sk of cubie.stickers) {
    for (let k = 0; k < 4; k++) if (sk.faceDir[k] !== 0) colorOf[k*2 + (sk.faceDir[k] > 0 ? 0 : 1)] = CELLS[sk.cellIndex].color;
  }

  const boxes = [];
  for (let a = 0; a < 4; a++) for (const s of [1, -1]) {
    const ln = [0,0,0,0]; ln[a] = s;
    const lnw = mat4MulVec4(orient, ln);                        // this cell's outward dir (world)
    const df  = dot4(lnw, frame.eF);                           // current depth facing
    const dft = dot4(mat4MulVec4(targetOrient, ln), frame.eF);  // committed (end-of-turn) depth facing
    const perp = [0,1,2,3].filter(x => x !== a);
    const C8 = new Array(8);
    let cx = 0, cy = 0, cz = 0;
    for (let b = 0; b < 8; b++) {
      const lc = [0,0,0,0]; lc[a] = s;
      lc[perp[0]] = (b & 1) ? 1 : -1;
      lc[perp[1]] = (b & 2) ? 1 : -1;
      lc[perp[2]] = (b & 4) ? 1 : -1;
      const lcw = mat4MulVec4(orient, lc);
      const k = CUBE_S * cubiePersp(dot4(lcw, frame.eF));   // local depth perspective
      const fc = freeComps(lcw, frame);
      C8[b] = [cubieC[0] + k*fc[0], cubieC[1] + k*fc[1], cubieC[2] + k*fc[2]];
      cx += C8[b][0]; cy += C8[b][1]; cz += C8[b][2];
    }
    let ctr = [cx/8, cy/8, cz/8];
    for (let b = 0; b < 8; b++)                            // inset toward cell centre
      C8[b] = [ctr[0]+(C8[b][0]-ctr[0])*CUBIE_SHRINK, ctr[1]+(C8[b][1]-ctr[1])*CUBIE_SHRINK, ctr[2]+(C8[b][2]-ctr[2])*CUBIE_SHRINK];
    boxes.push({ color: colorOf[a*2 + (s > 0 ? 0 : 1)] || null, C8, ctr, df, dft });
  }
  return { cubieC, boxes };
}

// Emit the (camera-facing) quad faces of a cubie's 8 cell boxes into `faces`, at the
// given opacity. Colour each box by its sticker via colorWeight (DARK when unused/
// hidden). Normals point outward from each cell's own centroid so cells self-cull.
function pushBoxFaces(faces, boxes, opacity, classic = null) {
  for (const bx of boxes) {
    const C8 = bx.C8, ctr = bx.ctr;
    const op = opacity;
    if (op <= 0.004) continue;
    const w = bx.color ? colorWeight(bx.df, bx.dft) : 0;
    const color = w <= 0 ? DARK
      : w >= 1 ? bx.color
      : [DARK[0]+(bx.color[0]-DARK[0])*w, DARK[1]+(bx.color[1]-DARK[1])*w, DARK[2]+(bx.color[2]-DARK[2])*w];
    for (let fi = 0; fi < BOX_FACES.length; fi++) {
      const F = BOX_FACES[fi];
      const q = [C8[F[0]], C8[F[1]], C8[F[2]], C8[F[3]]];
      const fcx=(q[0][0]+q[1][0]+q[2][0]+q[3][0])*0.25 - ctr[0];
      const fcy=(q[0][1]+q[1][1]+q[2][1]+q[3][1])*0.25 - ctr[1];
      const fcz=(q[0][2]+q[1][2]+q[2][2]+q[3][2])*0.25 - ctr[2];
      let n = norm3(cross3(sub3(q[1],q[0]), sub3(q[2],q[0])));
      if (n[0]*fcx + n[1]*fcy + n[2]*fcz < 0) n = [-n[0],-n[1],-n[2]];
      faces.push({ color, quad: q, normal: n, opacity: op, sortDepth: 0 });
    }
  }
}

// Solid render: each cubie's cell boxes → outward (camera-facing) quad faces.
export function computeCells(cubies, frame, getState = null, { sideAlpha = 0, centralSolid = true, classic = null } = {}) {
  const faces = [];
  cubies.forEach((cubie, i) => {
    if (isHidden(cubie.pos4)) return;
    const st = getState ? getState(i) : null;
    const center4 = st ? st.center4 : cubie.pos4;
    const opacity = 1;
    // Pass the committed orientation as the target so each cell knows whether it's
    // heading toward the side role (revealing) or toward inner/outer (hiding).
    const { boxes } = cubieBoxes(
      cubie, center4, st ? st.orient : cubie.orient, frame, cubie.orient, classic);
    pushBoxFaces(faces, boxes, opacity, classic);
  });
  return faces;
}
