/**
 * Conversation state for follow-ups (pure):
 *  - classifyIntent / isFollowUp: what a user message asks for, and whether it is a short "ok / yes / try now";
 *  - findOpenRequest: the user's most recent request that wasn't fulfilled (no matching action in the reply),
 *    especially one blocked by missing sharing or setup — "try now" resumes it before anything else;
 *  - sharedFromGrounding / sharingChange: which categories were shared when the previous reply was written (from its
 *    stored grounding labels) vs now, so the coach can say "Thanks — I can see your nutrition now" and continue.
 */
import type { AiScopes, StoredMessage } from './types.ts';

export type RequestIntent = 'meal_plan' | 'week_adjustment' | 'program' | 'recipes';
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function classifyIntent(text: string): RequestIntent | null {
  const t = fold(text);
  if (/\bmeal[\s-]?plan|\bplan (my|the|our)?\s*(meals|food|eating)|\bplan meals\b|\bmeals for (the|this|next) week\b/.test(t)) return 'meal_plan';
  if (/\b(only|just) (train|lift|go|make it)\b.*\b(this week|once|twice|\d+ times?)|\bthis week\b.*\b(only|just|can'?t|cannot|miss|skip|move)\b|\b(move|swap|reschedule)\b.*\b(session|workout|day)\b/.test(t)) return 'week_adjustment';
  if (/\b(new|build|make|create|write|design|give me)\b.*\b(program|programme|routine|split|training plan|workout plan)\b|\b(program|programme|routine)\b.*\b(for me|please)\b/.test(t)) return 'program';
  if (/\brecipes?\b|\bmeal ideas?\b|\bwhat (should|can) i (eat|cook|make)\b|\b(breakfast|lunch|dinner|snack) ideas?\b/.test(t)) return 'recipes';
  return null;
}

/** A short reply that refers back to the previous exchange ("ok", "yes do that", "try now", "go ahead"). */
export function isFollowUp(text: string): boolean {
  const t = fold(text).replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8) return false;
  return /^(ok|okay|k|yes|yep|yeah|yup|sure|please|go|go ahead|do it|do that|done|shared|again|now|lets go|let's go|lets do it|let's do it|sounds good|perfect|great)\b/.test(t) ||
    /\btry (it )?(again|now)\b|\b(do|make) it\b|\bgo ahead\b|\bdone now\b|\bshared it\b|\bturned it on\b/.test(t);
}

const BLOCK_RE = /\/coaching\/ai\/settings|\/nutrition\/targets|\[\[open:\/settings|\[\[open:\/onboarding|can['’]t see|cannot see|isn['’]t shared|not shared/i;

export interface OpenRequest {
  text: string;
  intent: RequestIntent;
  blocked: boolean;
}

function fulfilled(intent: RequestIntent, reply: StoredMessage | undefined): boolean {
  if (!reply) return false;
  const kind = (reply.action as { kind?: string } | null | undefined)?.kind;
  switch (intent) {
    case 'meal_plan': return kind === 'meal_plan';
    case 'week_adjustment': return kind === 'week_adjustment';
    case 'program': return !!reply.proposalId;
    case 'recipes': return kind === 'recipe_suggestions' || kind === 'meal_plan' || /\[\[open:\/nutrition\/recipes\//.test(reply.content ?? '');
  }
}

/**
 * The most recent request (within the last 3 user messages that carry an intent) whose reply didn't deliver it.
 * A newer request that WAS delivered closes older ones. `history` is oldest first and excludes the new message.
 */
export function findOpenRequest(history: StoredMessage[]): OpenRequest | null {
  let seen = 0;
  for (let i = history.length - 1; i >= 0 && seen < 3; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const intent = classifyIntent(m.content ?? '');
    if (!intent) continue;
    seen++;
    const reply = history.slice(i + 1).find((x) => x.role === 'assistant');
    if (fulfilled(intent, reply)) return null;
    return { text: m.content.slice(0, 300), intent, blocked: !!reply && BLOCK_RE.test(reply.content ?? '') };
  }
  return null;
}

/** Categories that were shared when a reply was written, from its grounding labels (see context.ts grounding). */
export function sharedFromGrounding(grounding: string[] | undefined): Partial<AiScopes> {
  const g = grounding ?? [];
  return {
    profile: g.includes('Profile & preferences'),
    training: g.some((x) => /recent workouts?$/.test(x) || x.startsWith('Active plan:')),
    measurements: g.includes('Bodyweight trend'),
    nutrition: g.includes('Nutrition targets & 7-day food log'),
  };
}

export const SCOPE_NAMES: Record<keyof AiScopes, string> = { profile: 'profile', training: 'training', measurements: 'measurements', nutrition: 'nutrition' };

/** Newly shared categories, and whether any category was revoked since the previous reply. */
export function sharingChange(prev: Partial<AiScopes>, now: AiScopes): { added: (keyof AiScopes)[]; revoked: boolean } {
  const keys = Object.keys(SCOPE_NAMES) as (keyof AiScopes)[];
  return { added: keys.filter((k) => now[k] && !prev[k]), revoked: keys.some((k) => prev[k] && !now[k]) };
}
