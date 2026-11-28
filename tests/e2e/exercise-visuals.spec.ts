import { expect, test, type Page } from '@playwright/test';
import { startEmptyWithBench } from './helpers';

/** Every <img> in the locator area has loaded a real image (no broken images). */
async function expectImagesLoaded(page: Page, selector: string) {
  await expect
    .poll(() => page.$$eval(selector, (imgs) => imgs.length > 0 && (imgs as HTMLImageElement[]).every((i) => i.complete && i.naturalWidth > 0)))
    .toBe(true);
}

test('exercise detail shows one start/end illustration with alt text and technique cues, no attribution', async ({ page }) => {
  await page.goto('/train/exercises/barbell-back-squat');
  const visual = page.getByTestId('exercise-visual');
  await expect(visual.getByRole('img', { name: 'Barbell back squat – start and end position' })).toBeVisible();
  await expectImagesLoaded(page, '[data-testid="exercise-illustration"] img');
  await expect(visual.getByRole('img')).toHaveCount(1);
  await expect(visual.getByRole('button')).toHaveCount(0);
  await expect(visual.getByRole('link')).toHaveCount(0);
  await expect(visual.getByRole('heading', { name: 'Key points' })).toBeVisible();
  await expect(visual.getByTestId('exercise-cues').getByRole('listitem')).toHaveCount(4);
  await expect(visual.getByTestId('exercise-cues')).toContainText('Brace your core before each rep');
  // The old English-only "Cues" block isn't repeated below for library exercises.
  await expect(page.getByRole('heading', { name: 'Cues', exact: true })).toHaveCount(0);
});

test('lists and the picker show movement-pattern tiles, never the photo thumbnails', async ({ page }) => {
  const thumbRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('thumb.webp')) thumbRequests.push(r.url());
  });
  await page.goto('/train/exercises?tab=all');
  const row = page.locator('a[href="/train/exercises/barbell-back-squat"]');
  await expect(row.getByTestId('exercise-glyph-tile').locator('svg[data-pattern="squat"][data-glyph="barbell_squat"]')).toBeVisible();
  // Each library exercise shows its own glyph, not just its movement pattern's.
  await expect(page.locator('a[href="/train/exercises/push-up"] svg[data-glyph="push_up"]')).toBeVisible();
  await expect(page.locator('a[href="/train/exercises/chest-supported-dumbbell-row"] svg[data-glyph="chest_supported_row"]')).toBeVisible();
  await expect(page.locator('a[href="/train/exercises/dumbbell-lateral-raise"] svg[data-glyph="lateral_raise"]')).toBeVisible();
  await expect(page.locator('a[href^="/train/exercises/"] img')).toHaveCount(0);
  const box = await row.getByTestId('exercise-glyph-tile').boundingBox();
  expect(Math.round(box!.width)).toBe(44);
  // The picker in the logger uses the same rows.
  await page.goto('/train');
  await page.getByRole('button', { name: 'Empty workout' }).click();
  await page.waitForURL(/\/train\/session\//);
  await page.getByRole('button', { name: 'Add exercise' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox').fill('pull-up');
  await expect(dialog.getByTestId('exercise-glyph-tile').first()).toBeVisible();
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(thumbRequests).toEqual([]);
  // Opening an exercise still shows the full illustration.
  await page.goto('/train/exercises/barbell-back-squat');
  await expectImagesLoaded(page, '[data-testid="exercise-illustration"] img');
  await expect(page.locator('[data-testid="exercise-illustration"] img')).toHaveAttribute('src', /full\.webp$/);
});

test('every library exercise’s full image and thumbnail are served as WebP', async ({ page, request }) => {
  await page.goto('/train/exercises?tab=all');
  // The ids come from the library list itself (one row link per exercise).
  await expect(page.locator('a[href^="/train/exercises/"]')).toHaveCount(105);
  const hrefs = await page.locator('a[href^="/train/exercises/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!.split('/').pop()!));
  expect(new Set(hrefs).size).toBe(105);
  for (const id of new Set(hrefs)) {
    for (const f of ['full.webp', 'thumb.webp']) {
      const res = await request.get(`/exercise-media/v2/${decodeURIComponent(id)}/${f}`);
      expect(res.status(), `${id}/${f}`).toBe(200);
      expect(res.headers()['content-type'], `${id}/${f}`).toContain('image/webp');
    }
  }
});

test('the logger thumbnail expands the illustration and the viewed images work offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => void (await navigator.serviceWorker.ready));
  await page.reload(); // controlled by the service worker from here on
  await startEmptyWithBench(page);
  const thumb = page.getByRole('button', { name: 'Show how to do Barbell bench press' });
  await expect(thumb).toBeVisible();
  // Compact row: the Direction B pattern tile, not the photo thumbnail.
  await expect(thumb.getByTestId('exercise-glyph-tile').locator('svg[data-pattern="horizontal_push"][data-glyph="bench_press"]')).toBeVisible();
  await expect(thumb.locator('img')).toHaveCount(0);
  // Fixed-size thumbnail: no layout shift when it loads.
  const box = await thumb.boundingBox();
  expect(Math.round(box!.width)).toBe(44);
  expect(Math.round(box!.height)).toBe(44);

  await thumb.click();
  await expect(page.getByRole('button', { name: 'Hide how to do Barbell bench press' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('exercise-illustration')).toBeVisible();
  await expectImagesLoaded(page, '[data-testid="exercise-illustration"] img');
  await expect(page.getByTestId('exercise-cues').getByRole('listitem')).toHaveCount(4);

  // Viewed illustrations land in the bounded runtime cache (and nothing from /exercise-media/ was precached).
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open('exercise-media-v2')).keys()).map((r) => new URL(r.url).pathname)))
    .toEqual(expect.arrayContaining(['/exercise-media/v2/barbell-bench-press/full.webp']));
  // Thumbnails are no longer requested anywhere in the app.
  expect(
    (await page.evaluate(async () => (await (await caches.open('exercise-media-v2')).keys()).map((r) => r.url))).filter((u) => u.includes('thumb.webp')),
  ).toEqual([]);
  const precached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) if (name.includes('precache')) for (const r of await (await caches.open(name)).keys()) urls.push(r.url);
    return urls;
  });
  expect(precached.length).toBeGreaterThan(50);
  expect(precached.filter((u) => u.includes('/exercise-media/'))).toEqual([]);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Show how to do Barbell bench press' }).click();
  await expectImagesLoaded(page, '[data-testid="exercise-illustration"] img');
  await context.setOffline(false);
});
