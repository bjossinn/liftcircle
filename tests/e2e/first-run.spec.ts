import { expect, test } from '@playwright/test';

// A brand-new device: nothing in storage, so the first-launch theme picker shows.
test.use({ storageState: { cookies: [], origins: [] }, colorScheme: 'light' });

test('first launch: pick a look, see it applied live, continue into the welcome; it never shows again', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Pick your look' })).toBeVisible();
  const group = page.getByRole('radiogroup', { name: 'Pick your look' });
  // Default: Match my phone (this browser prefers light, so Daylight is what's showing).
  await expect(group.getByRole('radio', { name: 'Match my phone' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await group.getByRole('radio', { name: 'Midnight' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#101215');
  // Targets stay at least 44 px.
  for (const r of await group.getByRole('radio').all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Welcome to LiftCircle')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up my plan' })).toBeVisible();

  // Refresh: straight in, still Midnight, painted before React starts.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Set up my plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pick your look' })).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.goto('/settings');
  await expect(page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Midnight' })).toHaveAttribute('aria-checked', 'true');
});
