/**
 * Uploads the device-computed push schedule (src/domain/pushSchedule.ts):
 *  - usePushScheduler (app shell): workout reminders + missed-session nudges for the next 14 days, whenever the plan,
 *    week overrides, sessions, activities or push settings change, and on app start. Unchanged schedules aren't
 *    re-uploaded.
 *  - useRestPush (logger): one rest-over push at the rest deadline (dedupe key per workout), replaced or cancelled
 *    when the timer is skipped, paused or extended, the next set starts a new rest, or the workout ends. While the
 *    page is visible the in-app alert handles it, so the push is cancelled a few seconds before the deadline.
 * Offline-first: every upload is best-effort. No signal → no push; the in-app timer and reminders on Today still work.
 * Upload signatures and cached preferences are namespaced by the signed-in user id; work started for one account is
 * dropped when the account changes. Uploaded reminders are candidates: the server re-checks synchronized data, the
 * daily limit and the pause before sending, and writes the final text. Food-log reminders are scheduled by the server.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/state/app';
import { kvGet } from '@/db/repo';
import { pushApi } from '@/backend/push';
import { mentionsPainOrIllness, missedNudgeJobs, restAlertJob, workoutReminderJobs, type ScheduledJob } from '@/domain/pushSchedule';
import { effectiveLanguage } from '@/i18n';
import type { Exercise, ID, WeightUnit, WorkoutSession } from '@/domain/types';
import { useActiveProgram, useAllActivities, useAllSessions } from '@/features/train/hooks';
import { AI_HISTORY_CACHE_KEY } from '@/features/coaching/ai/model';
import { todayISO } from '@/lib/dates';
import { cachedPushPrefs, listenForSubscriptionChanges, onPushChange, pushEnabledHere, refreshPushSubscription, type PushAccount } from './push';

const UPLOADED_KEY = 'lc-push-uploaded';
export const uploadedKey = (uid: string, kind: string) => `${UPLOADED_KEY}:${uid}:${kind}`;
function lastUploaded(uid: string, kind: string): string | null {
  try {
    return localStorage.getItem(uploadedKey(uid, kind));
  } catch {
    return null;
  }
}
function markUploaded(uid: string, kind: string, sig: string) {
  try {
    localStorage.setItem(uploadedKey(uid, kind), sig);
  } catch {
    /* ignore */
  }
}
/** Forget this account's upload signatures so the next run re-uploads everything (after turning push on again). */
export function resetUploadedSchedules(uid: PushAccount) {
  try {
    for (const k of ['workout_reminder', 'missed_nudge']) {
      localStorage.removeItem(`${UPLOADED_KEY}:${k}`); // pre-namespacing keys
      if (uid) localStorage.removeItem(uploadedKey(uid, k));
    }
  } catch {
    /* ignore */
  }
}

async function upload(uid: string, kind: 'workout_reminder' | 'missed_nudge', jobs: ScheduledJob[], isCurrent: () => boolean) {
  const sig = JSON.stringify(jobs);
  if (lastUploaded(uid, kind) === sig || !isCurrent()) return;
  await pushApi.replaceJobs(kind, jobs);
  if (isCurrent()) markUploaded(uid, kind, sig);
}

/** Latest local hint of pain/injury/illness: the last AI chat message the user sent, or discomfort in the last workout. */
export async function localPainFlag(db: Parameters<typeof kvGet>[1], sessions: WorkoutSession[]): Promise<boolean> {
  const history = await kvGet<{ role: string; content: string; createdAt?: string }[]>(AI_HISTORY_CACHE_KEY, db).catch(() => undefined);
  const lastUser = [...(history ?? [])].reverse().find((m) => m.role === 'user');
  if (mentionsPainOrIllness(lastUser?.content)) return true;
  const last = sessions.filter((s) => s.status === 'completed' && !s.deletedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
  return !!last?.exercises.some((e) => e.discomfort);
}

export function usePushScheduler() {
  const { auth, online, account, db } = useApp();
  const program = useActiveProgram();
  const sessions = useAllSessions();
  const activities = useAllActivities();
  const [rev, setRev] = useState(0);
  const signedIn = auth.status === 'signed_in';
  const uid = signedIn ? auth.userId ?? null : null;
  // Guests and demo databases never upload reminders.
  const enabled = !!uid && online && !db.isGuest && db.accountKey === uid && !account.settings.demoData && pushEnabledHere(uid);

  useEffect(() => onPushChange(() => setRev((r) => r + 1)), []);
  useEffect(() => listenForSubscriptionChanges(uid), [uid]);
  useEffect(() => {
    if (!uid || !online) return;
    let current = true;
    void refreshPushSubscription(uid, () => current).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [uid, online]);

  useEffect(() => {
    if (!enabled || !uid || program === undefined || sessions === undefined) return;
    let current = true;
    const isCurrent = () => current;
    const t = setTimeout(() => {
      void (async () => {
        const prefs = { ...cachedPushPrefs(uid), timeZone: account.settings.timeZone };
        const base = { program, sessions, activities: activities ?? [], today: todayISO(account.settings.timeZone), now: new Date(), prefs, style: account.settings.coachStyle, language: effectiveLanguage(account.settings.language) };
        const painFlag = await localPainFlag(db, sessions);
        await upload(uid, 'workout_reminder', prefs.kinds.includes('workout_reminder') ? workoutReminderJobs(base) : [], isCurrent);
        await upload(uid, 'missed_nudge', prefs.kinds.includes('missed_nudge') ? missedNudgeJobs({ ...base, painFlag }) : [], isCurrent);
      })().catch(() => undefined); // offline / server down: try again on the next change or start
    }, 2000);
    return () => {
      current = false; // account / data changed: a running upload for the old state stops before its next call
      clearTimeout(t);
    };
  }, [enabled, uid, program, sessions, activities, account.settings.timeZone, account.settings.coachStyle, db, rev]);
}

/** Cancel this workout's rest-over push (finish / discard). Best-effort. */
export function cancelRestPush(uid: PushAccount, sessionId: string) {
  if (!pushEnabledHere(uid)) return;
  void pushApi.cancelJob(`rest:${sessionId}`).catch(() => undefined);
}

const VISIBLE_HANDOFF_MS = 5000;

export function useRestPush(session: WorkoutSession | null | undefined, byId: Map<ID, Exercise>, unit: WeightUnit) {
  const { auth, online } = useApp();
  const uid = auth.status === 'signed_in' ? auth.userId ?? null : null;
  const enabled = !!uid && online && pushEnabledHere(uid) && cachedPushPrefs(uid).kinds.includes('rest_over');
  const job = session ? restAlertJob(session, byId, unit) : null;
  const sig = job ? `${job.fireAt}|${job.payload.body}` : '';
  const sent = useRef<string | null>(null);
  const sessionId = session?.id;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    if (sig === (sent.current ?? '')) return;
    const prev = sent.current;
    sent.current = sig;
    if (!job) {
      if (prev) void pushApi.replaceJobs('rest_over', []).catch(() => undefined); // skipped / paused / done
      return;
    }
    void pushApi.replaceJobs('rest_over', [job]).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, sig]);

  // Visible at the deadline → the in-app alert covers it; cancel the push shortly before.
  const endsAt = job ? Date.parse(job.fireAt) : null;
  useEffect(() => {
    if (!enabled || endsAt == null || !sessionId) return;
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') void pushApi.cancelJob(`rest:${sessionId}`).catch(() => undefined);
    }, Math.max(0, endsAt - Date.now() - VISIBLE_HANDOFF_MS));
    return () => clearTimeout(t);
  }, [enabled, endsAt, sessionId]);
}
