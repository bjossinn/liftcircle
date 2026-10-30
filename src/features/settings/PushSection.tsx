/**
 * Settings → Notifications → "Push notifications" (this device).
 * Hidden entirely when the build has no VAPID public key. The permission prompt only ever comes from the
 * "Turn on notifications" tap (iOS requires a user gesture). On iPhone/iPad outside the installed Home Screen app,
 * push isn't possible, so we explain how to install instead of showing the button.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BellOff, BellRing, Send, Smartphone } from 'lucide-react';
import { Button, Card, Input, Notice, SectionTitle, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { pushApi } from '@/backend/push';
import type { PushKind, PushPrefs } from '@/domain/pushSchedule';
import { cachePushPrefs, cachedPushPrefs, disablePush, enablePush, onPushChange, pushEnabledHere, pushSupport, type PushSupport } from '@/pwa/push';
import { resetUploadedSchedules } from '@/pwa/pushScheduler';

export const PUSH_KIND_INFO: { key: PushKind; title: string; description: string }[] = [
  { key: 'workout_reminder', title: 'Workout reminders', description: 'On planned training days, about 2 hours before you usually start (or noon).' },
  { key: 'rest_over', title: 'Rest-over alerts', description: 'When your rest timer ends and the app is in the background.' },
  { key: 'coaching', title: 'Coaching messages', description: 'New messages and plan updates from your coach (never the message text).' },
  { key: 'social', title: 'Friends & social', description: 'Friend requests, likes and comments.' },
  { key: 'missed_nudge', title: 'Missed-session nudges', description: 'One nudge the day after a planned session that didn’t happen.' },
];

export function PushSection() {
  const toast = useToast();
  const { auth, online, account } = useApp();
  const [support, setSupport] = useState<PushSupport>(() => pushSupport());
  const [on, setOn] = useState(() => pushEnabledHere());
  const [prefs, setPrefs] = useState<PushPrefs>(() => cachedPushPrefs());
  const [busy, setBusy] = useState<null | 'enable' | 'disable' | 'test' | 'prefs'>(null);

  useEffect(
    () =>
      onPushChange(() => {
        setOn(pushEnabledHere());
        setPrefs(cachedPushPrefs());
        setSupport(pushSupport());
      }),
    [],
  );
  useEffect(() => {
    if (!on || !online || auth.status !== 'signed_in') return;
    let cancelled = false;
    pushApi
      .getPrefs()
      .then((p) => {
        if (cancelled) return;
        setPrefs(p);
        cachePushPrefs(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [on, online, auth.status]);

  if (support === 'no_key') return null;

  const signedIn = auth.status === 'signed_in';

  async function turnOn() {
    setBusy('enable');
    const r = await enablePush(account.settings.timeZone);
    setBusy(null);
    setSupport(pushSupport());
    if (r.ok) {
      resetUploadedSchedules();
      setOn(true);
      setPrefs(cachedPushPrefs());
      toast.show('Notifications are on for this device', { tone: 'success' });
    } else if (r.reason === 'denied') {
      setSupport('denied');
    } else if (r.reason === 'dismissed') {
      toast.show('Notifications stay off. You can turn them on any time.', { tone: 'info' });
    } else {
      toast.show(r.message || 'Couldn’t turn on notifications. Please try again.', { tone: 'error' });
    }
  }
  async function turnOff() {
    setBusy('disable');
    try {
      await disablePush();
      setOn(false);
      toast.show('Notifications are off on this device', { tone: 'success' });
    } catch (e) {
      toast.show((e as Error).message || 'Couldn’t turn off notifications.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  async function save(patch: Partial<PushPrefs>) {
    const prev = prefs;
    setPrefs({ ...prefs, ...patch });
    setBusy('prefs');
    try {
      const p = await pushApi.setPrefs(patch);
      setPrefs(p);
      cachePushPrefs(p);
      resetUploadedSchedules();
    } catch (e) {
      setPrefs(prev);
      toast.show((e as Error).message || 'Couldn’t save that change.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  async function test() {
    setBusy('test');
    try {
      await pushApi.sendTest();
      toast.show('Test notification on its way. It should arrive within a minute.', { tone: 'success' });
    } catch (e) {
      toast.show((e as Error).message || 'Couldn’t send a test notification.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  const toggleKind = (k: PushKind, v: boolean) => void save({ kinds: v ? [...new Set([...prefs.kinds, k])] : prefs.kinds.filter((x) => x !== k) });

  return (
    <section aria-labelledby="push-title">
      <SectionTitle id="push-title">Push notifications</SectionTitle>
      <Card className="p-4 space-y-3">
        {support === 'ios_needs_install' ? (
          <div data-testid="push-ios-install" className="space-y-2">
            <p className="text-sm flex gap-2 items-start">
              <Smartphone className="size-4 mt-0.5 shrink-0 text-accent" aria-hidden />
              <span>On iPhone and iPad, notifications only work in the installed app.</span>
            </p>
            <ol className="text-sm text-muted list-decimal pl-5 space-y-1">
              <li>Open LiftCircle in Safari.</li>
              <li>
                Tap <strong className="text-ink">Share</strong>, then <strong className="text-ink">Add to Home Screen</strong>.
              </li>
              <li>Open LiftCircle from your Home Screen and come back here.</li>
            </ol>
            <Link to="/install" className="text-sm text-accent underline">
              Step-by-step install guide
            </Link>
          </div>
        ) : support === 'unsupported' ? (
          <p className="text-sm text-muted">This browser doesn’t support push notifications. Try the installed app, or Chrome, Edge, Firefox or Safari.</p>
        ) : support === 'denied' ? (
          <div data-testid="push-denied">
          <Notice tone="warn">
            <p className="font-medium">Notifications are blocked for LiftCircle.</p>
            <p className="mt-1">
              iPhone/iPad: Settings → Notifications → LiftCircle → Allow Notifications. Android/Chrome: tap the lock icon next to the address (or long-press the app icon → App info) → Notifications → Allow. Desktop: the site settings next to the address bar.
              Then come back here and turn them on.
            </p>
          </Notice>
          </div>
        ) : !signedIn ? (
          <p className="text-sm text-muted">Sign in to get reminders and coaching messages as notifications.</p>
        ) : !on ? (
          <>
            <p className="text-sm text-muted">Get workout reminders, rest-over alerts and coaching messages on this device, even when LiftCircle is closed. You choose which ones next.</p>
            <Button variant="primary" icon={<BellRing className="size-4" />} loading={busy === 'enable'} disabled={!online} onClick={() => void turnOn()}>
              Turn on notifications
            </Button>
            {!online && <p className="text-xs text-muted">You’re offline. Connect to turn notifications on.</p>}
          </>
        ) : (
          <>
            <p className="text-sm">Notifications are on for this device.</p>
            <div className="divide-y divide-line -my-1">
              {PUSH_KIND_INFO.map((k) => (
                <Toggle key={k.key} label={k.title} description={k.description} checked={prefs.kinds.includes(k.key)} disabled={busy === 'prefs' || !online} onChange={(v) => toggleKind(k.key, v)} />
              ))}
            </div>
            <div className="pt-1">
              <Toggle
                label="Remind me at a fixed time"
                description="Use the same time for every workout reminder instead of the automatic one."
                checked={prefs.fixedReminderTime != null}
                disabled={busy === 'prefs' || !online || !prefs.kinds.includes('workout_reminder')}
                onChange={(v) => void save({ fixedReminderTime: v ? prefs.fixedReminderTime ?? '17:00' : null })}
              />
              {prefs.fixedReminderTime != null && (
                <Input
                  type="time"
                  label="Reminder time"
                  value={prefs.fixedReminderTime}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^\d{2}:\d{2}$/.test(v)) void save({ fixedReminderTime: v });
                  }}
                />
              )}
              <p className="text-xs text-muted mt-2">
                Quiet hours {prefs.quietStart}–{prefs.quietEnd}: nothing is sent then except rest-over alerts during a workout.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button icon={<Send className="size-4" />} loading={busy === 'test'} disabled={!online} onClick={() => void test()}>
                Send a test notification
              </Button>
              <Button variant="outline" icon={<BellOff className="size-4" />} loading={busy === 'disable'} disabled={!online} onClick={() => void turnOff()}>
                Turn off on this device
              </Button>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
