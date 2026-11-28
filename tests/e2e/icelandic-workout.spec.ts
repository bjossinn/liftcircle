import { expect, test } from '@playwright/test';
import { completeOnboarding } from './helpers';

/**
 * Generated session names are canonical English in storage and shown in Icelandic through the whole workout flow:
 * Train → logger header → summary → History list → history detail. The stored name stays English.
 */
test('Icelandic: a generated session keeps its Icelandic name from start to history detail', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/train');
  const firstRowTitleEn = await page.locator('button[aria-label^="Start "]').first().getAttribute('aria-label');
  const englishName = firstRowTitleEn!.replace(/^Start /, '');
  expect(englishName.length).toBeGreaterThan(0);

  await page.goto('/settings?section=app');
  await page.getByRole('radio', { name: 'Íslenska' }).click();
  await expect(page.getByRole('heading', { name: 'Tungumál og birting' })).toBeVisible();

  await page.goto('/train');
  const startBtn = page.locator('button[aria-label^="Byrja: "]').first();
  const icelandicName = (await startBtn.getAttribute('aria-label'))!.replace(/^Byrja: /, '');
  expect(icelandicName).not.toBe(englishName);
  await startBtn.click();
  await page.waitForURL(/\/train\/session\//);

  // Logger header (text and the rename button's accessible name).
  const header = page.locator('header');
  await expect(header.getByText(icelandicName, { exact: true })).toBeVisible();
  await expect(header.getByText(englishName, { exact: true })).toHaveCount(0);

  await page.getByLabel(/^Þyngd í setti 1/).first().fill('60');
  await page.getByLabel('Endurtekningar í setti 1').first().fill('8');
  await page.getByRole('button', { name: 'Merkja sett 1 sem lokið' }).first().click();
  await page.getByRole('button', { name: 'Ljúka æfingu', exact: true }).first().click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Ljúka æfingu', exact: true });
  await Promise.race([page.waitForURL(/\/train\/summary\//), confirm.click().catch(() => undefined)]);
  await page.waitForURL(/\/train\/summary\//);
  await expect(page.getByText(icelandicName, { exact: true }).first()).toBeVisible();

  await page.goto('/train/history');
  const row = page.getByText(icelandicName, { exact: true }).first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForURL(/\/train\/history\//);
  await expect(page.getByRole('heading', { name: icelandicName })).toBeVisible();
  // The editable name field still holds the stored (English) name.
  await expect(page.getByRole('textbox').first()).toHaveValue(englishName);

  // Renaming the finished workout makes the name the person's own: shown as typed, even when it looks generated.
  const nameField = page.getByRole('textbox').first();
  await nameField.fill('Upper A');
  await nameField.blur();
  await expect(page.getByRole('heading', { name: 'Upper A', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upper A', exact: true })).toBeVisible();
});
