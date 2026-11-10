// Generates the logo + favicon SVGs (assets/): the centred cell "disassembled" as in the
// classic view — a 3×3×3 core with its six sticker sheets pulled out — drawn in a parallel
// (isometric) projection. Zero-dep; re-run after tweaking:  node scripts/make-logo.js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Cell colours (puzzle.js CELLS): the +X core, and the six cells around it.
const C = {
  red: [255, 51, 51], green: [26, 204, 51], blue: [26, 128, 255], yellow: [255, 255, 26],
  white: [230, 230, 230], purple: [204, 26, 230], cyan: [26, 230, 230],
};
const BG = '#0b0b12';
const COS30 = Math.sqrt(3) / 2;
const SHADE = [0.72, 1.0, 0.86];      // lambert-ish per face axis: right, top, left
const BACK_DIM = 0.62;                // the three far sheets sit back in shadow

const proj = ([x, y, z]) => [(x - z) * COS30, -y + (x + z) * 0.5];
const rgb = (c, k) => `rgb(${c.map(v => Math.round(v * k)).join(',')})`;
const num = n => +n.toFixed(3);

// grid: stickers per sheet edge / core cubies per edge · cube: core cubie pitch ·
// cubeSize: core cubie edge · sheet: sticker pitch · tile: sticker edge · dist: how far
// the sheets are pulled out · pad: margin (model units) · radius: tile corner (0–0.5).
export function buildLogo({
  grid = 3, cube = 0.6, cubeSize = 0.38, sheet = 1.0, tile = 0.82, dist = 2.6,
  back = true, pad = 0.45, radius = 0.22,
} = {}) {
  const quads = [];
  const add = (pts, col, k) => quads.push({
    pts, col, k, depth: pts.reduce((s, p) => s + p[0] + p[1] + p[2], 0),
  });
  const idx = Array.from({ length: grid }, (_, i) => i - (grid - 1) / 2);
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  // the quad ⟂ axis `a` centred at `c`, half-extent `h` in its two in-plane axes
  const face = (a, c, h) => CORNERS.map(([su, sv]) => {
    const p = [...c];
    p[(a + 1) % 3] += su * h;
    p[(a + 2) % 3] += sv * h;
    return p;
  });

  for (const i of idx) for (const j of idx) for (const k of idx) {
    for (let a = 0; a < 3; a++) {              // only the 3 camera-facing faces
      const c = [i * cube, j * cube, k * cube];
      c[a] += cubeSize / 2;
      add(face(a, c, cubeSize / 2), C.red, SHADE[a]);
    }
  }
  const sheets = [[0, 1, C.green], [1, 1, C.purple], [2, 1, C.yellow]];
  if (back) sheets.push([0, -1, C.white], [1, -1, C.cyan], [2, -1, C.blue]);
  for (const [a, s, col] of sheets) {
    for (const i of idx) for (const j of idx) {
      const c = [0, 0, 0];
      c[a] = s * dist;
      c[(a + 1) % 3] = i * sheet;
      c[(a + 2) % 3] = j * sheet;
      add(face(a, c, tile / 2), col, s > 0 ? 1 : BACK_DIM);
    }
  }
  quads.sort((p, q) => p.depth - q.depth);     // painter's order along the view axis

  const pts2 = quads.flatMap(q => q.pts.map(proj));
  const R = Math.max(...pts2.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1])))) + pad;
  const paths = quads.map(q =>
    `<path d="M${q.pts.map(p => proj(p).map(num).join(' ')).join('L')}Z" fill="${rgb(q.col, q.k)}"/>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(-R)} ${num(-R)} ${num(2 * R)} ${num(2 * R)}">`,
    `<rect x="${num(-R)}" y="${num(-R)}" width="${num(2 * R)}" height="${num(2 * R)}" rx="${num(2 * R * radius)}" fill="${BG}"/>`,
    ...paths,
    '</svg>',
  ].join('\n') + '\n';
}

// The full mark (README, large sizes) and a one-sticker-per-sheet reduction of the same
// composition that survives 16 px (favicon); the touch icon is full-bleed (iOS rounds it).
export const LOGO = { dist: 3.4, cube: 0.72, cubeSize: 0.5 };
export const FAVICON = { grid: 1, cubeSize: 1.5, tile: 2.6, dist: 2.5, pad: 0.3 };
export const TOUCH_ICON = { ...LOGO, pad: 1.1, radius: 0 };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(fileURLToPath(import.meta.url), '..', '..', 'assets');
  writeFileSync(join(out, 'logo.svg'), buildLogo(LOGO));
  writeFileSync(join(out, 'favicon.svg'), buildLogo(FAVICON));
}
