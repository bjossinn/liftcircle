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
import { AllergenNote, useWeekPlan } from './shared';

export default function ShoppingListPage() {
  const nav = useNavigate();
  const { account, db } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const thisWeek = startOfWeek(todayISO(account.settings.timeZone), account.settings.weekStart);
  const weekParam = params.get('week');
  const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : thisWeek;
  const plan = useWeekPlan(weekStart);
  const [copyText, setCopyText] = useState<string | null>(null);
  const groups = useMemo(() => (plan ? buildShoppingList(plan, RECIPES_BY_ID) : []), [plan]);
  const checked = plan?.shoppingChecked ?? [];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const done = groups.reduce((n, g) => n + g.items.filter((i) => checked.includes(i.ingredientId)).length, 0);

  async function toggle(id: ID) {
    if (!plan) return;
    const next = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id];
    try {
      await saveRecord('meal_plans', { ...plan, shoppingChecked: next }, db);
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    }
  }
  async function clearTicks() {
    if (plan) await saveRecord('meal_plans', { ...plan, shoppingChecked: [] }, db);
  }
  async function copy() {
    const text = shoppingListText(groups, checked, `Shopping list – week of ${formatDate(weekStart)}`);
    try {
      await navigator.clipboard.writeText(text);
      toast.show('Copied to clipboard', { tone: 'success' });
    } catch {
      setCopyText(text); // Clipboard blocked: show the text so it can be copied manually.
    }
  }

  return (
    <Page
      title="Shopping list"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <IconButton label="Previous week" onClick={() => setParams({ week: addDays(weekStart, -7) }, { replace: true })}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <div className="text-center font-semibold">{weekStart === thisWeek ? 'This week' : `Week of ${formatDate(weekStart)}`}</div>
        <IconButton label="Next week" onClick={() => setParams({ week: addDays(weekStart, 7) }, { replace: true })}>
          <ChevronRight className="size-5" />
        </IconButton>
      </div>

      {plan === undefined ? (
        <Spinner />
      ) : plan === null || total === 0 ? (
        <Card>
          <EmptyState
            title="No meal plan for this week"
            body="Generate a week plan and its ingredients are added up here."
            action={
              <Link to="/nutrition/plan" className="inline-flex items-center min-h-11 px-4 rounded-xl bg-accent text-accent-ink font-semibold">
                Go to meal plan
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" icon={<ClipboardCopy className="size-4" />} onClick={copy}>
              Copy as text
            </Button>
            <Button icon={<RotateCcw className="size-4" />} onClick={clearTicks} disabled={done === 0}>
              Clear ticks
            </Button>
          </div>
          <p className="text-xs text-muted mt-2 px-1" aria-live="polite">
            {done} of {total} items ticked
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
                              on ? 'bg-accent border-accent text-accent-ink' : 'border-line',
                            )}
                          >
                            {on && <Check className="size-4" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cx('block text-[15px]', on && 'line-through text-muted')}>{i.name}</span>
                            <span className="block text-xs text-muted truncate">
                              {i.display}
                              {i.convertedFrom ? ` · as bought (recipes use ${INGREDIENTS_BY_ID.get(i.convertedFrom)?.name.toLowerCase()})` : ''}
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
            Amounts are totals for the planned servings, rounded, using dry or raw weights as bought. Round up to pack sizes and check labels, especially for allergens.
          </Notice>
          <AllergenNote className="mt-2 px-1" />
        </>
      )}

      <Sheet open={copyText !== null} onClose={() => setCopyText(null)} title="Copy shopping list">
        <Textarea label="Select all and copy" readOnly value={copyText ?? ''} className="min-h-72" onFocus={(e) => e.currentTarget.select()} />
      </Sheet>
    </Page>
  );
}
