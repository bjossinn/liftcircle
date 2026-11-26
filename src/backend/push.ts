/**
 * Push notification RPCs (supabase/migrations/20261101000001_push_notifications.sql, 20261129000001_coach_push.sql).
 * All take the user from the access token; nothing user-identifying is taken from the request body.
 */
import { backendConfigured, requireSupabase } from './supabase';
import { BackendError, toBackendError } from './syncRemote';
import {
  DEFAULT_PUSH_PREFS, PUSH_KINDS, isDailyCap, isHHMM, type DailyCap, type PushKind, type PushPrefs, type ScheduledJob, type SnoozeDays,
} from '@/domain/pushSchedule';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  if (!backendConfigured) throw new BackendError('Notifications need the Hard Earned server.', 'backend_missing');
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw toBackendError(error, 'Couldn’t update notifications. Please try again.');
  return data as T;
}

export type ServerPushPrefs = PushPrefs & {
  devices?: number;
  /** False when the server predates coach notifications (no revision/daily cap): those settings are unavailable. */
  coachSupported: boolean;
};

export function toPushPrefs(raw: Record<string, unknown> | null | undefined): ServerPushPrefs {
  if (!raw) return { ...DEFAULT_PUSH_PREFS, coachSupported: false };
  // An explicitly empty kinds list is kept (the user turned everything off).
  const kinds = Array.isArray(raw.kinds) ? (raw.kinds.filter((k) => PUSH_KINDS.includes(k as PushKind)) as PushKind[]) : DEFAULT_PUSH_PREFS.kinds;
  const hhmm = (v: unknown, d: string) => (isHHMM(v) ? v : d);
  const snooze = typeof raw.snoozeUntil === 'string' && Number.isFinite(Date.parse(raw.snoozeUntil)) ? raw.snoozeUntil : null;
  const coachSupported = typeof raw.revision === 'number' && 'dailyCap' in raw;
  return {
    kinds,
    fixedReminderTime: isHHMM(raw.fixedReminderTime) ? raw.fixedReminderTime : null,
    timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : 'UTC',
    quietStart: hhmm(raw.quietStart, DEFAULT_PUSH_PREFS.quietStart),
    quietEnd: hhmm(raw.quietEnd, DEFAULT_PUSH_PREFS.quietEnd),
    dailyCap: isDailyCap(raw.dailyCap) ? raw.dailyCap : DEFAULT_PUSH_PREFS.dailyCap,
    snoozeUntil: snooze,
    revision: typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0,
    coachSupported,
    ...(typeof raw.devices === 'number' ? { devices: raw.devices } : {}),
  };
}

/** One versioned preference patch (update_push_prefs). */
export interface PushPrefsPatch {
  kinds?: PushKind[];
  fixedReminderTime?: string | null;
  quietStart?: string;
  quietEnd?: string;
  timeZone?: string;
  dailyCap?: DailyCap;
  snoozeDays?: SnoozeDays;
  resume?: true;
}
export type PrefsField = 'cap' | 'time' | 'snoozeDays' | 'kinds' | 'timeZone' | 'unknown';
export type UpdatePrefsResult =
  | { status: 'ok'; prefs: ServerPushPrefs }
  /** Another device saved first: nothing was written; `prefs` are the latest settings. */
  | { status: 'conflict'; prefs: ServerPushPrefs }
  | { status: 'invalid'; field: PrefsField; prefs: ServerPushPrefs };

export function toUpdateResult(raw: Record<string, unknown> | null | undefined): UpdatePrefsResult {
  const prefs = toPushPrefs((raw?.prefs as Record<string, unknown> | undefined) ?? null);
  if (raw?.status === 'ok') return { status: 'ok', prefs };
  if (raw?.status === 'conflict') return { status: 'conflict', prefs };
  if (raw?.status === 'invalid') {
    const f = raw.field;
    return { status: 'invalid', field: f === 'cap' || f === 'time' || f === 'snoozeDays' || f === 'kinds' || f === 'timeZone' ? f : 'unknown', prefs };
  }
  throw new BackendError('Unexpected response.', 'bad_response');
}

export const pushApi = {
  saveSubscription: (s: { endpoint: string; p256dh: string; auth: string; userAgent?: string }) => rpc<{ id: string; endpoint: string }>('save_push_subscription', { p: s }),
  deleteSubscription: (endpoint: string) => rpc<boolean>('delete_push_subscription', { p_endpoint: endpoint }),
  getPrefs: async () => toPushPrefs(await rpc<Record<string, unknown>>('get_push_prefs')),
  /** Legacy last-write-wins update (only used for the device's time zone when turning push on). */
  setPrefs: async (p: Partial<PushPrefs>) => toPushPrefs(await rpc<Record<string, unknown>>('set_push_prefs', { p })),
  /** Versioned patch: applied only when `revision` is still current. A pause/resume is in effect once this returns ok. */
  updatePrefs: async (patch: PushPrefsPatch, revision: number) =>
    toUpdateResult(await rpc<Record<string, unknown>>('update_push_prefs', { p_patch: patch, p_revision: revision })),
  replaceJobs: (kind: 'workout_reminder' | 'missed_nudge' | 'rest_over', jobs: ScheduledJob[]) => rpc<number>('replace_scheduled_jobs', { p_kind: kind, p_jobs: jobs }),
  cancelJob: (dedupeKey: string) => rpc<boolean>('cancel_push_job', { p_dedupe_key: dedupeKey }),
  sendTest: () => rpc<{ queued: boolean }>('send_test_push'),
  /** Server-stamped "a full sync finished" receipt (food-log reminders need a fresh one). */
  recordSyncComplete: () => rpc<boolean>('record_sync_complete'),
};
