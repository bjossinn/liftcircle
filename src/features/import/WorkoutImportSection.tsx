/**
 * Settings → Data → "Import from Strong or Hevy": choose a CSV export, review a preview (workouts and sets found,
 * date range, matched vs new exercises, duplicates), then import everything in one transaction.
 *
 * Account safety: the chosen file, its preview and the final write are bound to the account database that was open
 * when the file was chosen. If the account changes (sign-out, another account in another tab), everything is reset,
 * a file still being read is discarded, and a preview built for one account can never be written into another.
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
import type { LiftDb } from '@/db/db';
import { MAX_IMPORT_BYTES, parseWorkoutCsv } from './parse';
import { APP_NAME, applyWorkoutImport, planWorkoutImport, type ExerciseLine, type WorkoutImportPlan } from './plan';
import { WorkoutImportError, type ParsedImport } from './types';

type DayOrder = 'dmy' | 'mdy';

/** A chosen file, bound to the account database it was chosen in. */
interface Selection {
  db: LiftDb;
  text: string;
  parsed: ParsedImport;
}

export function WorkoutImportSection() {
  const { db, account } = useApp();
  const toast = useToast();
  const { t, tp } = useT();
  const { list: library } = useExercises();
  const fileRef = useRef<HTMLInputElement>(null);
  const dbRef = useRef(db);
  dbRef.current = db;
  /** Bumped on every new file and on account changes: a slower, older read can't overwrite a newer state. */
  const readToken = useRef(0);
  const [sel, setSel] = useState<Selection | null>(null);
  const [unit, setUnit] = useState<WeightUnit>(account.settings.units.weight);
  /** The person's explicit answer to "day/month or month/day?" (only asked when the file can't tell). */
  const [dayOrder, setDayOrder] = useState<DayOrder | null>(null);
  // The plan with what it was built from: while a re-plan for a newly chosen unit or date order runs, Import waits.
  const [planned, setPlanned] = useState<{ plan: WorkoutImportPlan; unit: WeightUnit; parsed: ParsedImport; db: LiftDb } | null>(null);
  const plan = planned?.plan ?? null;
  const stale = !!planned && (planned.unit !== unit || planned.parsed !== sel?.parsed);
  const needsOrder = !!plan?.dayOrderNeeded && !dayOrder;
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const timeZone = account.settings.timeZone;

  const errorText = (e: unknown) => {
    if (e instanceof WorkoutImportError) {
      if (e.code === 'unknown_format') return t('import.error.unknownFormat');
      if (e.code === 'empty') return t('import.error.empty');
      if (e.code === 'too_large') return t('import.error.tooLarge');
      if (e.code === 'date_order') return t('import.error.dateOrder');
    }
    return t('import.error.unreadable');
  };

  const reset = () => {
    setSel(null);
    setPlanned(null);
    setDayOrder(null);
  };

  // A different account database: drop the file, its preview and any read still in progress.
  useEffect(() => {
    readToken.current++;
    setSel(null);
    setPlanned(null);
    setDayOrder(null);
    setError(null);
    setReading(false);
    setBusy(false);
  }, [db]);

  // (Re)build the preview whenever the file, the weight unit or the date order changes. The library is read once per
  // file so a custom exercise created by this import doesn't change the preview underneath the person.
  const libraryRef = useRef(library);
  libraryRef.current = library;
  useEffect(() => {
    if (!sel) return;
    let live = true;
    const { db: owner, parsed } = sel;
    planWorkoutImport(owner, parsed, libraryRef.current, { timeZone, weightUnit: unit })
      .then((p) => live && owner === dbRef.current && setPlanned({ plan: p, unit, parsed, db: owner }))
      .catch((e) => {
        if (!live || owner !== dbRef.current) return;
        console.error(e);
        setError(t('import.error.unreadable'));
        setSel(null);
      });
    return () => {
      live = false;
    };
  }, [sel, unit, timeZone, t]);

  const onFile = async (f: File) => {
    const owner = db;
    const token = ++readToken.current;
    setError(null);
    reset();
    if (f.size > MAX_IMPORT_BYTES) {
      setError(errorText(new WorkoutImportError('too_large')));
      return;
    }
    setReading(true);
    try {
      const text = await f.text();
      // The account changed (or another file was chosen) while reading: discard this file.
      if (token !== readToken.current || owner !== dbRef.current) return;
      const parsed = parseWorkoutCsv(text);
      setUnit(parsed.weightUnit ?? account.settings.units.weight);
      setSel({ db: owner, text, parsed });
    } catch (e) {
      if (token !== readToken.current || owner !== dbRef.current) return;
      if (!(e instanceof WorkoutImportError)) console.error(e);
      setError(errorText(e));
    } finally {
      if (token === readToken.current) setReading(false);
    }
  };

  /** Re-read the file with the chosen slash-date order. */
  const chooseDayOrder = (order: DayOrder) => {
    if (!sel || sel.db !== dbRef.current) return;
    setDayOrder(order);
    try {
      setSel({ ...sel, parsed: parseWorkoutCsv(sel.text, { dayOrder: order }) });
    } catch (e) {
      setError(errorText(e));
      reset();
    }
  };

  const confirm = async () => {
    if (!planned || stale || needsOrder) return;
    // Only ever write into the account the file was chosen in, and only while it is still the open one.
    if (planned.db !== dbRef.current || sel?.db !== planned.db) {
      reset();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await applyWorkoutImport(planned.db, planned.plan);
      if (planned.db !== dbRef.current) return;
      toast.show(tp('import.done', r.workouts), { tone: 'success' });
      reset();
    } catch (e) {
      console.error(e);
      if (planned.db === dbRef.current) setError(t('import.error.failed'));
    } finally {
      if (planned.db === dbRef.current) setBusy(false);
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
      {sel && plan && (
        <div className="space-y-3" data-testid="workout-import-preview">
          <p className="text-sm font-medium">
            {t('import.summary', { app: APP_NAME[plan.source], workouts: tp('import.workouts', plan.workoutsFound), sets: tp('import.sets', plan.setsFound) })}
          </p>
          {plan.dayOrderNeeded && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">{t('import.dateOrderQuestion')}</span>
              <Segmented<DayOrder | ''>
                label={t('import.dateOrderQuestion')}
                value={dayOrder ?? ''}
                onChange={(v) => v && chooseDayOrder(v)}
                options={[
                  { value: 'dmy', label: t('import.dateOrderDmy') },
                  { value: 'mdy', label: t('import.dateOrderMdy') },
                ]}
              />
              <p className="text-xs text-muted">{t('import.dateOrderHelp')}</p>
            </div>
          )}
          {!needsOrder && plan.from && plan.to && <p className="text-sm text-muted">{t('import.dateRange', { from: dateText(plan.from), to: dateText(plan.to) })}</p>}

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
              <Button variant="primary" loading={busy || stale} disabled={needsOrder} onClick={() => void confirm()}>
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
          <li key={`${l.name}\u0000${l.exerciseId}`} className="flex justify-between gap-3">
            <span className="min-w-0 break-words">{l.name === l.exerciseName ? l.name : t('import.exerciseLine', { name: l.name, exercise: l.exerciseName })}</span>
            <span className="text-muted tabular shrink-0">{tp('import.sets', l.sets)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
