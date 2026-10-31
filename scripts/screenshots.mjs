// Screenshots of the main screens at 390 px in both themes, using the demo dataset, plus the first-launch picker.
// Run against a production preview:  npx vite preview --port 4174  then  node scripts/screenshots.mjs [baseURL] [outDir]
// Output: docs/screenshots/<version>/<theme>-<nn>-<screen>.png (viewport only, 1x, so the files stay small).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:4174';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const out = process.argv[3] ?? path.join('docs', 'screenshots', pkg.version);
fs.mkdirSync(out, { recursive: true });
const VIEWPORT = { width: 390, height: 844 };

async function shot(page, name) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
}

const browser = await chromium.launch();

// First-launch picker: default (Match my phone, phone in light mode) and after tapping Midnight.
{
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.getByRole('heading', { name: 'Pick your look' }).waitFor();
  await shot(page, 'picker-1-match-my-phone');
  await page.getByRole('radio', { name: 'Midnight' }).click();
  await shot(page, 'picker-2-midnight-selected');
  await ctx.close();
}

for (const [label, theme] of [['midnight', 'dark'], ['daylight', 'light']]) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: theme,
    reducedMotion: 'reduce', // no confetti or transitions mid-capture
    storageState: { cookies: [], origins: [{ origin: base, localStorage: [{ name: 'lc-theme-picked', value: '1' }, { name: 'lc-theme-choice', value: theme }] }] },
  });
  const page = await ctx.newPage();
  let n = 0;
  const s = (name) => shot(page, `${label}-${String(++n).padStart(2, '0')}-${name}`);

  await page.goto(base + '/settings');
  await page.getByRole('button', { name: /Try with demo data/ }).click();
  await page.waitForURL(base + '/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await s('today');

  await page.goto(base + '/train');
  await s('train');

  // Active workout: start today's (or the next) session, tick the first set.
  await page.goto(base + '/');
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
  for (const [label, value] of [['Set 1 load in kg', '40'], ['Set 1 reps', '8']]) {
    const f = page.getByLabel(label, { exact: true }).first();
    if ((await f.count()) && !(await f.inputValue())) {
      await f.fill(value);
      await f.blur();
    }
  }
  await tick.click();
  await page.getByRole('button', { name: /^Set 1 done/ }).first().waitFor();
  await s('active-workout');

  // Finish → summary.
  await page.getByRole('button', { name: 'Finish', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Finish', exact: true }).click();
  await page.waitForURL(/\/train\/summary\//);
  await s('workout-summary');

  await page.goto(base + '/progress');
  await s('progress');
  await page.goto(base + '/nutrition');
  await s('nutrition');
  await page.goto(base + '/nutrition/plan');
  const gen = page.getByRole('button', { name: 'Generate a week plan' });
  if (await gen.count()) {
    await gen.click();
    await page.waitForTimeout(800);
  }
  await s('meal-plan');
  await page.goto(base + '/nutrition/recipes');
  await page.locator('a[href^="/nutrition/recipes/"]').first().click();
  await page.waitForURL(/\/nutrition\/recipes\/.+/);
  await s('recipe');
  await page.goto(base + '/feed');
  await s('feed');
  await page.goto(base + '/coaching');
  await s('coaching');
  await page.goto(base + '/coaching/ai');
  await s('ai-chat');
  await page.goto(base + '/settings');
  await s('settings');
  await page.locator('#appearance-title').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await s('settings-appearance');
  await ctx.close();
}
await browser.close();
