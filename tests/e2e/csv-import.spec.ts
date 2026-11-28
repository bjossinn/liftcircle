import { expect, test } from '@playwright/test';
import { join } from 'node:path';

const FIXTURES = join(process.cwd(), 'tests/unit/fixtures/import');

test('Strong CSV import: preview, import into history, re-import adds nothing', async ({ page }) => {
  await page.goto('/settings/data');
  await expect(page.getByRole('heading', { name: 'Import from Strong or Hevy' })).toBeVisible();
  await page.getByLabel('Choose Strong or Hevy CSV file').setInputFiles(join(FIXTURES, 'strong.csv'));

  const preview = page.getByTestId('workout-import-preview');
  await expect(preview.getByText('Strong export: 2 workouts · 18 sets')).toBeVisible();
  await expect(preview.getByText('Matched to your exercises (8)')).toBeVisible();
  await expect(preview.getByText('New custom exercises (2)')).toBeVisible();
  await expect(preview.getByText('Landmine Press')).toBeVisible();
  await expect(preview.getByText('2 new workouts will be added.')).toBeVisible();
  await preview.getByRole('radio', { name: 'Kilograms' }).click();

  await preview.getByRole('button', { name: 'Import 2 workouts' }).click();
  await expect(page.getByText('Imported 2 workouts')).toBeVisible();
  await expect(preview).toHaveCount(0);

  await page.goto('/train/history');
  await expect(page.getByText('Push Day').first()).toBeVisible();
  await expect(page.getByText('Pull Day').first()).toBeVisible();

  // The same file again: nothing new to add.
  await page.goto('/settings/data');
  await page.getByLabel('Choose Strong or Hevy CSV file').setInputFiles(join(FIXTURES, 'strong.csv'));
  await expect(page.getByText('Everything in this file has already been imported. Nothing new to add.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0);
});

test('Hevy CSV import shows no unit question and rejects other files', async ({ page }) => {
  await page.goto('/settings/data');
  const input = page.getByLabel('Choose Strong or Hevy CSV file');
  await input.setInputFiles({ name: 'weights.csv', mimeType: 'text/csv', buffer: Buffer.from('date,kind,value\n2024-01-01,bodyweight,80\n') });
  await expect(page.getByRole('alert')).toHaveText('This file doesn’t look like a Strong or Hevy CSV export. Nothing was imported.');

  await input.setInputFiles(join(FIXTURES, 'hevy.csv'));
  const preview = page.getByTestId('workout-import-preview');
  await expect(preview.getByText('Hevy export: 2 workouts · 12 sets')).toBeVisible();
  await expect(preview.getByText('Weights in this file are in')).toHaveCount(0);
  await preview.getByRole('button', { name: 'Import 2 workouts' }).click();
  await expect(page.getByText('Imported 2 workouts')).toBeVisible();
  await page.goto('/train/history');
  await expect(page.getByText('Upper A').first()).toBeVisible();
});
