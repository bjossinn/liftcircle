/**
 * Add/edit a body measurement (extracted from BodySection so "Add a record" works even before any measurement
 * exists). Validation, the delete confirmation and all seven kinds are unchanged; a new entry can choose its kind.
 */
import { useState } from 'react';
import { useReturnFocus } from './shared';
import { Button, ConfirmDialog, Input, NumberInput, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { deleteRecord, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import { cmToIn, fromKg, inToCm, round, toKg } from '@/domain/units';
import type { Measurement, MeasurementKind, Settings } from '@/domain/types';
import { t, useT, type MessageKey } from '@/i18n';

export const MEASUREMENT_KINDS: { value: MeasurementKind; label: MessageKey }[] = [
  { value: 'bodyweight', label: 'progress.bodyweight' },
  { value: 'waist', label: 'progress.waist' },
  { value: 'chest', label: 'progress.chest' },
  { value: 'hips', label: 'progress.hips' },
  { value: 'arm', label: 'progress.arm' },
  { value: 'thigh', label: 'progress.thigh' },
  { value: 'bodyfat_pct', label: 'progress.bodyFat' },
];
export const KIND_ORDER = MEASUREMENT_KINDS.map((k) => k.value);
export const kindLabel = (k: MeasurementKind) => t(MEASUREMENT_KINDS.find((x) => x.value === k)!.label);

/** Display unit, conversions and plausible bounds (in display units) for a measurement kind. */
export function unitFor(kind: MeasurementKind, settings: Settings) {
  const u = settings.units;
  if (kind === 'bodyweight') return { unit: u.weight, toDisplay: (v: number) => round(fromKg(v, u.weight), 1), toCanonical: (v: number) => toKg(v, u.weight), min: u.weight === 'kg' ? 20 : 45, max: u.weight === 'kg' ? 400 : 880 };
  if (kind === 'bodyfat_pct') return { unit: '%', toDisplay: (v: number) => round(v, 1), toCanonical: (v: number) => v, min: 2, max: 75 };
  const inch = u.length === 'ftin';
  return { unit: inch ? 'in' : 'cm', toDisplay: (v: number) => round(inch ? cmToIn(v) : v, 1), toCanonical: (v: number) => (inch ? inToCm(v) : v), min: inch ? 4 : 10, max: inch ? 120 : 300 };
}

/** The value shown for a stored entry: what was typed when the unit still matches, else the converted value. */
export const shownValue = (m: Measurement, settings: Settings) => {
  const u = unitFor(m.kind, settings);
  return m.entered && m.entered.unit === u.unit ? m.entered.value : u.toDisplay(m.value);
};

export interface MeasurementEditorProps {
  /** The entry to edit, 'new' to add, null when closed. */
  target: Measurement | 'new' | null;
  /** Kind of a new entry (changeable in the sheet). */
  kind: MeasurementKind;
  /** Existing entries (latest of a kind pre-fills a new value). */
  measurements: Measurement[];
  settings: Settings;
  today: string;
  onClose: () => void;
}

/** Mounted per opening (keyed by the caller) so its draft starts from the target. */
export function MeasurementEditor(props: MeasurementEditorProps) {
  if (props.target == null) return null;
  return <EditorBody key={props.target === 'new' ? `new-${props.kind}` : props.target.id} {...props} target={props.target} />;
}

function latestOf(measurements: Measurement[], kind: MeasurementKind) {
  return measurements.filter((m) => m.kind === kind).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))[0];
}

function EditorBody({ target, kind: initialKind, measurements, settings, today, onClose }: MeasurementEditorProps & { target: Measurement | 'new' }) {
  const { db } = useApp();
  const toast = useToast();
  const { t, locale } = useT();
  useReturnFocus();
  const lower = (s: string) => s.toLocaleLowerCase(locale);
  const isNew = target === 'new';
  const [kind, setKind] = useState<MeasurementKind>(isNew ? initialKind : target.kind);
  const initialValue = (k: MeasurementKind) => {
    if (!isNew) return shownValue(target, settings);
    const last = latestOf(measurements, k);
    return last ? shownValue(last, settings) : null;
  };
  const [date, setDate] = useState(isNew ? today : target.date);
  const [value, setValue] = useState<number | null>(() => initialValue(kind));
  const [note, setNote] = useState(isNew ? '' : target.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const u = unitFor(kind, settings);
  const isBw = kind === 'bodyweight';

  const save = async () => {
    if (value == null || value < u.min || value > u.max) {
      setError(t('validation.between', { min: u.min, max: u.max, unit: u.unit }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
      setError(t('progress.dateNotFuture'));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const canonical = u.toCanonical(value);
      const entered = isBw ? { value, unit: settings.units.weight } : undefined;
      if (isNew) await saveRecord('measurements', newRecord<Omit<Measurement, 'id' | 'createdAt' | 'updatedAt'>>({ kind, date, value: canonical, entered, note: note.trim() || undefined }), db);
      else await saveRecord('measurements', { ...target, date, value: canonical, entered, note: note.trim() || undefined }, db);
      onClose();
      toast.show(isBw ? t('progress.weightSaved') : t('progress.measurementSaved', { measurement: kindLabel(kind) }), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.entrySaveFailed'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    try {
      await deleteRecord('measurements', target.id, db);
      toast.show(t('progress.entryDeleted'));
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.entryDeleteFailed'), { tone: 'error' });
    }
    setConfirmDel(false);
    onClose();
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={isNew ? t('progress.addMeasurement', { measurement: lower(kindLabel(kind)) }) : t('progress.editMeasurement', { measurement: lower(kindLabel(kind)) })}
        footer={
          <>
            {!isNew && (
              <Button variant="danger" onClick={() => setConfirmDel(true)} className="mr-auto">
                {t('common.delete')}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {isNew && (
            <Select
              label={t('progress.measurement')}
              value={kind}
              onChange={(e) => {
                const k = e.target.value as MeasurementKind;
                setKind(k);
                setValue(initialValue(k));
                setError(null);
              }}
            >
              {MEASUREMENT_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{t(k.label)}</option>
              ))}
            </Select>
          )}
          <NumberInput label={`${kindLabel(kind)} (${u.unit})`} value={value} onChange={(v) => { setValue(v); setError(null); }} error={error} suffix={u.unit} />
          <Input label={t('progress.date')} type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value); setError(null); }} />
          <Input label={t('progress.note')} hint={t('common.optional')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} />
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} title={t('progress.deleteMeasurementTitle')} body={t('progress.deleteMeasurementHelp')} confirmLabel={t('common.delete')} danger onConfirm={remove} onCancel={() => setConfirmDel(false)} />
    </>
  );
}
