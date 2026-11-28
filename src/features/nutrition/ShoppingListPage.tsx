import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Check, ChevronLeft, ChevronRight, ClipboardCopy, RotateCcw } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Notice, Page, SectionTitle, Sheet, Spinner, Textarea, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { saveRecord } from '@/db/repo';
import { addDays, formatDate, startOfWeek, todayISO } from '@/lib/dates';
import type { ID } from '@/domain/types';
import { INGREDIENTS_BY_ID } from '@/data/ingredients';
import { RECIPES_BY_ID } from '@/data/recipes';
import { buildShoppingList, shoppingListText } from '@/domain/nutrition/mealplan';
import { ingredientDisplayName } from '@/data/catalogText';
import { useT } from '@/i18n';
import { AllergenNote, useWeekPlan } from './shared';

export default function ShoppingListPage() {
  const nav = useNavigate();
  const { account, db } = useApp();
  const toast = useToast();
  const { t, language, locale } = useT();
  const [params, setParams] = useSearchParams();
  const thisWeek = startOfWeek(todayISO(account.settings.timeZone), account.settings.weekStart);
  const weekParam = params.get('week');
  const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : thisWeek;
  const plan = useWeekPlan(weekStart);
  const [copyText, setCopyText] = useState<string | null>(null);
  const groups = useMemo(() => (plan ? buildShoppingList(plan, RECIPES_BY_ID, undefined, language) : []), [plan, language]);
  const checked = plan?.shoppingChecked ?? [];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const done = groups.reduce((n, g) => n + g.items.filter((i) => checked.includes(i.ingredientId)).length, 0);

  async function toggle(id: ID) {
    if (!plan) return;
    const next = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id];
    try {
      await saveRecord('meal_plans', { ...plan, shoppingChecked: next }, db);
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    }
  }
  async function clearTicks() {
    if (plan) await saveRecord('meal_plans', { ...plan, shoppingChecked: [] }, db);
  }
  async function copy() {
    const text = shoppingListText(groups, checked, t('nutrition.shopping.copy_title', { date: formatDate(weekStart) }));
    try {
      await navigator.clipboard.writeText(text);
      toast.show(t('nutrition.shopping.copied_to_clipboard'), { tone: 'success' });
    } catch {
      setCopyText(text); // Clipboard blocked: show the text so it can be copied manually.
    }
  }

  return (
    <Page
      title={t('nutrition.mealPlan.shopping_list')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)} iconSize="lg">
          <ChevronLeft />
        </IconButton>
      }
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <IconButton label={t('nutrition.mealPlan.previous_week')} onClick={() => setParams({ week: addDays(weekStart, -7) }, { replace: true })}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <div className="text-center font-semibold">{weekStart === thisWeek ? t('today.thisWeek') : t('nutrition.mealPlan.week_of_x', { date: formatDate(weekStart) })}</div>
        <IconButton label={t('format.relative.nextWeek')} onClick={() => setParams({ week: addDays(weekStart, 7) }, { replace: true })}>
          <ChevronRight className="size-5" />
        </IconButton>
      </div>

      {plan === undefined ? (
        <Spinner />
      ) : plan === null || total === 0 ? (
        <Card>
          <EmptyState
            title={t('nutrition.shopping.no_meal_plan_for_this_week')}
            body={t('nutrition.shopping.generate_a_week_plan_and_its')}
            action={
              <Link to="/nutrition/plan" className="inline-flex items-center min-h-11 px-4 rounded-xl ember-fill font-semibold">
                {t('nutrition.shopping.go_to_meal_plan')}
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" icon={<ClipboardCopy className="size-4" />} onClick={copy}>
              {t('nutrition.shopping.copy_as_text')}
            </Button>
            <Button icon={<RotateCcw className="size-4" />} onClick={clearTicks} disabled={done === 0}>
              {t('nutrition.shopping.clear_ticks')}
            </Button>
          </div>
          <p className="text-xs text-muted mt-2 px-1" aria-live="polite">
            {t('nutrition.shopping.items_ticked', { done, total })}
          </p>
          {groups.map((g) => (
            <section key={g.category} aria-labelledby={`g-${g.category}`}>
              <SectionTitle id={`g-${g.category}`}>{g.label}</SectionTitle>
              <Card>
                <ul className="divide-y divide-line">
                  {g.items.map((i) => {
                    const on = checked.includes(i.ingredientId);
                    return (
                      <li key={i.ingredientId}>
                        <label className="flex items-center gap-3 px-4 py-2.5 min-h-14 cursor-pointer hover:bg-surface-2">
                          <input type="checkbox" className="sr-only peer" checked={on} onChange={() => toggle(i.ingredientId)} />
                          <span
                            aria-hidden
                            className={cx(
                              'size-6 shrink-0 rounded-md border flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                              on ? 'bg-ember border-edge text-accent-ink' : 'border-line',
                            )}
                          >
                            {on && <Check className="size-4" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cx('block text-[15px]', on && 'line-through text-muted')}>{i.name}</span>
                            <span className="block text-xs text-muted truncate">
                              {i.convertedFrom && INGREDIENTS_BY_ID.has(i.convertedFrom)
                                ? t('nutrition.shopping.as_bought_recipes_use_x', {
                                    amount: i.display,
                                    ingredient: ingredientDisplayName(i.convertedFrom, language).toLocaleLowerCase(locale),
                                  })
                                : i.display}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
          <Notice className="mt-4">
            {t('nutrition.shopping.amounts_note')}
          </Notice>
          <AllergenNote className="mt-2 px-1" />
        </>
      )}

      <Sheet open={copyText !== null} onClose={() => setCopyText(null)} title={t('nutrition.shopping.copy_shopping_list')}>
        <Textarea label={t('nutrition.shopping.select_all_and_copy')} readOnly value={copyText ?? ''} className="min-h-72" onFocus={(e) => e.currentTarget.select()} />
      </Sheet>
    </Page>
  );
}
