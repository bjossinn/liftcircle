import { expect, test, type Page } from '@playwright/test';
import { completeOnboarding, startEmptyWithBench } from './helpers';

/**
 * Direction B icons: every icon-only control has a ≥ 44×44 CSS px hit area (its box, or its box extended by the
 * invisible ::after hit target from components/ui.tsx), and generated program sessions get distinct marks.
 */
async function smallIconControls(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], [role="button"]')) {
      if ((el.textContent ?? '').trim()) continue; // has a visible text label
      if (!el.querySelector('svg')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue; // not rendered
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || el.closest('[hidden], dialog:not([open]), [aria-hidden="true"]')) continue;
      let w = r.width;
      let h = r.height;
      const a = getComputedStyle(el, '::after');
      if (a.content !== 'none' && a.position === 'absolute') {
        const px = (v: string) => (v.endsWith('px') ? parseFloat(v) : 0);
        w = Math.max(w, r.width - px(a.left) - px(a.right));
        h = Math.max(h, r.height - px(a.top) - px(a.bottom));
      }
      if (w < 43.5 || h < 43.5) out.push(`${el.getAttribute('aria-label') ?? el.outerHTML.slice(0, 80)} ${Math.round(w)}×${Math.round(h)}`);
    }
    return out;
  });
}

test('icon-only buttons on the main screens have at least a 44×44 px hit area', async ({ page }) => {
  await completeOnboarding(page);
  for (const path of ['/', '/train', '/train/program', '/train/exercises', '/train/exercises/barbell-back-squat', '/train/history', '/progress', '/settings', '/coach']) {
    await page.goto(path);
    await page.waitForTimeout(400);
    expect(await smallIconControls(page), path).toEqual([]);
  }
  // Header back button: 44 px box with a 24 px chevron.
  await page.goto('/train/exercises/barbell-back-squat');
  const back = page.getByRole('button', { name: 'Back' });
  const box = await back.boundingBox();
  expect(Math.round(box!.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
  const chevron = await back.locator('svg').boundingBox();
  expect(Math.round(chevron!.width)).toBe(24);
  // The logger (action buttons per set and exercise).
  await startEmptyWithBench(page);
  expect(await smallIconControls(page), 'logger').toEqual([]);
  // Bottom tab bar stays (no hamburger menu); tab icons are 24 px.
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Train' })).toBeVisible();
  const tabIcon = await nav.getByRole('link', { name: 'Train' }).locator('svg').first().boundingBox();
  expect(Math.round(tabIcon!.width)).toBe(24);
});

test('every generated session in the plan has its own mark (Full body A/B/C)', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/train');
  const marks = page.getByTestId('session-mark');
  await expect(marks.first()).toBeVisible();
  const keys = await marks.evaluateAll((els) => els.map((e) => e.getAttribute('data-session-mark')));
  expect(keys.length).toBeGreaterThanOrEqual(3);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toEqual(expect.arrayContaining(['full_body:A', 'full_body:B', 'full_body:C']));
  await expect(page.getByTestId('session-mark-letter')).toHaveText(['A', 'B', 'C']);
});
