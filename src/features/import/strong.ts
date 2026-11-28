/**
 * Strong CSV export → ParsedImport.
 *
 * Columns (comma or semicolon separated, depending on the phone's region):
 *   Date; Workout Name; Duration; Exercise Name; Set Order; Weight; Reps; Distance; Seconds; Notes; Workout Notes; RPE
 * Variants handled: "Weight (kg)" / "Weight (lbs)" headers, a per-row "Weight Unit" / "Distance Unit" column, and a
 * "Workout #" column. Set Order is a number for working sets, "W" for warm-ups, "D" for drop sets and "F" for sets
 * to failure (imported as normal sets); other values (e.g. "Rest Timer") and rows without a date or exercise are
 * skipped and counted. Plain Strong exports state no weight unit: the preview then asks which unit the file uses.
 */
import { parseNumber, type CsvTable } from './csv';
import { WorkoutGrouper, cell, column, distanceUnitOf, fileDayOrder, hasValues, parseDuration, parseStart, weightUnitOf } from './common';
import type { ImportDistanceUnit, ParseOptions, ParsedImport, ParsedSet } from './types';
import type { WeightUnit } from '@/domain/types';

export function isStrongTable(t: CsvTable): boolean {
  return column(t, 'exercise name') >= 0 && column(t, 'date') >= 0 && (column(t, 'set order') >= 0 || column(t, 'workout name') >= 0);
}

const WEIGHT_HEADERS = ['weight', 'weight (kg)', 'weight (kgs)', 'weight (lbs)', 'weight (lb)'];
const DISTANCE_HEADERS = ['distance', 'distance (km)', 'distance (mi)', 'distance (m)', 'distance (meters)', 'distance (miles)'];

export function parseStrong(t: CsvTable, opts: ParseOptions = {}): ParsedImport {
  const c = {
    date: column(t, 'date'),
    name: column(t, 'workout name'),
    workoutNo: column(t, 'workout #'),
    duration: column(t, 'duration', 'workout duration', 'duration (sec)', 'duration (min)'),
    exercise: column(t, 'exercise name'),
    order: column(t, 'set order'),
    weight: column(t, ...WEIGHT_HEADERS),
    weightUnit: column(t, 'weight unit'),
    reps: column(t, 'reps'),
    distance: column(t, ...DISTANCE_HEADERS),
    distanceUnit: column(t, 'distance unit'),
    seconds: column(t, 'seconds', 'time', 'set duration'),
    notes: column(t, 'notes'),
    workoutNotes: column(t, 'workout notes'),
    rpe: column(t, 'rpe'),
  };
  const headerWeightUnit: WeightUnit | null = c.weight >= 0 ? (weightUnitOf(t.headers[c.weight]) ?? null) : null;
  const headerDistanceUnit: ImportDistanceUnit | null = c.distance >= 0 ? (distanceUnitOf(t.headers[c.distance].replace(/^distance/i, '')) ?? null) : null;
  const durationPlain = c.duration >= 0 && /min/i.test(t.headers[c.duration]) ? 'min' : 'sec';

  const days = fileDayOrder(t.rows.map((r) => cell(r, c.date)), opts.dayOrder);
  const g = new WorkoutGrouper();
  let skipped = 0;
  const rowUnits = new Set<WeightUnit>();
  const rowDistUnits = new Set<ImportDistanceUnit>();

  for (const row of t.rows) {
    const dateRaw = cell(row, c.date);
    const exName = cell(row, c.exercise);
    const start = parseStart(dateRaw, days.order);
    const order = cell(row, c.order).toUpperCase();
    let type: ParsedSet['type'] | null;
    if (order === '' || /^\d+$/.test(order) || order === 'F') type = 'normal';
    else if (order === 'W') type = 'warmup';
    else if (order === 'D') type = 'drop';
    else type = null; // "Rest Timer", "Note" and other non-set rows
    if (!start || !exName || !type) {
      skipped++;
      continue;
    }
    const name = cell(row, c.name);
    const key = `${dateRaw}\u0000${name}\u0000${cell(row, c.workoutNo)}`;
    const w = g.workout(key, () => ({ name, start, startKey: dateRaw, exercises: [] }));
    if (w.durationSec == null) w.durationSec = parseDuration(cell(row, c.duration), durationPlain);
    const wNotes = cell(row, c.workoutNotes);
    if (wNotes && !w.notes) w.notes = wNotes;

    const rowWeightUnit = c.weightUnit >= 0 ? weightUnitOf(cell(row, c.weightUnit)) : undefined;
    const rowDistanceUnit = c.distanceUnit >= 0 ? distanceUnitOf(cell(row, c.distanceUnit)) : undefined;
    if (rowWeightUnit) rowUnits.add(rowWeightUnit);
    if (rowDistanceUnit) rowDistUnits.add(rowDistanceUnit);
    const set: ParsedSet = {
      type,
      weight: parseNumber(cell(row, c.weight)),
      ...(rowWeightUnit ? { weightUnit: rowWeightUnit } : {}),
      reps: parseNumber(cell(row, c.reps)),
      distance: parseNumber(cell(row, c.distance)),
      ...(rowDistanceUnit ? { distanceUnit: rowDistanceUnit } : {}),
      durationSec: parseNumber(cell(row, c.seconds)),
      rpe: parseNumber(cell(row, c.rpe)),
    };
    const ex = g.exercise(w, exName);
    const note = cell(row, c.notes);
    if (note && !ex.notes) ex.notes = note;
    if (!hasValues(set)) {
      skipped++;
      continue;
    }
    ex.sets.push(set);
  }

  return {
    source: 'strong',
    weightUnit: headerWeightUnit ?? (rowUnits.size === 1 ? [...rowUnits][0] : null),
    distanceUnit: headerDistanceUnit ?? (rowDistUnits.size === 1 ? [...rowDistUnits][0] : null),
    workouts: g.result(),
    skippedRows: skipped,
    dayOrderNeeded: days.needed,
    ...(days.order ? { dayOrder: days.order } : {}),
  };
}
