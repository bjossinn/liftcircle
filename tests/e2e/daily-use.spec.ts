import { expect, test, type Page } from '@playwright/test';

/**
 * Roadmap item 11 (daily-use polish), in English and Icelandic:
 * - Food log → Quick protein adds one entry from the Recent landing;
 * - Progress → the first measurement and the first goal from the empty state's "Add a record" actions;
 * - Settings → the five-group index, a group, Back to the index (focus on the row), and a legacy hash.
 */

async function setLanguage(page: Page, language: 'en' | 'is') {
  if (language === 'en') return;
  await page.goto('/settings?section=app');
  await page.getByRole('radio', { name: 'Íslenska' }).click();
  await expect(page.getByRole('heading', { name: 'Tungumál og birting' })).toBeVisible();
}

const COPY = {
  en: {
    quickProtein: 'Add 30 g protein',
    added: /Added: Quick protein · 30 g\./,
    recentAgain: 'Log Quick protein · 30 g again',
    emptyTitle: 'Your progress will appear here',
    addMeasurement: 'Add a measurement',
    save: 'Save',
    groups: ['Language & display', 'Training & nutrition', 'Coach & notifications', 'Sharing & privacy', 'Account & data'],
    back: 'Back',
  },
  is: {
    quickProtein: 'Skrá 30 g af próteini',
    added: /Skráð: Prótein · 30 g\./,
    recentAgain: 'Skrá aftur: Prótein · 30 g',
    emptyTitle: 'Framfarirnar þínar birtast hér',
    addMeasurement: 'Skrá mælingu',
    save: 'Vista',
    groups: ['Tungumál og birting', 'Æfingar og næring', 'Þjálfari og tilkynningar', 'Deiling og persónuvernd', 'Reikningur og gögn'],
    back: 'Til baka',
  },
};

for (const language of ['en', 'is'] as const) {
  const c = COPY[language];

  test(`[${language}] Food log: Quick protein adds one entry from the Recent landing`, async ({ page }) => {
    await setLanguage(page, language);
    await page.goto('/nutrition/log');
    await expect(page.getByRole('tab', { selected: true })).toHaveId('tab-recent');
    await page.getByRole('button', { name: c.quickProtein }).click();
    await expect(page.getByText(c.added)).toBeVisible();
    await expect(page.getByRole('button', { name: c.recentAgain })).toBeVisible();
  });

  test(`[${language}] Progress: first measurement from the empty state`, async ({ page }) => {
    await setLanguage(page, language);
    await page.goto('/progress');
    await expect(page.getByText(c.emptyTitle)).toBeVisible();
    await page.getByRole('button', { name: c.addMeasurement }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').first().fill(language === 'is' ? '80,5' : '80.5');
    await dialog.getByRole('button', { name: c.save, exact: true }).click();
    await expect(page.locator('section[aria-labelledby="p-body"]')).toBeVisible();
    await expect(page.getByText(c.emptyTitle)).toHaveCount(0);
  });

  test(`[${language}] Settings: five groups, a group, Back to the index, legacy hash`, async ({ page }) => {
    await setLanguage(page, language);
    await page.goto('/settings');
    const rows = page.locator('nav a[id^="settings-row-"]');
    await expect(rows).toHaveCount(5);
    for (let i = 0; i < 5; i++) await expect(rows.nth(i)).toContainText(c.groups[i]);
    await rows.nth(1).click();
    await expect(page).toHaveURL(/section=training/);
    await expect(page.getByRole('heading', { name: c.groups[1], level: 2 })).toBeFocused();
    await page.getByRole('button', { name: c.back }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(rows.nth(1)).toBeFocused();
    await page.goto('/settings#appearance-title');
    await expect(page.locator('#appearance-title')).toBeFocused();
    await page.reload();
    await expect(page.locator('#appearance-title')).toBeVisible();
  });
}

test('[en] Progress: first goal from the empty state', async ({ page }) => {
  await page.goto('/progress');
  await page.getByRole('button', { name: 'Add a goal' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(page.locator('section[aria-labelledby="p-goals"]')).toBeVisible();
});
