/**
 * Pure helpers for the training assistant screens (no React, no network).
 * What each data category sends mirrors the AiScopes contract (src/backend/coachingContract.ts);
 * the server (ai-coach Edge Function) is the authority and builds context only from enabled categories.
 */
import type { AiAvailability, AiMessage, AiScopes, AiSettings, AiUsage, ProgramProposal } from '@/backend/coachingContract';
import type { CoachStyle, Program } from '@/domain/types';
import { getLanguage, hasKey, listText, locale, t, tp, type MessageKey } from '@/i18n';
import type { CoachRequest } from './workoutContext';

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
  /**
   * The contextual request this message came from (entry points in the logger and summary). The workout snapshot is
   * rebuilt from the device right before every send (and Retry), and only while Training is shared.
   */
  request?: CoachRequest;
  /**
   * Parts of `text` the app generated for a contextual request ([start, end) offsets), so they can be removed if
   * Training sharing is turned off; the rest is what the user wrote.
   */
  generated?: [number, number][];
  status: 'sending' | 'failed';
  /** Why it wasn't sent: a message key (stable). Older builds stored English text (see pendingErrorText). */
  error?: string;
  createdAt: string;
  /** The account that wrote it (1.0.3): never sent under another signed-in account. */
  userId?: string;
  /**
   * The reply was stopped and the server confirmed it (item 10). The id is spent: sending the text again (Retry) is a
   * deliberate new request with a new id.
   */
  stopped?: boolean;
}

export interface QueuedAck {
  id: string;
  accept: boolean;
  applied?: { programId: string; version: number };
  attempts?: number;
}

export const DEFAULT_SCOPES: AiScopes = { profile: true, training: true, measurements: false, nutrition: false };

/* --------------------------------------------------------- data sharing */
/** Display labels are localized on read (the keys are stable scope IDs). */
export const SCOPE_INFO: { readonly key: keyof AiScopes; readonly title: string; readonly sends: string }[] = (['profile', 'training', 'measurements', 'nutrition'] as const).map((key) => ({
  key,
  get title() {
    return t(`ai.scope.${key}`);
  },
  get sends() {
    return t(`ai.scope.${key}.description`);
  },
}));

/** Scope display labels as a localized list ("Profile & preferences and Training" / "Prófíll og óskir og Æfingar"). */
export function scopeListText(keys: (keyof AiScopes)[], lower = false): string {
  return listText(keys.map((k) => {
    const title = t(`ai.scope.${k}`);
    return lower ? title.toLocaleLowerCase(locale()) : title;
  }));
}

export const alwaysSentText = () => t('ai.data.alwaysSent');
export const neverSentText = () => t('ai.data.neverSent');

/* --------------------------------------------------------- coach style */
/** Supportive is the default everywhere (consent screen, settings, server prompt and ai_settings_json). */
export const DEFAULT_COACH_STYLE: CoachStyle = 'supportive';
export const COACH_STYLE_INFO: { readonly key: CoachStyle; readonly title: string; readonly body: string }[] = (['supportive', 'balanced', 'strict'] as const).map((key) => ({
  key,
  get title() {
    return t(`ai.style.${key}`);
  },
  get body() {
    return t(`ai.style.${key}.description`);
  },
}));
export const coachStyleSafetyText = () => t('ai.style.safety');

/** Quick replies under the welcome. Tapping one sends it as the user's message (the real AI answers). */
const WELCOME_CHIP_KEYS = ['ai.quick.feelingGreat', 'ai.quick.tired', 'ai.quick.sore', 'ai.quick.shortOnTime', 'ai.quick.skipToday'] as const;
export const welcomeChips = (): string[] => WELCOME_CHIP_KEYS.map((k) => t(k));

export function scopesEqual(a: AiScopes, b: AiScopes): boolean {
  return a.profile === b.profile && a.training === b.training && a.measurements === b.measurements && a.nutrition === b.nutrition;
}

/* ------------------------------------------------------------ prompts */
const SUGGESTED_KEYS = ['ai.suggest.twiceWeek', 'ai.suggest.bench', 'ai.suggest.proteinMeals', 'ai.suggest.reviewFortnight'] as const;
/** Suggested questions under the composer (put into the composer in the app language). */
export const suggestedQuestions = (): string[] => SUGGESTED_KEYS.map((k) => t(k));
/** The visible text of a check-in review request (the mode, not this text, selects the review). */
export const checkinReviewText = () => t('ai.checkin.request');

/* ------------------------------------------------------------ errors */
export type AiErrorKind = 'offline' | 'rate_limited' | 'unavailable' | 'disabled' | 'paused' | 'auth' | 'failed';
export interface ClassifiedAiError {
  kind: AiErrorKind;
  /** Localized, user-facing text (never the raw provider/database message). */
  message: string;
  /** The message key behind `message` (stable: store this, not the text). */
  key: MessageKey;
  reason?: Extract<AiAvailability, { available: false }>['reason'];
  usage?: Partial<AiUsage>;
  /** The raw error message, for diagnostics only (not shown). */
  detail?: string;
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

/**
 * Map whatever the AI backend threw into something the UI can explain truthfully. Recognized codes/reasons map to
 * authored messages; the raw error text (English from the server, the database or the network stack) is never shown.
 */
export function classifyAiError(e: unknown): ClassifiedAiError {
  const err = (e && typeof e === 'object' ? e : {}) as ErrLike;
  const code = typeof err.code === 'string' ? err.code : '';
  const status = typeof err.status === 'number' ? err.status : undefined;
  const msg = typeof err.message === 'string' ? err.message : typeof e === 'string' ? e : '';
  const details = (err.details && typeof err.details === 'object' ? err.details : {}) as Record<string, unknown>;
  const reason = (typeof err.reason === 'string' ? err.reason : typeof details.reason === 'string' ? details.reason : undefined) as ClassifiedAiError['reason'];
  const out = (kind: AiErrorKind, key: MessageKey, extra: Partial<ClassifiedAiError> = {}): ClassifiedAiError => ({
    kind,
    key,
    message: t(key),
    ...extra,
    ...(msg ? { detail: msg } : {}),
  });

  if (code === 'network' || /failed to fetch|networkerror|network request failed|load failed|fetch failed|offline/i.test(msg)) return out('offline', 'ai.error.offline');
  if (code === 'PT429' || code === 'rate_limited' || status === 429) return out('rate_limited', 'ai.error.dailyLimit', { usage: pickUsage(err.usage, err.details) });
  if (code === 'ai_paused' || code === 'paused') return out('paused', 'ai.error.paused');
  if (code === 'consent_required' || (reason as string) === 'consent_required') return out('disabled', 'ai.error.providerChanged');
  if (code === 'ai_disabled' || code === 'disabled' || reason === 'disabled') return out('disabled', 'ai.error.disabled');
  if (code === 'ai_unavailable' || status === 503 || reason === 'not_configured' || reason === 'provider_down')
    return out('unavailable', 'ai.error.unavailable', { reason: reason ?? 'provider_down' });
  if (code === 'backend_missing' || reason === 'backend_missing' || /not implemented/i.test(msg)) return out('unavailable', 'ai.error.notSetUp', { reason: 'backend_missing' });
  if (code === 'auth' || status === 401) return out('auth', 'ai.error.auth');
  if (code === 'in_progress') return out('failed', 'aiServer.error.inProgress');
  // Item 10 (approved copy; typed codes only, never the raw transport or provider text).
  if (code === 'invalid_reply') return out('failed', 'ai.error.invalidReply');
  if (code === 'sharing_changed') return out('failed', 'ai.chat.replyDiscardedPrivacy');
  if (code === 'training_not_shared') return out('failed', 'ai.chat.trainingOffPending');
  if (code === 'request_cancelled') return out('failed', 'ai.chat.replyStopped');
  if (code === 'cancel_unconfirmed') return out('failed', 'ai.chat.stopUnconfirmed');
  if (code === 'stream_interrupted' || code === 'stream_protocol') return out('failed', 'ai.chat.replyInterrupted');
  return out('failed', 'ai.error.failed');
}

/** Known English texts older builds stored as a pending message's error, mapped to their keys. */
const LEGACY_PENDING_ERRORS: Record<string, MessageKey> = {
  'Training sharing is off, so this workout question can’t be sent. Switch on Training in training assistant settings, or remove it.': 'ai.chat.trainingOffPending',
  'Not confirmed yet. Tap Retry to send it again.': 'ai.chat.notConfirmed',
  'You appear to be offline. Your message is kept. Try again when you’re connected.': 'ai.error.offline',
  'You’ve reached today’s training assistant limit.': 'ai.error.dailyLimit',
  'The training assistant is paused.': 'ai.error.paused',
  'The training assistant’s provider changed. Review and agree again in training assistant setup.': 'ai.error.providerChanged',
  'The training assistant is turned off.': 'ai.error.disabled',
  'The training assistant is unavailable right now.': 'ai.error.unavailable',
  'The training assistant isn’t set up on this server yet.': 'ai.error.notSetUp',
  'Your session has expired. Please sign in again.': 'ai.error.auth',
  'Couldn’t reach the training assistant. Please try again.': 'ai.error.failed',
};

/**
 * The reason shown under an unsent message, in the app language. New builds store a message key; an older build's
 * stored English is recognized exactly, and any other stored diagnostic gets the generic message outside English.
 */
export function pendingErrorText(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (hasKey(error)) return t(error);
  const legacy = LEGACY_PENDING_ERRORS[error];
  if (legacy) return t(legacy);
  return getLanguage() === 'en' ? error : t('ai.error.failed');
}

/** True when the server will never answer (no point showing a chat composer). */
export function isHardUnavailable(a: AiAvailability | undefined): boolean {
  return !!a && !a.available && (a.reason === 'not_configured' || a.reason === 'backend_missing');
}

export function usageLine(u: Partial<AiUsage> | undefined): string | null {
  if (!u || typeof u.requests !== 'number') return null;
  if (typeof u.limitRequests === 'number' && u.limitRequests > 0)
    return t('ai.usage.withLimit', { used: u.requests, limit: u.limitRequests, remaining: Math.max(0, u.limitRequests - u.requests) });
  return tp('ai.usage.today', u.requests);
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

/** The named company that receives AI requests, when the server says which (a proper name: never translated). */
export function providerName(a: AiAvailability | undefined): string | undefined {
  return a && a.available && a.providerName ? a.providerName : undefined;
}

/**
 * Name of the company that receives AI requests, or the localized generic wording, for inline use. Branch on
 * providerName() (not on this text) to choose between named and generic sentences.
 */
export function providerLabel(a: AiAvailability | undefined): string {
  return providerName(a) ?? t('ai.provider.generic');
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

type Tone = 'accent' | 'neutral' | 'warn' | 'danger' | 'info';
const viewLabel = (view: ProposalView, tone: Tone): { readonly label: string; readonly tone: Tone } => ({
  tone,
  get label() {
    return t(`ai.proposal.status.${view}`);
  },
});
/** Status badge per proposal view; `label` is localized on read. */
export const PROPOSAL_VIEW_LABEL: Record<ProposalView, { readonly label: string; readonly tone: Tone }> = {
  pending: viewLabel('pending', 'accent'),
  stale: viewLabel('stale', 'warn'),
  invalid: viewLabel('invalid', 'danger'),
  accepted: viewLabel('accepted', 'info'),
  declined: viewLabel('declined', 'neutral'),
  closed: viewLabel('closed', 'neutral'),
};

/** "Your plan changed since this suggestion…", in the app language. */
export const staleMessage = () => t('ai.proposal.stale');
/** @deprecated English only; use staleMessage(). */
export const STALE_MESSAGE = t('ai.proposal.stale', undefined, 'en');

export function isCoachManaged(programs: Program[]): boolean {
  return liveActive(programs)?.managedBy?.kind === 'coach';
}

/** Plain-text summary used when the user shares a suggestion with their human coach. */
export function proposalShareText(p: ProgramProposal, describe: string[]): string {
  const lines = [t('ai.proposal.shareTitle', { name: p.program.name })];
  const changes = p.changeSummary.length ? p.changeSummary : describe;
  for (const c of changes.slice(0, 12)) lines.push(`• ${c}`);
  if (p.message) lines.push('', p.message);
  return clip(lines.join('\n'), COACH_MESSAGE_MAX);
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
