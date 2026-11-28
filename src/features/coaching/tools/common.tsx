/**
 * Shared pieces of the coach/client screens: access gating, async loading, sharing-scope editor,
 * "Not shared" panels, status badges, intake + check-in summaries and the coaching report sheet.
 * All user content is rendered as React text — never as HTML.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ChevronLeft, EyeOff, HeartHandshake, Lock, WifiOff } from 'lucide-react';
import { Badge, Button, Card, ChipGroup, EmptyState, IconButton, Sheet, Spinner, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import type { CheckIn, CoachingIntake, ProposalStatus, SharingScopes } from '@/backend/coachingContract';
import type { WeightUnit } from '@/domain/types';
import { formatWeight } from '@/domain/units';
import { GOAL_TEXT, EXPERIENCE_TEXT, experienceText, goalText } from '@/domain/program/explain';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { coachingError } from '@/coaching/errors';
import { SCOPE_INFO, SCOPE_KEYS, sameScopes } from '@/coaching/relationship';
import { authHref } from '@/features/auth/authReturn';
import { locale, t as tNow, useT, type MessageKey } from '@/i18n';

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

/** `what` is a translated, capitalized noun phrase (Icelandic: nominative singular, e.g. “Þjálfun”). */
export function CoachingAccessNotice({ access, what }: { access: Exclude<CoachingAccess, 'ok'>; what?: string }) {
  const { t } = useT();
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
          title={t('coaching.editor.coaching_needs_an_account')}
          body={t('coaching.editor.working_with_a_coach_is_part')}
        />
      );
    case 'guest':
      return (
        <EmptyState
          icon={<HeartHandshake className="size-6" aria-hidden />}
          title={t('coaching.editor.sign_in_to_work_with_a')}
          body={t('coaching.editor.create_an_account_to_find_a')}
          action={
            <Button variant="primary" onClick={() => nav(authHref('signup', returnTo))}>
              {t('coaching.editor.create_an_account')}
            </Button>
          }
        />
      );
    case 'expired':
      return (
        <EmptyState
          icon={<Lock className="size-6" aria-hidden />}
          title={t('settings.signInAgain')}
          body={t('coaching.directory.your_session_has_expired_sign_in')}
          action={
            <Button variant="primary" onClick={() => nav(authHref('signin', returnTo))}>
              {t('settings.signIn')}
            </Button>
          }
        />
      );
    case 'offline':
      return <EmptyState icon={<WifiOff className="size-6" aria-hidden />} title={t('ai.unavailable.offline.title')} body={t('coaching.editor.x_needs_a_connection_your_workouts', { what: what ?? t('coaching.editor.what_coaching') })} />;
  }
}

export function BackButton({ to }: { to?: string }) {
  const nav = useNavigate();
  const { t } = useT();
  return (
    <IconButton label={t('common.back')} onClick={() => (to ? nav(to) : nav(-1))}>
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
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList, enabled = true, fallback = tNow('coaching.editor.couldnt_load_this')): Loaded<T> {
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
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(t);
}
export function fmtDay(iso: string | null | undefined, timeZone?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!isFinite(t)) return '';
  return new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(t);
}

/* ================================================================ scopes */
export function ScopeEditor({ scopes, onSave, disabled, clientView = true }: { scopes: SharingScopes; onSave: (s: SharingScopes) => Promise<void>; disabled?: boolean; clientView?: boolean }) {
  const { t } = useT();
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
      setError(coachingError(e, t('coaching.editor.sharing_not_saved')));
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
          {t('coaching.editor.turning_a_category_off_takes_effect')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger pb-2">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p role="status" className="text-sm text-accent pb-2">
          {t('coaching.editor.sharing_updated')}
        </p>
      )}
      <div className="flex justify-end gap-2 pb-2">
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(scopes)} disabled={busy}>
            {t('workout.undo')}
          </Button>
        )}
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty || disabled}>
          {t('coaching.editor.save_sharing')}
        </Button>
      </div>
    </Card>
  );
}

/* ================================================================ panels */
export function NotShared({ who, what }: { who: string; what: string }) {
  const { t } = useT();
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-line px-3.5 py-3 text-sm text-muted">
      <EyeOff className="size-4 shrink-0 mt-0.5" aria-hidden />
      <span>
        {t('coaching.editor.not_shared_by', { name: who, what })}
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
export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  const { t } = useT();
  return <Badge tone={PROPOSAL_TONE[status]}>{t(`coaching.proposal.status.${status}`)}</Badge>;
}

/* ================================================================ intake */
const isGoal = (g?: string): g is keyof typeof GOAL_TEXT => !!g && g in GOAL_TEXT;
const isExp = (x?: string): x is keyof typeof EXPERIENCE_TEXT => !!x && x in EXPERIENCE_TEXT;

export function IntakeSummary({ intake, intro }: { intake: CoachingIntake; intro?: string }) {
  const { t, language } = useT();
  const rows: [string, string][] = [];
  if (intake.goal) rows.push([t('coaching.directory.goal'), isGoal(intake.goal) ? cap(goalText(intake.goal, language)) : intake.goal]);
  if (intake.secondaryGoal) rows.push([t('coaching.client.intake_also'), isGoal(intake.secondaryGoal) ? cap(goalText(intake.secondaryGoal, language)) : intake.secondaryGoal]);
  if (intake.experience) rows.push([t('onboarding.experience.group'), isExp(intake.experience) ? cap(experienceText(intake.experience, language)) : intake.experience]);
  if (intake.daysPerWeek) rows.push([t('coaching.client.intake_days_per_week'), String(intake.daysPerWeek)]);
  if (intake.sessionMinutes) rows.push([t('coaching.request.session_length'), t('coaching.client.x_min', { minutes: intake.sessionMinutes })]);
  if (intake.equipment?.length) rows.push([t('workout.picker.equipment'), intake.equipment.map((e) => (EQUIPMENT_LABELS as Record<string, string>)[e] ?? e).join(', ')]);
  if (intake.limitations?.length) rows.push([t('coaching.request.areas_to_be_careful_with'), intake.limitations.map((l) => (LIMITATION_LABELS as Record<string, string>)[l] ?? l).join(', ')]);
  if (intake.preferredFormat) rows.push([t('coaching.client.intake_prefers'), intake.preferredFormat === 'in_person' ? t('coaching.directory.in_person') : t('coaching.directory.online')]);
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
        <p className="text-sm text-muted">{t('coaching.editor.no_intake_details_were_shared')}</p>
      )}
      {intake.notes && <p className="text-sm whitespace-pre-wrap break-words">{intake.notes}</p>}
      {intro && (
        <blockquote className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">
          <span className="sr-only">{t('coaching.editor.intro_message')} </span>
          {intro}
        </blockquote>
      )}
    </div>
  );
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ================================================================ rich text */
/** Placeholder value that `withSlots` replaces by a React node (e.g. bold text inside a translated sentence). */
export const slot = (name: string) => `\u0001${name}\u0001`;
/** Renders a translated sentence, swapping each `slot(name)` for `nodes[name]`. */
export function withSlots(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/\u0001(\w+)\u0001/).map((part, i) => (i % 2 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}

/* ================================================================ check-ins */
const SCALE: Record<'energy' | 'sleep' | 'soreness' | 'stress', MessageKey> = {
  energy: 'activities.form.energy',
  sleep: 'coaching.client.scale_sleep',
  soreness: 'coaching.checkIn.soreness',
  stress: 'coaching.checkIn.stress',
};

export function CheckInAnswers({ c, unit }: { c: CheckIn; unit: WeightUnit }) {
  const { t } = useT();
  const a = c.answers;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ul className="flex flex-wrap gap-1.5" aria-label={t('coaching.editor.ratings_from_1_to_5')}>
        {(Object.keys(SCALE) as (keyof typeof SCALE)[]).map((k) =>
          a[k] != null ? (
            <li key={k}>
              <Badge>
                {t(SCALE[k])} {a[k]}/5
              </Badge>
            </li>
          ) : null,
        )}
        {a.bodyweightKg != null && (
          <li>
            <Badge>{t('coaching.client.bodyweight_x', { weight: formatWeight(a.bodyweightKg, unit) })}</Badge>
          </li>
        )}
      </ul>
      {a.wins && (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-muted">{t('coaching.editor.wins')} </span>
          {a.wins}
        </p>
      )}
      {a.struggles && (
        <p className="break-words whitespace-pre-wrap">
          <span className="text-muted">{t('coaching.editor.struggles')} </span>
          {a.struggles}
        </p>
      )}
      {c.note && <p className="break-words whitespace-pre-wrap">{c.note}</p>}
    </div>
  );
}

/* ================================================================ report */
const REASONS: { value: string; label: MessageKey }[] = [
  { value: 'harassment', label: 'coaching.editor.harassment_or_bullying' },
  { value: 'inappropriate', label: 'coaching.editor.inappropriate_content' },
  { value: 'unsafe_advice', label: 'coaching.editor.unsafe_advice' },
  { value: 'spam', label: 'coaching.editor.spam_or_scam' },
  { value: 'other', label: 'coaching.editor.something_else' },
];

export function ReportCoachingSheet({ open, onClose, relationshipId, messageId, what }: { open: boolean; onClose: () => void; relationshipId: string; messageId?: string; what: string }) {
  const { t } = useT();
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
      toast.show(t('coaching.editor.thanks_your_report_was_sent_to'), { tone: 'success' });
      close();
    } catch (e) {
      setError(coachingError(e, t('coaching.editor.report_not_sent')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('coaching.editor.report_x', { what })}
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
      <p className="text-sm text-muted mb-3">{t('coaching.editor.reports_are_private_and_go_to')}</p>
      <ChipGroup single label={t('coaching.editor.reason')} values={reason ? [reason] : []} onChange={(v) => setReason(v[0] ?? null)} options={REASONS.map((r) => ({ value: r.value, label: t(r.label) }))} />
      <Textarea className="mt-4" label={t('coaching.editor.details_optional')} maxLength={500} value={details} onChange={(e) => setDetails(e.target.value)} />
      {error && (
        <p role="alert" className="text-sm text-danger mt-2">
          {error}
        </p>
      )}
    </Sheet>
  );
}
