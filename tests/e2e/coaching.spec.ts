import { expect, test } from '@playwright/test';
import { completeOnboarding } from './helpers';

// This build has no backend configured (personal/offline version). Coaching and the AI coach must say so
// truthfully, never pretend to work, and leave the tracker fully usable (requirements §10 items 11–12).
test('coaching and AI coach show truthful unavailable states and the tracker keeps working', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await completeOnboarding(page);

  await page.getByRole('link', { name: 'Coaching' }).click();
  await expect(page).toHaveURL(/\/coaching$/);
  await expect(page.getByText('Coaching needs the online version')).toBeVisible();

  await page.goto('/coaching/ai');
  await expect(page.getByText('AI coach isn’t set up on this server yet')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0); // no composer that could never send

  for (const path of ['/coaching/find', '/coaching/my', '/coaching/dashboard', '/coaching/admin', '/coaching/admin/reports']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/needs (an account|the online version)/)).toBeVisible();
  }

  // Existing flow still works: start today's/next planned session from Today.
  await page.goto('/');
  await page.getByRole('button', { name: /Start/ }).first().click();
  await expect(page).toHaveURL(/\/train\/session\//);
  expect(errors).toEqual([]);
});
