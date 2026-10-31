/**
 * Push notification RPCs (supabase/migrations/20261101000001_push_notifications.sql). All take the user from the
 * access token; nothing user-identifying is taken from the request body.
 */
import { backendConfigured, requireSupabase } from './supabase';
import { BackendError, toBackendError } from './syncRemote';
import { DEFAULT_PUSH_PREFS, PUSH_KINDS, type PushKind, type PushPrefs, type ScheduledJob } from '@/domain/pushSchedule';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  if (!backendConfigured) throw new BackendError('Notifications need the Hard Earned server.', 'backend_missing');
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw toBackendError(error, 'Couldn’t update notifications. Please try again.');
  return data as T;
}

export function toPushPrefs(raw: Record<string, unknown> | null | undefined): PushPrefs & { devices?: number } {
  if (!raw) return { ...DEFAULT_PUSH_PREFS };
  const kinds = Array.isArray(raw.kinds) ? (raw.kinds.filter((k) => PUSH_KINDS.includes(k as PushKind)) as PushKind[]) : DEFAULT_PUSH_PREFS.kinds;
  const hhmm = (v: unknown, d: string) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : d);
  return {
    kinds,
    fixedReminderTime: typeof raw.fixedReminderTime === 'string' && /^\d{2}:\d{2}$/.test(raw.fixedReminderTime) ? raw.fixedReminderTime : null,
    timeZone: typeof raw.timeZone === 'string' ? raw.timeZone : 'UTC',
    quietStart: hhmm(raw.quietStart, DEFAULT_PUSH_PREFS.quietStart),
    quietEnd: hhmm(raw.quietEnd, DEFAULT_PUSH_PREFS.quietEnd),
    ...(typeof raw.devices === 'number' ? { devices: raw.devices } : {}),
  };
}

export const pushApi = {
  saveSubscription: (s: { endpoint: string; p256dh: string; auth: string; userAgent?: string }) => rpc<{ id: string; endpoint: string }>('save_push_subscription', { p: s }),
  deleteSubscription: (endpoint: string) => rpc<boolean>('delete_push_subscription', { p_endpoint: endpoint }),
  getPrefs: async () => toPushPrefs(await rpc<Record<string, unknown>>('get_push_prefs')),
  setPrefs: async (p: Partial<PushPrefs>) => toPushPrefs(await rpc<Record<string, unknown>>('set_push_prefs', { p })),
  replaceJobs: (kind: 'workout_reminder' | 'missed_nudge' | 'rest_over', jobs: ScheduledJob[]) => rpc<number>('replace_scheduled_jobs', { p_kind: kind, p_jobs: jobs }),
  cancelJob: (dedupeKey: string) => rpc<boolean>('cancel_push_job', { p_dedupe_key: dedupeKey }),
  sendTest: () => rpc<{ queued: boolean }>('send_test_push'),
};
