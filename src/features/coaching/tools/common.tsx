/**
 * Shared pieces of the coach/client screens: access gating, async loading, sharing-scope editor,
 * "Not shared" panels, status badges, intake + check-in summaries and the coaching report sheet.
 * All user content is rendered as React text — never as HTML.
 */
import { useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ChevronLeft, EyeOff, HeartHandshake, Lock, WifiOff } from 'lucide-react';
import { Badge, Button, Card, ChipGroup, EmptyState, IconButton, Sheet, Spinner, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import type { CheckIn, CoachingIntake, ProposalStatus, SharingScopes } from '@/backend/coachingContract';
import type { WeightUnit } from '@/domain/types';
import { formatWeight } from '@/domain/units';
import { GOAL_TEXT, EXPERIENCE_TEXT } from '@/domain/program/explain';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { coachingError } from '@/coaching/errors';
import { SCOPE_INFO, SCOPE_KEYS, sameScopes } from '@/coaching/relationship';
import { authHref } from '@/features/auth/authReturn';

/* ================================================================ access */
export type CoachingAccess = 'personal' | 'loading' | 'guest' | 'expired' | 'offline' | 'ok';

export function useCoachingAccess(): { access: CoachingAccess; meId: string | undefined } {
  const { backendConfigured, auth, online } = useApp();
  let access: CoachingAccess = 'ok';
  if (!backendConfigured) access = 'personal';
  else if (auth.status === 'loading') access = 'loading';
  else if (auth.status === 'guest') access = 'guest';
  else if (auth.status === 'expired') access = 'expired';
  else if (!online) access = 'offline';
  return { access, meId: auth.status === 'signed_in' || auth.status === 'expired' ? auth.userId : undefined };
}

export function CoachingAccessNotice({ access, what = 'Coaching' }: { access: Exclude<CoachingAccess, 'ok'>; what?: string }) {
  const nav = useNavigate();
  const here = useLocation();
  const returnTo = here.pathname + here.search;
  switch (access) {
    case 'loading':
      return <Spinner />;
    case 'personal':
      return (
        <EmptyState
          icon={<HeartHandshake className="size-6" aria-hidden />}
          title="Coaching needs an account"
          body="Working with a coach is part of the account-based version of Hard Earned. Your workouts, programs and nutrition keep working on this device."
        />
      );
    case 'guest':
      return (
        <EmptyState
          icon={<HeartHandshake className="size-6" aria-hidden />}
          title="Sign in to work with a coach"
          body="Create an account to find a coach, share what you choose and get a plan built for you."
          action={
            <Button variant="primary" onClick={() => nav(authHref('signup', returnTo))}>
              Create an account
            </Button>
          }
        />
      );
    case 'expired':
      return (
        <EmptyState
          icon={<Lock className="size-6" aria-hidden />}
          title="Sign in again"
          body="Your session has expired. Sign in to use coaching. Your workouts still save on this device."
          action={
            <Button variant="primary" onClick={() => nav(authHref('signin', returnTo))}>
              Sign in
            </Button>
          }
        />
      );
    case 'offline':
      return <EmptyState icon={<WifiOff className="size-6" aria-hidden />} title="You’re offline" body={`${what} needs a connection. Your workouts and current plan still work offline.`} />;
  }
}

export function BackButton({ to }: { to?: string }) {
  const nav = useNavigate();
  return (
    <IconButton label="Back" onClick={() => (to ? nav(to) : nav(-1))}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
}

/* ================================================================ loading */
export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: (cur: T | undefined) => T | undefined) => void;
}

/** Run `fn` when `enabled` and deps change; keeps the last data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList, enabled = true, fallback = 'Couldn’t load this. Check your connection and try again.'): Loaded<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const v = await fn();
      if (n === seq.current) setDataState(v);
    } catch (e) {
      if (n === seq.current) setError(coachingError(e, fallback));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  const setData = useCallback((f: (cur: T | undefined) => T | undefined) => setDataState(f), []);
  return { data, error, loading: loading || (enabled && data === undefined && !error), reload, setData };
}

/** Scroll to the element named by location.hash once `ready` (react-router doesn't do this itself). */
export function useScrollToHash(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [ready, hash]);
}

/* ================================================================ dates */
export function fmtDateTime(iso: string | null | undefined, timeZone?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(t);
}
export function fmtDay(iso: string | null | undefined, timeZone?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(t);
}

/* ================================================================ scopes */
export function ScopeEditor({ scopes, onSave, disabled, clientView = true }: { scopes: SharingScopes; onSave: (s: SharingScopes) => Promise<void>; disabled?: boolean; clientView?: boolean }) {
  const [draft, setDraft] = useState<SharingScopes>(scopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [prevScopes, setPrevScopes] = useState<SharingScopes>(scopes);
  if (!sameScopes(prevScopes, scopes)) {
    setPrevScopes(scopes);
    setDraft(scopes);
  }
  const dirty = !sameScopes(draft, scopes);
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (e) {
      setError(coachingError(e, 'Your sharing settings weren’t saved. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-4 py-2">
      {SCOPE_KEYS.map((k) => (
        <div key={k} className="border-b border-line last:border-0 py-1">
          <Toggle
            checked={!!draft[k]}
            disabled={disabled || busy}
            onChange={(v) => {
              setSaved(false);
              setDraft({ ...draft, [k]: v });
            }}
            label={SCOPE_INFO[k].label}
            description={
              <>
                {SCOPE_INFO[k].reveals} <span className="text-faint">{SCOPE_INFO[k].needs}</span>
              </>
            }
          />
        </div>
      ))}
      {clientView && (
        <p className="text-xs text-muted py-2">
          Turning a category off takes effect immediately on the server: your coach can no longer see it, even in a screen they already have open. Being friends never gives
          anyone access to these records.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger pb-2">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p role="status" className="text-sm text-accent pb-2">
          Sharing updated.
        </p>
      )}
      <div className="flex justify-end gap-2 pb-2">
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(scopes)} disabled={busy}>
            Undo
          </Button>
        )}
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty || disabled}>
          Save sharing
        </Button>
      </div>
    </Card>
  );
}

/* ================================================================ panels */
export function NotShared({ who, what }: { who: string; what: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-line px-3.5 py-3 text-sm text-muted">
      <EyeOff className="size-4 shrink-0 mt-0.5" aria-hidden />
      <span>
        Not shared by {who}. {what} is visible only if {who} turns on this category in their sharing settings.
      </span>
    </div>
  );
}

/** Renders `children(value)` when the panel is permitted (non-null), otherwise a "Not shared" note. */
export function Panel<T>({ value, who, what, children }: { value: T | null | undefined; who: string; what: string; children: (v: T) => ReactNode }) {
  if (value === null || value === undefined) return <NotShared who={who} what={what} />;
  return <>{children(value)}</>;
}

const PROPOSAL_TONE: Record<ProposalStatus, 'neutral' | 'accent' | 'warn' | 'danger' | 'info'> = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'accent',
  declined: 'warn',
  withdrawn: 'neutral',
  superseded: 'neutral',
  invalid: 'danger',
};
const PROPOSAL_LABEL: Record<ProposalStatus, string> = {
  draft: 'Draft',
  sent: 'Waiting for response',
  accepted: 'Accepted',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
  invalid: 'Invalid',
};
export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return <Badge tone={PROPOSAL_TONE[status]}>{PROPOSAL_LABEL[status]}</Badge>;
}

/* ================================================================ intake */
const isGoal = (g?: string): g is keyof typeof GOAL_TEXT => !!g && g in GOAL_TEXT;
const isExp = (x?: string): x is keyof typeof EXPERIENCE_TEXT => !!x && x in EXPERIENCE_TEXT;

export function IntakeSummary({ intake, intro }: { intake: CoachingIntake; intro?: string }) {
  const rows: [string, string][] = [];
  if (intake.goal) rows.push(['Goal', isGoal(intake.goal) ? cap(GOAL_TEXT[intake.goal]) : intake.goal]);
  if (intake.secondaryGoal) rows.push(['Also', isGoal(intake.secondaryGoal) ? cap(GOAL_TEXT[intake.secondaryGoal]) : intake.secondaryGoal]);
  if (intake.experience) rows.push(['Experience', isExp(intake.experience) ? cap(EXPERIENCE_TEXT[intake.experience]) : intake.experience]);
  if (intake.daysPerWeek) rows.push(['Days per week', String(intake.daysPerWeek)]);
  if (intake.sessionMinutes) rows.push(['Session length', `${intake.sessionMinutes} min`]);
  if (intake.equipment?.length) rows.push(['Equipment', intake.equipment.map((e) => (EQUIPMENT_LABELS as Record<string, string>)[e] ?? e).join(', ')]);
  if (intake.limitations?.length) rows.push(['Areas to be careful with', intake.limitations.map((l) => (LIMITATION_LABELS as Record<string, string>)[l] ?? l).join(', ')]);
  if (intake.preferredFormat) rows.push(['Prefers', intake.preferredFormat === 'in_person' ? 'In person' : 'Online']);
  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">No intake details were shared.</p>
      )}
      {intake.notes && <p className="text-sm whitespace-pre-wrap break-words">{intake.notes}</p>}
      {intro && (
        <blockquote className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">
          <span className="sr-only">Intro message: </span>
          {intro}
        </blockquote>
      )}
    </div>
  );
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ================================================================ check-ins */
const SCALE: Record<'energy' | 'sleep' | 'soreness' | 'stress', string> = { energy: 'Energy', sleep: 'Sleep', soreness: 'Soreness', stress: 'Stress' };

export function CheckInAnswers({ c, unit }: { c: CheckIn; unit: WeightUnit }) {
  const a = c.answers;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ul className="flex flex-wrap gap-1.5" aria-label="Ratings from 1 to 5">
        {(Object.keys(SCALE) as (keyof typeof SCALE)[]).map((k) =>
          a[k] != null ? (
            <li key={k}>
              <Badge>
                {SCALE[k]} {a[k]}/5
              </Badge>
            </li>
          ) : null,
        )}
        {a.bodyweightKg != null && (
          <li>
            <Badge>Bodyweight {formatWeight(a.bodyweightKg, unit)}</Badge>
          </li>
        )}
      </ul>
      {a.wins && (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-muted">Wins: </span>
          {a.wins}
        </p>
      )}
      {a.struggles && (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-muted">Struggles: </span>
          {a.struggles}
        </p>
      )}
      {c.note && <p className="break-words whitespace-pre-wrap">{c.note}</p>}
    </div>
  );
}

/* ================================================================ report */
const REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'inappropriate', label: 'Inappropriate content' },
  { value: 'unsafe_advice', label: 'Unsafe advice' },
  { value: 'spam', label: 'Spam or scam' },
  { value: 'other', label: 'Something else' },
];

export function ReportCoachingSheet({ open, onClose, relationshipId, messageId, what }: { open: boolean; onClose: () => void; relationshipId: string; messageId?: string; what: string }) {
  const toast = useToast();
  const [reason, setReason] = useState<string | null>(null);
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
      await coachingApi.reportCoachingContent({ relationshipId, messageId, reason, details: details.trim() || undefined });
      toast.show('Thanks: your report was sent to our moderators.', { tone: 'success' });
      close();
    } catch (e) {
      setError(coachingError(e, 'Your report couldn’t be sent. Please try again.'));
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
      <p className="text-sm text-muted mb-3">Reports are private and go to Hard Earned moderators. The other person isn’t told who reported them.</p>
      <ChipGroup single label="Reason" values={reason ? [reason] : []} onChange={(v) => setReason(v[0] ?? null)} options={REASONS} />
      <Textarea className="mt-4" label="Details (optional)" maxLength={500} value={details} onChange={(e) => setDetails(e.target.value)} />
      {error && (
        <p role="alert" className="text-sm text-danger mt-2">
          {error}
        </p>
      )}
    </Sheet>
  );
}
