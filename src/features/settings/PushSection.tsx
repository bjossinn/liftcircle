/**
 * Settings → Notifications → "Push notifications".
 * Hidden entirely when the build has no VAPID public key. The permission prompt only ever comes from the
 * "Turn on notifications" tap (iOS requires a user gesture). On iPhone/iPad outside the installed Home Screen app,
 * push isn't possible, so we explain how to install instead of showing the button.
 *
 * Roadmap item 9 (coach notifications, phase 1): the account-wide reminder settings live on the server (push_prefs,
 * outside Settings and account backups) and are saved as one versioned patch (update_push_prefs). They are shown to
 * every signed-in account, whether or not notifications are on in this browser (pause the phone's reminders from a
 * laptop). A change made on
 * another device first reloads the latest settings and says so. Pausing and resuming wait for the server's
 * acknowledgement; offline, every change is disabled and nothing claims a pause took effect. Everything that is
 * loaded or saved belongs to the signed-in user id: an account switch drops pending loads/saves for the old one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BellOff, BellRing, PauseCircle, PlayCircle, Send, Smartphone } from 'lucide-react';
import { Button, Card, Input, Notice, SectionTitle, Select, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { pushApi, type PrefsField, type PushPrefsPatch, type ServerPushPrefs } from '@/backend/push';
import {
  COACH_PUSH_KINDS, DAILY_CAPS, FOOD_REMINDER_TIME, SNOOZE_DAYS, activeSnooze, isDailyCap, isHHMM, isSnoozeDays, quietHoursOff,
  type PushKind, type PushPrefs, type SnoozeDays,
} from '@/domain/pushSchedule';
import { cachePushPrefs, cachedPushPrefs, disablePush, enablePush, onPushChange, pushEnabledHere, pushSupport, type PushSupport } from '@/pwa/push';
import { resetUploadedSchedules } from '@/pwa/pushScheduler';
import { clockText, dateTimeText, t as tNow, useT, type MessageKey } from '@/i18n';

/** Title/description are read on access, so they follow the current language. */
const kindInfo = (key: PushKind, titleKey: MessageKey, descriptionKey: MessageKey) => ({
  key,
  get title() {
    return tNow(titleKey);
  },
  get description() {
    return tNow(descriptionKey);
  },
});
/** Other notifications (not limited by the daily limit or the pause). */
export const PUSH_KIND_INFO: { readonly key: PushKind; readonly title: string; readonly description: string }[] = [
  kindInfo('rest_over', 'settings.pushRest', 'settings.pushRestHelp'),
  kindInfo('coaching', 'settings.pushCoaching', 'settings.pushCoachingHelp'),
  kindInfo('social', 'settings.pushFriends', 'settings.pushFriendsHelp'),
];

type Load = 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';
type Status =
  | null
  | { kind: 'saving' | 'saved' | 'snoozing' | 'resuming' | 'resumed' | 'updatedElsewhere' | 'snoozeFailed' | 'resumeFailed' }
  | { kind: 'invalid'; field: PrefsField };

const VALIDATION: Partial<Record<PrefsField, MessageKey>> = {
  cap: 'validation.coachPushCap',
  time: 'validation.coachPushTime',
  snoozeDays: 'validation.coachPushSnoozeDays',
};

export function PushSection() {
  const toast = useToast();
  const { t, tp } = useT();
  const { auth, online, account } = useApp();
  const uid = auth.status === 'signed_in' ? auth.userId ?? null : null;
  const [support, setSupport] = useState<PushSupport>(() => pushSupport());
  const [on, setOn] = useState(() => pushEnabledHere(uid));
  const [prefs, setPrefs] = useState<PushPrefs>(() => cachedPushPrefs(uid));
  const [devices, setDevices] = useState<number | undefined>(undefined);
  const [load, setLoad] = useState<Load>('idle');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<null | 'enable' | 'disable' | 'test' | 'prefs'>(null);
  const [snoozeDays, setSnoozeDays] = useState<SnoozeDays>(1);
  const [quietDraft, setQuietDraft] = useState<{ start: string; end: string } | null>(null);
  const [, setTick] = useState(0);

  // Everything async is tied to the account it started for: a newer generation ignores older results.
  const gen = useRef({ uid, n: 0 });
  if (gen.current.uid !== uid) gen.current = { uid, n: gen.current.n + 1 };
  const stamp = () => gen.current.n;
  const current = (n: number) => gen.current.n === n;

  // Account switch: reset to that account's own (namespaced) state; never carry over the previous account's choices.
  useEffect(() => {
    setOn(pushEnabledHere(uid));
    setPrefs(cachedPushPrefs(uid));
    setDevices(undefined);
    setLoad('idle');
    setStatus(null);
    setBusy(null);
    setQuietDraft(null);
  }, [uid]);

  useEffect(
    () =>
      onPushChange(() => {
        setOn(pushEnabledHere(gen.current.uid));
        setSupport(pushSupport());
      }),
    [],
  );

  const apply = useCallback(
    (p: ServerPushPrefs) => {
      setPrefs(p);
      if (typeof p.devices === 'number') setDevices(p.devices);
      cachePushPrefs(uid, p);
    },
    [uid],
  );

  const reload = useCallback(() => {
    if (!uid || !online) return;
    const n = stamp();
    setLoad('loading');
    pushApi
      .getPrefs()
      .then((p) => {
        if (!current(n)) return;
        apply(p);
        setLoad(p.coachSupported ? 'ready' : 'unavailable');
      })
      .catch(() => {
        if (current(n)) setLoad('failed');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, online, apply]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A pause ends on its own: re-render at its end so the status switches back.
  const snoozedUntil = activeSnooze(prefs);
  useEffect(() => {
    if (!snoozedUntil) return;
    const ms = Date.parse(snoozedUntil) - Date.now();
    if (ms > 2 ** 31 - 1) return;
    const timer = setTimeout(() => setTick((x) => x + 1), Math.max(0, ms) + 50);
    return () => clearTimeout(timer);
  }, [snoozedUntil]);

  if (support === 'no_key') return null;

  const signedIn = auth.status === 'signed_in' && !!uid;
  const coachReady = load === 'ready';
  const locked = !online || busy === 'prefs' || (load !== 'ready' && load !== 'unavailable');

  async function turnOn() {
    const n = stamp();
    setBusy('enable');
    const r = await enablePush(uid, account.settings.timeZone, () => current(n));
    if (!current(n) || (!r.ok && r.reason === 'cancelled')) return;
    setBusy(null);
    setSupport(pushSupport());
    if (r.ok) {
      resetUploadedSchedules(uid);
      setOn(true);
      setPrefs(cachedPushPrefs(uid));
      reload();
      toast.show(t('settings.pushOnToast'), { tone: 'success' });
    } else if (r.reason === 'denied') {
      setSupport('denied');
    } else if (r.reason === 'dismissed') {
      toast.show(t('settings.pushStayedOff'), { tone: 'info' });
    } else {
      // The raw browser/server error message is not approved copy: always the localized message.
      toast.show(t('settings.pushOnFailed'), { tone: 'error' });
    }
  }
  async function turnOff() {
    const n = stamp();
    setBusy('disable');
    try {
      const done = await disablePush(uid, () => current(n));
      if (!current(n) || !done) return;
      setOn(false);
      toast.show(t('settings.pushOffToast'), { tone: 'success' });
    } catch {
      if (current(n)) toast.show(t('settings.pushOffFailed'), { tone: 'error' });
    } finally {
      if (current(n)) setBusy(null);
    }
  }

  /**
   * One versioned patch. Toggles update the screen right away (reverted on failure); a pause or resume only shows as
   * done after the server acknowledged it.
   */
  async function save(patch: PushPrefsPatch, mode: 'change' | 'snooze' | 'resume' = 'change') {
    if (!online || !uid) return;
    const n = stamp();
    const prev = prefs;
    if (mode === 'change') {
      const { snoozeDays: _s, resume: _r, ...visible } = patch;
      void _s;
      void _r;
      setPrefs({ ...prefs, ...visible });
    }
    setBusy('prefs');
    setStatus({ kind: mode === 'snooze' ? 'snoozing' : mode === 'resume' ? 'resuming' : 'saving' });
    try {
      if (!coachReady) {
        // Server without coach notifications: the older settings still save (last write wins).
        const { snoozeDays: _s, resume: _r, dailyCap: _c, ...legacy } = patch;
        void _s;
        void _r;
        void _c;
        const p = await pushApi.setPrefs(legacy, uid);
        if (!current(n)) return;
        apply(p);
        resetUploadedSchedules(uid);
        setStatus({ kind: 'saved' });
        return;
      }
      const r = await pushApi.updatePrefs(patch, prev.revision, uid);
      if (!current(n)) return;
      apply(r.prefs);
      if (r.status === 'conflict') {
        setStatus({ kind: 'updatedElsewhere' });
      } else if (r.status === 'invalid') {
        setStatus({ kind: 'invalid', field: r.field });
      } else {
        resetUploadedSchedules(uid);
        // After a pause, the "paused until …" line is the confirmation.
        setStatus(mode === 'snooze' ? null : { kind: mode === 'resume' ? 'resumed' : 'saved' });
      }
    } catch {
      if (!current(n)) return;
      setPrefs(prev);
      if (mode === 'snooze') setStatus({ kind: 'snoozeFailed' });
      else if (mode === 'resume') setStatus({ kind: 'resumeFailed' });
      else {
        setStatus(null);
        toast.show(t('settings.pushSaveFailed'), { tone: 'error' });
      }
    } finally {
      if (current(n)) setBusy(null);
    }
  }
  async function test() {
    const n = stamp();
    setBusy('test');
    try {
      await pushApi.sendTest();
      if (current(n)) toast.show(t('settings.pushTestSent'), { tone: 'success' });
    } catch {
      if (current(n)) toast.show(t('settings.pushTestFailed'), { tone: 'error' });
    } finally {
      if (current(n)) setBusy(null);
    }
  }

  const toggleKind = (k: PushKind, v: boolean) => void save({ kinds: v ? [...new Set([...prefs.kinds, k])] : prefs.kinds.filter((x) => x !== k) });
  const setCap = (raw: string) => {
    const v = Number(raw);
    if (!isDailyCap(v)) return setStatus({ kind: 'invalid', field: 'cap' });
    void save({ dailyCap: v });
  };
  const snooze = () => {
    if (!isSnoozeDays(snoozeDays)) return setStatus({ kind: 'invalid', field: 'snoozeDays' });
    void save({ snoozeDays }, 'snooze');
  };
  const setQuiet = (which: 'start' | 'end', v: string) => {
    const next = { start: quietDraft?.start ?? prefs.quietStart, end: quietDraft?.end ?? prefs.quietEnd, [which]: v };
    setQuietDraft(next);
    if (!isHHMM(v)) return setStatus({ kind: 'invalid', field: 'time' });
    setQuietDraft(null);
    void save(which === 'start' ? { quietStart: v } : { quietEnd: v });
  };

  const foodAllowed = account.settings.nutritionEnabled;
  const anyCoachOn = COACH_PUSH_KINDS.some((k) => prefs.kinds.includes(k) && (k !== 'food_unlogged' || foodAllowed));
  const tz = account.settings.timeZone;
  const statusKey: MessageKey | null = !status
    ? null
    : status.kind === 'invalid'
      ? VALIDATION[status.field] ?? 'settings.pushSaveFailed'
      : (
          {
            saving: 'settings.coachPushSaving',
            saved: 'settings.coachPushSaved',
            snoozing: 'settings.coachPushSnoozing',
            resuming: 'settings.coachPushResuming',
            resumed: 'settings.coachPushResumed',
            updatedElsewhere: 'settings.coachPushUpdatedElsewhere',
            snoozeFailed: 'settings.coachPushSnoozeFailed',
            resumeFailed: 'settings.coachPushResumeFailed',
          } as const
        )[status.kind];
  const statusTone = status && (status.kind === 'invalid' || status.kind === 'snoozeFailed' || status.kind === 'resumeFailed') ? 'danger' : 'info';
  const fieldError = (f: PrefsField) => (status?.kind === 'invalid' && status.field === f ? t(VALIDATION[f] ?? 'settings.pushSaveFailed') : null);
  const quietStart = quietDraft?.start ?? prefs.quietStart;
  const quietEnd = quietDraft?.end ?? prefs.quietEnd;

  return (
    <section aria-labelledby="push-title">
      <SectionTitle id="push-title">{t('settings.pushTitle')}</SectionTitle>
      <Card className="p-4 space-y-3">
        {support === 'ios_needs_install' ? (
          <div data-testid="push-ios-install" className="space-y-2">
            <p className="text-sm flex gap-2 items-start">
              <Smartphone className="size-4 mt-0.5 shrink-0 text-accent" aria-hidden />
              <span>{t('settings.pushIosInstalled')}</span>
            </p>
            <ol className="text-sm text-muted list-decimal pl-5 space-y-1">
              <li>{t('settings.pushIosStep1')}</li>
              <li>{t('settings.pushIosStep2')}</li>
              <li>{t('settings.pushIosStep3')}</li>
            </ol>
            <Link to="/install" className="text-sm text-accent underline">
              {t('settings.pushInstallGuide')}
            </Link>
          </div>
        ) : support === 'unsupported' ? (
          <p className="text-sm text-muted">{t('settings.pushUnsupported')}</p>
        ) : support === 'denied' ? (
          <div data-testid="push-denied">
            <Notice tone="warn">
              <p className="font-medium">{t('settings.pushBlocked')}</p>
              <p className="mt-1">{t('settings.pushUnblockHelp')}</p>
            </Notice>
          </div>
        ) : !signedIn ? (
          <p className="text-sm text-muted">{t('settings.pushSignIn')}</p>
        ) : !on ? (
          <>
            <p className="text-sm text-muted">{t('settings.pushIntro')}</p>
            {!!devices && <p className="text-sm text-muted" data-testid="push-device-off">{t('settings.coachPushDeviceOff')}</p>}
            <Button variant="primary" icon={<BellRing className="size-4" />} loading={busy === 'enable'} disabled={!online} onClick={() => void turnOn()}>
              {t('settings.pushEnable')}
            </Button>
            {!online && <p className="text-xs text-muted">{t('settings.pushOffline')}</p>}
          </>
        ) : (
          <>
            <p className="text-sm">{t('settings.pushOnStatus')}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button icon={<Send className="size-4" />} loading={busy === 'test'} disabled={!online} onClick={() => void test()}>
                {t('settings.pushTest')}
              </Button>
              <Button variant="outline" icon={<BellOff className="size-4" />} loading={busy === 'disable'} disabled={!online} onClick={() => void turnOff()}>
                {t('settings.pushDisableDevice')}
              </Button>
            </div>
          </>
        )}
        {signedIn && (
          <div className="space-y-3 border-t border-line pt-3" data-testid="push-account-settings">
            {!online && (
              <Notice tone="info">
                <span data-testid="push-offline">{t('settings.coachPushOffline')}</span>
              </Notice>
            )}
            {online && load === 'loading' && <p className="text-xs text-muted">{t('common.loading')}</p>}
            {online && load === 'failed' && (
              <Notice tone="warn">
                <p>{t('settings.coachPushLoadFailed')}</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={reload}>
                  {t('common.retry')}
                </Button>
              </Notice>
            )}
            <p role="status" aria-live="polite" data-testid="push-status" className={statusTone === 'danger' ? 'text-sm text-danger' : 'text-sm text-muted'}>
              {statusKey ? t(statusKey) : ''}
            </p>

            {/* ---------------------------------------------------------------- coach notifications */}
            <div className="space-y-2" aria-labelledby="coach-push-title" role="group">
              <h3 id="coach-push-title" className="text-[15px] font-semibold pt-1">
                {t('settings.coachPushTitle')}
              </h3>
              <p className="text-xs text-muted">{t('settings.coachPushHelp')}</p>
              {load === 'unavailable' ? (
                <Notice tone="info">
                  <span data-testid="coach-push-unavailable">{t('settings.coachPushUnavailable')}</span>
                </Notice>
              ) : (
                <>
                  <p className="text-sm" data-testid="coach-push-state">
                    {snoozedUntil
                      ? t('settings.coachPushSnoozedUntil', { dateTime: dateTimeText(Date.parse(snoozedUntil), tz) })
                      : anyCoachOn
                        ? t('settings.coachPushActive')
                        : t('settings.coachPushAllOff')}
                  </p>
                  <div className="divide-y divide-line -my-1">
                    <Toggle label={t('settings.pushWorkout')} description={t('settings.coachPushWorkoutHelp')} checked={prefs.kinds.includes('workout_reminder')} disabled={locked} onChange={(v) => toggleKind('workout_reminder', v)} />
                    <Toggle label={t('settings.pushMissed')} description={t('settings.coachPushMissedHelp')} checked={prefs.kinds.includes('missed_nudge')} disabled={locked} onChange={(v) => toggleKind('missed_nudge', v)} />
                    <Toggle
                      label={t('settings.coachPushFood')}
                      description={t('settings.coachPushFoodHelp', { time: clockText(Date.UTC(2000, 0, 1, Number(FOOD_REMINDER_TIME.slice(0, 2)), Number(FOOD_REMINDER_TIME.slice(3))), 'UTC') })}
                      checked={foodAllowed && prefs.kinds.includes('food_unlogged')}
                      disabled={locked || !foodAllowed || !coachReady}
                      onChange={(v) => toggleKind('food_unlogged', v)}
                    />
                  </div>
                  {!foodAllowed && (
                    <p className="text-xs text-muted">
                      {t('settings.coachPushFoodNeedsNutrition')}{' '}
                      <Link to="/nutrition" className="text-accent underline">
                        {t('settings.coachPushOpenNutrition')}
                      </Link>
                    </p>
                  )}
                  <div className="pt-1">
                    <Toggle
                      label={t('settings.pushFixedTime')}
                      description={t('settings.pushFixedTimeHelp')}
                      checked={prefs.fixedReminderTime != null}
                      disabled={locked || !prefs.kinds.includes('workout_reminder')}
                      onChange={(v) => void save({ fixedReminderTime: v ? prefs.fixedReminderTime ?? '17:00' : null })}
                    />
                    {prefs.fixedReminderTime != null && (
                      <Input
                        type="time"
                        label={t('settings.pushReminderTime')}
                        value={prefs.fixedReminderTime}
                        disabled={locked}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (isHHMM(v)) void save({ fixedReminderTime: v });
                          else setStatus({ kind: 'invalid', field: 'time' });
                        }}
                      />
                    )}
                  </div>
                  {coachReady && (
                    <>
                      <Select
                        label={t('settings.coachPushDailyCap')}
                        hint={t('settings.coachPushDailyCapHelp')}
                        error={fieldError('cap')}
                        value={String(prefs.dailyCap)}
                        disabled={locked}
                        onChange={(e) => setCap(e.target.value)}
                      >
                        {DAILY_CAPS.map((n) => (
                          <option key={n} value={n}>
                            {tp('settings.coachPushCap', n)}
                          </option>
                        ))}
                      </Select>
                      <div className="text-xs text-muted space-y-1">
                        <p>{t('settings.coachPushScope')}</p>
                        <p>{t('settings.coachPushPrivacy')}</p>
                        <p>{t('settings.coachPushAiHelp')}</p>
                      </div>

                      <div className="space-y-2 pt-1" data-testid="coach-push-snooze">
                        <h4 className="text-sm font-semibold">{t('settings.coachPushSnoozeTitle')}</h4>
                        <p className="text-xs text-muted">{t('settings.coachPushSnoozeHelp')}</p>
                        {snoozedUntil ? (
                          <Button variant="outline" icon={<PlayCircle className="size-4" />} loading={status?.kind === 'resuming'} disabled={locked} onClick={() => void save({ resume: true }, 'resume')}>
                            {t('settings.coachPushResume')}
                          </Button>
                        ) : (
                          <>
                            <Select
                              label={t('settings.coachPushSnoozeDuration')}
                              error={fieldError('snoozeDays')}
                              value={String(snoozeDays)}
                              disabled={locked}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                if (isSnoozeDays(v)) setSnoozeDays(v);
                                else setStatus({ kind: 'invalid', field: 'snoozeDays' });
                              }}
                            >
                              {SNOOZE_DAYS.map((n) => (
                                <option key={n} value={n}>
                                  {tp('settings.coachPushSnoozeDays', n)}
                                </option>
                              ))}
                            </Select>
                            <Button variant="outline" icon={<PauseCircle className="size-4" />} loading={status?.kind === 'snoozing'} disabled={locked} onClick={snooze}>
                              {tp('settings.coachPushSnoozeAction', snoozeDays)}
                            </Button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* ---------------------------------------------------------------- quiet hours */}
            <div className="space-y-2 pt-1" role="group" aria-labelledby="quiet-push-title">
              <h3 id="quiet-push-title" className="text-[15px] font-semibold">
                {t('settings.coachPushQuietTitle')}
              </h3>
              <p className="text-xs text-muted">{t('settings.coachPushQuietHelp')}</p>
              <div className="grid grid-cols-2 gap-2">
                <Input type="time" label={t('settings.coachPushQuietStart')} value={quietStart} disabled={locked} onChange={(e) => setQuiet('start', e.target.value)} />
                <Input type="time" label={t('settings.coachPushQuietEnd')} value={quietEnd} disabled={locked} onChange={(e) => setQuiet('end', e.target.value)} />
              </div>
              {fieldError('time') && <p className="text-xs text-danger">{fieldError('time')}</p>}
              <p className="text-xs text-muted" data-testid="quiet-summary">
                {quietHoursOff(prefs) ? t('settings.coachPushQuietDisabled') : t('settings.coachPushQuietSummary', { start: prefs.quietStart, end: prefs.quietEnd })}
              </p>
              <p className="text-xs text-muted">{t('settings.coachPushTimeZone', { timeZone: tz })}</p>
            </div>

            {/* ---------------------------------------------------------------- other notifications */}
            <div className="space-y-1 pt-1" role="group" aria-labelledby="other-push-title">
              <h3 id="other-push-title" className="text-[15px] font-semibold">
                {t('settings.coachPushOtherTitle')}
              </h3>
              <div className="divide-y divide-line -my-1">
                {PUSH_KIND_INFO.map((k) => (
                  <Toggle key={k.key} label={k.title} description={k.description} checked={prefs.kinds.includes(k.key)} disabled={locked} onChange={(v) => toggleKind(k.key, v)} />
                ))}
              </div>
            </div>

          </div>
        )}
      </Card>
    </section>
  );
}
