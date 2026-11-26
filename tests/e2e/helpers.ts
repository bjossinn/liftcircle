import type { Page } from '@playwright/test';

/**
 * Walk the six onboarding questions with defaults (Mon/Wed/Fri, 60 min, gym) and save the plan without starting a
 * workout ("Save plan, start later"), landing on Today. "Accept & start" (straight into the logger) is covered in
 * onboarding.spec.ts. Onboarding doesn't ask for a name; pass `name` to set it in Settings afterwards.
 */
export async function completeOnboarding(page: Page, name?: string) {
  await page.goto('/onboarding');
  for (let i = 0; i < 12; i++) {
    const later = page.getByRole('button', { name: 'Save plan, start later' });
    if (await later.count()) {
      await later.click();
      await page.waitForURL((u) => u.pathname === '/');
      if (name) await setName(page, name);
      return;
    }
    await page.getByRole('button', { name: /^(Get started|Continue|Build my plan)$/ }).last().click();
    await page.waitForTimeout(150);
  }
  throw new Error('Onboarding did not finish');
}

/** Set the private display name (Settings → Your name) and return to Today. */
export async function setName(page: Page, name: string) {
  await page.goto('/settings');
  const input = page.getByLabel('Your name (private)');
  await input.fill(name);
  await input.blur();
  await page.waitForTimeout(200);
  await page.goto('/');
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
