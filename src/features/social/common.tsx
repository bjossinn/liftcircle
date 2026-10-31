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

/** Friendly explanation for every state in which social features can't be used right now. */
export function AccessNotice({ access, what = 'The feed', guestTitle }: { access: Exclude<SocialAccess, 'ok'>; what?: string; guestTitle?: string }) {
  const nav = useNavigate();
  const here = useLocation();
  const returnTo = here.pathname + here.search;
  switch (access) {
    case 'loading':
      return <Spinner />;
    case 'personal':
      return (
        <EmptyState
          icon={<Users className="size-6" aria-hidden />}
          title="Sharing needs an account"
          body="Friends, the feed and photo posts are part of the account-based version of Hard Earned. Everything else, workouts, programs, nutrition and progress, works fully on this device."
        />
      );
    case 'guest':
      return (
        <EmptyState
          icon={<Users className="size-6" aria-hidden />}
          title={guestTitle ?? 'Train together'}
          body="Share finished workouts and photos with friends, and cheer each other on. Your workouts on this device can come with you."
          action={
            <Button variant="primary" onClick={() => nav(authHref('signup', returnTo))}>
              Create an account to share with friends
            </Button>
          }
        />
      );
    case 'expired':
      return (
        <EmptyState
          icon={<Lock className="size-6" aria-hidden />}
          title="Sign in again"
          body="Your session has expired. Sign in to use social features. Your workouts still save on this device."
          action={
            <Button variant="primary" onClick={() => nav(authHref('signin', returnTo))}>
              Sign in
            </Button>
          }
        />
      );
    case 'offline':
      return <EmptyState icon={<WifiOff className="size-6" aria-hidden />} title="You’re offline" body={`${what} needs a connection. Your workouts still save.`} />;
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
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' }).format(t);
}
export function fullDate(iso: string): string {
  const t = Date.parse(iso);
  return isFinite(t) ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(t) : '';
}

export function Time({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={fullDate(iso)} className={className}>
      {timeAgo(iso)}
    </time>
  );
}

/* ================================================================ snapshot */
const MAX_EXERCISES_COLLAPSED = 5;

export function SnapshotView({ snapshot, className }: { snapshot: WorkoutSnapshot; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const exercises = snapshot.exercises ?? [];
  const shown = expanded ? exercises : exercises.slice(0, MAX_EXERCISES_COLLAPSED);
  const Icon = snapshot.kind === 'activity' ? Activity : snapshot.kind === 'achievement' ? Trophy : Dumbbell;
  const stats: { label: string; value: string }[] = [];
  if (snapshot.durationSec) stats.push({ label: 'Duration', value: formatMinutes(snapshot.durationSec) });
  if (snapshot.activity?.distance) stats.push({ label: 'Distance', value: snapshot.activity.distance });
  if (snapshot.activity?.pace) stats.push({ label: snapshot.activity.pace.includes('/h') || snapshot.activity.pace.includes('mph') ? 'Speed' : 'Pace', value: snapshot.activity.pace });
  if (snapshot.volume) stats.push({ label: 'Volume', value: `${snapshot.volume.value.toLocaleString('en-GB')} ${snapshot.volume.unit}` });
  if (snapshot.exercises?.length) stats.push({ label: 'Exercises', value: String(snapshot.exercises.length) });

  return (
    <div className={cx('rounded-xl bg-surface-2 border border-line p-3', className)}>
      <div className="flex items-center gap-2.5">
        <span className="size-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="font-semibold truncate">
            {snapshot.kind === 'activity' ? snapshot.title : `Completed ${snapshot.title}`}
          </p>
          <p className="text-xs text-muted">{formatDate(snapshot.date, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
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
      {snapshot.volume && <p className="text-[11px] text-faint mt-1">{snapshot.volume.convention}</p>}

      {shown.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {shown.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="font-medium">{e.name}</span>
              {e.sets && e.sets.length > 0 && (
                <span className="text-muted">
                  {': '}
                  {e.sets
                    .map((s) => [s.weight, s.reps != null ? `${s.weight ? '× ' : ''}${s.reps}${s.weight ? '' : ' reps'}` : null, s.duration].filter(Boolean).join(' '))
                    .join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {exercises.length > MAX_EXERCISES_COLLAPSED && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 min-h-11 text-sm text-accent font-medium" aria-expanded={expanded}>
          {expanded ? 'Show less' : `Show all ${exercises.length} exercises`}
        </button>
      )}

      {snapshot.records && snapshot.records.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1" aria-label="Records">
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
const REASONS: { value: ReportInput['reason']; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'inappropriate', label: 'Inappropriate content' },
  { value: 'other', label: 'Something else' },
];

export function ReportSheet({ open, onClose, target, what }: { open: boolean; onClose: () => void; target: Omit<ReportInput, 'reason' | 'details'>; what: string }) {
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
      toast.show('Thanks: your report was sent to our moderators.', { tone: 'success' });
      close();
    } catch (e) {
      setError(friendlyError(e, 'Your report couldn’t be sent. Please try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Report ${what}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} loading={busy} disabled={!reason}>
            Send report
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-3">Reports are private. The person won’t know who reported them.</p>
      <ChipGroup single label="Reason" values={reason ? [reason] : []} onChange={(v) => setReason(v[0] ?? null)} options={REASONS} />
      <Textarea className="mt-4" label="Details (optional)" maxLength={500} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything that helps us understand" />
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
  if (!u) return 'Choose a username.';
  if (u.length < 3) return 'At least 3 characters.';
  if (u.length > 20) return 'At most 20 characters.';
  if (!USERNAME_RE.test(u)) return 'Use lowercase letters, numbers and underscores only.';
  return null;
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
    toast.show('Link copied', { tone: 'success' });
  } catch {
    toast.show(`Copy this link: ${url}`, { duration: 10000 });
  }
}
