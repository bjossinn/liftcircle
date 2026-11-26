import { expect, test } from '@playwright/test';
import { completeOnboarding, setName } from './helpers';

test('six questions, about a minute: the plan matches the days, session length and equipment; units follow the locale', async ({ page }) => {
  await page.goto('/onboarding');
  await expect(page.getByText('About a minute', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();

  const titles: string[] = [];
  for (let q = 1; q <= 6; q++) {
    await expect(page.getByText(`Question ${q} of 6`)).toBeVisible();
    titles.push(await page.getByRole('heading', { level: 1 }).innerText());
    if (q === 1) await page.getByRole('radio', { name: /^Improve strength/ }).click();
    if (q === 2) await page.getByRole('radio', { name: /^Intermediate/ }).click();
    if (q === 3) await page.getByRole('group', { name: 'Training days' }).getByRole('checkbox', { name: 'Tue' }).click();
    if (q === 4) await page.getByRole('radio', { name: /^45 minutes/ }).click();
    if (q === 5) await page.getByRole('radio', { name: /^Home gym/ }).click();
    if (q === 6) await page.getByRole('group', { name: 'Limitation areas' }).getByRole('checkbox', { name: 'Knees' }).click();
    await page.getByRole('button', { name: q === 6 ? 'Build my plan' : 'Continue' }).click();
  }
  expect(titles).toEqual(['What’s your main goal?', 'How much have you lifted before?', 'Which days can you train?', 'How long is a workout?', 'Where do you train?', 'Anything to be careful with?']);

  await expect(page.getByRole('heading', { name: 'Your plan', level: 1 })).toBeVisible();
  await expect(page.getByTestId('answers-summary')).toHaveText('Improve strength · Intermediate · Mon, Tue, Wed and Fri · 45 min · Home gym · Careful with knees');
  await page.getByRole('button', { name: 'Save plan, start later' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByRole('button', { name: /Start workout|Log this activity/ })).toBeVisible();

  await page.goto('/train/program');
  await expect(page.getByText(/~\d+ min/).first()).toBeVisible();
  const text = await page.locator('main').innerText();
  const minutes = [...text.matchAll(/~(\d+) min/g)].map((m) => Number(m[1]));
  expect(minutes.length).toBeGreaterThan(0);
  for (const m of minutes) expect(m).toBeLessThanOrEqual(45);

  // The test device is en-US, so weights default to pounds (changeable in Settings).
  await page.goto('/settings');
  await expect(page.getByRole('radiogroup', { name: /weight unit/i }).getByRole('radio', { name: /lb|Pounds/ })).toHaveAttribute('aria-checked', 'true');
});

test('defaults: the greeting uses the name set in Settings; nothing about body or nutrition is asked', async ({ page }) => {
  await page.goto('/onboarding');
  for (let i = 0; i < 8 && !(await page.getByRole('button', { name: 'Save plan, start later' }).count()); i++) {
    await expect(page.getByText(/What should we call you|Current weight|Food preferences|Everyday activity/)).toHaveCount(0);
    await page.getByRole('button', { name: /^(Get started|Continue|Build my plan)$/ }).last().click();
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: 'Save plan, start later' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await setName(page, 'Björn');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Björn$/ })).toBeVisible();
});

test('Accept & start saves the plan and opens its first workout in the logger', async ({ page }) => {
  await page.goto('/onboarding');
  for (let i = 0; i < 10 && !(await page.getByRole('button', { name: 'Accept & start' }).count()); i++) {
    await page.getByRole('button', { name: /^(Get started|Continue|Build my plan)$/ }).last().click();
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: 'Accept & start' }).dblclick(); // a double tap starts one workout
  await page.waitForURL(/\/train\/session\//);
  await expect(page.getByRole('table').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
  // Back on Today the same workout is in progress (not a second one).
  await page.getByRole('button', { name: 'Minimise workout' }).click();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue workout' })).toBeVisible();
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

test('a split chosen on the plan preview survives refresh, shuffling and acceptance', async ({ page }) => {
  await page.goto('/onboarding');
  for (let i = 0; i < 6 && !(await page.getByText('Question 3 of 6').count()); i++) {
    await page.getByRole('button', { name: /^(Get started|Continue)$/ }).last().click();
    await page.waitForTimeout(150);
  }
  // Two training days: Mon and Wed (Fri off).
  await page.getByRole('group', { name: 'Training days' }).getByRole('checkbox', { name: 'Fri' }).click();
  for (let i = 0; i < 6 && !(await page.getByRole('button', { name: 'Build my plan' }).count()); i++) {
    await page.getByRole('button', { name: /^Continue$/ }).last().click();
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: 'Build my plan' }).click();
  await page.getByRole('button', { name: 'Change split' }).click();
  const ul = page.getByRole('dialog').getByRole('radio', { name: /^Upper \/ Lower/ });
  await ul.click();
  await expect(page.getByText('Split:').first()).toBeVisible();
  await expect(page.getByRole('article', { name: 'Upper A' })).toBeVisible();

  await page.waitForTimeout(500); // draft is saved with a short debounce
  await page.reload();
  await expect(page.getByRole('article', { name: 'Upper A' })).toBeVisible();
  await page.getByRole('button', { name: 'Shuffle exercises', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Lower A' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept & start' }).click();
  // Accept & start opens the plan's first workout in the logger.
  await page.waitForURL(/\/train\/session\//);

  await page.goto('/train/program');
  await expect(page.getByText('Upper / Lower', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upper A' })).toBeVisible();
});
