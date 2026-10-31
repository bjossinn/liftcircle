/** Review and result screens of the onboarding wizard. */
import { useState, type ReactNode } from 'react';
import { LayoutGrid, Pencil, Shuffle } from 'lucide-react';
import { Badge, Button, Card, Notice, Segmented, SectionTitle, Sheet, Toggle } from '@/components/ui';
import { EQUIPMENT_LABELS, LIMITATION_LABELS } from '@/data/exerciseMeta';
import { formatLength, formatWeight } from '@/domain/units';
import { weekdaysText } from '@/domain/program/explain';
import { regenerateTemplates, suggestProgramName } from '@/domain/program/generator';
import { effectiveLiftingDays, resolveSplit, splitKeyOfVersion } from '@/domain/program/splits';
import { SPLITS } from '@/domain/program/templates';
import type { computeNutritionTargets } from '@/domain/nutrition/targets';
import type { Exercise, ID, ProgramVersion, SessionTemplate, SplitKey } from '@/domain/types';
import { PlanLegend, SessionCard, WeekStrip, WhyItFits } from '@/features/program/parts';
import { ALLERGEN_LABELS, DIET_TAG_LABELS, isUnder18, type Draft, type StepKey } from './draft';
import { ACTIVITY_LEVELS, ACTIVITY_OPTIONS, EXPERIENCE_OPTIONS, GOAL_OPTIONS, LOCATION_LABELS, ManualTargets, SplitPicker } from './steps';
import { proteinPrefsSummary } from '@/features/nutrition/ProteinPicker';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function ReviewSection({ title, step, onEdit, children }: { title: string; step: StepKey; onEdit: (s: StepKey) => void; children: ReactNode }) {
  return (
    <Card as="section" className="px-4 py-3" aria-label={title}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => onEdit(step)} aria-label={`Edit ${title}`}>
          Edit
        </Button>
      </div>
      <dl>{children}</dl>
    </Card>
  );
}

export function ReviewStep({ d, byId, onEdit }: { d: Draft; byId: Map<ID, Exercise>; onEdit: (s: StepKey) => void }) {
  const a = d.a;
  const split = resolveSplit(a, effectiveLiftingDays(a));
  const u = a.units;
  const none = <span className="text-faint">—</span>;
  const names = (ids: ID[]) => (ids.length ? ids.map((id) => byId.get(id)?.name ?? id).join(', ') : none);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">Check your answers. Tap Edit to change anything, then build your plan.</p>
      <ReviewSection title="About you" step="about" onEdit={onEdit}>
        <Row label="Name">{a.displayName || none}</Row>
        <Row label="Units">
          {u.weight}, {u.length === 'cm' ? 'cm' : 'ft/in'}, {u.distance}
        </Row>
      </ReviewSection>
      <ReviewSection title="Body details" step="body" onEdit={onEdit}>
        <Row label="Age">{a.age ?? none}</Row>
        <Row label="Weight">{a.weightKg != null ? formatWeight(a.weightKg, u.weight) : none}</Row>
        <Row label="Height">{a.heightCm != null ? formatLength(a.heightCm, u.length) : none}</Row>
      </ReviewSection>
      <ReviewSection title="Goal" step="goal" onEdit={onEdit}>
        <Row label="Primary">{GOAL_OPTIONS.find((g) => g.value === a.goal)?.title}</Row>
        <Row label="Secondary">{a.secondaryGoal ? GOAL_OPTIONS.find((g) => g.value === a.secondaryGoal)?.title : none}</Row>
        <Row label="Target weight">{a.targetWeightKg != null ? formatWeight(a.targetWeightKg, u.weight) : none}</Row>
        {a.goal === 'endurance' && (
          <Row label="Endurance">
            {ACTIVITY_OPTIONS.find((o) => o.value === a.endurance?.activity)?.label ?? 'Running'}
            {a.endurance?.recentMinutes ? ` · ${a.endurance.recentMinutes} min` : ' · calibration session first'}
          </Row>
        )}
      </ReviewSection>
      <ReviewSection title="Experience" step="experience" onEdit={onEdit}>
        <Row label="Level">{EXPERIENCE_OPTIONS.find((o) => o.value === a.experience)?.title}</Row>
      </ReviewSection>
      <ReviewSection title="Your week" step="schedule" onEdit={onEdit}>
        <Row label="Active days">{a.totalDaysPerWeek} per week</Row>
        <Row label="Lifting days">{a.liftingDaysPerWeek} per week</Row>
        <Row label="Split">
          {split.key ? (
            <>
              {SPLITS[split.key].label}
              {split.recommended && !split.explicit && <span className="text-muted"> (recommended)</span>}
              {split.adjustment && <span className="block text-xs text-warn mt-0.5">{split.adjustment.message}</span>}
            </>
          ) : (
            none
          )}
        </Row>
        <Row label="Available">{a.availableWeekdays.length === 7 ? 'Any day' : weekdaysText(a.availableWeekdays)}</Row>
        <Row label="Preferred lifting">{a.preferredLiftingWeekdays.length ? weekdaysText(a.preferredLiftingWeekdays) : none}</Row>
        <Row label="Session length">{a.sessionMinutes} min</Row>
      </ReviewSection>
      <ReviewSection title="Equipment" step="equipment" onEdit={onEdit}>
        <Row label="Location">{LOCATION_LABELS[a.location]}</Row>
        <Row label="Equipment">{a.equipment.length ? a.equipment.map((e) => EQUIPMENT_LABELS[e]).join(', ') : 'Bodyweight only'}</Row>
      </ReviewSection>
      <ReviewSection title="Activities & exercises" step="exercises" onEdit={onEdit}>
        <Row label="Activities">{a.preferredActivities.length ? a.preferredActivities.map((t) => ACTIVITY_OPTIONS.find((o) => o.value === t)?.label ?? t).join(', ') : none}</Row>
        <Row label="Enjoy">{names(a.enjoyedExerciseIds)}</Row>
        <Row label="Leave out">{names(a.excludedExerciseIds)}</Row>
        <Row label="Known weights">
          {Object.keys(a.knownLoads ?? {}).length
            ? Object.entries(a.knownLoads ?? {})
                .map(([id, kg]) => `${byId.get(id)?.name ?? id} ${formatWeight(kg, u.weight)}`)
                .join(', ')
            : 'None — calibration sessions'}
        </Row>
      </ReviewSection>
      <ReviewSection title="Go easy on" step="limits" onEdit={onEdit}>
        <Row label="Areas">{a.limitations.length ? a.limitations.map((l) => LIMITATION_LABELS[l]).join(', ') : none}</Row>
      </ReviewSection>
      <ReviewSection title="Everyday activity & nutrition" step="lifestyle" onEdit={onEdit}>
        <Row label="Activity">{ACTIVITY_LEVELS.find((o) => o.value === a.activityLevel)?.title}</Row>
        <Row label="Nutrition">{a.wantsNutrition ? (a.nutritionMode === 'full' && !isUnder18(a) ? 'Protein, calories & macros' : 'Protein target') : 'Not now'}</Row>
      </ReviewSection>
      {a.wantsNutrition && (
        <ReviewSection title="Food preferences" step="nutrition" onEdit={onEdit}>
          <Row label="Diet">{a.diet.tags.length ? a.diet.tags.map((t) => DIET_TAG_LABELS[t]).join(', ') : none}</Row>
          <Row label="Allergies">{a.diet.allergens.length ? a.diet.allergens.map((t) => ALLERGEN_LABELS[t]).join(', ') : none}</Row>
          {proteinPrefsSummary(a.diet.proteinPrefs) && <Row label="Proteins">{proteinPrefsSummary(a.diet.proteinPrefs)}</Row>}
          <Row label="Dislikes">{a.diet.dislikedIngredientIds.length ? a.diet.dislikedIngredientIds.join(', ') : none}</Row>
          <Row label="Cooking">up to {a.diet.maxCookMinutes} min · {a.diet.mealsPerDay} meals/day</Row>
          {a.individualizedNutrition && <Row label="Targets">Manual only (individual advice)</Row>}
        </ReviewSection>
      )}
    </div>
  );
}

type NutritionResult = ReturnType<typeof computeNutritionTargets> | null;

export function ResultStep({
  d,
  version,
  catalog,
  byId,
  nutrition,
  onVersion,
  onShuffle,
  onSplit,
  setDraft,
  today,
}: {
  d: Draft;
  version: ProgramVersion;
  catalog: Exercise[];
  byId: Map<ID, Exercise>;
  nutrition: NutritionResult;
  onVersion: (v: ProgramVersion) => void;
  /** Re-pick exercises within the same split. */
  onShuffle: () => void;
  /** Choose another split structure. */
  onSplit: (key: SplitKey) => void;
  setDraft: (fn: (d: Draft) => Draft) => void;
  today: string;
}) {
  const a = d.a;
  const unit = a.units.weight;
  const days = (t: SessionTemplate) => version.schedule.filter((s) => s.templateId === t.id).map((s) => s.weekday);
  const regenerate = (t: SessionTemplate) => {
    const n = (d.regen[t.id] ?? 0) + 1;
    setDraft((x) => ({ ...x, regen: { ...x.regen, [t.id]: n } }));
    onVersion(regenerateTemplates(version, [t.id], a, catalog, d.variant + n));
  };
  const totalMin = version.schedule.reduce((s, slot) => s + (version.templates.find((t) => t.id === slot.templateId)?.estimatedMinutes ?? 0), 0);
  const disabled = nutrition?.targets.autoDisabledReason;
  const [splitOpen, setSplitOpen] = useState(false);
  const split = resolveSplit(a, effectiveLiftingDays(a));
  const shownKey = splitKeyOfVersion(version) ?? split.key;
  const canShuffle = version.templates.some((t) => t.exercises.length > 0);
  return (
    <div className="flex flex-col">
      <Card className="px-4 py-3">
        <h2 className="text-lg font-semibold">{suggestProgramName(a, version)}</h2>
        <p className="text-sm text-muted mt-1">
          {version.weeks}-week block starting {today} · review in week {version.reviewWeek} · about {Math.round(totalMin / 5) * 5} min of training a week
        </p>
        <div className="mt-3">
          <WeekStrip version={version} />
        </div>
        {shownKey && (
          <p className="text-sm mt-3">
            <span className="text-muted">Split: </span>
            <span className="font-medium">{SPLITS[shownKey].label}</span>
            {split.recommended && shownKey === split.key && ' '}
            {split.recommended && shownKey === split.key && (
              <Badge tone="accent" className="ml-1">
                Recommended
              </Badge>
            )}
          </p>
        )}
        {split.adjustment && (
          <Notice tone="warn" className="mt-2 py-2.5">
            {split.adjustment.message}
          </Notice>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          {split.options.length > 1 && (
            <Button size="sm" icon={<LayoutGrid className="size-4" />} onClick={() => setSplitOpen(true)}>
              Change split
            </Button>
          )}
          {canShuffle && (
            <Button size="sm" variant="ghost" icon={<Shuffle className="size-4" />} onClick={onShuffle}>
              Shuffle exercises
            </Button>
          )}
        </div>
      </Card>

      <WhyItFits version={version} defaultOpen={false} />

      <SectionTitle>Sessions</SectionTitle>
      <PlanLegend />
      <div className="flex flex-col gap-3">
        {version.templates.map((t) => (
          <SessionCard
            key={t.id}
            template={t}
            byId={byId}
            catalog={catalog}
            unit={unit}
            editable
            experience={a.experience}
            goal={a.goal}
            days={days(t)}
            defaultOpen={t.kind === 'lifting'}
            onChange={(next) => onVersion({ ...version, templates: version.templates.map((x) => (x.id === next.id ? next : x)) })}
            onRegenerate={t.exercises.length ? () => regenerate(t) : undefined}
          />
        ))}
      </div>

      <Sheet open={splitOpen} onClose={() => setSplitOpen(false)} title="Change split">
        {splitOpen && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">Pick how your {split.liftingDays} lifting sessions are organised. Changing the split rebuilds the sessions (edits to the current ones are replaced — you can undo).</p>
            <SplitPicker
              a={a}
              showTitle={false}
              onSelect={(key) => {
                setSplitOpen(false);
                if (key !== shownKey) onSplit(key);
                else if (a.splitPreference !== key)
                  // Same structure as shown: just make the choice explicit and keep any edits.
                  setDraft((x) => {
                    const na = { ...x.a, splitPreference: key };
                    return { ...x, a: na, versionKey: x.version && x.versionKey === JSON.stringify(x.a) ? JSON.stringify(na) : x.versionKey };
                  });
              }}
            />
          </div>
        )}
      </Sheet>

      {a.wantsNutrition && (
        <>
          <SectionTitle>Nutrition targets</SectionTitle>
          <Card className="px-4 py-3 flex flex-col gap-3">
            {nutrition && !d.nutri.manual && !disabled && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <TargetStat label="Protein" value={nutrition.targets.proteinG != null ? `${nutrition.targets.proteinG} g` : '—'} />
                  {nutrition.targets.calories != null && <TargetStat label="Calories" value={`${nutrition.targets.calories} kcal`} />}
                  {nutrition.targets.carbsG != null && <TargetStat label="Carbs" value={`${nutrition.targets.carbsG} g`} />}
                  {nutrition.targets.fatG != null && <TargetStat label="Fat" value={`${nutrition.targets.fatG} g`} />}
                </div>
                {a.targetWeightKg != null && a.weightKg != null && (
                  <div>
                    <span className="text-sm font-medium block mb-1.5">Base protein on</span>
                    <Segmented
                      label="Protein reference weight"
                      value={d.nutri.refSource}
                      onChange={(v) => setDraft((x) => ({ ...x, nutri: { ...x.nutri, refSource: v } }))}
                      options={[
                        { value: 'current', label: `Current (${formatWeight(a.weightKg, unit)})` },
                        { value: 'goal', label: `Goal (${formatWeight(a.targetWeightKg, unit)})` },
                      ]}
                    />
                  </div>
                )}
                <div>
                  <span className="text-sm font-medium block mb-1.5">Protein per kg</span>
                  <Segmented
                    label="Protein grams per kilogram"
                    value={d.nutri.proteinPerKg}
                    onChange={(v) => setDraft((x) => ({ ...x, nutri: { ...x.nutri, proteinPerKg: v } }))}
                    options={[1.6, 1.8, 2.0, 2.2].map((n) => ({ value: n, label: `${n} g` }))}
                  />
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer min-h-11 flex items-center font-medium">How we calculated this</summary>
                  <ul className="list-disc pl-5 flex flex-col gap-1.5 text-muted">
                    {nutrition.explanation.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </details>
                {nutrition.warnings.map((w) => (
                  <Notice key={w} tone="warn">
                    {w}
                  </Notice>
                ))}
              </>
            )}
            {nutrition && disabled && (
              <>
                {nutrition.explanation.map((e) => (
                  <p key={e} className="text-sm">
                    {e}
                  </p>
                ))}
              </>
            )}
            {!disabled && (
              <Toggle checked={d.nutri.manual} onChange={(v) => setDraft((x) => ({ ...x, nutri: { ...x.nutri, manual: v } }))} label="I’ll set my own targets" />
            )}
            {(d.nutri.manual || disabled) && <ManualTargets d={d} setDraft={setDraft} />}
          </Card>
        </>
      )}
    </div>
  );
}

function TargetStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular">{value}</div>
    </div>
  );
}
