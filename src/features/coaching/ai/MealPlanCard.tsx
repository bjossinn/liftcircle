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
import { kvGet, kvSet, newRecord, saveRecord } from '@/db/repo';
import { formatDate, todayISO } from '@/lib/dates';
import { displayMacro, MEAL_LABELS } from '@/domain/nutrition/recipes';
import { extraText, type PlanDay } from '@/domain/nutrition/mealplan';
import {
  applyMealPlanSuggestion, isMealPlanApplied, previewMealPlan, undoMealPlanSuggestion, type MealPlanApplyMode, type MealPlanSuggestion,
} from '@/domain/nutrition/aiActions';
import { RECIPES_BY_ID } from '@/data/recipes';
import type { MealPlan } from '@/domain/types';
import { prefsFromAccount, useWeekPlan } from '@/features/nutrition/shared';

const undoKey = (id: string) => `ai-mealplan-undo:${id}`;

export function MealPlanCard({ plan: s }: { plan: MealPlanSuggestion }) {
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
        toast.show('Those days already have meals. Nothing to add.', { tone: 'info' });
        return;
      }
      if (!r.alreadyApplied) {
        await saveRecord('meal_plans', existing ? ({ ...existing, ...r.plan } as MealPlan) : newRecord(r.plan), db);
        await kvSet(undoKey(s.id), r.snapshot, db).catch(() => undefined);
        toast.show(`Added to your meal plan (${r.touched.length} day${r.touched.length === 1 ? '' : 's'})`, { tone: 'success' });
      }
      then?.();
    } catch {
      toast.show('Could not save the plan. Please try again.', { tone: 'error' });
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
      toast.show('Meal plan put back as it was.');
    } catch {
      toast.show('Could not undo. Please try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Suggested meal plan" className="mt-2 rounded-2xl border border-accent/40 bg-accent-soft px-3.5 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Salad className="size-5 text-accent shrink-0" aria-hidden />
        <h3 className="font-semibold text-[15px] flex-1">Meal plan · {d(s.weekStart)} – {d(s.weekEnd)}</h3>
        {applied && <Badge tone="info">Added</Badge>}
      </div>
      {s.summary && <p className="text-sm mb-1.5">{s.summary}</p>}
      <ul className="space-y-2" aria-label="Days">
        {preview.days.map((day, i) => {
          const st = preview.status.days[i];
          const ok = st.state === 'on_target' && st.kcalState !== 'low' && st.kcalState !== 'high';
          return (
            <li key={day.date} data-testid="ai-mealplan-day" className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{d(day.date)}</span>
                <span className={ok ? 'text-success text-xs' : 'text-muted text-xs'} data-testid="ai-mealplan-totals">
                  <strong>{displayMacro(st.totals.protein, 'protein')} g</strong> protein{st.proteinTarget != null ? ` / ${st.proteinTarget} g` : ''} · {displayMacro(st.totals.kcal, 'kcal')} kcal
                  {st.kcalTarget != null ? ` / ${st.kcalTarget}` : ''}
                  {st.proteinTarget != null && (ok ? ' ✓' : st.state === 'short' ? ` · ${st.proteinGap} g short` : '')}
                </span>
              </div>
              <ul className="text-xs text-muted">
                {day.items.map((it) => (
                  <li key={it.id}>
                    {MEAL_LABELS[it.slot]}: {RECIPES_BY_ID.get(it.recipeId)?.name ?? 'Recipe'}
                    {it.servings !== 1 ? ` ×${it.servings}` : ''}
                    {it.extras?.[0] ? ` + ${extraText(it.extras[0])}` : ''}
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
      {noTargets && <p className="text-xs text-muted mt-1.5">No protein target is set in the app right now, so totals aren’t compared with a target.</p>}
      <div className="mt-2 space-y-2">
        {expired ? (
          <p className="text-xs text-faint">This plan’s week is over.</p>
        ) : applied ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => nav(`/nutrition/plan?week=${s.weekStart}`)}>
              Open meal plan
            </Button>
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} loading={busy} onClick={() => void undo()}>
              Undo
            </Button>
          </div>
        ) : (
          <>
            {overlaps && (
              <Segmented<MealPlanApplyMode>
                size="sm"
                label="How to add it"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'replace', label: 'Replace these days' },
                  { value: 'empty', label: 'Only empty days' },
                ]}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy} disabled={existing === undefined} onClick={() => void apply()}>
                Add to my meal plan
              </Button>
              <Button size="sm" variant="secondary" disabled={busy || existing === undefined} onClick={() => void apply(() => nav(`/nutrition/plan?week=${s.weekStart}`))}>
                Customize first
              </Button>
            </div>
          </>
        )}
        {!account.settings.nutritionEnabled && !applied && <Notice tone="info">Nutrition features are off in Settings. The plan is saved, but turn them on to see it in the Nutrition tab.</Notice>}
      </div>
    </section>
  );
}
