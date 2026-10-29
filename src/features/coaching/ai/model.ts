/**
 * Pure helpers for the AI coach screens (no React, no network).
 * What each data category sends mirrors the AiScopes contract (src/backend/coachingContract.ts);
 * the server (ai-coach Edge Function) is the authority and builds context only from enabled categories.
 */
import type { AiAvailability, AiMessage, AiScopes, AiSettings, AiUsage, ProgramProposal } from '@/backend/coachingContract';
import type { Program } from '@/domain/types';

/* ------------------------------------------------------------ local keys */
/** Unsent composer text (string). Survives reloads and offline. */
export const AI_DRAFT_KEY = 'ai-draft';
/** The one message that was sent but not confirmed (keeps its id so a retry is idempotent). */
export const AI_PENDING_KEY = 'ai-pending';
/** Last loaded conversation, so it can still be read offline. Cleared with "Clear history". */
export const AI_HISTORY_CACHE_KEY = 'ai-history-cache';
/** Proposal responses applied on this device but not yet recorded on the server. */
export const AI_ACK_QUEUE_KEY = 'ai-proposal-acks';

export const AI_MESSAGE_MAX = 2000;
export const AI_NOTES_MAX = 4000;
export const COACH_MESSAGE_MAX = 4000;

export type AiMode = 'chat' | 'checkin_review';

export interface PendingSend {
  id: string;
  text: string;
  mode: AiMode;
  status: 'sending' | 'failed';
  error?: string;
  createdAt: string;
}

export interface QueuedAck {
  id: string;
  accept: boolean;
  applied?: { programId: string; version: number };
  attempts?: number;
}

export const DEFAULT_SCOPES: AiScopes = { profile: true, training: true, measurements: false, nutrition: false };

/* --------------------------------------------------------- data sharing */
export const SCOPE_INFO: { key: keyof AiScopes; title: string; sends: string }[] = [
  {
    key: 'profile',
    title: 'Profile & preferences',
    sends: 'Your goal, experience, training days and session length, equipment, exercises you excluded, areas to go easy on (body-area names only), and diet preferences and allergies.',
  },
  {
    key: 'training',
    title: 'Training',
    sends: 'Your active plan, recent workouts (dates, exercises, sets, reps and weights) and personal records.',
  },
  {
    key: 'measurements',
    title: 'Measurements',
    sends: 'Your recent bodyweight entries, so it can describe your trend.',
  },
  {
    key: 'nutrition',
    title: 'Nutrition',
    sends: 'Your nutrition targets and recent daily food-log totals (such as protein and calories).',
  },
];

export const ALWAYS_SENT = 'Your messages in this conversation (the most recent ones, for context) and your AI coach notes.';
export const NEVER_SENT = 'Your email, photos, social posts and friends, messages with a human coach, coach notes, and private notes about injuries.';

export function scopesEqual(a: AiScopes, b: AiScopes): boolean {
  return a.profile === b.profile && a.training === b.training && a.measurements === b.measurements && a.nutrition === b.nutrition;
}

/* ------------------------------------------------------------ prompts */
export const SUGGESTED_QUESTIONS = [
  'I can only train twice this week',
  'Help me progress my bench press',
  'Suggest meals that fit my protein target',
  'Review my last two weeks',
];
export const CHECKIN_REVIEW_TEXT = 'Please do a check-in review of my recent training and progress.';

/* ------------------------------------------------------------ errors */
export type AiErrorKind = 'offline' | 'rate_limited' | 'unavailable' | 'disabled' | 'paused' | 'auth' | 'failed';
export interface ClassifiedAiError {
  kind: AiErrorKind;
  message: string;
  reason?: Extract<AiAvailability, { available: false }>['reason'];
  usage?: Partial<AiUsage>;
}

type ErrLike = { code?: unknown; status?: unknown; message?: unknown; reason?: unknown; details?: unknown; usage?: unknown };

function pickUsage(...cands: unknown[]): Partial<AiUsage> | undefined {
  for (const c of cands) {
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      if (o.usage && typeof o.usage === 'object') return o.usage as Partial<AiUsage>;
      if (typeof o.requests === 'number' || typeof o.limitRequests === 'number') return o as Partial<AiUsage>;
    }
  }
  return undefined;
}

/** Map whatever the AI backend threw into something the UI can explain truthfully. */
export function classifyAiError(e: unknown): ClassifiedAiError {
  const err = (e && typeof e === 'object' ? e : {}) as ErrLike;
  const code = typeof err.code === 'string' ? err.code : '';
  const status = typeof err.status === 'number' ? err.status : undefined;
  const msg = typeof err.message === 'string' ? err.message : typeof e === 'string' ? e : '';
  const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
  const reason = (typeof err.reason === 'string' ? err.reason : typeof details.reason === 'string' ? details.reason : undefined) as ClassifiedAiError['reason'];

  if (code === 'network' || /failed to fetch|networkerror|network request failed|load failed|fetch failed|offline/i.test(msg))
    return { kind: 'offline', message: 'You appear to be offline. Your message is kept — try again when you’re connected.' };
  if (code === 'PT429' || code === 'rate_limited' || status === 429)
    return { kind: 'rate_limited', message: msg || 'You’ve reached today’s AI coach limit.', usage: pickUsage(err.usage, err.details) };
  if (code === 'ai_paused' || code === 'paused') return { kind: 'paused', message: 'The AI coach is paused.' };
  if (code === 'consent_required' || (reason as string) === 'consent_required')
    return { kind: 'disabled', message: msg || 'The AI coach’s provider changed. Review and agree again in AI coach setup.' };
  if (code === 'ai_disabled' || code === 'disabled' || reason === 'disabled')
    return { kind: 'disabled', message: 'The AI coach is turned off.' };
  if (code === 'ai_unavailable' || status === 503 || reason === 'not_configured' || reason === 'provider_down')
    return { kind: 'unavailable', reason: reason ?? 'provider_down', message: 'The AI coach is unavailable right now.' };
  if (/not implemented/i.test(msg)) return { kind: 'unavailable', reason: 'backend_missing', message: 'The AI coach isn’t set up on this server yet.' };
  if (code === 'auth' || status === 401) return { kind: 'auth', message: 'Your session has expired. Please sign in again.' };
  return { kind: 'failed', message: msg || 'Couldn’t reach the AI coach. Please try again.' };
}

/** True when the server will never answer (no point showing a chat composer). */
export function isHardUnavailable(a: AiAvailability | undefined): boolean {
  return !!a && !a.available && (a.reason === 'not_configured' || a.reason === 'backend_missing');
}

export function usageLine(u: Partial<AiUsage> | undefined): string | null {
  if (!u || typeof u.requests !== 'number') return null;
  if (typeof u.limitRequests === 'number' && u.limitRequests > 0)
    return `${u.requests} of ${u.limitRequests} messages used today · ${Math.max(0, u.limitRequests - u.requests)} left`;
  return `${u.requests} message${u.requests === 1 ? '' : 's'} today`;
}

/* --------------------------------------------------------- conversation */
/** History plus the locally pending message (dropped once the server has it). */
export function mergeConversation(history: AiMessage[], pending: PendingSend | null): (AiMessage & { pending?: PendingSend })[] {
  const out: (AiMessage & { pending?: PendingSend })[] = [...history];
  if (pending && !history.some((m) => m.id === pending.id)) {
    out.push({ id: pending.id, role: 'user', content: pending.text, createdAt: pending.createdAt, status: pending.status === 'failed' ? 'failed' : 'queued', pending });
  }
  return out;
}

export function upsertMessages(list: AiMessage[], add: AiMessage[]): AiMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of add) byId.set(m.id, m);
  const order = [...list.map((m) => m.id)];
  for (const m of add) if (!order.includes(m.id)) order.push(m.id);
  return order.map((id) => byId.get(id)!);
}

/** On, agreed to, and (when the server says so) agreed for the provider the server uses now. */
export function settingsActive(s: AiSettings | null | undefined, a?: AiAvailability): boolean {
  return !!s && s.enabled && !!s.consentAt && !consentOutdated(s, a);
}

/** The user agreed earlier, but for a different AI provider than the server uses now. */
export function consentOutdated(s: AiSettings | null | undefined, a?: AiAvailability): boolean {
  return !!s?.consentAt && !!a && a.available && a.consentCurrent === false;
}

/** Name of the company that receives AI requests, for consent and data texts. */
export function providerLabel(a: AiAvailability | undefined): string {
  return a && a.available && a.providerName ? a.providerName : 'the AI provider';
}

/* ------------------------------------------------------------- proposals */
export type ProposalView = 'pending' | 'stale' | 'invalid' | 'accepted' | 'declined' | 'closed';

export function liveActive(programs: Program[]): Program | undefined {
  return programs.filter((p) => p.active && !p.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function proposalView(p: ProgramProposal, programs: Program[]): ProposalView {
  if (p.status === 'accepted') return 'accepted';
  if (p.status === 'declined') return 'declined';
  if (p.status === 'withdrawn' || p.status === 'superseded') return 'closed';
  if (p.status === 'invalid' || (p.validationErrors?.length ?? 0) > 0) return 'invalid';
  if (p.baseProgramId) {
    const base = programs.find((x) => x.id === p.baseProgramId && !x.deletedAt);
    if (!base || base.currentVersion !== p.baseVersion) return 'stale';
  }
  return 'pending';
}

export const PROPOSAL_VIEW_LABEL: Record<ProposalView, { label: string; tone: 'accent' | 'neutral' | 'warn' | 'danger' | 'info' }> = {
  pending: { label: 'Ready to review', tone: 'accent' },
  stale: { label: 'Out of date', tone: 'warn' },
  invalid: { label: 'Not applicable', tone: 'danger' },
  accepted: { label: 'Applied', tone: 'info' },
  declined: { label: 'Declined', tone: 'neutral' },
  closed: { label: 'Replaced', tone: 'neutral' },
};

export const STALE_MESSAGE = 'Your plan changed since this suggestion; ask the AI for an updated one.';

export function isCoachManaged(programs: Program[]): boolean {
  return liveActive(programs)?.managedBy?.kind === 'coach';
}

/** Plain-text summary used when the user shares a suggestion with their human coach. */
export function proposalShareText(p: ProgramProposal, describe: string[]): string {
  const lines = [`AI coach suggestion: ${p.program.name}`];
  const changes = p.changeSummary.length ? p.changeSummary : describe;
  for (const c of changes.slice(0, 12)) lines.push(`• ${c}`);
  if (p.message) lines.push('', p.message);
  return clip(lines.join('\n'), COACH_MESSAGE_MAX);
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
