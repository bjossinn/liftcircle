import { expect, test, type Page } from '@playwright/test';

/**
 * Responsive / accessibility checks on the production build at phone, tablet and desktop widths.
 * (Contrast of the theme tokens is computed separately; real keyboards/safe areas need devices — docs/DEVICE_CHECKS.md.)
 */
const WIDTHS = [360, 375, 390, 430, 768, 1280];
const ROUTES = ['/', '/train', '/feed', '/nutrition', '/progress', '/coaching', '/settings', '/train/exercises', '/nutrition/recipes', '/train/history'];

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test('no horizontal scrolling on key screens at 360–1280 px, and the six tabs fit', async ({ page }) => {
  test.setTimeout(180_000);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w >= 768 ? 1024 : 780 });
    for (const r of ROUTES) {
      await page.goto(r);
      await page.waitForLoadState('networkidle');
      expect(await overflow(page), `${r} @ ${w}px`).toBeLessThanOrEqual(0);
    }
    const tabs = page.getByRole('navigation', { name: 'Main' }).getByRole('link');
    await expect(tabs).toHaveCount(6);
    for (const box of await tabs.evaluateAll((els) => els.map((e) => ({ h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, clipped: e.scrollWidth > e.clientWidth + 1 })))) {
      expect(box.h).toBeGreaterThanOrEqual(44);
      expect(box.w).toBeGreaterThanOrEqual(44);
      expect(box.clipped).toBe(false);
    }
  }
});

test('workout screen: long names wrap, numeric inputs use the decimal keypad, nothing overflows at 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/train');
  await page.getByRole('button', { name: 'Empty workout' }).click();
  await page.waitForURL(/\/train\/session\//);
  await page.getByRole('button', { name: 'Add exercise' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName(/exercise/i);
  await dialog.getByRole('searchbox').fill('triceps extension');
  await dialog.getByText('Overhead dumbbell triceps extension', { exact: true }).first().click();
  await expect(page.getByText('Overhead dumbbell triceps extension').first()).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const load = page.getByLabel(/Set 1 load/);
  await expect(load).toHaveAttribute('inputmode', 'decimal');
  await expect(page.getByLabel('Set 1 reps')).toHaveAttribute('inputmode', 'numeric');
  const fs = await load.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(fs).toBeGreaterThanOrEqual(16); // < 16 px makes iOS zoom the page on focus
});

test('sheets: named dialog, Escape closes and focus returns to the trigger', async ({ page }) => {
  await page.goto('/train');
  await page.getByRole('button', { name: 'Empty workout' }).click();
  await page.waitForURL(/\/train\/session\//);
  const trigger = page.getByRole('button', { name: 'Add exercise' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/./);
  // focus is inside the dialog
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await trigger.evaluate((e) => e === document.activeElement)).toBe(true);
});

test('compact shared controls still have ≥ 44 px touch targets', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('[role="radio"]').first()).toBeVisible();
  const probes = await page.evaluate(() => {
    const out: { name: string; h: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[role="radio"], [role="switch"]')) {
      el.scrollIntoView({ block: 'center' }); // hit-testing only works inside the viewport
      const b = el.getBoundingClientRect();
      if (!b.height) continue;
      // measure the tappable height by hit-testing above and below the visible box
      let top = b.top;
      while (top > b.top - 12 && document.elementFromPoint(b.left + b.width / 2, top - 1)?.closest('[role="radio"], [role="switch"]') === el) top--;
      let bottom = b.bottom;
      while (bottom < b.bottom + 12 && document.elementFromPoint(b.left + b.width / 2, bottom)?.closest('[role="radio"], [role="switch"]') === el) bottom++;
      out.push({ name: el.textContent?.trim() || el.getAttribute('aria-label') || el.id, h: bottom - top });
    }
    return out;
  });
  expect(probes.length).toBeGreaterThan(5);
  for (const p of probes) expect(p.h, p.name).toBeGreaterThanOrEqual(43);
});

test('reduced motion turns animations and transitions off', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/settings');
  const d = await page.locator('[role="switch"]').first().evaluate((e) => getComputedStyle(e).transitionDuration);
  expect(parseFloat(d)).toBeLessThanOrEqual(0.0001);
  await ctx.close();
});

test('skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/train');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
});
