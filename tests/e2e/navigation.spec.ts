import { expect, test } from '@playwright/test';
import { completeOnboarding } from './helpers';

// Four tabs (Today, Train, Coach, Progress) and Profile in the header. Nutrition, Friends and Settings are no longer tabs
// or header icons: Nutrition is reached from Today and Profile, Settings from Profile, and every old link still works.
test('Profile in the header leads to Nutrition and Settings; Today jumps into Nutrition; old links still work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await completeOnboarding(page);

  const main = page.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link')).toHaveText(['Today', 'Train', 'Coach', 'Progress']);
  await expect(main.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');

  // Header: Profile only in the personal version (no Settings gear, no Friends icon).
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Friends' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Profile', exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
  const shortcuts = page.getByRole('navigation', { name: 'Profile shortcuts' });
  await expect(shortcuts.getByRole('link', { name: /Nutrition/ })).toBeVisible();
  await shortcuts.getByRole('link', { name: /Settings/ }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText('Redo setup questions')).toBeVisible();

  await page.goto('/profile');
  await page.getByRole('navigation', { name: 'Profile shortcuts' }).getByRole('link', { name: /Nutrition/ }).click();
  await expect(page).toHaveURL(/\/nutrition$/);

  await page.goto('/');
  await page.getByRole('link', { name: 'Track protein' }).click();
  await expect(page).toHaveURL(/\/nutrition$/);

  for (const path of ['/nutrition/recipes', '/nutrition/log', '/nutrition/targets', '/nutrition/plan']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('This page doesn’t exist')).toHaveCount(0);
  }

  // The Coach tab stays highlighted on human-coaching screens.
  await page.goto('/coaching');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Coach' })).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});
