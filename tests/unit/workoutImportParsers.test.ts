/**
 * CSV workout import (roadmap item 13): the CSV reader, number/date/duration parsing, format detection, and the
 * Strong and Hevy parsers against realistic export fixtures (tests/unit/fixtures/import).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, parseCsvRows, parseNumber } from '@/features/import/csv';
import { parseDuration, parseStart } from '@/features/import/common';
import { detectSource, parseWorkoutCsv } from '@/features/import/parse';
import { WorkoutImportError } from '@/features/import/types';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url), 'utf8');
const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof WorkoutImportError ? e.code : 'other';
  }
  return null;
};

describe('CSV reader', () => {
  it('handles quoted fields with delimiters, doubled quotes and line breaks', () => {
    const rows = parseCsvRows('a,b,c\n"x, y","say ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });

  it('detects comma, semicolon and tab delimiters from the header line (ignoring quoted ones)', () => {
    expect(detectDelimiter('Date,Workout Name,Exercise Name\n')).toBe(',');
    expect(detectDelimiter('"Date";"Weight (kg)";"Notes, more"\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
  });

  it('strips a BOM, accepts CRLF / CR line endings and drops blank rows', () => {
    const t = parseCsv('﻿a;b\r\n1;2\r\n\r\n;\r\n3;4\r5;6');
    expect(t.headers).toEqual(['a', 'b']);
    expect(t.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('pads short rows and cuts long ones to the header width', () => {
    expect(parseCsv('a,b,c\n1\n1,2,3,4').rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });
});

describe('numbers, dates and durations', () => {
  it('reads decimal points, European decimal commas and thousand separators; junk is null', () => {
    expect(parseNumber('82.5')).toBe(82.5);
    expect(parseNumber('82,5')).toBe(82.5);
    expect(parseNumber(' 102,5 ')).toBe(102.5);
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('1 234,5')).toBe(1234.5);
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('12kg')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });

  it('reads the start-time formats Strong and Hevy write', () => {
    expect(parseStart('2024-01-15 07:45:12')).toEqual({ local: '2024-01-15T07:45:12' });
    expect(parseStart('2024-01-15T07:45')).toEqual({ local: '2024-01-15T07:45:00' });
    expect(parseStart('15 Jan 2024, 08:30')).toEqual({ local: '2024-01-15T08:30:00' });
    expect(parseStart('Feb 3, 2024, 6:15 PM')).toEqual({ local: '2024-02-03T18:15:00' });
    expect(parseStart('Feb 3, 2024, 12:05 AM')).toEqual({ local: '2024-02-03T00:05:00' });
    expect(parseStart('04.03.2024 06:30')).toEqual({ local: '2024-03-04T06:30:00' });
    expect(parseStart('25/12/2023 10:00')).toEqual({ local: '2023-12-25T10:00:00' });
    expect(parseStart('2024-01-15T07:45:12Z')).toEqual({ epochMs: Date.UTC(2024, 0, 15, 7, 45, 12) });
    expect(parseStart('2024-01-15 07:45:12+0100')).toEqual({ epochMs: Date.UTC(2024, 0, 15, 6, 45, 12) });
    expect(parseStart('2024-02-31 10:00')).toBeNull();
    expect(parseStart('yesterday')).toBeNull();
    expect(parseStart('')).toBeNull();
  });

  it('reads workout durations', () => {
    expect(parseDuration('1h 5m')).toBe(3900);
    expect(parseDuration('1h5m')).toBe(3900);
    expect(parseDuration('58m')).toBe(3480);
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('1:05:00')).toBe(3900);
    expect(parseDuration('65:30')).toBe(3930);
    expect(parseDuration('3720')).toBe(3720);
    expect(parseDuration('62', 'min')).toBe(3720);
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('0')).toBeUndefined();
    expect(parseDuration('soon')).toBeUndefined();
  });
});

describe('format detection', () => {
  it('recognises Strong and Hevy headers and rejects other files', () => {
    expect(detectSource(['Date', 'Workout Name', 'Duration', 'Exercise Name', 'Set Order', 'Weight', 'Reps'])).toBe('strong');
    expect(detectSource(['title', 'start_time', 'end_time', 'exercise_title', 'set_type', 'weight_kg'])).toBe('hevy');
    expect(detectSource(['date', 'workout', 'exercise', 'exercise_id'])).toBeNull();
    expect(errorCode(() => parseWorkoutCsv('date,kind,value\n2024-01-01,bodyweight,80'))).toBe('unknown_format');
    expect(errorCode(() => parseWorkoutCsv(''))).toBe('unknown_format');
    expect(errorCode(() => parseWorkoutCsv('Date,Workout Name,Exercise Name,Set Order,Weight,Reps\n'))).toBe('empty');
  });
});

describe('Strong export', () => {
  it('parses workouts, exercise blocks, set types, notes and durations; skips rest-timer and empty rows', () => {
    const p = parseWorkoutCsv(fixture('strong.csv'));
    expect(p.source).toBe('strong');
    expect(p.weightUnit).toBeNull(); // plain Strong exports don't say kg or lb
    expect(p.workouts).toHaveLength(2);
    const [push, pull] = p.workouts;
    expect(push).toMatchObject({ name: 'Push Day', start: { local: '2024-01-15T07:45:12' }, startKey: '2024-01-15 07:45:12', durationSec: 3900, notes: 'Good session, slept well' });
    expect(push.exercises.map((e) => e.name)).toEqual(['Bench Press (Barbell)', 'Overhead Press (Barbell)', 'Triceps Pushdown (Cable - Straight Bar)', 'Landmine Press', 'Plank']);
    const bench = push.exercises[0];
    expect(bench.notes).toBe('Paused reps, "touch and go" last set');
    expect(bench.sets.map((s) => s.type)).toEqual(['warmup', 'normal', 'normal', 'normal']);
    expect(bench.sets[1]).toMatchObject({ weight: 80, reps: 8, rpe: 8 });
    expect(bench.sets[2].rpe).toBe(8.5);
    expect(push.exercises[2].sets.map((s) => s.type)).toEqual(['normal', 'drop']);
    expect(push.exercises[4].sets[0]).toMatchObject({ durationSec: 60, reps: 0, weight: 0 });

    expect(pull.durationSec).toBe(3480);
    expect(pull.exercises.map((e) => e.name)).toEqual(['Deadlift (Barbell)', 'Pull Up', 'Pull Up (Assisted)', 'Bicep Curl (Barbell)', 'Running']);
    expect(pull.exercises[3].sets[0].type).toBe('normal'); // "F" (failure) is a normal set
    expect(pull.exercises[4].sets[0]).toMatchObject({ distance: 2.5, durationSec: 900 });
    // "Rest Timer" row + the all-zero Seated Row set
    expect(p.skippedRows).toBe(2);
  });

  it('parses the semicolon / decimal-comma variant with unit headers and a BOM', () => {
    const p = parseWorkoutCsv(fixture('strong-eu.csv'));
    expect(p.source).toBe('strong');
    expect(p.weightUnit).toBe('kg');
    expect(p.distanceUnit).toBe('m');
    expect(p.workouts.map((w) => [w.name, w.durationSec])).toEqual([
      ['Fótadagur', 3720],
      ['Efri líkami', 2700],
    ]);
    const squat = p.workouts[0].exercises[0];
    expect(squat.sets.map((s) => [s.type, s.weight, s.reps, s.rpe])).toEqual([
      ['warmup', 40, 8, null],
      ['normal', 102.5, 5, 8.5],
      ['normal', 102.5, 5, 9],
    ]);
    expect(p.workouts[0].exercises[1].notes).toBe('Sæti í stöðu 4');
    expect(p.workouts[0].exercises[2].sets[0]).toMatchObject({ distance: 2000, durationSec: 480 });
    expect(p.workouts[1].exercises[0].sets[0].weight).toBe(32.5);
  });

  it('reads a per-row Weight Unit column, and lb headers', () => {
    const rows = 'Date,Workout Name,Exercise Name,Set Order,Weight,Weight Unit,Reps\n2024-01-01 10:00:00,A,Squat (Barbell),1,225,lbs,5\n2024-01-01 10:00:00,A,Squat (Barbell),2,100,kg,5';
    const p = parseWorkoutCsv(rows);
    expect(p.weightUnit).toBeNull(); // mixed
    expect(p.workouts[0].exercises[0].sets.map((s) => s.weightUnit)).toEqual(['lb', 'kg']);
    expect(parseWorkoutCsv('Date,Workout Name,Exercise Name,Set Order,Weight (lbs),Reps\n2024-01-01 10:00:00,A,Squat,1,135,5').weightUnit).toBe('lb');
  });

  it('keeps the same exercise later in a workout as a separate block', () => {
    const p = parseWorkoutCsv('Date,Workout Name,Exercise Name,Set Order,Weight,Reps\nd,A,X,1,1,1\n2024-01-01 10:00,A,Bench Press,1,60,5\n2024-01-01 10:00,A,Pull Up,1,0,8\n2024-01-01 10:00,A,Bench Press,1,60,5');
    expect(p.workouts[0].exercises.map((e) => e.name)).toEqual(['Bench Press', 'Pull Up', 'Bench Press']);
    expect(p.skippedRows).toBe(1); // unreadable date
  });
});

describe('Hevy export', () => {
  it('parses workouts, warm-up / drop / failure set types, supersets, notes and end times', () => {
    const p = parseWorkoutCsv(fixture('hevy.csv'));
    expect(p.source).toBe('hevy');
    expect(p.weightUnit).toBe('kg');
    expect(p.distanceUnit).toBe('km');
    expect(p.workouts).toHaveLength(2);
    const [upper, lower] = p.workouts;
    expect(upper).toMatchObject({ name: 'Upper A', start: { local: '2024-01-15T08:30:00' }, end: { local: '2024-01-15T09:35:00' }, notes: 'Felt good, new gym' });
    expect(upper.exercises.map((e) => [e.name, e.supersetId ?? null])).toEqual([
      ['Bench Press (Barbell)', null],
      ['Bent Over Row (Barbell)', '0'],
      ['Lateral Raise (Dumbbell)', '0'],
      ['Cable Crunch', null],
    ]);
    expect(upper.exercises[0].notes).toBe('Elbows tucked');
    expect(upper.exercises[0].sets.map((s) => [s.type, s.weight, s.reps, s.rpe])).toEqual([
      ['warmup', 40, 10, null],
      ['normal', 82.5, 8, 8],
      ['normal', 82.5, 6, 10],
    ]);
    expect(upper.exercises[2].sets.map((s) => s.type)).toEqual(['normal', 'drop']);
    expect(lower.exercises.map((e) => e.name)).toEqual(['Squat (Barbell)', 'Romanian Deadlift (Barbell)', 'Treadmill', 'Plank']);
    expect(lower.exercises[2].sets[0]).toMatchObject({ distance: 1.6, durationSec: 600, weight: null });
    expect(p.skippedRows).toBe(1); // Hip Thrust row without any values
  });

  it('parses imperial exports (weight_lbs, distance_miles) and US-style times', () => {
    const p = parseWorkoutCsv(fixture('hevy-lbs.csv'));
    expect(p.weightUnit).toBe('lb');
    expect(p.distanceUnit).toBe('mi');
    expect(p.workouts[0].start).toEqual({ local: '2024-02-03T18:15:00' });
    expect(p.workouts[0].exercises[0].sets.map((s) => s.weight)).toEqual([60, 60]);
    expect(p.workouts[0].exercises[1].sets[0]).toMatchObject({ distance: 1.5, durationSec: 720 });
  });
});
