import type { Page } from '@playwright/test';

/**
 * Walk the onboarding wizard with defaults (3 lifting days, full gym, 60 min) and save the plan without starting a
 * workout ("Save plan, start later"), landing on Today. "Accept & start" (straight into the logger) is covered in
 * onboarding.spec.ts.
 */
export async function completeOnboarding(page: Page, name = 'Tester') {
  await page.goto('/onboarding');
  for (let i = 0; i < 20; i++) {
    const step = await page.getByText(/Step \d+ of \d+/).innerText().catch(() => '');
    if (step.startsWith('Step 2')) await page.getByLabel('What should we call you?').fill(name);
    const later = page.getByRole('button', { name: 'Save plan, start later' });
    if (await later.count()) {
      await later.click();
      await page.waitForURL((u) => u.pathname === '/');
      return;
    }
    await page.getByRole('button', { name: /^(Get started|Continue|Build my plan)$/ }).last().click();
    await page.waitForTimeout(150);
  }
  throw new Error('Onboarding did not finish');
}

export async function startEmptyWithBench(page: Page) {
  await page.goto('/train');
  await page.getByRole('button', { name: 'Empty workout' }).click();
  await page.waitForURL(/\/train\/session\//);
  await page.getByRole('button', { name: 'Add exercise' }).first().click();
  await page.getByRole('dialog').getByRole('searchbox').fill('barbell bench');
  await page.getByRole('dialog').getByText('Barbell bench press', { exact: true }).first().click();
}

/** Tap Finish; confirm in the sheet when it asks (it doesn't when every working set is already done). */
export async function finishWorkout(page: Page) {
  await page.getByRole('button', { name: 'Finish', exact: true }).first().click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Finish', exact: true });
  await Promise.race([page.waitForURL(/\/train\/summary\//), confirm.click().catch(() => undefined)]);
  await page.waitForURL(/\/train\/summary\//);
}
