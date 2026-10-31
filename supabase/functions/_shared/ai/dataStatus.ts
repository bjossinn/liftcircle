/**
 * Why data is missing, computed by the server (pure). The system prompt gets one line per gap with the exact fix and
 * an in-app link ([[open:/path|label]], validated later by appGuide.validateOpenLinks), so the model can say e.g.
 * "I can't see your nutrition yet. You can share it under training assistant settings." instead of guessing.
 *
 * Order per category: sharing first (the training assistant settings), then setup in the app (Settings toggle, targets,
 * program, logs). For categories that aren't shared only setup *status* is used (on/off, set/not set) — never values.
 */
import type { AccountStatePayload, AiScopes } from './types.ts';

export const SHARE_LINK = '[[open:/coaching/ai/settings|Change what the coach can see]]';

export interface NutritionStatus {
  shared: boolean;
  /** Settings → Nutrition features. null = unknown (no account state). */
  enabled: boolean | null;
  /** Automatic targets switched off (under 18 / individualized): never give numeric targets. */
  autoDisabled: boolean;
  proteinG: number | null;
  kcal: number | null;
  /** Carbs and fat targets present too. */
  macros: boolean;
}

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function nutritionStatus(account: AccountStatePayload | null, shared: boolean): NutritionStatus {
  const n = account?.nutrition;
  const e = account?.settings?.nutritionEnabled;
  const withTargets = !!n && n.mode !== 'none' && !n.autoDisabledReason;
  const energy = withTargets && (n!.mode === 'full' || n!.mode === 'manual') ? pos(n!.calories) : null;
  return {
    shared,
    enabled: typeof e === 'boolean' ? e : null,
    autoDisabled: !!n?.autoDisabledReason,
    proteinG: withTargets ? pos(n!.proteinG) : null,
    kcal: energy,
    macros: withTargets && pos(n!.carbsG) != null && pos(n!.fatG) != null,
  };
}

/** Plain reason a meal plan can't be built right now (null = it can). Used by propose_meal_plan and the prompt. */
export function mealPlanBlocker(s: NutritionStatus): string | null {
  if (!s.shared) return `Nutrition isn't shared with the training assistant. Tell the user they can share it under training assistant settings ${SHARE_LINK}.`;
  if (s.enabled === false) return 'Nutrition features are turned off in the app. Tell the user to turn on "Nutrition features" in Settings → Plan & nutrition [[open:/settings|Open Settings]].';
  if (s.autoDisabled) return 'Automatic nutrition targets are turned off for this user (under 18 or individualized guidance). Do not build a target-based meal plan; suggest a doctor or registered dietitian.';
  if (s.proteinG == null) return 'No protein target is set. Tell the user to set targets first [[open:/nutrition/targets|Set your targets]].';
  return null;
}

export interface DataStatusInput {
  scopes: AiScopes;
  account: AccountStatePayload | null;
  hasPlan: boolean;
  completedWorkouts: number;
  bodyweightEntries: number;
  foodLogDays: number;
}

export function dataStatusLines(i: DataStatusInput): string[] {
  const lines: string[] = [];
  const share = (what: string, fix: string) => lines.push(`- ${what}: NOT shared with you. Say "I can't see your ${fix} yet. You can share it under training assistant settings." and include ${SHARE_LINK}.`);
  if (!i.scopes.profile) share('Profile & preferences (goal, equipment, diet, allergies)', 'profile and preferences');
  if (!i.scopes.training) share('Training (plan, workouts, records)', 'training');
  else {
    if (!i.hasPlan) lines.push('- Training: shared, but there is no program yet. Say so and link [[open:/onboarding|Set up a plan]] — or, if they describe what they want, build one with propose_program_change.');
    if (i.completedWorkouts === 0) lines.push('- Training: no completed workouts logged yet (don\'t invent any).');
  }
  if (!i.scopes.measurements) share('Measurements (bodyweight)', 'measurements');
  else if (i.bodyweightEntries === 0) lines.push('- Measurements: shared, but no bodyweight entries in the last 120 days. They can log them in Progress [[open:/progress|Open Progress]].');

  const n = nutritionStatus(i.account, i.scopes.nutrition);
  const setup: string[] = [];
  if (n.enabled === false) setup.push('"Nutrition features" is turned off in Settings → Plan & nutrition [[open:/settings|Open Settings]]');
  if (n.autoDisabled) setup.push('automatic targets are off for this user (no numeric targets; suggest a dietitian)');
  else if (n.proteinG == null) setup.push('no nutrition targets are set [[open:/nutrition/targets|Set your targets]]');
  if (!n.shared) {
    lines.push(
      `- Nutrition: NOT shared with you. Say "I can't see your nutrition yet. You can share it under training assistant settings." and include ${SHARE_LINK}.` +
        (setup.length ? ` After that, setup is also needed: ${setup.join('; ')} — mention it second.` : ''),
    );
  } else {
    if (setup.length) lines.push(`- Nutrition: shared, but ${setup.join('; ')}. Name the fix and include the link.`);
    else if (!n.macros || n.kcal == null)
      lines.push('- Nutrition: only a protein target is set (no calorie/macro targets). Still help — e.g. a meal plan built for the protein target only — and say so; link [[open:/nutrition/targets|Set your targets]] if they want calories or macros.');
    if (i.foodLogDays === 0) lines.push('- Nutrition: nothing logged in the food log in the last 7 days [[open:/nutrition/log|Open food log]].');
  }
  lines.push('- Check-ins and messages with a human coach are never visible to you (by design). Don\'t offer to read them.');
  return lines;
}
