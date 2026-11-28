/**
 * "Which proteins do you like?" — the one picker used in setup, plan preferences, the meal plan and the recipes screen.
 * Each chip cycles: neutral → like (filled) → not for me (crossed out) → neutral. It's a taste preference, kept apart
 * from allergies (those stay a safety filter with their own wording).
 */
import { useId, useState, type ComponentType } from 'react';
import { Bean, Beef, Bird, Check, Drumstick, Dumbbell, Egg, Fish, FishSymbol, Ham, Leaf, Milk, Shell, Shrimp, Sprout, Vegan, X } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import type { DietPrefs, ProteinGroup, ProteinPrefs } from '@/domain/types';
import { cycleProteinChoice, normalizeProteinPrefs, proteinChoice, proteinGroupLabel, PROTEIN_GROUPS, type ProteinChoice } from '@/domain/nutrition/recipes';
import { proteinExampleText } from '@/data/catalogText';
import { getLanguage, locale, t as tNow, useT, type Language } from '@/i18n';

const ICONS: Record<ProteinGroup, ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  chicken: Drumstick,
  turkey: Bird,
  beef: Beef,
  pork: Ham,
  lamb: Beef,
  white_fish: Fish,
  oily_fish: FishSymbol,
  tuna: Fish,
  prawns: Shrimp,
  shellfish: Shell,
  eggs: Egg,
  dairy: Milk,
  tofu_tempeh: Vegan,
  beans_lentils: Bean,
  chickpeas: Leaf,
  whey: Dumbbell,
  plant_protein: Sprout,
};

/** Chip state names in the current language (read at render). */
export const CHOICE_TEXT: Readonly<Record<ProteinChoice, string>> = {
  get like() {
    return tNow('nutrition.protein.choice.like');
  },
  get exclude() {
    return tNow('nutrition.protein.choice.exclude');
  },
  get neutral() {
    return tNow('nutrition.protein.choice.neutral');
  },
};

export function ProteinPicker({
  value,
  onChange,
  hint: hintProp,
  groups = PROTEIN_GROUPS,
}: {
  value: Partial<ProteinPrefs> | undefined;
  onChange: (next: ProteinPrefs) => void;
  hint?: string | null;
  groups?: ProteinGroup[];
}) {
  const hintId = useId();
  const { t, language } = useT();
  const hint = hintProp === undefined ? t('nutrition.protein.hint') : hintProp;
  return (
    <div className="flex flex-col gap-2">
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-2" aria-label={t('nutrition.mealPlan.proteins')}>
        {groups.map((g) => {
          const choice = proteinChoice(value, g);
          const Icon = ICONS[g];
          const label = proteinGroupLabel(g, language);
          return (
            <li key={g}>
              <button
                type="button"
                data-choice={choice}
                aria-label={t('nutrition.protein.chip_label', { protein: label, choice: CHOICE_TEXT[choice] })}
                aria-describedby={hint ? hintId : undefined}
                title={proteinExampleText(g, language)}
                onClick={() => onChange(cycleProteinChoice(value, g))}
                className={cx(
                  'w-full min-h-12 rounded-xl border px-3 py-2 text-left flex items-center gap-2 text-sm transition-colors',
                  choice === 'like' && 'bg-accent-soft border-accent text-ink font-semibold',
                  choice === 'exclude' && 'border-line bg-surface-2 text-muted',
                  choice === 'neutral' && 'border-line bg-surface hover:bg-surface-2',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cx('block leading-tight', choice === 'exclude' && 'line-through')}>{label}</span>
                  {choice !== 'neutral' && <span className="block text-[11px] leading-tight mt-0.5 no-underline">{CHOICE_TEXT[choice]}</span>}
                </span>
                {choice === 'like' && <Check className="size-4 shrink-0" aria-hidden />}
                {choice === 'exclude' && <X className="size-4 shrink-0" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Likes chicken, eggs · Not for me: prawns" (empty string when there are no preferences). */
export function proteinPrefsSummary(p: Partial<ProteinPrefs> | undefined, lang: Language = getLanguage()): string {
  const n = normalizeProteinPrefs(p);
  const names = (gs: ProteinGroup[]) => gs.map((g) => proteinGroupLabel(g, lang).toLocaleLowerCase(locale(lang))).join(', ');
  return [
    n.liked.length ? tNow('nutrition.protein.summary_likes', { proteins: names(n.liked) }, lang) : '',
    n.excluded.length ? tNow('nutrition.protein.summary_not_for_me', { proteins: names(n.excluded) }, lang) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The "Proteins" sheet on the meal plan and recipes screens: the same picker as setup. Saving keeps the current plan; when there is one, it then
 * offers to rebuild the plan with the new choices (nothing changes until the user confirms).
 */
export function ProteinsForm({ hasPlan, busy, onRebuild, onDone }: { hasPlan: boolean; busy: boolean; onRebuild: (diet: DietPrefs) => void | Promise<void>; onDone: () => void }) {
  const { account, updateAccount } = useApp();
  const toast = useToast();
  const { t } = useT();
  const [value, setValue] = useState<ProteinPrefs>(() => normalizeProteinPrefs(account.profile.diet.proteinPrefs));
  const [saved, setSaved] = useState<DietPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  const before = JSON.stringify(normalizeProteinPrefs(account.profile.diet.proteinPrefs));
  const changed = JSON.stringify(normalizeProteinPrefs(value)) !== before;
  async function save() {
    setSaving(true);
    try {
      const diet: DietPrefs = { ...account.profile.diet, proteinPrefs: normalizeProteinPrefs(value) };
      await updateAccount((a) => ({ ...a, profile: { ...a.profile, diet: { ...a.profile.diet, proteinPrefs: diet.proteinPrefs } } }));
      if (hasPlan) setSaved(diet);
      else {
        toast.show(t('nutrition.protein.protein_choices_saved'), { tone: 'success' });
        onDone();
      }
    } catch {
      toast.show(t('foodLog.saveError'), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  }
  if (saved)
    return (
      <div className="flex flex-col gap-4" role="status">
        <p className="text-sm">{t('nutrition.protein.saved_your_current_plan_stays_as')}</p>
        <div className="flex flex-col gap-2">
          <Button variant="primary" loading={busy} onClick={() => onRebuild(saved)}>
            {t('nutrition.protein.rebuild_meal_plan_with_these')}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            {t('nutrition.protein.keep_current_plan')}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <ProteinPicker value={value} onChange={setValue} />
      <p className="text-xs text-muted">{t('nutrition.protein.not_for_me_proteins_never_appear')}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={save} loading={saving} disabled={!changed}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
