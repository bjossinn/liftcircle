import { expect, test, type Page } from '@playwright/test';

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

test('opening an exercise from a scrolled library starts at the top; Back restores the list position', async ({ page }) => {
  await page.goto('/train/exercises?tab=all');
  const rows = page.locator('a[href^="/train/exercises/"]');
  await expect(rows).toHaveCount(105);
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(400);
  const listY = await scrollY(page);

  await last.click();
  await expect(page).toHaveURL(/\/train\/exercises\/[^/?]+$/);
  // The URL changes before the lazily loaded detail page commits (router transition): wait for the detail page itself.
  await expect(page.getByTestId('exercise-visual')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  expect(await scrollY(page)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();

  await page.goBack();
  await expect(page).toHaveURL(/\/train\/exercises\?tab=all$/);
  await expect.poll(async () => Math.abs((await scrollY(page)) - listY)).toBeLessThanOrEqual(40);
  await expect(last).toBeInViewport();
});

test('typing in the library search keeps the scroll position (search-only URL updates do not reset it)', async ({ page }) => {
  await page.goto('/train/exercises?tab=all');
  await expect(page.locator('a[href^="/train/exercises/"]')).toHaveCount(105);
  // Scrolled a little, with the search field still on screen (so typing doesn't scroll it into view).
  await page.evaluate(() => window.scrollTo(0, 40));
  await expect.poll(() => scrollY(page)).toBe(40);
  await expect(page.getByRole('searchbox')).toBeInViewport({ ratio: 1 });
  await page.getByRole('searchbox').evaluate((el) => (el as HTMLInputElement).focus({ preventScroll: true }));
  await page.keyboard.type('a');
  await expect(page).toHaveURL(/[?&]q=a\b/);
  // Still a long list, so nothing clamps: the position is unchanged.
  expect(await page.locator('a[href^="/train/exercises/"]').count()).toBeGreaterThan(40);
  expect(await scrollY(page)).toBe(40);
});

test('/settings?section=app still lands on its heading, directly and from the index', async ({ page }) => {
  await page.goto('/settings?section=app');
  await expect(page.locator('#settings-group-app')).toBeInViewport();
  await expect(page.locator('#settings-group-app')).toBeFocused();

  await page.goto('/settings');
  await page.locator('a[href="/settings?section=app"]').click();
  await expect(page).toHaveURL(/\/settings\?section=app$/);
  await expect(page.locator('#settings-group-app')).toBeInViewport();
  await expect(page.locator('#settings-group-app')).toBeFocused();
});
