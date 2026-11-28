import { expect, test, type Page } from '@playwright/test';
import { startEmptyWithBench } from './helpers';

/** Every <img> in the locator area has loaded a real image (no broken images). */
async function expectImagesLoaded(page: Page, selector: string) {
  await expect
    .poll(() => page.$$eval(selector, (imgs) => imgs.length > 0 && (imgs as HTMLImageElement[]).every((i) => i.complete && i.naturalWidth > 0)))
    .toBe(true);
}

test('exercise detail shows the illustration with alternating frames, alt text and the licence credit', async ({ page }) => {
  await page.goto('/train/exercises/barbell-back-squat');
  const fig = page.getByTestId('exercise-illustration');
  await expect(fig).toBeVisible();
  await expect(fig.getByRole('img', { name: 'Barbell back squat: start position' })).toBeVisible();
  await expectImagesLoaded(page, '[data-testid="exercise-illustration"] img');
  await expect(fig.getByRole('img', { name: 'Barbell back squat: end position' })).toBeAttached({ timeout: 4000 });
  await fig.getByRole('button', { name: 'Pause animation' }).click();
  await expect(fig.getByRole('button', { name: 'Play animation' })).toHaveAttribute('aria-pressed', 'true');
  await expect(fig.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/');
});

test('reduced motion shows the start and end frames side by side without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/train/exercises/barbell-bench-press');
  const fig = page.getByTestId('exercise-illustration');
  await expect(fig.getByRole('img', { name: 'Barbell bench press: start position' })).toBeVisible();
  await expect(fig.getByRole('img', { name: 'Barbell bench press: end position' })).toBeVisible();
  await expect(fig.getByRole('button')).toHaveCount(0);
});

test('an exercise without an illustration shows the glyph placeholder and no image', async ({ page }) => {
  await page.goto('/train/exercises/kettlebell-swing');
  await expect(page.getByRole('heading', { name: 'Kettlebell swing' })).toBeVisible();
  await expect(page.getByTestId('exercise-illustration')).toHaveCount(0);
  // The header keeps the movement-pattern glyph; any images on the page (substitution thumbnails) load fine.
  await expect(page.getByRole('heading', { name: 'Kettlebell swing' }).locator('xpath=ancestor::div[2]').locator('svg').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expectImagesLoaded(page, 'img');
});

test('the logger thumbnail expands the illustration and the viewed images work offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => void (await navigator.serviceWorker.ready));
  await page.reload(); // controlled by the service worker from here on
  await startEmptyWithBench(page);
  const thumb = page.getByRole('button', { name: 'Show how to do Barbell bench press' });
  await expect(thumb).toBeVisible();
  await expectImagesLoaded(page, '[data-testid="exercise-thumb"] img');
  // Fixed-size thumbnail: no layout shift when it loads.
  const box = await thumb.boundingBox();
  expect(Math.round(box!.width)).toBe(44);
  expect(Math.round(box!.height)).toBe(44);

  await thumb.click();
  await expect(page.getByRole('button', { name: 'Hide how to do Barbell bench press' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('exercise-illustration')).toBeVisible();
  await expectImagesLoaded(page, '[data-testid="exercise-illustration"] img');

  // Viewed illustrations land in the bounded runtime cache (and nothing from /exercise-media/ was precached).
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open('exercise-media-v1')).keys()).map((r) => new URL(r.url).pathname)))
    .toEqual(expect.arrayContaining(['/exercise-media/v1/ek-0042/0.webp', '/exercise-media/v1/ek-0042/1.webp', '/exercise-media/v1/ek-0042/thumb.webp']));
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
