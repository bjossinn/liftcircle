/**
 * Shared pieces of the social screens: access states, avatars, time formatting, snapshot
 * rendering and the report sheet. All user content is rendered as React text — never as HTML.
 */
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Activity, Dumbbell, Trophy, Users, WifiOff, Clock, Lock } from 'lucide-react';
import { Button, ChipGroup, EmptyState, Sheet, Spinner, Textarea, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import type { ReportInput } from '@/backend/contract';
import { socialApi } from '@/backend/social';
import type { SocialProfile, WorkoutSnapshot } from '@/domain/types';
import { formatDate, formatMinutes } from '@/lib/dates';
import { friendlyError } from '@/social/pendingPosts';
import { authHref } from '@/features/auth/authReturn';
import { ACTIVITY_LABELS } from '@/social/snapshot';
import { locale, numberText, t, useT, type Language, type MessageKey } from '@/i18n';

/* ================================================================ access */
export type SocialAccess = 'personal' | 'loading' | 'guest' | 'expired' | 'offline' | 'ok';

export function useSocialAccess(): { access: SocialAccess; meId: string | undefined } {
  const { backendConfigured, auth, online } = useApp();
  let access: SocialAccess = 'ok';
  if (!backendConfigured) access = 'personal';
  else if (auth.status === 'loading') access = 'loading';
  else if (auth.status === 'guest') access = 'guest';
  else if (auth.status === 'expired') access = 'expired';
  else if (!online) access = 'offline';
  return { access, meId: auth.status === 'signed_in' ? auth.userId : undefined };
}

/** Which screen an offline notice is about (each has its own full sentence, so word order works in every language). */
export type OfflineWhat = 'feed' | 'friends' | 'notifications' | 'moderation' | 'profiles' | 'edit_profile' | 'post';

/** Friendly explanation for every state in which social features can't be used right now. */
export function AccessNotice({ access, what = 'feed', guestTitle }: { access: Exclude<SocialAccess, 'ok'>; what?: OfflineWhat; guestTitle?: string }) {
  const nav = useNavigate();
  const { t } = useT();
  const here = useLocation();
  const returnTo = here.pathname + here.search;
  switch (access) {
    case 'loading':
      return <Spinner />;
    case 'personal':
      return (
        <EmptyState
          icon={<Users className="size-6" aria-hidden />}
          title={t('social.sharing_needs_an_account')}
          body={t('social.friends_the_feed_and_photo_posts')}
        />
      );
    case 'guest':
      return (
        <EmptyState
          icon={<Users className="size-6" aria-hidden />}
          title={guestTitle ?? t('social.access.train_together')}
          body={t('social.share_finished_workouts_and_photos_with')}
          action={
            <Button variant="primary" onClick={() => nav(authHref('signup', returnTo))}>
              {t('social.create_an_account_to_share_with')}
            </Button>
          }
        />
      );
    case 'expired':
      return (
        <EmptyState
          icon={<Lock className="size-6" aria-hidden />}
          title={t('settings.signInAgain')}
          body={t('social.your_session_has_expired_sign_in')}
          action={
            <Button variant="primary" onClick={() => nav(authHref('signin', returnTo))}>
              {t('settings.signIn')}
            </Button>
          }
        />
      );
    case 'offline':
      return <EmptyState icon={<WifiOff className="size-6" aria-hidden />} title={t('ai.unavailable.offline.title')} body={t(`social.offline.${what}`)} />;
  }
}

/* ================================================================ avatar */
type ProfileLike = Pick<SocialProfile, 'displayName' | 'username'> & { avatarUrl?: string | null };

export function Avatar({ profile, size = 40, className }: { profile?: ProfileLike | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const name = profile?.displayName || profile?.username || '?';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) };
  if (profile?.avatarUrl && !broken) {
    return <img src={profile.avatarUrl} alt="" width={size} height={size} style={style} onError={() => setBroken(true)} className={cx('rounded-full object-cover bg-surface-3 shrink-0', className)} />;
  }
  return (
    <span aria-hidden style={style} className={cx('rounded-full bg-accent-soft text-accent font-semibold inline-flex items-center justify-center shrink-0', className)}>
      {initials || '?'}
    </span>
  );
}

/* ================================================================ time */
export function timeAgo(iso: string, now = Date.now(), language?: Language): string {
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return t('format.relative.justNow', undefined, language);
  if (s < 3600) return t('social.time.minutes_ago', { count: Math.floor(s / 60) }, language);
  if (s < 86400) return t('social.time.hours_ago', { count: Math.floor(s / 3600) }, language);
  if (s < 7 * 86400) return t('social.time.days_ago', { count: Math.floor(s / 86400) }, language);
  return new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' }).format(ms);
}
export function fullDate(iso: string, language?: Language): string {
  const ms = Date.parse(iso);
  return isFinite(ms) ? new Intl.DateTimeFormat(locale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(ms) : '';
}

export function Time({ iso, className }: { iso: string; className?: string }) {
  const { language } = useT();
  return (
    <time dateTime={iso} title={fullDate(iso, language)} className={className}>
      {timeAgo(iso, Date.now(), language)}
    </time>
  );
}

/* ================================================================ snapshot */
const MAX_EXERCISES_COLLAPSED = 5;

/** Snapshot text is stored canonical English: show built-in labels in the reader's language, user text as stored. */
function snapshotTitle(snapshot: WorkoutSnapshot, language: Language): string {
  const type = snapshot.activity?.type;
  if (snapshot.kind === 'activity' && type && (type === 'custom' ? snapshot.title === ACTIVITY_LABELS.custom : snapshot.title === ACTIVITY_LABELS[type])) {
    return t(`program.activity.${type}`, undefined, language);
  }
  if (snapshot.kind === 'workout' && snapshot.title === 'Workout') return t('train.historyWorkout', undefined, language);
  return snapshot.title;
}

export function SnapshotView({ snapshot, className }: { snapshot: WorkoutSnapshot; className?: string }) {
  const { t, tp, language } = useT();
  const [expanded, setExpanded] = useState(false);
  const exercises = snapshot.exercises ?? [];
  const shown = expanded ? exercises : exercises.slice(0, MAX_EXERCISES_COLLAPSED);
  const Icon = snapshot.kind === 'activity' ? Activity : snapshot.kind === 'achievement' ? Trophy : Dumbbell;
  const stats: { label: string; value: string }[] = [];
  if (snapshot.durationSec) stats.push({ label: t('workout.share.duration'), value: formatMinutes(snapshot.durationSec, language) });
  if (snapshot.activity?.distance) stats.push({ label: t('workout.share.distance'), value: snapshot.activity.distance });
  if (snapshot.activity?.pace) stats.push({ label: snapshot.activity.pace.includes('/h') || snapshot.activity.pace.includes('mph') ? t('summary.speed') : t('summary.pace'), value: snapshot.activity.pace });
  if (snapshot.volume) stats.push({ label: t('workout.share.volume'), value: `${numberText(snapshot.volume.value, 0, true, language)} ${snapshot.volume.unit}` });
  if (snapshot.exercises?.length) stats.push({ label: t('summary.exercises'), value: String(snapshot.exercises.length) });
  const title = snapshotTitle(snapshot, language);

  return (
    <div className={cx('rounded-xl bg-surface-2 border border-line p-3', className)}>
      <div className="flex items-center gap-2.5">
        <span className="size-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="font-semibold truncate">
            {snapshot.kind === 'activity' ? title : t('social.completed_x', { title })}
          </p>
          <p className="text-xs text-muted">{formatDate(snapshot.date, { weekday: 'long', day: 'numeric', month: 'short' }, language)}</p>
        </div>
      </div>

      {stats.length > 0 && (
        <dl className="grid grid-cols-3 gap-2 mt-3">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <dt className="text-[11px] text-muted">{s.label}</dt>
              <dd className="text-[15px] font-semibold tabular truncate">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {snapshot.volume && (
        <p className="text-[11px] text-faint mt-1">
          {snapshot.volume.convention === 'Free-weight working sets' ? t('social.snapshot.free_weight_sets') : snapshot.volume.convention}
        </p>
      )}

      {shown.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {shown.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">{e.name}</span>
              {e.sets && e.sets.length > 0 && (
                <span className="text-muted">
                  {': '}
                  {e.sets
                    .map((s) => [s.weight, s.reps != null ? (s.weight ? `× ${s.reps}` : tp('social.snapshot.reps', s.reps)) : null, s.duration].filter(Boolean).join(' '))
                    .join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {exercises.length > MAX_EXERCISES_COLLAPSED && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 min-h-11 text-sm text-accent font-medium" aria-expanded={expanded}>
          {expanded ? t('social.show_less') : t('social.show_all_x_exercises', { count: exercises.length })}
        </button>
      )}

      {snapshot.records && snapshot.records.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1" aria-label={t('workout.share.records')}>
          {snapshot.records.map((r, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <Trophy className="size-4 text-warn shrink-0" aria-hidden />
              <span>
                <span className="font-medium">{r.exercise}</span> <span className="text-muted">{r.label}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ================================================================ report */
const REASONS: { value: ReportInput['reason']; label: MessageKey }[] = [
  { value: 'spam', label: 'social.spam' },
  { value: 'harassment', label: 'coaching.editor.harassment_or_bullying' },
  { value: 'inappropriate', label: 'coaching.editor.inappropriate_content' },
  { value: 'other', label: 'coaching.editor.something_else' },
];
const REPORT_TITLES = {
  post: 'social.report_post',
  comment: 'social.report_comment',
  profile: 'social.report_profile',
  'coach profile': 'social.report_coach_profile',
} as const satisfies Record<string, MessageKey>;

export function ReportSheet({ open, onClose, target, what }: { open: boolean; onClose: () => void; target: Omit<ReportInput, 'reason' | 'details'>; what: keyof typeof REPORT_TITLES }) {
  const { t } = useT();
  const toast = useToast();
  const [reason, setReason] = useState<ReportInput['reason'] | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setReason(null);
    setDetails('');
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await socialApi.report({ ...target, reason, details: details.trim() || undefined });
      toast.show(t('coaching.editor.thanks_your_report_was_sent_to'), { tone: 'success' });
      close();
    } catch (e) {
      setError(friendlyError(e, t('social.report.send_failed')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title={t(REPORT_TITLES[what])}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={submit} loading={busy} disabled={!reason}>
            {t('coaching.editor.send_report')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-3">{t('social.reports_are_private_the_person_wont')}</p>
      <ChipGroup
        single
        label={t('coaching.editor.reason')}
        values={reason ? [reason] : []}
        onChange={(v) => setReason(v[0] ?? null)}
        options={REASONS.map((r) => ({ value: r.value, label: t(r.label) }))}
      />
      <Textarea
        className="mt-4"
        label={t('coaching.editor.details_optional')}
        maxLength={500}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        placeholder={t('social.anything_that_helps_us_understand')}
      />
      {error && (
        <p role="alert" className="text-sm text-danger mt-2">
          {error}
        </p>
      )}
    </Sheet>
  );
}

/* ================================================================ usernames */
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export function usernameProblem(u: string): string | null {
  if (!u) return t('social.username.choose');
  if (u.length < 3) return t('social.at_least_chars', { min: 3 });
  if (u.length > 20) return t('social.at_most_chars', { max: 20 });
  if (!USERNAME_RE.test(u)) return t('social.username.chars');
  return null;
}

/* ================================================================ interests */
/** Preset training interests: stored as these English values, shown translated. Custom interests are user text. */
export const PRESET_INTERESTS = ['Strength', 'Muscle building', 'Powerlifting', 'Running', 'Cycling', 'Walking', 'Hiking', 'Swimming', 'Mobility', 'Yoga', 'Calisthenics', 'Conditioning', 'Sports'];
const INTEREST_KEYS: Record<string, MessageKey> = {
  Strength: 'social.interest.strength',
  'Muscle building': 'social.interest.muscle_building',
  Powerlifting: 'social.interest.powerlifting',
  Running: 'social.interest.running',
  Cycling: 'social.interest.cycling',
  Walking: 'social.interest.walking',
  Hiking: 'social.interest.hiking',
  Swimming: 'social.interest.swimming',
  Mobility: 'social.interest.mobility',
  Yoga: 'social.interest.yoga',
  Calisthenics: 'social.interest.calisthenics',
  Conditioning: 'social.interest.conditioning',
  Sports: 'social.interest.sports',
};
export function interestLabel(interest: string, language?: Language): string {
  const key = INTEREST_KEYS[interest];
  return key ? t(key, undefined, language) : interest;
}

/* ================================================================ misc */
export function PendingBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warn">
      <Clock className="size-3.5" aria-hidden />
      {children}
    </span>
  );
}

/** Copy/share a profile link. Uses the native share sheet when available. */
export async function shareLink(url: string, title: string, toast: ReturnType<typeof useToast>) {
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({ title, url });
      return;
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.show(t('social.link_copied'), { tone: 'success' });
  } catch {
    toast.show(t('social.copy_this_link_x', { url }), { duration: 10000 });
  }
}
