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
import { t as tNow, useT, type MessageKey } from '@/i18n';

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
export const PUSH_KIND_INFO: { readonly key: PushKind; readonly title: string; readonly description: string }[] = [
  kindInfo('workout_reminder', 'settings.pushWorkout', 'settings.pushWorkoutHelp'),
  kindInfo('rest_over', 'settings.pushRest', 'settings.pushRestHelp'),
  kindInfo('coaching', 'settings.pushCoaching', 'settings.pushCoachingHelp'),
  kindInfo('social', 'settings.pushFriends', 'settings.pushFriendsHelp'),
  kindInfo('missed_nudge', 'settings.pushMissed', 'settings.pushMissedHelp'),
];

export function PushSection() {
  const toast = useToast();
  const { t } = useT();
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
    setBusy('disable');
    try {
      await disablePush();
      setOn(false);
      toast.show(t('settings.pushOffToast'), { tone: 'success' });
    } catch {
      toast.show(t('settings.pushOffFailed'), { tone: 'error' });
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
    } catch {
      setPrefs(prev);
      toast.show(t('settings.pushSaveFailed'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  async function test() {
    setBusy('test');
    try {
      await pushApi.sendTest();
      toast.show(t('settings.pushTestSent'), { tone: 'success' });
    } catch {
      toast.show(t('settings.pushTestFailed'), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  const toggleKind = (k: PushKind, v: boolean) => void save({ kinds: v ? [...new Set([...prefs.kinds, k])] : prefs.kinds.filter((x) => x !== k) });

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
            <Button variant="primary" icon={<BellRing className="size-4" />} loading={busy === 'enable'} disabled={!online} onClick={() => void turnOn()}>
              {t('settings.pushEnable')}
            </Button>
            {!online && <p className="text-xs text-muted">{t('settings.pushOffline')}</p>}
          </>
        ) : (
          <>
            <p className="text-sm">{t('settings.pushOnStatus')}</p>
            <div className="divide-y divide-line -my-1">
              {PUSH_KIND_INFO.map((k) => (
                <Toggle key={k.key} label={k.title} description={k.description} checked={prefs.kinds.includes(k.key)} disabled={busy === 'prefs' || !online} onChange={(v) => toggleKind(k.key, v)} />
              ))}
            </div>
            <div className="pt-1">
              <Toggle
                label={t('settings.pushFixedTime')}
                description={t('settings.pushFixedTimeHelp')}
                checked={prefs.fixedReminderTime != null}
                disabled={busy === 'prefs' || !online || !prefs.kinds.includes('workout_reminder')}
                onChange={(v) => void save({ fixedReminderTime: v ? prefs.fixedReminderTime ?? '17:00' : null })}
              />
              {prefs.fixedReminderTime != null && (
                <Input
                  type="time"
                  label={t('settings.pushReminderTime')}
                  value={prefs.fixedReminderTime}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^\d{2}:\d{2}$/.test(v)) void save({ fixedReminderTime: v });
                  }}
                />
              )}
              <p className="text-xs text-muted mt-2">{t('settings.pushQuietHours', { start: prefs.quietStart, end: prefs.quietEnd })}</p>
            </div>
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
      </Card>
    </section>
  );
}
