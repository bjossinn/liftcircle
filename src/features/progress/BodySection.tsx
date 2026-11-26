import { useMemo, useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Pencil, Plus, Scale } from 'lucide-react';
import { Button, Card, ConfirmDialog, EmptyState, IconButton, Input, NumberInput, Select, Sheet } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { deleteRecord, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import { rollingAverage } from '@/domain/stats';
import { cmToIn, fromKg, inToCm, round, toKg } from '@/domain/units';
import type { Measurement, MeasurementKind } from '@/domain/types';
import { formatDate } from '@/lib/dates';
import { ChartFigure, ChartTip, Legend, axisProps, chartAnimation, num, seriesLine, shortDate, useChartColors } from './charts';
import { t, useT, type MessageKey } from '@/i18n';
import type { ProgressData } from './shared';

const KINDS: { value: MeasurementKind; label: MessageKey }[] = [
  { value: 'bodyweight', label: 'progress.bodyweight' },
  { value: 'waist', label: 'progress.waist' },
  { value: 'chest', label: 'progress.chest' },
  { value: 'hips', label: 'progress.hips' },
  { value: 'arm', label: 'progress.arm' },
  { value: 'thigh', label: 'progress.thigh' },
  { value: 'bodyfat_pct', label: 'progress.bodyFat' },
];
const kindLabel = (k: MeasurementKind) => t(KINDS.find((x) => x.value === k)!.label);

/** Display unit, conversions and plausible bounds (in display units) for a measurement kind. */
function unitFor(kind: MeasurementKind, d: ProgressData) {
  const u = d.settings.units;
  if (kind === 'bodyweight') return { unit: u.weight, toDisplay: (v: number) => round(fromKg(v, u.weight), 1), toCanonical: (v: number) => toKg(v, u.weight), min: u.weight === 'kg' ? 20 : 45, max: u.weight === 'kg' ? 400 : 880 };
  if (kind === 'bodyfat_pct') return { unit: '%', toDisplay: (v: number) => round(v, 1), toCanonical: (v: number) => v, min: 2, max: 75 };
  const inch = u.length === 'ftin';
  return { unit: inch ? 'in' : 'cm', toDisplay: (v: number) => round(inch ? cmToIn(v) : v, 1), toCanonical: (v: number) => (inch ? inToCm(v) : v), min: inch ? 4 : 10, max: inch ? 120 : 300 };
}

export function BodySection({ d, today }: { d: ProgressData; today: string }) {
  const c = useChartColors();
  const { db } = useApp();
  const toast = useToast();
  const { t, locale } = useT();
  const lower = (s: string) => s.toLocaleLowerCase(locale);
  const [kind, setKind] = useState<MeasurementKind>('bodyweight');
  const [editing, setEditing] = useState<Measurement | 'new' | null>(null);
  const [date, setDate] = useState(today);
  const [value, setValue] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);

  const u = unitFor(kind, d);
  const all = useMemo(() => d.measurements.filter((m) => m.kind === kind).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt)), [d.measurements, kind]);
  const inRange = all.filter((m) => m.date >= d.from && m.date <= d.to);
  const isBw = kind === 'bodyweight';
  const chartData = useMemo(() => {
    // Rolling average uses all entries so the first points in the range have a full window.
    const avg = rollingAverage(all.map((m) => ({ date: m.date, value: m.value, id: m.id })), 7);
    const byId = new Map(avg.map((a) => [a.id, a.avg]));
    return [...inRange].reverse().map((m) => ({ date: m.date, value: u.toDisplay(m.value), avg: isBw ? u.toDisplay(byId.get(m.id) ?? m.value) : undefined }));
  }, [all, inRange, isBw, u]);

  const openNew = () => {
    setEditing('new');
    setDate(today);
    setValue(all[0] ? (all[0].entered && all[0].entered.unit === u.unit ? all[0].entered.value : u.toDisplay(all[0].value)) : null);
    setNote('');
    setError(null);
  };
  const openEdit = (m: Measurement) => {
    setEditing(m);
    setDate(m.date);
    setValue(m.entered && m.entered.unit === u.unit ? m.entered.value : u.toDisplay(m.value));
    setNote(m.note ?? '');
    setError(null);
  };

  const save = async () => {
    if (value == null || value < u.min || value > u.max) {
      setError(t('validation.between', { min: u.min, max: u.max, unit: u.unit }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
      setError('Choose a date that isn’t in the future'); // i18n: no approved Icelandic copy
      return;
    }
    setBusy(true);
    try {
      const canonical = u.toCanonical(value);
      const entered = isBw ? { value, unit: d.settings.units.weight } : undefined;
      if (editing === 'new') {
        await saveRecord('measurements', newRecord<Omit<Measurement, 'id' | 'createdAt' | 'updatedAt'>>({ kind, date, value: canonical, entered, note: note.trim() || undefined }), db);
      } else if (editing) {
        await saveRecord('measurements', { ...editing, date, value: canonical, entered, note: note.trim() || undefined }, db);
      }
      setEditing(null);
      toast.show(isBw ? t('progress.weightSaved') : t('progress.measurementSaved', { measurement: kindLabel(kind) }), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.entrySaveFailed'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || editing === 'new') return;
    try {
      await deleteRecord('measurements', editing.id, db);
      toast.show(t('progress.entryDeleted'));
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('progress.entryDeleteFailed'), { tone: 'error' });
    }
    setConfirmDel(false);
    setEditing(null);
  };

  const fmt = (m: Measurement) => `${num(m.entered && m.entered.unit === u.unit ? m.entered.value : u.toDisplay(m.value))} ${u.unit}`;
  const latest = chartData.at(-1);
  const firstPt = chartData[0];
  const summary =
    chartData.length >= 2
      ? t('progress.measurementTrend', { count: chartData.length, metric: t(isBw ? 'progress.average7Days' : 'progress.value'), first: (isBw ? firstPt.avg : firstPt.value) ?? '–', last: (isBw ? latest!.avg : latest!.value) ?? '–', unit: u.unit })
      : chartData.length === 1
        ? t('progress.oneMeasurement', { value: latest!.value, unit: u.unit })
        : '';

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex gap-2 items-end">
        <Select label={t('progress.measurement')} value={kind} onChange={(e) => setKind(e.target.value as MeasurementKind)} className="flex-1">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{t(k.label)}</option>
          ))}
        </Select>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={openNew}>
          {/* i18n: no approved Icelandic copy for the bare "Add" button */}
          Add
        </Button>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Scale className="size-6" />}
          title={isBw ? t('progress.weightEmpty') : t('progress.measurementEmpty', { measurement: lower(kindLabel(kind)) })}
          body={isBw ? t('progress.weightHelp') : t('progress.measurementPrivacy')}
          action={<Button onClick={openNew}>{t('progress.addMeasurement', { measurement: lower(kindLabel(kind)) })}</Button>}
        />
      ) : (
        <>
          {chartData.length > 0 ? (
            <div>
              {isBw && <Legend items={[{ label: t('progress.entries'), color: c.series[1], series: 1 }, { label: t('progress.average7Days'), color: c.series[0], series: 0 }]} />}
              <ChartFigure
                title={`${kindLabel(kind)} (${u.unit})`}
                summary={summary}
                table={{ headers: [t('progress.date'), t('progress.valueUnit', { unit: u.unit }), ...(isBw ? [t('progress.average7DaysShort')] : [])], rows: chartData.map((p) => [formatDate(p.date), p.value, ...(isBw ? [p.avg ?? '–'] : [])]) }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid vertical={false} stroke={c.line} />
                    <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} tickFormatter={(v: number) => num(v)} />
                    <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${num(v)} ${u.unit}`} />} />
                    <Line dataKey="value" name="Entry" /* i18n: no approved Icelandic copy */ strokeWidth={2} isAnimationActive={chartAnimation()} {...seriesLine(isBw ? 1 : 0, c)} stroke={isBw ? 'transparent' : c.series[0]} />
                    {isBw && <Line type="monotone" dataKey="avg" name={t('progress.average7Days')} strokeWidth={2} isAnimationActive={chartAnimation()} {...seriesLine(0, c)} dot={false} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartFigure>
            </div>
          ) : (
            <p className="text-sm text-muted">{t('progress.entriesPeriodEmpty')}</p>
          )}
          <ul className="-mx-4 divide-y divide-line border-t border-line max-h-80 overflow-y-auto">
            {all.slice(0, 50).map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-4 min-h-12">
                <span className="flex-1 min-w-0">
                  <span className="text-[15px] tabular">{fmt(m)}</span>
                  <span className="block text-xs text-muted truncate">{formatDate(m.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}{m.note ? ` · ${m.note}` : ''}</span>
                </span>
                <IconButton label={t('progress.editMeasurementDated', { measurement: lower(kindLabel(kind)), date: formatDate(m.date) })} onClick={() => openEdit(m)}>
                  <Pencil className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        </>
      )}

      <Sheet
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('progress.addMeasurement', { measurement: lower(kindLabel(kind)) }) : t('progress.editMeasurement', { measurement: lower(kindLabel(kind)) })}
        footer={
          <>
            {editing && editing !== 'new' && (
              <Button variant="danger" onClick={() => setConfirmDel(true)} className="mr-auto">
                {t('common.delete')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <NumberInput label={`${kindLabel(kind)} (${u.unit})`} value={value} onChange={(v) => { setValue(v); setError(null); }} error={error} suffix={u.unit} />
          <Input label={t('progress.date')} type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value); setError(null); }} />
          <Input label={t('progress.note')} hint={t('common.optional')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} />
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} title={t('progress.deleteMeasurementTitle')} body={t('progress.deleteMeasurementHelp')} confirmLabel={t('common.delete')} danger onConfirm={remove} onCancel={() => setConfirmDel(false)} />
    </Card>
  );
}
