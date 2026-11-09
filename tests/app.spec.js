// End-to-end smoke/robustness tests. There are no unit tests — correctness here is
// "the real app runs, renders, and survives every interaction without console errors."
import { test, expect } from '@playwright/test';

// Load the app, capture any page/console errors, wait until it's interactive.
async function gotoApp(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('/');
  return errors;
}

test('loads without errors', async ({ page }) => {
  const errors = await gotoApp(page);
  expect(errors).toEqual([]);
});
