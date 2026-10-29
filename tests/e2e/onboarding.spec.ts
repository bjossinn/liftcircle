import { expect, test } from '@playwright/test';
import { completeOnboarding } from './helpers';

test('new user completes onboarding and gets a schedule matching days, equipment and session length', async ({ page }) => {
  await completeOnboarding(page, 'Björn');
  await expect(page.getByRole('heading', { name: 'Hi, Björn' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start workout|Log this activity/ })).toBeVisible();

  await page.goto('/train/program');
  // Default answers: 3 lifting days, every weekday available, 60 minutes, full gym.
  const week = page.getByText(/Full body [ABC]/);
  await expect(week.first()).toBeVisible();
  const text = await page.locator('main').innerText();
  const minutes = [...text.matchAll(/~(\d+) min/g)].map((m) => Number(m[1]));
  expect(minutes.length).toBeGreaterThan(0);
  for (const m of minutes) expect(m).toBeLessThanOrEqual(60);
});

test('a user can skip nutrition and still use the complete tracker', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/nutrition');
  await expect(page.getByText('Nutrition is optional')).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: /Start workout/ }).click();
  await expect(page).toHaveURL(/\/train\/session\//);
  await expect(page.getByRole('table').first()).toBeVisible();
});

test('an explicit split choice survives refresh, review, shuffling and acceptance', async ({ page }) => {
  await page.goto('/onboarding');
  for (let i = 0; i < 12 && !(await page.getByText('Workout split', { exact: true }).count()); i++) {
    const step = await page.getByText(/Step \d+ of \d+/).innerText();
    if (step.startsWith('Step 2')) await page.getByLabel('What should we call you?').fill('Split');
    await page.getByRole('button', { name: /^(Get started|Continue)$/ }).last().click();
    await page.waitForTimeout(150);
  }
  await page.getByRole('radiogroup', { name: 'Lifting days per week' }).getByRole('radio', { name: '2', exact: true }).click();
  const ul = page.getByRole('radio', { name: /^Upper \/ Lower/ });
  await ul.click();
  await expect(ul).toHaveAttribute('aria-checked', 'true');

  await page.waitForTimeout(500); // draft is saved with a short debounce
  await page.reload();
  await expect(page.getByRole('radio', { name: /^Upper \/ Lower/ })).toHaveAttribute('aria-checked', 'true');

  for (let i = 0; i < 12 && !(await page.getByRole('button', { name: 'Build my plan' }).count()); i++) {
    await page.getByRole('button', { name: /^Continue$/ }).last().click();
    await page.waitForTimeout(150);
  }
  await expect(page.getByText('Upper / Lower', { exact: true }).first()).toBeVisible(); // review row
  await page.getByRole('button', { name: 'Build my plan' }).click();
  await expect(page.getByText('Split:').first()).toBeVisible();
  await expect(page.getByRole('article', { name: 'Upper A' })).toBeVisible();
  await page.getByRole('button', { name: 'Shuffle exercises', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Lower A' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept & start' }).click();
  await page.waitForURL((u) => u.pathname === '/');

  await page.goto('/train/program');
  await expect(page.getByText('Upper / Lower', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upper A' })).toBeVisible();
});
