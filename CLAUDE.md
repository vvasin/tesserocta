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
- `scripts/serve.js` — zero-dep static dev server (sets ESM MIME types). `tests/` — Playwright specs. `playwright.config.js`, `eslint.config.js`, `package.json` — infra.

