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
import { cycleProteinChoice, normalizeProteinPrefs, proteinChoice, PROTEIN_GROUP_EXAMPLES, PROTEIN_GROUP_LABELS, PROTEIN_GROUPS, type ProteinChoice } from '@/domain/nutrition/recipes';

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

export const CHOICE_TEXT: Record<ProteinChoice, string> = { like: 'Like', exclude: 'Not for me', neutral: 'No preference' };

export function ProteinPicker({
  value,
  onChange,
  hint = 'Tap once to like, twice for “Not for me”, a third time to reset. Optional.',
  groups = PROTEIN_GROUPS,
}: {
  value: Partial<ProteinPrefs> | undefined;
  onChange: (next: ProteinPrefs) => void;
  hint?: string | null;
  groups?: ProteinGroup[];
}) {
  const hintId = useId();
  return (
    <div className="flex flex-col gap-2">
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-2" aria-label="Proteins">
        {groups.map((g) => {
          const choice = proteinChoice(value, g);
          const Icon = ICONS[g];
          return (
            <li key={g}>
              <button
                type="button"
                data-choice={choice}
                aria-label={`${PROTEIN_GROUP_LABELS[g]}: ${CHOICE_TEXT[choice]}`}
                aria-describedby={hint ? hintId : undefined}
                title={PROTEIN_GROUP_EXAMPLES[g]}
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
                  <span className={cx('block leading-tight', choice === 'exclude' && 'line-through')}>{PROTEIN_GROUP_LABELS[g]}</span>
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
export function proteinPrefsSummary(p: Partial<ProteinPrefs> | undefined): string {
  const n = normalizeProteinPrefs(p);
  const names = (gs: ProteinGroup[]) => gs.map((g) => PROTEIN_GROUP_LABELS[g].toLowerCase()).join(', ');
  return [n.liked.length ? `likes ${names(n.liked)}` : '', n.excluded.length ? `not for me: ${names(n.excluded)}` : ''].filter(Boolean).join(' · ');
}

/**
 * The "Proteins" sheet on the meal plan and recipes screens: the same picker as setup. Saving keeps the current plan; when there is one, it then
 * offers to rebuild the plan with the new choices (nothing changes until the user confirms).
 */
export function ProteinsForm({ hasPlan, busy, onRebuild, onDone }: { hasPlan: boolean; busy: boolean; onRebuild: (diet: DietPrefs) => void | Promise<void>; onDone: () => void }) {
  const { account, updateAccount } = useApp();
  const toast = useToast();
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
        toast.show('Protein choices saved.', { tone: 'success' });
        onDone();
      }
    } catch {
      toast.show('Could not save. Please try again.', { tone: 'error' });
    } finally {
      setSaving(false);
    }
  }
  if (saved)
    return (
      <div className="flex flex-col gap-4" role="status">
        <p className="text-sm">Saved. Your current plan stays as it is until you rebuild it.</p>
        <div className="flex flex-col gap-2">
          <Button variant="primary" loading={busy} onClick={() => onRebuild(saved)}>
            Rebuild meal plan with these
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Keep current plan
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <ProteinPicker value={value} onChange={setValue} />
      <p className="text-xs text-muted">“Not for me” proteins never appear in plans, swaps or protein sides. Allergies are separate, under Plan preferences.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} loading={saving} disabled={!changed}>
          Save
        </Button>
      </div>
    </div>
  );
}
