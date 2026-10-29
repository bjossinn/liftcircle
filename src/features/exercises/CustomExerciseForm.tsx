import { useId, useMemo, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type {
  CustomExercise, Equipment, ExerciseCategory, LoadConvention, MovementPattern, MuscleGroup, SyncFields, TrackingType,
} from '@/domain/types';
import { Button, ChipGroup, Field, Input, Notice, Segmented, Select, Sheet, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import {
  CATEGORY_LABELS, defaultIncrement, EQUIPMENT_LABELS, LOAD_LABELS, LOADS_FOR_TRACKING, loadConventionNote, MUSCLE_LABELS,
  normalizeText, PATTERN_LABELS, TRACKING_LABELS,
} from '@/data/exerciseMeta';
import { useExercises } from '@/data/catalog';
import { newRecord, saveRecord } from '@/db/repo';
import { useApp } from '@/state/app';

const keys = <T extends string>(o: Record<T, string>) => Object.keys(o) as [T, ...T[]];

const MUSCLES = keys(MUSCLE_LABELS);
const EQUIPMENT = keys(EQUIPMENT_LABELS);
const PATTERNS = keys(PATTERN_LABELS);
const CATEGORIES = keys(CATEGORY_LABELS);
const TRACKINGS = keys(TRACKING_LABELS);
const LOADS = keys(LOAD_LABELS);

export const customExerciseSchema = z
  .object({
    name: z.string().trim().min(2, 'Use at least 2 characters.').max(60, 'Keep the name to 60 characters or fewer.'),
    category: z.enum(CATEGORIES),
    pattern: z.enum(PATTERNS),
    primaryMuscles: z.array(z.enum(MUSCLES)).min(1, 'Pick at least one primary muscle.'),
    equipment: z.array(z.enum(EQUIPMENT)),
    tracking: z.enum(TRACKINGS),
    load: z.enum(LOADS),
    implements: z.union([z.literal(1), z.literal(2)]),
    unilateral: z.boolean(),
    notes: z.string().trim().max(1000, 'Keep notes under 1000 characters.'),
  })
  .refine((v) => LOADS_FOR_TRACKING[v.tracking].includes(v.load), { path: ['load'], message: 'This load type doesn’t fit the tracking type.' });

export type CustomExerciseInput = z.input<typeof customExerciseSchema>;
type Errors = Partial<Record<keyof CustomExerciseInput | 'form', string>>;

const PATTERN_DEFAULT_CATEGORY: Record<MovementPattern, ExerciseCategory> = {
  squat: 'compound', lunge: 'compound', hinge: 'compound', horizontal_push: 'compound', vertical_push: 'compound',
  horizontal_pull: 'compound', vertical_pull: 'compound', trunk: 'core', carry: 'compound', isolation_upper: 'isolation',
  isolation_lower: 'isolation', conditioning: 'cardio', mobility: 'mobility',
};

function initialValues(initial?: CustomExercise, defaultName?: string): CustomExerciseInput {
  if (initial)
    return {
      name: initial.name,
      category: initial.category,
      pattern: initial.pattern,
      primaryMuscles: initial.primaryMuscles,
      equipment: initial.equipment.filter((e) => e !== 'bodyweight'),
      tracking: initial.tracking,
      load: initial.load,
      implements: initial.implements ?? 2,
      unilateral: !!initial.unilateral,
      notes: initial.setup ?? '',
    };
  return {
    name: defaultName ?? '',
    category: 'compound',
    pattern: 'squat',
    primaryMuscles: [],
    equipment: [],
    tracking: 'weight_reps',
    load: 'total',
    implements: 2,
    unilateral: false,
    notes: '',
  };
}

/** Sheet to create or edit a user-defined exercise. */
export function CustomExerciseForm({
  open, onClose, initial, defaultName, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: CustomExercise;
  /** Prefill the name (e.g. from a search query that found nothing). */
  defaultName?: string;
  onSaved?: (ex: CustomExercise) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={initial ? 'Edit exercise' : 'New custom exercise'}>
      <FormBody initial={initial} defaultName={defaultName} onCancel={onClose} onSaved={onSaved} />
    </Sheet>
  );
}

function FormBody({ initial, defaultName, onCancel, onSaved }: { initial?: CustomExercise; defaultName?: string; onCancel: () => void; onSaved?: (ex: CustomExercise) => void }) {
  const { db } = useApp();
  const toast = useToast();
  const { list } = useExercises();
  const [v, setV] = useState<CustomExerciseInput>(() => initialValues(initial, defaultName));
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const muscleLabelId = useId();
  const equipmentLabelId = useId();

  const set = <K extends keyof CustomExerciseInput>(k: K, value: CustomExerciseInput[K]) => {
    setV((cur) => ({ ...cur, [k]: value }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const allowedLoads = LOADS_FOR_TRACKING[v.tracking];
  const preview = useMemo(
    () =>
      loadConventionNote({
        id: 'preview', name: v.name, aliases: [], category: v.category, primaryMuscles: v.primaryMuscles, secondaryMuscles: [],
        pattern: v.pattern, equipment: v.equipment.length ? v.equipment : ['bodyweight'], difficulty: 1, tracking: v.tracking, load: v.load,
        implements: v.load === 'per_hand' ? v.implements : undefined, unilateral: v.unilateral, stresses: [], setup: '', execution: '',
        cues: [], mistakes: [], substitutions: [],
      }),
    [v],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = customExerciseSchema.safeParse(v);
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0] as keyof CustomExerciseInput;
        if (k && !next[k]) next[k] = issue.message;
      }
      setErrors(next);
      return;
    }
    const d = parsed.data;
    const norm = normalizeText(d.name);
    if (list.some((x) => x.id !== initial?.id && normalizeText(x.name) === norm)) {
      setErrors({ name: 'An exercise with this name already exists.' });
      return;
    }
    const equipment: Equipment[] = d.equipment.length ? d.equipment : ['bodyweight'];
    const fields = {
      name: d.name,
      category: d.category,
      pattern: d.pattern,
      primaryMuscles: d.primaryMuscles as MuscleGroup[],
      equipment,
      tracking: d.tracking as TrackingType,
      load: d.load as LoadConvention,
      implements: d.load === 'per_hand' ? d.implements : undefined,
      unilateral: d.unilateral || undefined,
      increment: defaultIncrement(d.load),
      setup: d.notes,
    };
    setSaving(true);
    try {
      let rec: CustomExercise;
      if (initial) {
        rec = await saveRecord('custom_exercises', { ...initial, ...fields }, db);
      } else {
        const base: Omit<CustomExercise, keyof SyncFields> = {
          custom: true, aliases: [], secondaryMuscles: [], stresses: [], substitutions: [], cues: [], mistakes: [],
          execution: '', difficulty: 1, ...fields,
        };
        rec = await saveRecord('custom_exercises', newRecord(base) as CustomExercise, db);
      }
      toast.show(initial ? 'Exercise updated' : 'Custom exercise created', { tone: 'success' });
      onSaved?.(rec);
      onCancel();
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Could not save the exercise.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Input label="Name" value={v.name} maxLength={60} onChange={(e) => set('name', e.target.value)} error={errors.name} placeholder="e.g. Landmine press" autoComplete="off" required />

      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Movement"
          value={v.pattern}
          onChange={(e) => {
            const p = e.target.value as MovementPattern;
            setV((cur) => ({ ...cur, pattern: p, category: PATTERN_DEFAULT_CATEGORY[p] }));
          }}
        >
          {PATTERNS.map((p) => (
            <option key={p} value={p}>
              {PATTERN_LABELS[p]}
            </option>
          ))}
        </Select>
        <Select label="Category" value={v.category} onChange={(e) => set('category', e.target.value as ExerciseCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <span id={muscleLabelId} className="text-sm font-medium">
          Primary muscles
        </span>
        <ChipGroup label="Primary muscles" values={v.primaryMuscles} onChange={(m) => set('primaryMuscles', m)} options={MUSCLES.map((m) => ({ value: m, label: MUSCLE_LABELS[m] }))} />
        {errors.primaryMuscles && (
          <p className="text-xs text-danger" role="alert">
            {errors.primaryMuscles}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span id={equipmentLabelId} className="text-sm font-medium">
          Equipment
        </span>
        <ChipGroup
          label="Equipment"
          values={v.equipment}
          onChange={(eq) => set('equipment', eq.filter((x) => x !== 'bodyweight'))}
          options={EQUIPMENT.filter((q) => q !== 'bodyweight').map((q) => ({ value: q, label: EQUIPMENT_LABELS[q] }))}
        />
        <p className="text-xs text-muted">Leave empty for bodyweight-only exercises.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Select
          label="Tracking"
          value={v.tracking}
          onChange={(e) => {
            const t = e.target.value as TrackingType;
            setV((cur) => ({ ...cur, tracking: t, load: LOADS_FOR_TRACKING[t].includes(cur.load) ? cur.load : LOADS_FOR_TRACKING[t][0] }));
          }}
        >
          {TRACKINGS.map((t) => (
            <option key={t} value={t}>
              {TRACKING_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select label="Load means" value={v.load} onChange={(e) => set('load', e.target.value as LoadConvention)} error={errors.load} disabled={allowedLoads.length < 2}>
          {allowedLoads.map((l) => (
            <option key={l} value={l}>
              {LOAD_LABELS[l]}
            </option>
          ))}
        </Select>
      </div>

      {v.load === 'per_hand' && (
        <Field label="Implements used">
          <Segmented
            label="Implements used"
            value={v.implements}
            onChange={(n) => set('implements', n)}
            options={[
              { value: 1, label: 'One (single hand)' },
              { value: 2, label: 'Two (one per hand)' },
            ]}
          />
        </Field>
      )}

      <Toggle label="Unilateral" description="Each side is trained separately; reps are counted per side." checked={v.unilateral} onChange={(b) => set('unilateral', b)} />

      {preview && <Notice>{preview}</Notice>}

      <Textarea label="Notes" hint="Setup, cues or anything you want to remember." value={v.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} error={errors.notes} />

      {errors.form && <Notice tone="danger">{errors.form}</Notice>}

      <div className="sticky bottom-0 -mx-5 px-5 pt-3 pb-safe bg-surface border-t border-line flex gap-2 justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {initial ? 'Save changes' : 'Create exercise'}
        </Button>
      </div>
    </form>
  );
}
