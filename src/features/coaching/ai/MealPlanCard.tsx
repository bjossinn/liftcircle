/**
 * "Add to my meal plan" card for an AI meal plan suggestion (ai_messages.action kind 'meal_plan').
 * The preview balances each suggested day with the app's own balanceDay and shows planStatus totals vs the CURRENT
 * targets, so the numbers match what gets saved. Nothing changes until the user taps a button; applying is local-first
 * (saveRecord), idempotent (tagged item ids) and has Undo (snapshot of the touched days kept on this device).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Salad, Undo2 } from 'lucide-react';
import { Badge, Button, Notice, Segmented } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { trackAiAction } from '@/analytics/analytics';
import { kvGet, kvSet, newRecord, saveRecord } from '@/db/repo';
import { formatDate, todayISO } from '@/lib/dates';
import { displayMacro, mealLabel } from '@/domain/nutrition/recipes';
import { numberText, useT } from '@/i18n';
import { extraText, type PlanDay } from '@/domain/nutrition/mealplan';
import {
  applyMealPlanSuggestion, isMealPlanApplied, previewMealPlan, undoMealPlanSuggestion, type MealPlanApplyMode, type MealPlanSuggestion,
} from '@/domain/nutrition/aiActions';
import { RECIPES_BY_ID } from '@/data/recipes';
import type { MealPlan } from '@/domain/types';
import { prefsFromAccount, useWeekPlan } from '@/features/nutrition/shared';

const undoKey = (id: string) => `ai-mealplan-undo:${id}`;

export function MealPlanCard({ plan: s }: { plan: MealPlanSuggestion }) {
  const { t, tp, language } = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { account, db } = useApp();
  const existing = useWeekPlan(s.weekStart);
  const prefs = useMemo(() => prefsFromAccount(account), [account]);
  const preview = useMemo(() => previewMealPlan(s, prefs), [s, prefs]);
  const today = todayISO(account.settings.timeZone);
  const applied = isMealPlanApplied(existing, s.id);
  const expired = s.weekEnd < today;
  const overlaps = !!existing && s.days.some((d) => (existing.days.find((x) => x.date === d.date)?.items.length ?? 0) > 0);
  const [mode, setMode] = useState<MealPlanApplyMode>('replace');
  const [busy, setBusy] = useState(false);
  const noTargets = prefs.proteinTarget == null;
  const d = (x: string) => formatDate(x, { weekday: 'short', day: 'numeric', month: 'short' });

  async function apply(then?: () => void) {
    if (existing === undefined) return;
    setBusy(true);
    try {
      const r = applyMealPlanSuggestion(existing, s, overlaps ? mode : 'replace', prefs);
      if (!r) {
        toast.show(t('aiCard.mealPlan.nothingToAdd'), { tone: 'info' });
        return;
      }
      if (!r.alreadyApplied) {
        await saveRecord('meal_plans', existing ? ({ ...existing, ...r.plan } as MealPlan) : newRecord(r.plan), db);
        await kvSet(undoKey(s.id), r.snapshot, db).catch(() => undefined);
        void trackAiAction(db, 'meal_plan', 'applied');
        toast.show(tp('aiCard.mealPlan.addedDays', r.touched.length), { tone: 'success' });
      }
      then?.();
    } catch {
      toast.show(t('aiCard.mealPlan.saveError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!existing) return;
    setBusy(true);
    try {
      const snapshot = (await kvGet<PlanDay[]>(undoKey(s.id), db).catch(() => undefined)) ?? [];
      await saveRecord('meal_plans', undoMealPlanSuggestion(existing, s.id, snapshot), db);
      void trackAiAction(db, 'meal_plan', 'reverted');
      toast.show(t('aiCard.mealPlan.restored'));
    } catch {
      toast.show(t('aiCard.mealPlan.undoError'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={t('aiCard.mealPlan.title')} className="mt-2 rounded-2xl border border-accent/40 bg-accent-soft px-3.5 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Salad className="size-5 text-accent shrink-0" aria-hidden />
        <h3 className="font-semibold text-[15px] flex-1">{t('aiCard.mealPlan.dateRange', { fromDate: d(s.weekStart), toDate: d(s.weekEnd) })}</h3>
        {applied && <Badge tone="info">{t('aiCard.mealPlan.added')}</Badge>}
      </div>
      {s.summary && <p className="text-sm mb-1.5">{s.summary}</p>}
      <ul className="space-y-2" aria-label={t('aiCard.mealPlan.days')}>
        {preview.days.map((day, i) => {
          const st = preview.status.days[i];
          const ok = st.state === 'on_target' && st.kcalState !== 'low' && st.kcalState !== 'high';
          return (
            <li key={day.date} data-testid="ai-mealplan-day" className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{d(day.date)}</span>
                <span className={ok ? 'text-success text-xs' : 'text-muted text-xs'} data-testid="ai-mealplan-totals">
                  <strong>
                    {st.proteinTarget != null
                      ? t('aiCard.mealPlan.proteinTarget', { protein: displayMacro(st.totals.protein, 'protein'), target: st.proteinTarget })
                      : t('aiCard.mealPlan.protein', { protein: displayMacro(st.totals.protein, 'protein') })}
                  </strong>
                  {` · ${numberText(displayMacro(st.totals.kcal, 'kcal'))} kcal`}
                  {st.kcalTarget != null ? ` / ${numberText(st.kcalTarget)}` : ''}
                  {st.proteinTarget != null && (ok ? ' ✓' : st.state === 'short' ? ` · ${t('aiCard.mealPlan.proteinGap', { grams: st.proteinGap ?? 0 })}` : '')}
                </span>
              </div>
              <ul className="text-xs text-muted">
                {day.items.map((it) => (
                  <li key={it.id}>
                    {mealLabel(it.slot, language)}: {RECIPES_BY_ID.get(it.recipeId)?.name ?? t('aiCard.mealPlan.recipeFallback')}
                    {it.servings !== 1 ? ` ×${numberText(it.servings)}` : ''}
                    {it.extras?.[0] ? ` + ${extraText(it.extras[0], undefined, language)}` : ''}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {s.warnings.map((w, i) => (
        <p key={i} className="text-xs text-warn mt-1">
          {w}
        </p>
      ))}
      {noTargets && <p className="text-xs text-muted mt-1.5">{t('aiCard.mealPlan.noTarget')}</p>}
      <div className="mt-2 space-y-2">
        {expired ? (
          <p className="text-xs text-faint">{t('aiCard.mealPlan.expired')}</p>
        ) : applied ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => nav(`/nutrition/plan?week=${s.weekStart}`)}>
              {t('aiCard.mealPlan.open')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} loading={busy} onClick={() => void undo()}>
              {t('aiCard.undo')}
            </Button>
          </div>
        ) : (
          <>
            {overlaps && (
              <Segmented<MealPlanApplyMode>
                size="sm"
                label={t('aiCard.mealPlan.modeLabel')}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'replace', label: t('aiCard.mealPlan.replace') },
                  { value: 'empty', label: t('aiCard.mealPlan.emptyOnly') },
                ]}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy} disabled={existing === undefined} onClick={() => void apply()}>
                {t('aiCard.mealPlan.add')}
              </Button>
              {/* Adds the plan, then opens it to edit. (It used to say "Customize first", which read as a draft, but the
                  meal plan screen has no draft mode, so the label now says what happens; Undo stays on this card.) */}
              <Button size="sm" variant="secondary" disabled={busy || existing === undefined} onClick={() => void apply(() => nav(`/nutrition/plan?week=${s.weekStart}`))}>
                {t('aiCard.mealPlan.addEdit')}
              </Button>
            </div>
          </>
        )}
        {!account.settings.nutritionEnabled && !applied && <Notice tone="info">{t('aiCard.mealPlan.disabled')}</Notice>}
      </div>
    </section>
  );
}
