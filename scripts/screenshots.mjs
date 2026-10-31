// Screenshots of the main screens at 390 px in the dark and light themes, using the demo dataset, plus the first-launch
// picker, the welcome/onboarding step, the install page, an empty state and a dialog.
// Run against a production preview:  npx vite preview --port 4174  then  node scripts/screenshots.mjs [baseURL] [outDir]
// Output: docs/screenshots/hard-earned/<theme>-<nn>-<screen>.png (viewport only, 1x, so the files stay small).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:4174';
const out = process.argv[3] ?? path.join('docs', 'screenshots', 'hard-earned');
fs.mkdirSync(out, { recursive: true });
const VIEWPORT = { width: 390, height: 844 };

async function shot(page, name) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
}

const browser = await chromium.launch();

for (const [label, theme] of [['dark', 'dark'], ['light', 'light']]) {
  let n = 0;
  const s = (page, name) => shot(page, `${label}-${String(++n).padStart(2, '0')}-${name}`);

  // A brand-new device: the first-launch picker (Match my phone, following this browser's light/dark mode).
  {
    const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.getByRole('heading', { name: 'Pick your look' }).waitFor();
    await s(page, 'first-run-picker');
    await ctx.close();
  }

  // A device that picked a theme but has no data yet: welcome/onboarding, an empty state, the install page.
  {
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: theme,
      reducedMotion: 'reduce',
      storageState: { cookies: [], origins: [{ origin: base, localStorage: [{ name: 'lc-theme-picked', value: '1' }, { name: 'lc-theme-choice', value: theme }] }] },
    });
    const page = await ctx.newPage();
    await page.goto(base + '/onboarding');
    await page.getByRole('heading', { name: 'Welcome to Hard Earned' }).waitFor();
    await s(page, 'welcome-onboarding');
    await page.goto(base + '/train/history');
    await page.getByText('Your training history starts with your first workout.').waitFor();
    await s(page, 'empty-history');
    await page.goto(base + '/install');
    await page.getByRole('heading', { name: 'Install the app' }).waitFor();
    await s(page, 'install');
    await ctx.close();
  }

  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: theme,
    reducedMotion: 'reduce', // no celebration or transitions mid-capture
    storageState: { cookies: [], origins: [{ origin: base, localStorage: [{ name: 'lc-theme-picked', value: '1' }, { name: 'lc-theme-choice', value: theme }] }] },
  });
  const page = await ctx.newPage();

  await page.goto(base + '/settings');
  await page.getByRole('button', { name: /Try with demo data/ }).click();
  await page.waitForURL(base + '/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await s(page, 'today');

  // Active workout: start today's (or the next) session, log and tick the first set.
  const start = page.getByRole('button', { name: /^(Start workout|Start a workout)$/ }).first();
  if (await start.count()) await start.click();
  else {
    await page.goto(base + '/train');
    await page.getByRole('button', { name: 'Empty workout' }).click();
  }
  await page.waitForURL(/\/train\/session\//);
  const tick = page.getByRole('button', { name: 'Mark set 1 done', exact: true }).first();
  const addEx = page.getByRole('button', { name: 'Add exercise' }).first();
  await Promise.race([tick.waitFor(), addEx.waitFor()]);
  if (!(await tick.count())) {
    await addEx.click();
    await page.getByRole('dialog').getByRole('searchbox').fill('barbell bench');
    await page.getByRole('dialog').getByText('Barbell bench press', { exact: true }).first().click();
    await tick.waitFor();
  }
  for (const [lbl, value] of [['Set 1 load in kg', '40'], ['Set 1 reps', '8']]) {
    const f = page.getByLabel(lbl, { exact: true }).first();
    if ((await f.count()) && !(await f.inputValue())) {
      await f.fill(value);
      await f.blur();
    }
  }
  await tick.click();
  await page.getByRole('button', { name: /^Set 1 done/ }).first().waitFor();
  await s(page, 'active-workout');

  // Finish → summary.
  await page.getByRole('button', { name: 'Finish', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finish', exact: true }).click();
  await page.waitForURL(/\/train\/summary\//);
  await s(page, 'workout-summary');

  // A dialog: delete a workout (cancelled with "Keep workout").
  await page.goto(base + '/train/history');
  await page.locator('button:has(svg.lucide-dumbbell)').first().click();
  const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
  await del.waitFor();
  await del.click();
  await page.getByRole('dialog').getByText('Delete this workout?').waitFor();
  await s(page, 'dialog-delete-workout');
  await page.getByRole('dialog').getByRole('button', { name: 'Keep workout' }).click();

  await page.goto(base + '/progress');
  await s(page, 'progress');
  const chart = page.locator('figure').first();
  if (await chart.count()) {
    await chart.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -60));
    await s(page, 'progress-chart');
  }
  await page.goto(base + '/nutrition');
  await s(page, 'nutrition');
  await page.goto(base + '/nutrition/recipes');
  await page.locator('a[href^="/nutrition/recipes/"]').first().click();
  await page.waitForURL(/\/nutrition\/recipes\/.+/);
  await s(page, 'recipe');
  await page.goto(base + '/feed');
  await s(page, 'feed');
  await page.goto(base + '/coaching');
  await s(page, 'coaching');
  await page.goto(base + '/coaching/ai');
  await s(page, 'training-assistant');
  await page.goto(base + '/settings');
  await s(page, 'settings');
  await page.locator('#appearance-title').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await s(page, 'settings-appearance');
  await ctx.close();
}
await browser.close();
