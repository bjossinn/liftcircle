/**
 * Settings → Data → "Import from Strong or Hevy": choose a CSV export, review a preview (workouts and sets found,
 * date range, matched vs new exercises, duplicates), then import everything in one transaction.
 */
import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useApp } from '@/state/app';
import { Button, Card, Notice, Segmented } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useExercises } from '@/data/catalog';
import { formatDate } from '@/lib/dates';
import { useT } from '@/i18n';
import type { WeightUnit } from '@/domain/types';
import { MAX_IMPORT_BYTES, parseWorkoutCsv } from './parse';
import { applyWorkoutImport, planWorkoutImport, type ExerciseLine, type WorkoutImportPlan } from './plan';
import { WorkoutImportError, type ImportSource, type ParsedImport } from './types';

const APP_NAME: Record<ImportSource, string> = { strong: 'Strong', hevy: 'Hevy' };

export function WorkoutImportSection() {
  const { db, account } = useApp();
  const toast = useToast();
  const { t, tp } = useT();
  const { list: library } = useExercises();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [unit, setUnit] = useState<WeightUnit>(account.settings.units.weight);
  // The plan together with the unit it was built for: while a re-plan for a newly chosen unit runs, Import waits.
  const [planned, setPlanned] = useState<{ plan: WorkoutImportPlan; unit: WeightUnit } | null>(null);
  const plan = planned?.plan ?? null;
  const stale = !!planned && planned.unit !== unit;
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const timeZone = account.settings.timeZone;

  const errorText = (e: unknown) => {
    if (e instanceof WorkoutImportError) {
      if (e.code === 'unknown_format') return t('import.error.unknownFormat');
      if (e.code === 'empty') return t('import.error.empty');
      if (e.code === 'too_large') return t('import.error.tooLarge');
    }
    return t('import.error.unreadable');
  };

  // (Re)build the preview whenever the file or the chosen weight unit changes. The library is read once per file so a
  // custom exercise created by this import doesn't change the preview underneath the person.
  const libraryRef = useRef(library);
  libraryRef.current = library;
  useEffect(() => {
    if (!parsed) return;
    let live = true;
    planWorkoutImport(db, parsed, libraryRef.current, { timeZone, weightUnit: unit })
      .then((p) => live && setPlanned({ plan: p, unit }))
      .catch((e) => {
        if (!live) return;
        console.error(e);
        setError(t('import.error.unreadable'));
        setParsed(null);
      });
    return () => {
      live = false;
    };
  }, [db, parsed, unit, timeZone, t]);

  const reset = () => {
    setParsed(null);
    setPlanned(null);
  };

  const onFile = async (f: File) => {
    setError(null);
    reset();
    if (f.size > MAX_IMPORT_BYTES) {
      setError(errorText(new WorkoutImportError('too_large')));
      return;
    }
    setReading(true);
    try {
      const p = parseWorkoutCsv(await f.text());
      setUnit(p.weightUnit ?? account.settings.units.weight);
      setParsed(p);
    } catch (e) {
      if (!(e instanceof WorkoutImportError)) console.error(e);
      setError(errorText(e));
    } finally {
      setReading(false);
    }
  };

  const confirm = async () => {
    if (!plan || stale) return;
    setBusy(true);
    setError(null);
    try {
      const r = await applyWorkoutImport(db, plan);
      toast.show(tp('import.done', r.workouts), { tone: 'success' });
      reset();
    } catch (e) {
      console.error(e);
      setError(t('import.error.failed'));
    } finally {
      setBusy(false);
    }
  };

  const dateText = (d: string) => formatDate(d, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <Card className="p-4 space-y-3">
      <p className="text-sm text-muted">{t('import.help')}</p>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="sr-only"
        aria-label={t('import.chooseAria')}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onFile(f);
        }}
      />
      <Button block icon={<FileUp className="size-4" />} loading={reading} onClick={() => fileRef.current?.click()}>
        {reading ? t('import.reading') : t('import.choose')}
      </Button>
      {error && (
        <Notice tone="danger">
          <span role="alert">{error}</span>
        </Notice>
      )}
      {parsed && plan && (
        <div className="space-y-3" data-testid="workout-import-preview">
          <p className="text-sm font-medium">
            {t('import.summary', { app: APP_NAME[plan.source], workouts: tp('import.workouts', plan.workoutsFound), sets: tp('import.sets', plan.setsFound) })}
          </p>
          {plan.from && plan.to && <p className="text-sm text-muted">{t('import.dateRange', { from: dateText(plan.from), to: dateText(plan.to) })}</p>}

          {plan.unitNeeded && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">{t('import.unitQuestion')}</span>
              <Segmented<WeightUnit>
                label={t('import.unitQuestion')}
                value={unit}
                onChange={setUnit}
                options={[
                  { value: 'kg', label: t('settings.kilograms') },
                  { value: 'lb', label: t('settings.pounds') },
                ]}
              />
              <p className="text-xs text-muted">{t('import.unitHelp')}</p>
            </div>
          )}

          <ExerciseList title={t('import.matchedTitle', { count: plan.matched.length })} lines={plan.matched} />
          {plan.created.length > 0 && (
            <ExerciseList title={t('import.createdTitle', { count: plan.created.length })} lines={plan.created} help={t('import.createdHelp')} open />
          )}

          <ul className="text-sm space-y-1" role="status">
            {plan.newWorkouts > 0 && <li>{tp('import.newWorkouts', plan.newWorkouts)}</li>}
            {plan.alreadyImported > 0 && <li>{tp('import.alreadyImported', plan.alreadyImported)}</li>}
            {plan.warmupSets > 0 && <li className="text-muted">{tp('import.warmups', plan.warmupSets)}</li>}
            {plan.skippedRows > 0 && <li className="text-muted">{tp('import.skippedRows', plan.skippedRows)}</li>}
          </ul>
          {plan.repairedSets > 0 && <Notice tone="warn">{tp('import.repaired', plan.repairedSets)}</Notice>}
          {plan.newWorkouts === 0 ? <Notice>{t('import.nothingNew')}</Notice> : <p className="text-xs text-muted">{t('import.historyNote')}</p>}

          <div className="flex gap-2">
            {plan.newWorkouts > 0 && (
              <Button variant="primary" loading={busy || stale} onClick={() => void confirm()}>
                {tp('import.confirm', plan.newWorkouts)}
              </Button>
            )}
            <Button variant="ghost" onClick={reset} disabled={busy}>
              {plan.newWorkouts > 0 ? t('common.cancel') : t('common.close')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ExerciseList({ title, lines, help, open }: { title: string; lines: ExerciseLine[]; help?: string; open?: boolean }) {
  const { t, tp } = useT();
  return (
    <details className="text-sm rounded-xl border border-line px-3" open={open}>
      <summary className="min-h-11 flex items-center cursor-pointer font-medium">{title}</summary>
      {help && <p className="text-xs text-muted pb-2">{help}</p>}
      <ul className="pb-2 space-y-1">
        {lines.map((l) => (
          <li key={l.name} className="flex justify-between gap-3">
            <span className="min-w-0 break-words">{l.name === l.exerciseName ? l.name : t('import.exerciseLine', { name: l.name, exercise: l.exerciseName })}</span>
            <span className="text-muted tabular shrink-0">{tp('import.sets', l.sets)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
