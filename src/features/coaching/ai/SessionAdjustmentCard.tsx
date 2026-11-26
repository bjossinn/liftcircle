/**
 * "Apply to today's workout" card for an AI session_adjustment (roadmap item 7): swap one exercise or shorten what's
 * left, for TODAY ONLY. Applying changes only the live WorkoutSession on this device (src/domain/sessionAdjust.ts); the
 * saved plan, its templates and future sessions never change. Undo restores exactly what was removed or replaced.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, Timer, Repeat, Undo2 } from 'lucide-react';
import { Badge, Button, Notice } from '@/components/ui';
import { useToast } from '@/components/toast';
import { trackAiAction } from '@/analytics/analytics';
import type { LiftDb } from '@/db/db';
import { kvGet } from '@/db/repo';
import { useExercises } from '@/data/catalog';
import { useT } from '@/i18n';
import { adjustmentBlocker, adjustmentLines } from '@/domain/sessionAdjust';
import type { SessionAdjustmentAction } from '../../../../supabase/functions/_shared/ai/workout';
import { AI_SESSION_ADJUST_KEY, applyAdjustment, revertAdjustment, type AdjustRecords } from './sessionAdjustStore';

export function SessionAdjustmentCard({ action, db }: { action: SessionAdjustmentAction; db: LiftDb }) {
  const { t } = useT();
  const toast = useToast();
  const nav = useNavigate();
  const { byId } = useExercises();
  const [busy, setBusy] = useState(false);
  const session = useLiveQuery(async () => (await db.sessions.get(action.sessionId)) ?? null, [db, action.sessionId]);
  const recs = useLiveQuery(async () => (await kvGet<AdjustRecords>(AI_SESSION_ADJUST_KEY, db).catch(() => undefined)) ?? {}, [db]);
  const rec = recs?.[action.id];
  const applied = !!rec && !rec.revertedAt;
  const blocker = session === undefined ? null : adjustmentBlocker(session, action);
  const lines = adjustmentLines(action);
  const swap = action.change === 'swap';

  async function apply() {
    setBusy(true);
    try {
      const r = await applyAdjustment(db, action, byId, lines);
      if (!r.ok) {
        toast.show(r.reason, { tone: 'error' });
        return;
      }
      void trackAiAction(db, 'session_adjustment', 'applied');
      toast.show(swap ? t('aiCard.session.swapped') : t('aiCard.session.shortened'), {
        tone: 'success',
        action: { label: t('aiCard.session.back'), onClick: () => nav(`/train/session/${action.sessionId}`) },
      });
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    setBusy(true);
    try {
      const r = await revertAdjustment(db, action.id);
      if (!r.ok) {
        toast.show(r.reason, { tone: 'error' });
        return;
      }
      void trackAiAction(db, 'session_adjustment', 'reverted');
      toast.show(t('aiCard.session.restored'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t('aiCard.session.title')} className="mt-2 rounded-2xl border border-accent/40 bg-accent-soft px-3.5 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        {swap ? <Repeat className="size-5 text-accent shrink-0" aria-hidden /> : <Timer className="size-5 text-accent shrink-0" aria-hidden />}
        <h3 className="font-semibold text-[15px] flex-1">{swap ? t('aiCard.session.swap') : action.minutes ? t('aiCard.session.shorterMinutes', { minutes: action.minutes }) : t('aiCard.session.shorten')}</h3>
        {applied && <Badge tone="info">{t('ai.proposal.status.accepted')}</Badge>}
      </div>
      {session && <p className="text-xs text-muted mb-1">{session.name}</p>}
      <ul className="text-sm space-y-0.5 list-disc pl-5" aria-label={t('aiCard.session.changes')}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {!swap && action.estimatedMinutes != null && <p className="text-xs text-muted mt-1">{t('aiCard.session.remaining', { minutes: action.estimatedMinutes })}</p>}
      {action.warnings.map((w, i) => (
        <p key={i} className="text-xs text-warn mt-1">
          {w}
        </p>
      ))}
      <p className="text-xs text-muted mt-1.5">{t('aiCard.session.onlyToday')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {applied ? (
          <>
            {!blocker && (
              <Button size="sm" variant="primary" icon={<ArrowRight className="size-4" />} onClick={() => nav(`/train/session/${action.sessionId}`)}>
                {t('aiCard.session.back')}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} loading={busy} disabled={!!blocker} onClick={() => void undo()}>
              {t('aiCard.undo')}
            </Button>
          </>
        ) : blocker ? (
          <Notice className="w-full text-xs">{blocker}</Notice>
        ) : (
          <Button size="sm" variant="primary" loading={busy} disabled={session === undefined || recs === undefined} onClick={() => void apply()}>
            {t('aiCard.session.apply')}
          </Button>
        )}
      </div>
    </section>
  );
}
