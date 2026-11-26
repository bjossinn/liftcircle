/**
 * "Apply to this week" card for an AI this-week plan. Applying only writes date-specific schedule overrides
 * (src/domain/program/schedule.ts applyWeekPlan): the plan's content, frequency, split and version stay the same,
 * completed workouts are untouched, and next week returns to the usual schedule by itself.
 *
 * Coach-managed plans: allowed, because it is schedule-only — the same kind of change as skipping or moving a
 * missed session on Today, which the app already lets clients do. Session content is never changed here.
 */
import { useState } from 'react';
import { CalendarCheck, Undo2 } from 'lucide-react';
import { Badge, Button, Notice } from '@/components/ui';
import { useToast } from '@/components/toast';
import { saveRecord } from '@/db/repo';
import { trackAiAction } from '@/analytics/analytics';
import type { LiftDb } from '@/db/db';
import { applyWeekPlan, revertWeekPlan, weekPlanState, type WeekPlan } from '@/domain/program/schedule';
import type { ActivityLog, ISODate, Program, WorkoutSession } from '@/domain/types';
import { formatDate } from '@/lib/dates';
import { useT } from '@/i18n';
import { humanizeDates } from '../../../../supabase/functions/_shared/ai/humanDates';

export function WeekPlanCard({
  plan, program, sessions, activities, today, weekStart, db,
}: {
  plan: WeekPlan;
  program: Program | null | undefined;
  sessions: WorkoutSession[] | undefined;
  activities?: ActivityLog[];
  today: ISODate;
  weekStart: 0 | 1;
  db: LiftDb;
}) {
  const { t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const state = weekPlanState(program ?? undefined, plan, today, weekStart);
  const coach = program?.managedBy?.kind === 'coach' || plan.managedBy === 'coach';
  const d = (x: ISODate) => formatDate(x, { weekday: 'short', day: 'numeric', month: 'short' });

  async function apply() {
    if (!program || !sessions) return;
    setBusy(true);
    try {
      const r = applyWeekPlan(program, plan, today, sessions, weekStart, activities);
      if (!r.ok) {
        toast.show(r.message, { tone: 'error' });
        return;
      }
      if (!r.alreadyApplied) {
        await saveRecord('programs', r.program, db);
        void trackAiAction(db, 'week_plan', 'applied');
      }
      toast.show(r.message, { tone: 'success' });
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!program) return;
    setBusy(true);
    try {
      await saveRecord('programs', revertWeekPlan(program, plan.id), db);
      void trackAiAction(db, 'week_plan', 'reverted');
      toast.show(t('aiCard.week.restored'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t('aiCard.week.title')} className="mt-2 rounded-2xl border border-accent/40 bg-accent-soft px-3.5 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <CalendarCheck className="size-5 text-accent shrink-0" aria-hidden />
        <h3 className="font-semibold text-[15px] flex-1">{t('aiCard.week.onlyThisWeek')}</h3>
        {state === 'applied' && <Badge tone="info">{t('ai.proposal.status.accepted')}</Badge>}
      </div>
      <ol className="text-sm space-y-0.5 list-decimal pl-5">
        {plan.sessions.map((s) => (
          <li key={`${s.templateId}-${s.date}`}>
            <span className="font-medium">{s.name}</span>: {d(s.date)}
          </li>
        ))}
      </ol>
      {plan.sessions.length === 0 && <p className="text-sm">{t('aiCard.week.noneLeft')}</p>}
      {plan.completed.length > 0 && (
        <p className="text-xs text-muted mt-1.5">{t('aiCard.week.done', { sessions: plan.completed.map((c) => `${c.name} (${d(c.date)})`).join(', ') })}</p>
      )}
      {plan.skipped.length > 0 && <p className="text-xs text-muted mt-0.5">{t('aiCard.week.skipped', { sessions: plan.skipped.map((s) => s.name).join(', ') })}</p>}
      {plan.adjustments.length > 0 && (
        <ul className="text-xs text-muted mt-1 list-disc pl-4">
          {plan.adjustments.map((a, i) => (
            <li key={i}>{humanizeDates(a, today)}</li>
          ))}
        </ul>
      )}
      {plan.warnings.map((w, i) => (
        <p key={i} className="text-xs text-warn mt-1">
          {humanizeDates(w, today)}
        </p>
      ))}
      <p className="text-xs text-muted mt-1.5">
        {t('aiCard.week.planUnchanged')}
        {coach ? ` ${t('aiCard.week.coachUnchanged')}` : ''}
      </p>
      <div className="mt-2">
        {state === 'available' && (
          <Button size="sm" variant="primary" loading={busy} disabled={!program || !sessions} onClick={() => void apply()}>
            {t('aiCard.week.apply')}
          </Button>
        )}
        {state === 'applied' && (
          <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} loading={busy} onClick={() => void undo()}>
            {t('aiCard.undo')}
          </Button>
        )}
        {state === 'stale' && <Notice tone="warn">{t('aiCard.week.stale')}</Notice>}
        {state === 'expired' && <p className="text-xs text-faint">{t('aiCard.week.expired')}</p>}
      </div>
    </section>
  );
}
