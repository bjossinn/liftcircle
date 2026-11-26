/**
 * Conversation state for follow-ups (pure):
 *  - classifyIntent / isFollowUp: what a user message asks for, and whether it is a short "ok / yes / try now";
 *  - findOpenRequest: the user's most recent request that wasn't fulfilled (no matching action in the reply),
 *    especially one blocked by missing sharing or setup — "try now" resumes it before anything else;
 *  - sharedFromGrounding / sharingChange: which categories were shared when the previous reply was written (from its
 *    stored grounding labels) vs now, so the coach can say "Thanks — I can see your nutrition now" and continue.
 */
import type { AiScopes, StoredMessage } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { classifyRequest, tokensOf } from './requestSignals.ts';
// @ts-ignore see above
import { foldIs, IS_VOCAB } from './isLexicon.ts';

export type RequestIntent = 'meal_plan' | 'week_adjustment' | 'program' | 'recipes';
const fold = foldIs;
const REQUEST_INTENTS: readonly string[] = ['meal_plan', 'week_adjustment', 'program', 'recipes'];

/**
 * The request a message makes that the coach can resume later (meal plan, this week's schedule, a new program, recipes),
 * English or Icelandic. Built on requestSignals.classifyRequest — the same classifier meals.asksForMealPlan uses — so a
 * question about an existing plan ("Hvar finn ég matseðilinn minn?") or a negated one ("Ekki búa til matseðil ennþá",
 * "Ég vil ekki nýja æfingaáætlun") is never a request to create or replace it.
 */
export function classifyIntent(text: string): RequestIntent | null {
  const kind = classifyRequest(text);
  return kind && REQUEST_INTENTS.includes(kind) ? (kind as RequestIntent) : null;
}
export { classifyRequest };

/* ------------------------------------------------------------------ short follow-ups */
const phrases = (xs: readonly string[]) => xs.map((x) => tokensOf(x)).filter((p) => p.length);
const FU = IS_VOCAB.follow_up;
/** Cancel / not now / no — checked first: "Já, en ekki gera það ennþá" is not approval. */
const NEGATIVE = phrases([...FU.negative, 'bíddu', 'hættu', 'prófaðu ekki', 'reyndu ekki', 'ekki reyna', 'ekki ennþá', 'not now', 'not yet', "don't", 'do not', 'cancel', 'stop', 'wait', 'hold on', 'never mind']);
/** Affirmatives that are the WHOLE message, or lead into a retry/continue ("Allt í lagi hjá mér" is just "I'm fine"). */
const AFFIRM = phrases(FU.affirm);
/** "Try again / now", "go on", and "I turned sharing on": a request to resume, anywhere in a short message. */
const RESUME = phrases([...FU.retry, ...FU.sharingChanged, 'haltu áfram', 'reyndu aftur', 'prófaðu aftur', 'kveikti á því', 'kveikti á þessu', 'búinn að kveikja', 'búin að kveikja',
  'búinn að deila', 'búin að deila', 'búið að deila', 'gerðu það', 'gerðu þetta']);
const startsWith = (t: string[], p: string[]) => p.every((w, k) => t[k] === w);
const contains = (t: string[], p: string[]) => t.some((_, i) => p.every((w, k) => t[i + k] === w));

/** A short reply that refers back to the previous exchange ("ok", "yes do that", "try now", "go ahead"). */
export function isFollowUp(text: string): boolean {
  const t = fold(text).replace(/[^a-zæðþ\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8) return false;
  const w = tokensOf(text);
  // Negative or cancelling words win over a leading "já" / "ok" (and "nei" anywhere means no).
  if (w.includes('nei') || w[0] === 'no' || w[0] === 'nope' || NEGATIVE.some((p) => contains(w, p)) || /(?:^| )ekki (?:gera|profa|reyna|nuna)/.test(t)) return false;
  if (RESUME.some((p) => contains(w, p))) return true;
  // Icelandic affirmatives: the whole message ("Endilega.", "Já, takk.", "Ókei"), or "já" + anything that isn't negative.
  const aff = AFFIRM.find((p) => startsWith(w, p));
  if (aff && (aff.length === w.length || w[0] === 'ja' || w[0] === 'jæja' || (w.length === aff.length + 1 && w[w.length - 1] === 'takk'))) return true;
  return /^(ok|okay|k|yes|yep|yeah|yup|sure|please|go|go ahead|do it|do that|done|shared|again|now|lets go|let's go|lets do it|let's do it|sounds good|perfect|great)\b/.test(t) ||
    /\btry (it )?(again|now)\b|\b(do|make) it\b|\bgo ahead\b|\bdone now\b|\bshared it\b|\bturned it on\b/.test(t) ||
    // Icelandic (folded: accents dropped, æ/ð/þ kept): "já", "já takk", "endilega", "gerðu það", "prófaðu núna", "búið".
    // Plain "takk" / "thanks" is gratitude, not "do it", so it is deliberately not here.
    /^(ja|jæja|okei|oki|endilega|gjorðu svo vel|gerðu það|ja takk)(?![a-zæðþ])/.test(t) ||
    /(?<![a-zæðþ])(profaðu|reyndu|profa) (aftur|nuna)|(?<![a-zæðþ])gerðu það|(?<![a-zæðþ])(buið|buinn|buin) (að )?(deila|kveikja)|(?<![a-zæðþ])kveikti a/.test(t);
}

/* ------------------------------------------------------------------ tiredness */
const FAT = IS_VOCAB.fatigue;
const FATIGUE_TOKENS = new Set([...FAT.tokens, ...Object.keys(FAT.typographicalAliases), 'lufin', 'lufinn', 'útkeyrð', 'útkeyrður'].map(fold));
const FATIGUE_PHRASES = phrases([...FAT.phrases, 'litla orku', 'enga orku', 'litla sem enga orku']);
/** "þreytt á kjúklingi", "leið á þessum mat", "tired of chicken": fed up with something, not low on energy. */
const BOREDOM = /(?:^| )(?:þreytt[a-zæðþ]* a|leið(?:ur|ar|ir)? a|komin(?:n)? með leið a|komið nog af)(?: |$)|\b(?:tired|sick|bored) of\b|\bfed up with\b/;
const EN_TIRED = /\b(?:tired|exhausted|wiped(?: out)?|drained|knackered|shattered|worn out|burn(?:t|ed) out|no energy|sleepy|fatigued?|low on energy|slept badly|barely slept)\b/;
const NEG_BEFORE = /(?:^| )(?:ekki|alls ekki|not|never|isn't|aren't|am not|i'm not|im not)(?: [a-zæðþ']+)?$/;

/**
 * The user says they're tired (EN/IS), clause by clause: a food-boredom clause ("þreytt á kjúklingi") or a negated one
 * ("Ég er ekki þreyttur") doesn't count, but another clause in the same message still does ("…og líka orkulaus í dag").
 * Context alone (night shifts, a baby) isn't tiredness. Tiredness is never treated as a weak reason: see SYSTEM_RULES rule 9.
 */
export function mentionsTiredness(text: string): boolean {
  const parts = fold(text).split(/[.,;:!?\n]+|(?<![a-zæðþ])(?:og|en|and|but)(?![a-zæðþ])/);
  for (const part of parts) {
    const c = part.replace(/\s+/g, ' ').trim();
    if (!c || BOREDOM.test(c)) continue;
    const w = tokensOf(c);
    const at = w.findIndex((x) => FATIGUE_TOKENS.has(x) || /^(?:þreytt|orþreytt)/.test(x));
    if (at >= 0 && !NEG_BEFORE.test(w.slice(Math.max(0, at - 3), at).join(' '))) return true;
    if (FATIGUE_PHRASES.some((p) => contains(w, p))) return true;
    const en = EN_TIRED.exec(c);
    if (en && !NEG_BEFORE.test(c.slice(0, en.index).trimEnd())) return true;
  }
  return false;
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
    // Delivered by ANY later reply closes it — including one that answered a follow-up ("já, prófaðu núna") after a
    // blocked first reply. Otherwise it stays open, blocked if the latest reply was a missing-data message.
    const replies = history.slice(i + 1).filter((x) => x.role === 'assistant');
    if (replies.some((r) => fulfilled(intent, r))) return null;
    const last = replies.at(-1);
    return { text: m.content.slice(0, 300), intent, blocked: !!last && BLOCK_RE.test(last.content ?? '') };
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

/**
 * Messages from before the latest sharing change that may be carried over (oldest first, at most `max`). Walks back from
 * the newest and stops at — and leaves out — the first assistant reply whose grounding used a category that isn't
 * shared NOW (or whose grounding is unknown), together with everything older: a revoked category's content never
 * re-enters the model's history, even after a later, unrelated widening (share → revoke → share something else).
 */
export function carryOver(pre: StoredMessage[], now: AiScopes, max = 6): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = pre.length - 1; i >= 0 && out.length < max; i--) {
    const m = pre[i];
    if (m.role === 'assistant') {
      if (!Array.isArray(m.grounding)) break;
      const used = sharedFromGrounding(m.grounding);
      if ((Object.keys(SCOPE_NAMES) as (keyof AiScopes)[]).some((k) => used[k] && !now[k])) break;
    }
    out.push(m);
  }
  return out.reverse();
}

/** Newly shared categories, and whether any category was revoked since the previous reply. */
export function sharingChange(prev: Partial<AiScopes>, now: AiScopes): { added: (keyof AiScopes)[]; revoked: boolean } {
  const keys = Object.keys(SCOPE_NAMES) as (keyof AiScopes)[];
  return { added: keys.filter((k) => now[k] && !prev[k]), revoked: keys.some((k) => prev[k] && !now[k]) };
}
