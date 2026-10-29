import { expect, test } from '@playwright/test';
import { finishWorkout, startEmptyWithBench } from './helpers';

test('a workout survives reload, navigation, offline use and reopening with the same sets and timer state', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 15_000 }).catch(() => {});
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in kg').fill('60');
  await page.getByLabel('Set 1 reps').fill('10');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await expect(page.getByRole('button', { name: /Set 1 done/ })).toBeVisible();
  const before = await page.getByRole('timer').getAttribute('aria-label');
  expect(before).toMatch(/Rest \d+:\d\d remaining/);
  const url = page.url();
  await page.waitForTimeout(3000); // let real time pass before reopening

  await page.reload();
  await expect(page.getByLabel('Set 1 load in kg')).toHaveValue('60');
  await expect(page.getByRole('button', { name: /Set 1 done/ })).toBeVisible();
  await expect(page.getByLabel('Set 2 load in kg')).toHaveValue('60'); // carried forward
  const after = await page.getByRole('timer').getAttribute('aria-label');
  expect(after).toMatch(/Rest 1:[45]\d remaining/); // recalculated from the stored deadline

  // Navigate away and use the resume bar
  await page.getByRole('button', { name: 'Minimise workout' }).click();
  await page.getByRole('button', { name: /Resume workout/ }).click();
  await expect(page).toHaveURL(url);

  // Offline: keep logging, navigate, reopen
  await context.setOffline(true);
  await page.getByLabel('Set 2 reps').fill('9');
  await page.getByRole('button', { name: 'Mark set 2 done' }).click();
  await expect(page.getByRole('button', { name: /Set 2 done/ })).toBeVisible();
  await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible();
  await page.goto(url);
  await expect(page.getByRole('button', { name: /Set 2 done/ })).toBeVisible();
  await expect(page.getByLabel('Set 2 reps')).toHaveValue('9');
  await context.setOffline(false);

  await finishWorkout(page);
  await expect(page.getByText('Barbell bench press')).toBeVisible();
  await expect(page.getByText(/60 kg × 10/)).toBeVisible();
});

test('editing a historical result updates the workout and is kept', async ({ page }) => {
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in kg').fill('50');
  await page.getByLabel('Set 1 reps').fill('8');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await finishWorkout(page);
  await page.getByRole('button', { name: 'Edit workout' }).click();
  await page.getByLabel('Set 1 reps').fill('12');
  await page.getByLabel('Set 1 reps').blur();
  await page.reload();
  await expect(page.getByLabel('Set 1 reps')).toHaveValue('12');
  await page.goto('/train/history');
  await expect(page.getByText(/Workout/).first()).toBeVisible();
});

test('repeated taps on Finish do not duplicate the workout', async ({ page }) => {
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in kg').fill('40');
  await page.getByLabel('Set 1 reps').fill('5');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await page.getByRole('button', { name: 'Finish', exact: true }).first().click();
  const btn = page.getByRole('dialog').getByRole('button', { name: 'Finish', exact: true });
  await btn.dblclick(); // double tap
  await page.waitForURL(/\/train\/summary\//);
  const count = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const name = dbs.find((d) => d.name === 'liftcircle:guest')!.name!;
    return await new Promise<number>((res) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        const tx = r.result.transaction('sessions');
        const q = tx.objectStore('sessions').getAll();
        q.onsuccess = () => res((q.result as { status: string; deletedAt?: number }[]).filter((s) => s.status === 'completed' && !s.deletedAt).length);
      };
    });
  });
  expect(count).toBe(1);
});

test('a value typed without leaving the field survives an immediate reload (no blur needed)', async ({ page }) => {
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in kg').fill('20');
  await page.getByLabel('Set 1 reps').fill('8');
  await page.getByLabel('Set 1 reps').press('Tab');
  await page.getByLabel('Set 1 load in kg').fill('25'); // field stays focused
  await page.reload(); // immediately, before the debounced write would normally run
  await expect(page.getByLabel('Set 1 load in kg')).toHaveValue('25');
  await page.getByLabel('Set 1 load in kg').fill('22,5'); // decimal comma
  await page.waitForTimeout(800); // debounce
  await page.goto('/train');
  await page.goBack();
  await expect(page.getByLabel('Set 1 load in kg')).toHaveValue('22.5');
});

test('a set with 0 reps cannot be marked done and starts no rest timer', async ({ page }) => {
  await startEmptyWithBench(page);
  await page.getByLabel('Set 1 load in kg').fill('20');
  await page.getByLabel('Set 1 reps').fill('0');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await expect(page.getByText('Enter at least 1 rep').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark set 1 done' })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(page.getByLabel('Set 2 reps')).toHaveValue('');
  await page.getByLabel('Set 1 reps').fill('5');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await expect(page.getByRole('button', { name: /Set 1 done/ })).toBeVisible();
});

test('swapping an untouched rep exercise for a timed one switches the set fields to seconds', async ({ page }) => {
  await page.goto('/train');
  await page.getByRole('button', { name: 'Empty workout' }).click();
  await page.waitForURL(/\/train\/session\//);
  await page.getByRole('button', { name: 'Add exercise' }).first().click();
  await page.getByRole('dialog').getByRole('searchbox').fill('prone floor');
  await page.getByRole('dialog').getByText('Prone floor pulldown', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Options for Prone floor pulldown' }).click();
  await page.getByRole('button', { name: 'Swap exercise' }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill('plank');
  await page.getByRole('dialog').getByText('Plank', { exact: true }).first().click();
  await expect(page.getByLabel('Set T1 duration in seconds')).toBeVisible();
  await expect(page.getByLabel('Set T1 reps')).toHaveCount(0);
});
