import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight, Database, FlaskConical, Info, Smartphone, UserRound } from 'lucide-react';
import { useApp } from '@/state/app';
import { isBeginner, progressionRuleText } from '@/domain/progression';
import { Button, Card, IconButton, Input, ListRow, NumberInput, Page, SectionTitle, Segmented, Select, Sheet, Toggle } from '@/components/ui';
import type { Audience, Settings, ShareFields } from '@/domain/types';
import { SignOutButton } from './account';
import { enterDemo, exitDemo } from './demo';
import { updateDiscoverable } from '@/features/social/useMyProfile';
import { useToast } from '@/components/toast';
import { BRAND } from '@/config/brand';
import { BrandMoment } from '@/components/BrandMark';
import { PushSection } from './PushSection';
import { UpdateCheckRow } from './UpdateCheckRow';
import { ThemeOptions } from '@/theme/ThemeOptions';
import { effectiveThemeChoice, setDeviceThemeChoice } from '@/theme/theme';
import { analyticsEnabled, clearAnalyticsQueue } from '@/analytics/analytics';
import { effectiveLanguage, t as tFor, useT, type Language, type MessageKey } from '@/i18n';
import { knownErrorText } from './errorText';

export default function SettingsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
  const { account, updateAccount, auth, backendConfigured, db } = useApp();
  const s = account.settings;
  /** Saves a settings change; resolves true when it was saved, false after showing the error (never rejects). */
  const set = (fn: (s: Settings) => Settings): Promise<boolean> =>
    updateAccount((a) => ({ ...a, settings: fn(a.settings) })).then(
      () => true,
      (e) => {
        toast.show(knownErrorText(e), { tone: 'error' });
        return false;
      },
    );
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [s.timeZone];
    } catch {
      return [s.timeZone];
    }
  }, [s.timeZone]);
  const [about, setAbout] = useState(false);
  const signedIn = auth.status === 'signed_in' || auth.status === 'expired';

  return (
    <Page
      title={t('settings.title')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <SectionTitle>{t('settings.account')}</SectionTitle>
      <Card className="p-4 space-y-3">
        {db.isDemo ? (
          <>
            <p className="text-sm">{t('settings.demoBody')}</p>
            <Button onClick={() => void exitDemo()}>{t('settings.exitDemo')}</Button>
          </>
        ) : signedIn ? (
          <>
            <p className="text-sm">
              {auth.email ? withSlot(t('settings.signedInAs', { email: SLOT }), <span className="font-medium">{auth.email}</span>) : t('settings.signedIn')}
              {auth.status === 'expired' && ` ${t('settings.expired')}`}
            </p>
            <div className="flex flex-wrap gap-2">
              {auth.status === 'expired' && (
                <Button variant="primary" onClick={() => nav('/auth?reauth=1')}>
                  {t('settings.signInAgain')}
                </Button>
              )}
              <Button icon={<UserRound className="size-4" />} onClick={() => nav('/profile/edit')}>
                {t('settings.socialProfile')}
              </Button>
              <SignOutButton />
            </div>
          </>
        ) : backendConfigured ? (
          <>
            <p className="text-sm text-muted">{t('settings.guestBody', { brand: BRAND.name })}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => nav('/auth?mode=signup')}>
                {t('settings.createAccount')}
              </Button>
              <Button onClick={() => nav('/auth')}>{t('settings.signIn')}</Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">{t('settings.personalMode')}</p>
        )}
        <Input
          label={t('settings.privateName')}
          defaultValue={account.profile.displayName}
          maxLength={40}
          onBlur={(e) => e.target.value !== account.profile.displayName && void updateAccount((a) => ({ ...a, profile: { ...a.profile, displayName: e.target.value.trim() } }))}
          hint={t('settings.privateNameHint')}
        />
      </Card>

      <SectionTitle id="appearance-title">{t('settings.appearance')}</SectionTitle>
      <Card className="p-3">
        <ThemeOptions
          layout="compact"
          labelledBy="appearance-title"
          value={effectiveThemeChoice(s.theme)}
          onChange={(v) => {
            setDeviceThemeChoice(v);
            void set((x) => ({ ...x, theme: v }));
          }}
        />
      </Card>

      <SectionTitle id="language-title">{t('settings.languageTitle')}</SectionTitle>
      <Card className="p-4 space-y-3">
        {/* Autonyms stay in their own language in both locales. Changes Settings.language only: units, time zone,
            week start, theme and all saved content are untouched. */}
        <Segmented<Language>
          label={t('settings.languageAria')}
          value={effectiveLanguage(s.language)}
          onChange={(v) => {
            // Confirm only a saved change: a failed write shows its error and never the "language changed" toast.
            void set((x) => ({ ...x, language: v })).then((saved) => saved && toast.show(tFor('settings.languageSaved', undefined, v)));
          }}
          options={[
            { value: 'en', label: <span lang="en">{t('settings.languageEnglish')}</span> },
            { value: 'is', label: <span lang="is">{t('settings.languageIcelandic')}</span> },
          ]}
        />
        <p className="text-xs text-muted">{t('settings.languageDescription')}</p>
      </Card>

      <SectionTitle>{t('settings.unitsDisplay')}</SectionTitle>
      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t('settings.weight')}</span>
          <Segmented label={t('settings.weightUnit')} value={s.units.weight} onChange={(v) => set((x) => ({ ...x, units: { ...x.units, weight: v } }))} options={[{ value: 'kg', label: t('settings.kilograms') }, { value: 'lb', label: t('settings.pounds') }]} />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t('settings.heightMeasurements')}</span>
          <Segmented label={t('settings.lengthUnit')} value={s.units.length} onChange={(v) => set((x) => ({ ...x, units: { ...x.units, length: v } }))} options={[{ value: 'cm', label: t('settings.centimetres') }, { value: 'ftin', label: t('settings.feetInches') }]} />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t('settings.distance')}</span>
          <Segmented label={t('settings.distanceUnit')} value={s.units.distance} onChange={(v) => set((x) => ({ ...x, units: { ...x.units, distance: v } }))} options={[{ value: 'km', label: t('settings.kilometres') }, { value: 'mi', label: t('settings.miles') }]} />
        </div>
        <p className="text-xs text-muted">{t('settings.unitsHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          <Select label={t('settings.weekStart')} value={s.weekStart} onChange={(e) => set((x) => ({ ...x, weekStart: Number(e.target.value) as 0 | 1 }))}>
            <option value={1}>{t('settings.monday')}</option>
            <option value={0}>{t('settings.sunday')}</option>
          </Select>
          <Select label={t('settings.timeZone')} value={s.timeZone} onChange={(e) => set((x) => ({ ...x, timeZone: e.target.value }))}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-muted">{t('settings.timeZoneHint')}</p>
      </Card>

      <SectionTitle>{t('settings.workoutRest')}</SectionTitle>
      <Card className="px-4 py-2 divide-y divide-line">
        <div className="grid grid-cols-2 gap-3 py-3">
          <NumberInput label={t('settings.defaultRest')} value={s.rest.defaultSec} decimals={false} min={0} max={900} onChange={(v) => v != null && set((x) => ({ ...x, rest: { ...x.rest, defaultSec: v } }))} />
          <NumberInput label={t('settings.defaultSets')} value={s.workout.defaultSets} decimals={false} min={1} max={10} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, defaultSets: v } }))} />
          <NumberInput label={t('settings.barbellJumpKg')} value={s.workout.plateIncrementKg} min={0.25} max={20} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, plateIncrementKg: v } }))} />
          <NumberInput label={t('settings.barbellJumpLb')} value={s.workout.plateIncrementLb} min={0.5} max={45} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, plateIncrementLb: v } }))} />
          <NumberInput label={t('settings.emptyBarKg')} hint={t('settings.warmupHint')} value={s.workout.barKg ?? 20} min={0} max={30} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, barKg: v } }))} />
          <NumberInput label={t('settings.emptyBarLb')} hint={t('settings.warmupHint')} value={s.workout.barLb ?? 45} min={0} max={66} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, barLb: v } }))} />
        </div>
        <Toggle label={t('settings.autoRest')} checked={s.rest.autoStart} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, autoStart: v } }))} />
        <Toggle label={t('settings.restSound')} checked={s.rest.sound} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, sound: v } }))} />
        <Toggle label={t('settings.restVibrate')} description={t('settings.deviceSupport')} checked={s.rest.vibrate} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, vibrate: v } }))} />
        <Toggle label={t('settings.keepScreen')} description={t('settings.browserSupport')} checked={s.rest.keepAwake} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, keepAwake: v } }))} />
        <Toggle
          label={t('settings.cheers')}
          description={t('settings.cheersHint')}
          checked={s.workout.coachCheers !== false}
          onChange={(v) => set((x) => ({ ...x, workout: { ...x.workout, coachCheers: v } }))}
        />
        <Toggle
          label={t('settings.celebrations')}
          description={t('settings.celebrationsHint')}
          checked={s.workout.celebrations !== false}
          onChange={(v) => set((x) => ({ ...x, workout: { ...x.workout, celebrations: v } }))}
        />
        <Toggle label={t('settings.showRir')} description={t('settings.showRirHint')} checked={s.workout.showRir} onChange={(v) => set((x) => ({ ...x, workout: { ...x.workout, showRir: v } }))} />
        <p className="text-xs text-muted py-3">{t('settings.timerCaveat')}</p>
      </Card>

      <SectionTitle>{t('settings.privacy')}</SectionTitle>
      <Card className="px-4 py-2 divide-y divide-line">
        <Toggle
          label={t('settings.discoverable')}
          description={t('settings.discoverableHint')}
          checked={s.social.discoverable}
          onChange={async (v) => {
            await set((x) => ({ ...x, social: { ...x.social, discoverable: v } }));
            if (auth.status === 'signed_in' && auth.userId) updateDiscoverable(auth.userId, v).catch(() => toast.show(t('settings.profileUpdateFailed'), { tone: 'warn' }));
          }}
        />
        <div className="py-3 space-y-1.5">
          <span className="text-sm font-medium">{t('settings.defaultAudience')}</span>
          <Segmented<Audience> label={t('settings.audienceAria')} value={s.social.defaultAudience} onChange={(v) => set((x) => ({ ...x, social: { ...x.social, defaultAudience: v } }))} options={[{ value: 'friends', label: t('settings.friends') }, { value: 'only_me', label: t('settings.onlyMe') }]} />
        </div>
        <Toggle
          label={t('settings.autoShare')}
          description={t('settings.autoShareHint')}
          checked={s.social.autoShare.enabled}
          onChange={(v) => set((x) => ({ ...x, social: { ...x.social, autoShare: { ...x.social.autoShare, enabled: v } } }))}
        />
        {s.social.autoShare.enabled && (
          <div className="py-3 space-y-3">
            <Segmented<Audience> label={t('settings.autoShareAudience')} value={s.social.autoShare.audience} onChange={(v) => set((x) => ({ ...x, social: { ...x.social, autoShare: { ...x.social.autoShare, audience: v } } }))} options={[{ value: 'friends', label: t('settings.friends') }, { value: 'only_me', label: t('settings.onlyMe') }]} />
            {(
              [
                ['duration', 'settings.duration'],
                ['exerciseNames', 'settings.exerciseNames'],
                ['weightsReps', 'settings.weightsReps'],
                ['volume', 'settings.volumeDistance'],
                ['records', 'settings.records'],
              ] as [keyof ShareFields, MessageKey][]
            ).map(([k, label]) => (
              <Toggle key={k} label={t(label)} checked={s.social.autoShare.fields[k]} onChange={(v) => set((x) => ({ ...x, social: { ...x.social, autoShare: { ...x.social.autoShare, fields: { ...x.social.autoShare.fields, [k]: v } } } }))} />
            ))}
          </div>
        )}
        <Toggle
          label={t('settings.analytics')}
          description={t('settings.analyticsHint')}
          checked={analyticsEnabled(s)}
          onChange={async (v) => {
            await set((x) => ({ ...x, analytics: v }));
            if (!v) await clearAnalyticsQueue(db);
          }}
        />
      </Card>

      <SectionTitle>{t('settings.notifications')}</SectionTitle>
      <Card className="px-4 py-2 divide-y divide-line">
        <Toggle label={t('settings.friendNotifications')} checked={s.notifications.friendRequests} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, friendRequests: v } }))} />
        <Toggle label={t('settings.likes')} checked={s.notifications.likes} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, likes: v } }))} />
        <Toggle label={t('settings.comments')} checked={s.notifications.comments} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, comments: v } }))} />
        <Toggle label={t('settings.coachingUpdates')} checked={s.notifications.coaching !== false} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, coaching: v } }))} />
        <p className="text-xs text-muted py-3">{t('settings.notificationsHint')}</p>
      </Card>
      <PushSection />

      <SectionTitle>{t('settings.planNutrition')}</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        <div className="px-4">
          <Toggle label={t('settings.nutritionFeatures')} description={t('settings.nutritionHint')} checked={s.nutritionEnabled} onChange={(v) => set((x) => ({ ...x, nutritionEnabled: v }))} />
        </div>
        <ListRow title={t('settings.nutritionTargets')} right={<ChevronRight className="size-4" />} onClick={() => nav('/nutrition/targets')} />
        <ListRow title={t('settings.redoSetup')} subtitle={t('settings.redoSetupHint')} right={<ChevronRight className="size-4" />} onClick={() => nav('/onboarding')} />
        <ListRow title={t('train.programSchedule')} right={<ChevronRight className="size-4" />} onClick={() => nav('/train/program')} />
      </Card>

      <SectionTitle>{t('settings.app')}</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        <ListRow left={<Database className="size-5 text-muted" />} title={t('settings.yourData')} subtitle={t('settings.yourDataHint')} right={<ChevronRight className="size-4" />} onClick={() => nav('/settings/data')} />
        <UpdateCheckRow />
        <ListRow left={<Smartphone className="size-5 text-muted" />} title={t('settings.installPhone')} right={<ChevronRight className="size-4" />} onClick={() => nav('/install')} />
        {!db.isDemo && !signedIn && (
          <ListRow left={<FlaskConical className="size-5 text-muted" />} title={t('settings.demo')} subtitle={t('settings.demoHint')} right={<ChevronRight className="size-4" />} onClick={() => void enterDemo()} />
        )}
        <ListRow left={<Info className="size-5 text-muted" />} title={t('settings.about')} right={<ChevronRight className="size-4" />} onClick={() => setAbout(true)} />
      </Card>
      <p className="text-xs text-faint text-center mt-6">
        {BRAND.name} · v{__APP_VERSION__} · <Link to="/install" className="underline">{t('settings.install')}</Link>
      </p>

      <Sheet open={about} onClose={() => setAbout(false)} title={t('settings.aboutBrand', { brand: BRAND.name })}>
        <div className="space-y-3 text-sm">
          <BrandMoment />
          <p>{t('settings.aboutIdea', { brand: BRAND.name })}</p>
          <p>{t('settings.aboutRules')}</p>
          <ul className="list-disc pl-5 space-y-1.5 text-muted">
            <li>{t('settings.aboutSplits')}</li>
            <li>{progressionRuleText(isBeginner(account.profile.experience))}</li>
            <li>{t('settings.aboutProtein')}</li>
            <li>{t('settings.aboutEnergy')}</li>
            <li>{t('settings.aboutFood')}</li>
            <li>{t('settings.about1rm')}</li>
          </ul>
          <p className="text-muted">{t('settings.aboutExercise')}</p>
        </div>
      </Sheet>
    </Page>
  );
}

/** Placeholder marker: lets a translated sentence keep a styled element (e.g. the bold email) where {{email}} sits. */
const SLOT = '\u0001';
function withSlot(text: string, node: ReactNode): ReactNode {
  const i = text.indexOf(SLOT);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      {node}
      {text.slice(i + SLOT.length)}
    </>
  );
}
