// End-to-end smoke/robustness tests. There are no unit tests — correctness here is
// "the real app runs, renders, and survives every interaction without console errors."
import { test, expect } from '@playwright/test';

// Load the app, capture any page/console errors, wait until it's interactive.
async function gotoApp(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__app);
  await page.waitForTimeout(400);
  return errors;
}

test('loads and renders a non-blank scene', async ({ page }) => {
  const errors = await gotoApp(page);
  // preserveDrawingBuffer is on, so read the last frame straight from the GL context.
  const brightPixels = await page.evaluate(() => {
    const gl = window.__app.renderer.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 80) n++;
    return n;
  });
  expect(brightPixels).toBeGreaterThan(2000);   // the puzzle actually drew
  expect(errors).toEqual([]);
});

test('central-cell switching is stable (returns to the same orientation)', async ({ page }) => {
  await gotoApp(page);
  const stable = await page.evaluate(async () => {
    const a = window.__app;
    const settled = () => new Promise(r => {
      const t = setInterval(() => {
        if (a.anim.isIdle() && !a.shuffling && !a.pendingCenter) { clearInterval(t); r(); }
      }, 25);
    });
    a.anim.speedFactor = 6;
    const start = JSON.stringify(a.coreFrame);     // canonical frame for cell 0 at boot
    for (const c of [5, 2, 7, 0]) { a.selectCentralCell(c); await settled(); }
    return JSON.stringify(a.coreFrame) === start;   // round-trip lands exactly back
  });
  expect(stable).toBe(true);
});

test('twist buttons follow the view: button frame tracks screen slots across yaw', async ({ page }) => {
  const errors = await gotoApp(page);
  const r = await page.evaluate(async () => {
    const a = window.__app;
    const m3v = (m, v) => [m[0]*v[0]+m[3]*v[1]+m[6]*v[2], m[1]*v[0]+m[4]*v[1]+m[7]*v[2], m[2]*v[0]+m[5]*v[1]+m[8]*v[2]];
    const dot4 = (p, q) => p[0]*q[0]+p[1]*q[1]+p[2]*q[2]+p[3]*q[3];
    const DEF = a.viewYaw;                                    // app starts at DEFAULT_YAW
    a.viewYaw = DEF; a.viewRot = a._composeViewRot();
    const canon = a._buttonFrame();                          // k=0 → canonical frame
    const vr0 = a.viewRot.slice();
    const modelDir = v4 => [dot4(v4, canon.e[0]), dot4(v4, canon.e[1]), dot4(v4, canon.e[2])];
    const slotAt = (frame, vr, k) => m3v(vr, modelDir(frame.e[k]));
    const ref = [0, 1, 2].map(k => slotAt(canon, vr0, k));   // resting on-screen slot directions
    const close = (p, q) => Math.max(Math.abs(p[0]-q[0]), Math.abs(p[1]-q[1]), Math.abs(p[2]-q[2])) < 1e-6;

    // Each screen slot must keep projecting to the same on-screen direction as the view yaws,
    // and the top axis (e1) must never move.
    const slots = [];
    for (const dq of [1, 2, 3, -1]) {
      a.viewYaw = DEF + dq*Math.PI/2; a.viewRot = a._composeViewRot();
      const bf = a._buttonFrame();
      slots.push(JSON.stringify(bf.e[1]) === JSON.stringify(canon.e[1])
        && [0, 1, 2].every(k => close(slotAt(bf, a.viewRot, k), ref[k])));
    }

    // Functional: the same "left" button acts on a different cell once the view is yawed 90°.
    const settled = () => new Promise(res => { const t = setInterval(() => { if (a.anim.isIdle() && !a.pendingCenter) { clearInterval(t); res(); } }, 20); });
    a.anim.speedFactor = 6;
    a.viewYaw = DEF; a.viewRot = a._composeViewRot();
    a.turnFace(0, +1, +1, a._buttonFrame()); await settled(); const restCell = a.undoStack.at(-1).cellIndex; a.undo(); await settled();
    a.viewYaw = DEF + Math.PI/2; a.viewRot = a._composeViewRot();
    a.turnFace(0, +1, +1, a._buttonFrame()); await settled(); const yawCell = a.undoStack.at(-1).cellIndex;
    a.viewYaw = DEF; a.viewRot = a._composeViewRot();
    return { slots, restCell, yawCell };
  });
  expect(r.slots).toEqual([true, true, true, true]);   // all quadrants track, top static
  expect(r.yawCell).not.toBe(r.restCell);              // button followed the view
  expect(errors).toEqual([]);
});
