import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight, Database, FlaskConical, Info, Smartphone, UserRound } from 'lucide-react';
import { useApp } from '@/state/app';
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

export default function SettingsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { account, updateAccount, auth, backendConfigured, db } = useApp();
  const s = account.settings;
  const set = (fn: (s: Settings) => Settings) => updateAccount((a) => ({ ...a, settings: fn(a.settings) })).catch((e) => toast.show((e as Error).message, { tone: 'error' }));
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
      title="Settings"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <SectionTitle>Account</SectionTitle>
      <Card className="p-4 space-y-3">
        {db.isDemo ? (
          <>
            <p className="text-sm">You’re viewing demo data. Your real records are untouched.</p>
            <Button onClick={() => void exitDemo()}>Exit demo</Button>
          </>
        ) : signedIn ? (
          <>
            <p className="text-sm">
              Signed in{auth.email ? <> as <span className="font-medium">{auth.email}</span></> : ''}.{auth.status === 'expired' && ' Your session expired: sign in again to resume backup.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {auth.status === 'expired' && (
                <Button variant="primary" onClick={() => nav('/auth?reauth=1')}>
                  Sign in again
                </Button>
              )}
              <Button icon={<UserRound className="size-4" />} onClick={() => nav('/profile/edit')}>
                Social profile
              </Button>
              <SignOutButton />
            </div>
          </>
        ) : backendConfigured ? (
          <>
            <p className="text-sm text-muted">You’re using {BRAND.name} without an account. Everything is saved on this device. Create an account to back up, use several devices and share with friends.</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => nav('/auth?mode=signup')}>
                Create account
              </Button>
              <Button onClick={() => nav('/auth')}>Sign in</Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">Personal mode: everything is saved on this device. Use Your data to back up.</p>
        )}
        <Input
          label="Your name (private)"
          defaultValue={account.profile.displayName}
          maxLength={40}
          onBlur={(e) => e.target.value !== account.profile.displayName && void updateAccount((a) => ({ ...a, profile: { ...a.profile, displayName: e.target.value.trim() } }))}
          hint="Shown only to you, e.g. on the Today screen. Your social profile has its own display name."
        />
      </Card>

      <SectionTitle id="appearance-title">Appearance</SectionTitle>
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

      <SectionTitle>Units & display</SectionTitle>
      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Weight</span>
          <Segmented label="Weight unit" value={s.units.weight} onChange={(v) => set((x) => ({ ...x, units: { ...x.units, weight: v } }))} options={[{ value: 'kg', label: 'Kilograms' }, { value: 'lb', label: 'Pounds' }]} />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Height & measurements</span>
          <Segmented label="Length unit" value={s.units.length} onChange={(v) => set((x) => ({ ...x, units: { ...x.units, length: v } }))} options={[{ value: 'cm', label: 'Centimetres' }, { value: 'ftin', label: 'Feet & inches' }]} />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Distance</span>
          <Segmented label="Distance unit" value={s.units.distance} onChange={(v) => set((x) => ({ ...x, units: { ...x.units, distance: v } }))} options={[{ value: 'km', label: 'Kilometres' }, { value: 'mi', label: 'Miles' }]} />
        </div>
        <p className="text-xs text-muted">Changing units only changes how numbers are shown. Your recorded values stay exactly as logged.</p>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Week starts on" value={s.weekStart} onChange={(e) => set((x) => ({ ...x, weekStart: Number(e.target.value) as 0 | 1 }))}>
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
          </Select>
          <Select label="Time zone" value={s.timeZone} onChange={(e) => set((x) => ({ ...x, timeZone: e.target.value }))}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-muted">Workouts keep the calendar date they were logged on, even if you change time zone later.</p>
      </Card>

      <SectionTitle>Workouts & rest timer</SectionTitle>
      <Card className="px-4 py-2 divide-y divide-line">
        <div className="grid grid-cols-2 gap-3 py-3">
          <NumberInput label="Default rest (s)" value={s.rest.defaultSec} decimals={false} min={0} max={900} onChange={(v) => v != null && set((x) => ({ ...x, rest: { ...x.rest, defaultSec: v } }))} />
          <NumberInput label="Default sets" value={s.workout.defaultSets} decimals={false} min={1} max={10} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, defaultSets: v } }))} />
          <NumberInput label="Barbell jump (kg)" value={s.workout.plateIncrementKg} min={0.25} max={20} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, plateIncrementKg: v } }))} />
          <NumberInput label="Barbell jump (lb)" value={s.workout.plateIncrementLb} min={0.5} max={45} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, plateIncrementLb: v } }))} />
          <NumberInput label="Empty bar (kg)" hint="Used for warm-ups" value={s.workout.barKg ?? 20} min={0} max={30} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, barKg: v } }))} />
          <NumberInput label="Empty bar (lb)" hint="Used for warm-ups" value={s.workout.barLb ?? 45} min={0} max={66} onChange={(v) => v != null && set((x) => ({ ...x, workout: { ...x.workout, barLb: v } }))} />
        </div>
        <Toggle label="Start rest timer after each set" checked={s.rest.autoStart} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, autoStart: v } }))} />
        <Toggle label="Sound when rest ends" checked={s.rest.sound} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, sound: v } }))} />
        <Toggle label="Vibrate when rest ends" description="Where your device supports it." checked={s.rest.vibrate} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, vibrate: v } }))} />
        <Toggle label="Keep screen on during workouts" description="Where your browser supports it." checked={s.rest.keepAwake} onChange={(v) => set((x) => ({ ...x, rest: { ...x.rest, keepAwake: v } }))} />
        <Toggle
          label="Workout cheers"
          description="A short line when you finish a set or your rest ends, in the style you chose for the training assistant. Works offline."
          checked={s.workout.coachCheers !== false}
          onChange={(v) => set((x) => ({ ...x, workout: { ...x.workout, coachCheers: v } }))}
        />
        <Toggle
          label="Celebrations"
          description="A brief burst for a new record or a finished workout, and a streak flame on Today."
          checked={s.workout.celebrations !== false}
          onChange={(v) => set((x) => ({ ...x, workout: { ...x.workout, celebrations: v } }))}
        />
        <Toggle label="Show reps-in-reserve column" description="Optional: how many more reps you could have done." checked={s.workout.showRir} onChange={(v) => set((x) => ({ ...x, workout: { ...x.workout, showRir: v } }))} />
        <p className="text-xs text-muted py-3">Web apps can’t always sound alarms while the phone is locked or the app is in the background. The timer always shows the correct time when you come back.</p>
      </Card>

      <SectionTitle>Sharing & privacy</SectionTitle>
      <Card className="px-4 py-2 divide-y divide-line">
        <Toggle
          label="Let people find me by username"
          description="Other members only see your username, display name, avatar, bio and interests, plus posts you share. Age, weight, measurements, injuries and food logs are never shown to other members; a coach you approve or the training assistant only sees the categories you agree to share."
          checked={s.social.discoverable}
          onChange={async (v) => {
            await set((x) => ({ ...x, social: { ...x.social, discoverable: v } }));
            if (auth.status === 'signed_in' && auth.userId) updateDiscoverable(auth.userId, v).catch(() => toast.show('Couldn’t update your profile on the server. Try again when online.', { tone: 'warn' }));
          }}
        />
        <div className="py-3 space-y-1.5">
          <span className="text-sm font-medium">Default audience for posts</span>
          <Segmented<Audience> label="Default audience" value={s.social.defaultAudience} onChange={(v) => set((x) => ({ ...x, social: { ...x.social, defaultAudience: v } }))} options={[{ value: 'friends', label: 'Friends' }, { value: 'only_me', label: 'Only me' }]} />
        </div>
        <Toggle
          label="Automatically share completed workouts"
          description="Off by default. When on, finished workouts and activities are posted with the details below. Photos are never added automatically."
          checked={s.social.autoShare.enabled}
          onChange={(v) => set((x) => ({ ...x, social: { ...x.social, autoShare: { ...x.social.autoShare, enabled: v } } }))}
        />
        {s.social.autoShare.enabled && (
          <div className="py-3 space-y-3">
            <Segmented<Audience> label="Auto-share audience" value={s.social.autoShare.audience} onChange={(v) => set((x) => ({ ...x, social: { ...x.social, autoShare: { ...x.social.autoShare, audience: v } } }))} options={[{ value: 'friends', label: 'Friends' }, { value: 'only_me', label: 'Only me' }]} />
            {(
              [
                ['duration', 'Duration'],
                ['exerciseNames', 'Exercise names'],
                ['weightsReps', 'Weights & reps'],
                ['volume', 'Volume / distance'],
                ['records', 'Personal records'],
              ] as [keyof ShareFields, string][]
            ).map(([k, label]) => (
              <Toggle key={k} label={label} checked={s.social.autoShare.fields[k]} onChange={(v) => set((x) => ({ ...x, social: { ...x.social, autoShare: { ...x.social.autoShare, fields: { ...x.social.autoShare.fields, [k]: v } } } }))} />
            ))}
          </div>
        )}
      </Card>

      <SectionTitle>Notifications</SectionTitle>
      <Card className="px-4 py-2 divide-y divide-line">
        <Toggle label="Friend requests & acceptances" checked={s.notifications.friendRequests} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, friendRequests: v } }))} />
        <Toggle label="Likes" checked={s.notifications.likes} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, likes: v } }))} />
        <Toggle label="Comments" checked={s.notifications.comments} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, comments: v } }))} />
        <Toggle label="Coaching updates" checked={s.notifications.coaching !== false} onChange={(v) => set((x) => ({ ...x, notifications: { ...x.notifications, coaching: v } }))} />
        <p className="text-xs text-muted py-3">These control in-app notifications. Coaching notifications never include message text.</p>
      </Card>
      <PushSection />

      <SectionTitle>Plan & nutrition</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        <div className="px-4">
          <Toggle label="Nutrition features" description="Protein target, meal ideas and food logging. Optional." checked={s.nutritionEnabled} onChange={(v) => set((x) => ({ ...x, nutritionEnabled: v }))} />
        </div>
        <ListRow title="Nutrition targets" right={<ChevronRight className="size-4" />} onClick={() => nav('/nutrition/targets')} />
        <ListRow title="Redo setup questions" subtitle="Get a new suggested program" right={<ChevronRight className="size-4" />} onClick={() => nav('/onboarding')} />
        <ListRow title="Program & schedule" right={<ChevronRight className="size-4" />} onClick={() => nav('/train/program')} />
      </Card>

      <SectionTitle>App</SectionTitle>
      <Card className="divide-y divide-line overflow-hidden">
        <ListRow left={<Database className="size-5 text-muted" />} title="Your data" subtitle="Backup, export, import, sync, delete account" right={<ChevronRight className="size-4" />} onClick={() => nav('/settings/data')} />
        <UpdateCheckRow />
        <ListRow left={<Smartphone className="size-5 text-muted" />} title="Install on your phone" right={<ChevronRight className="size-4" />} onClick={() => nav('/install')} />
        {!db.isDemo && !signedIn && (
          <ListRow left={<FlaskConical className="size-5 text-muted" />} title="Try with demo data" subtitle="Opens a separate, clearly labelled sample dataset" right={<ChevronRight className="size-4" />} onClick={() => void enterDemo()} />
        )}
        <ListRow left={<Info className="size-5 text-muted" />} title="About, formulas & sources" right={<ChevronRight className="size-4" />} onClick={() => setAbout(true)} />
      </Card>
      <p className="text-xs text-faint text-center mt-6">
        {BRAND.name} · v{__APP_VERSION__} · <Link to="/install" className="underline">Install</Link>
      </p>

      <Sheet open={about} onClose={() => setAbout(false)} title={`About ${BRAND.name}`}>
        <div className="space-y-3 text-sm">
          <BrandMoment />
          <p>{BRAND.name} is built around a straightforward idea: the work you put into training deserves a clear record. Tracking should feel useful, whether you’re learning your first exercises or working toward a long-held goal.</p>
          <p>Programs, progression and nutrition targets are generated by transparent rules. No AI service is involved. The numbers below are adjustable starting points, not medical advice.</p>
          <ul className="list-disc pl-5 space-y-1.5 text-muted">
            <li>Training splits, set and rep ranges are product defaults informed by mainstream resistance-training guidance (such as the American College of Sports Medicine’s), not claims of a uniquely optimal program.</li>
            <li>Progression uses double progression: reach the top of the rep range on every working set in two comparable sessions, then add the smallest practical load.</li>
            <li>Protein: 1.6–2.2 g per kg of reference bodyweight per day is a practical planning range for muscle gain (Morton et al., 2018, BJSM). 1.8 g/kg is our editable default.</li>
            <li>Resting energy: Mifflin–St Jeor equation (Mifflin et al., 1990). Activity factors and goal adjustments are adjustable assumptions.</li>
            <li>Food values: approximate generic values based on USDA FoodData Central. Always check labels for packaged foods and allergens.</li>
            <li>Estimated 1RM uses the Epley formula and is shown only for loaded exercises at 1–10 reps.</li>
          </ul>
          <p className="text-muted">Exercise descriptions are original. No third-party exercise images are used.</p>
        </div>
      </Sheet>
    </Page>
  );
}
