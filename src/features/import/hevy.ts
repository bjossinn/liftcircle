/**
 * Hevy CSV export → ParsedImport.
 *
 * Columns: title, start_time, end_time, description, exercise_title, superset_id, exercise_notes, set_index,
 * set_type, weight_kg, reps, distance_km, duration_seconds, rpe. Imperial exports use weight_lbs / distance_miles.
 * set_type: "normal", "warmup", "dropset" or "failure" (imported as a normal set). Times look like
 * "15 Jan 2024, 08:30" (local time) and are read in the account's time zone.
 */
import { parseNumber, type CsvTable } from './csv';
import { WorkoutGrouper, cell, column, fileDayOrder, hasValues, parseStart } from './common';
import type { ImportDistanceUnit, ParseOptions, ParsedImport, ParsedSet } from './types';
import type { WeightUnit } from '@/domain/types';

export function isHevyTable(t: CsvTable): boolean {
  return column(t, 'exercise_title') >= 0 && column(t, 'start_time') >= 0;
}

function setType(raw: string): ParsedSet['type'] {
  const s = raw.trim().toLowerCase();
  if (s.startsWith('warm')) return 'warmup';
  if (s.startsWith('drop')) return 'drop';
  return 'normal';
}

export function parseHevy(t: CsvTable, opts: ParseOptions = {}): ParsedImport {
  const kg = column(t, 'weight_kg');
  const lbs = column(t, 'weight_lbs', 'weight_lb');
  const km = column(t, 'distance_km');
  const mi = column(t, 'distance_miles', 'distance_mi');
  const m = column(t, 'distance_meters', 'distance_m');
  const weightUnit: WeightUnit | null = kg >= 0 ? 'kg' : lbs >= 0 ? 'lb' : null;
  const distanceUnit: ImportDistanceUnit | null = km >= 0 ? 'km' : mi >= 0 ? 'mi' : m >= 0 ? 'm' : null;
  const c = {
    title: column(t, 'title'),
    start: column(t, 'start_time'),
    end: column(t, 'end_time'),
    description: column(t, 'description'),
    exercise: column(t, 'exercise_title'),
    superset: column(t, 'superset_id'),
    notes: column(t, 'exercise_notes'),
    type: column(t, 'set_type'),
    weight: kg >= 0 ? kg : lbs,
    reps: column(t, 'reps'),
    distance: km >= 0 ? km : mi >= 0 ? mi : m,
    duration: column(t, 'duration_seconds'),
    rpe: column(t, 'rpe'),
  };

  const days = fileDayOrder(t.rows.flatMap((r) => [cell(r, c.start), cell(r, c.end)]), opts.dayOrder);
  const g = new WorkoutGrouper();
  let skipped = 0;
  for (const row of t.rows) {
    const startRaw = cell(row, c.start);
    const exName = cell(row, c.exercise);
    const start = parseStart(startRaw, days.order);
    if (!start || !exName) {
      skipped++;
      continue;
    }
    const title = cell(row, c.title);
    const w = g.workout(`${startRaw}\u0000${title}`, () => {
      const endRaw = cell(row, c.end);
      const end = endRaw ? parseStart(endRaw, days.order) : null;
      const description = cell(row, c.description);
      return { name: title, start, startKey: startRaw, ...(end ? { end } : {}), ...(description ? { notes: description } : {}), exercises: [] };
    });
    const superset = cell(row, c.superset);
    const ex = g.exercise(w, exName, `${exName}\u0000${superset}`);
    if (superset && ex.supersetId == null) ex.supersetId = superset;
    const note = cell(row, c.notes);
    if (note && !ex.notes) ex.notes = note;
    const set: ParsedSet = {
      type: setType(cell(row, c.type)),
      weight: parseNumber(cell(row, c.weight)),
      reps: parseNumber(cell(row, c.reps)),
      distance: parseNumber(cell(row, c.distance)),
      durationSec: parseNumber(cell(row, c.duration)),
      rpe: parseNumber(cell(row, c.rpe)),
    };
    if (!hasValues(set)) {
      skipped++;
      continue;
    }
    ex.sets.push(set);
  }
  return { source: 'hevy', weightUnit, distanceUnit, workouts: g.result(), skippedRows: skipped, dayOrderNeeded: days.needed, ...(days.order ? { dayOrder: days.order } : {}) };
}
