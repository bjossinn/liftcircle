import { expect, test } from '@playwright/test';
import { finishWorkout, startEmptyWithBench } from './helpers';

test('unit changes preserve the recorded values exactly', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Pounds' }).click();
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in lb').fill('135');
  await page.getByLabel('Set 1 reps').fill('5');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await finishWorkout(page);
  await expect(page.getByText(/135 lb × 5/)).toBeVisible();
  const summaryUrl = page.url();
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Kilograms' }).click();
  await page.goto(summaryUrl);
  await expect(page.getByText(/61\.2 kg × 5/)).toBeVisible(); // 135 lb = 61.235 kg
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Pounds' }).click();
  await page.goto(summaryUrl);
  await expect(page.getByText(/135 lb × 5/)).toBeVisible(); // not 134.9
});

test('export/import restores usable records without duplicating them', async ({ page }) => {
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in kg').fill('70');
  await page.getByLabel('Set 1 reps').fill('6');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await finishWorkout(page);

  await page.goto('/settings/data');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download full backup/ }).click()]);
  const path = await download.path();

  // Importing into the same data: nothing new
  await page.getByLabel('Choose backup file').setInputFiles(path!);
  await expect(page.getByText(/1 new · 0 already here/)).toHaveCount(0);
  await expect(page.getByText(/0 new · 1 already here/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Wipe the device, then restore
  await page.getByRole('button', { name: /Delete all data on this device/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete everything' }).click();
  await page.waitForURL('/');
  await page.goto('/settings/data');
  await page.getByLabel('Choose backup file').setInputFiles(path!);
  await page.getByRole('button', { name: 'Import selected' }).click();
  await expect(page.getByText(/Restored \d+ record/)).toBeVisible();
  await page.goto('/train/history');
  await expect(page.getByRole('button', { name: /Workout/ })).toHaveCount(1);
});
