import { expect, test } from '@playwright/test';

// A brand-new device: nothing in storage. There is no first-launch theme picker any more.
test.use({ storageState: { cookies: [], origins: [] }, colorScheme: 'light' });

test('first launch goes straight into the welcome on Match my phone; the theme is still set in Settings', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Set up my plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pick your look' })).toHaveCount(0);
  // Match my phone: this browser prefers light.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.goto('/settings');
  const appearance = page.getByRole('radiogroup', { name: 'Appearance' });
  await expect(appearance.getByRole('radio', { name: /Match/ })).toHaveAttribute('aria-checked', 'true');
  await appearance.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Refresh: still Dark, painted before React starts, and still no picker.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Set up my plan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pick your look' })).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
