import { expect, test } from '@playwright/test';

test('manifest, icons and service worker are valid', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', name: 'Hard Earned', short_name: 'Hard Earned' });
  expect(m.theme_color).toBeTruthy();
  expect(m.background_color).toBeTruthy();
  const sizes = m.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}:${i.purpose ?? 'any'}`);
  expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
  for (const i of m.icons) expect((await request.get(i.src)).headers()['content-type']).toContain('image/png');
  expect((await request.get('/icons/apple-touch-icon-180.png')).ok()).toBe(true);
  const reg = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(reg).toMatch(/sw\.js$/);
});

test('a previously loaded build opens offline and navigates between screens', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // now controlled by the SW
  await context.setOffline(true);
  for (const [path, heading] of [['/train', 'Train'], ['/progress', 'Progress'], ['/nutrition', 'Nutrition'], ['/train/exercises', 'Exercises'], ['/onboarding', 'Welcome to Hard Earned']] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
  // Recipes and exercises are bundled data, so they work offline too
  await page.goto('/nutrition/recipes');
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
  await context.setOffline(false);
});

test('the service worker never caches Supabase API traffic', async ({ request }) => {
  const sw = await (await request.get('/sw.js')).text();
  expect(sw).not.toMatch(/supabase/i);
  expect(sw).not.toMatch(/registerRoute\([^)]*rest\/v1/);
});

test('first load precaches every build asset before saying "Ready to work offline"', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Ready to work offline')).toBeVisible({ timeout: 20_000 });
  const { expected, cached, foreign } = await page.evaluate(async () => {
    const sw = await (await fetch('/sw.js')).text();
    const expected = [...sw.matchAll(/\{url:"([^"]+)",revision:/g)].map((m) => m[1]);
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) urls.push(new URL(r.url).pathname.replace(/^\//, ''));
    return { expected, cached: urls, foreign: urls.filter((u) => /^https?:/.test(u)) };
  });
  expect(expected.length).toBeGreaterThan(50);
  for (const u of expected) expect(cached, `precached ${u}`).toContain(u);
  expect(foreign).toEqual([]);
});

test('a failed service-worker registration is shown and the tracker keeps working online', async ({ page }) => {
  await page.addInitScript(() => {
    const sw = navigator.serviceWorker;
    if (sw) sw.register = () => Promise.reject(new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (404) was received'));
  });
  await page.goto('/train');
  await expect(page.getByText(/Offline mode couldn’t be set up/)).toBeVisible();
  await expect(page.getByText('Ready to work offline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Empty workout' }).click();
  await expect(page).toHaveURL(/\/train\/session\//);
  await page.getByRole('button', { name: 'Dismiss' }).first().click();
  await expect(page.getByText(/Offline mode couldn’t be set up/)).toHaveCount(0);
});

test('a browser that blocks IndexedDB gets a clear explanation instead of an endless spinner', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
  });
  await page.goto('/train');
  await expect(page.getByRole('alert')).toContainText('isn’t letting Hard Earned save on this device');
  // navigation still works
  await page.getByRole('link', { name: 'Progress' }).click();
  await expect(page).toHaveURL(/\/progress/);
});

test('generated service worker: precache + navigation fallback only; Supabase paths never routed or cached', async ({ request }) => {
  const sw = await (await request.get('/sw.js')).text();
  const routes = [...sw.matchAll(/registerRoute\(/g)].length;
  expect(routes).toBe(1); // the NavigationRoute; no runtime caching routes at all
  expect(sw).toMatch(/NavigationRoute/);
  for (const p of ['auth', 'rest', 'storage', 'functions']) expect(sw).toContain(`/^\\/${p}\\/v1/`);
  expect(sw).not.toMatch(/StaleWhileRevalidate|CacheFirst|NetworkFirst|ExpirationPlugin/);
  // Push handlers come in via importScripts and add no routes or caching of their own.
  expect(sw).toMatch(/importScripts\(["']push-sw\.js["']\)/);
  const push = await request.get('/push-sw.js');
  expect(push.ok()).toBe(true);
  const pushSrc = await push.text();
  for (const ev of ['push', 'notificationclick', 'pushsubscriptionchange']) expect(pushSrc).toContain(`addEventListener('${ev}'`);
  expect(pushSrc).toContain('showNotification');
  expect(pushSrc).not.toMatch(/registerRoute|caches\.|addEventListener\(['"]fetch/);
});
