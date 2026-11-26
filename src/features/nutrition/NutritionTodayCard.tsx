import { useMemo } from 'react';
import { Link } from 'react-router';
import { ChevronRight, Plus, Utensils } from 'lucide-react';
import { Card } from '@/components/ui';
import { useApp } from '@/state/app';
import { todayISO } from '@/lib/dates';
import { dayTotals } from '@/domain/nutrition/log';
import { MacroProgress, useDayEntries } from './shared';
import { displayMacro } from '@/domain/nutrition/recipes';
import { useT } from '@/i18n';

/** Compact nutrition summary for the Today screen. Renders nothing when nutrition is off. */
export function NutritionTodayCard() {
  const { account } = useApp();
  const { t: tr } = useT();
  const enabled = account.settings.nutritionEnabled && account.nutrition.mode !== 'none';
  const today = todayISO(account.settings.timeZone);
  const entries = useDayEntries(today);
  const totals = useMemo(() => dayTotals(entries ?? []), [entries]);
  if (!enabled) return null;
  const t = account.nutrition;
  const hasTargets = t.proteinG != null || (t.mode !== 'protein_only' && t.calories != null);
  return (
    <Card as="section" className="p-4" tint="2" aria-labelledby="today-nutrition">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 id="today-nutrition" className="flex items-center gap-2 font-semibold">
          <Utensils className="size-4 text-accent" aria-hidden /> {tr('today.nutrition')}
        </h2>
        <Link to="/nutrition" className="inline-flex items-center gap-0.5 text-sm text-muted hover:text-ink min-h-9 px-1">
          {tr('today.nutritionDetails')} <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      {entries === undefined ? (
        <div className="h-12" aria-hidden />
      ) : hasTargets ? (
        <MacroProgress totals={totals} targets={t} compact />
      ) : (
        <p className="text-sm text-muted">
          {totals.entries
            ? tr(totals.missing.kcal ? 'today.nutritionLoggedMinimum' : 'today.nutritionLogged', { kcal: totals.kcal, protein: displayMacro(totals.protein, 'protein') })
            : tr('today.nutritionEmpty')}
        </p>
      )}
      <Link
        to={`/nutrition/log?date=${today}`}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 min-h-11 rounded-xl bg-surface-2 border border-line text-[15px] hover:bg-surface-3"
      >
        <Plus className="size-4" aria-hidden /> {tr('today.logFood')}
      </Link>
    </Card>
  );
}
