/** Entry point for reading a workout export: detect the app from the header row and parse it. */
import { parseCsv } from './csv';
import { isHevyTable, parseHevy } from './hevy';
import { isStrongTable, parseStrong } from './strong';
import { WorkoutImportError, type ImportSource, type ParseOptions, type ParsedImport } from './types';

/** Largest export we read (a decade of daily Strong workouts is a few MB). */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export function detectSource(headers: string[]): ImportSource | null {
  const t = { delimiter: ',' as const, headers, rows: [] };
  if (isHevyTable(t)) return 'hevy';
  if (isStrongTable(t)) return 'strong';
  return null;
}

/** Parse a Strong or Hevy CSV export. Throws WorkoutImportError for unknown formats and files without workouts. */
export function parseWorkoutCsv(text: string, opts: ParseOptions = {}): ParsedImport {
  const table = parseCsv(text);
  const source = detectSource(table.headers);
  if (!source) throw new WorkoutImportError('unknown_format');
  const parsed = source === 'hevy' ? parseHevy(table, opts) : parseStrong(table, opts);
  if (!parsed.workouts.length) throw new WorkoutImportError('empty');
  return parsed;
}
