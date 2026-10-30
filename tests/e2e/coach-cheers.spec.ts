import { expect, test } from '@playwright/test';
import { startEmptyWithBench } from './helpers';

test('coach cheers: a popup on ✓, a rest-over popup naming the next set, and silence once switched off', async ({ page }) => {
  await startEmptyWithBench(page);
  const cheer = page.locator('[data-coach-cheer]');

  await page.getByLabel('Set 1 load in kg').fill('60');
  await page.getByLabel('Set 1 reps').fill('10');
  await page.getByRole('button', { name: 'Mark set 1 done' }).click();
  await expect(cheer).toHaveCount(1);
  await expect(cheer).toHaveAttribute('role', 'status');
  // The popup never sits over the set "Done" buttons.
  const pop = (await cheer.boundingBox())!;
  const done = (await page.getByRole('button', { name: 'Mark set 2 done' }).boundingBox())!;
  expect(pop.x + pop.width).toBeLessThanOrEqual(done.x);
  await cheer.click(); // tap to dismiss
  await expect(cheer).toHaveCount(0);

  // Run the rest timer down: the popup names the next set, from the stored deadline.
  await expect(page.getByRole('timer')).toBeVisible();
  // The rest bar re-renders every 250 ms, so dispatch the click instead of waiting for a stable element.
  const minus = page.getByRole('button', { name: 'Subtract 15 seconds' });
  for (let i = 0; i < 20 && (await minus.count()); i++) await minus.dispatchEvent('click').catch(() => undefined);
  await expect(cheer).toContainText(/Rest’s up, Barbell bench press set 2: 60 kg/);

  // Logger menu → switch cheers off → no popup on the next ✓.
  await page.getByRole('button', { name: 'Workout options' }).click();
  await page.getByRole('switch', { name: 'Coach cheers during workouts' }).click();
  await expect(page.getByRole('switch', { name: 'Coach cheers during workouts' })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mark set 2 done' }).click();
  await expect(page.getByText('Set logged')).toBeVisible();
  await expect(cheer).toHaveCount(0);
});
