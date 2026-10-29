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
import { ChartFigure, ChartTip, Legend, axisProps, chartAnimation, shortDate, useChartColors } from './charts';
import type { ProgressData } from './shared';

const KINDS: { value: MeasurementKind; label: string }[] = [
  { value: 'bodyweight', label: 'Bodyweight' },
  { value: 'waist', label: 'Waist' },
  { value: 'chest', label: 'Chest' },
  { value: 'hips', label: 'Hips' },
  { value: 'arm', label: 'Arm' },
  { value: 'thigh', label: 'Thigh' },
  { value: 'bodyfat_pct', label: 'Body fat' },
];
const kindLabel = (k: MeasurementKind) => KINDS.find((x) => x.value === k)!.label;

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
      setError(`Enter a value between ${u.min} and ${u.max} ${u.unit}`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
      setError('Choose a date that isn’t in the future');
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
      toast.show(`${kindLabel(kind)} saved`, { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t save the entry', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || editing === 'new') return;
    try {
      await deleteRecord('measurements', editing.id, db);
      toast.show('Entry deleted');
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t delete the entry', { tone: 'error' });
    }
    setConfirmDel(false);
    setEditing(null);
  };

  const fmt = (m: Measurement) => `${m.entered && m.entered.unit === u.unit ? m.entered.value : u.toDisplay(m.value)} ${u.unit}`;
  const latest = chartData.at(-1);
  const firstPt = chartData[0];
  const summary =
    chartData.length >= 2
      ? `${chartData.length} entries. ${isBw ? '7-day average' : 'Value'} went from ${isBw ? firstPt.avg : firstPt.value} to ${isBw ? latest!.avg : latest!.value} ${u.unit}.`
      : chartData.length === 1
        ? `One entry: ${latest!.value} ${u.unit}.`
        : '';

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex gap-2 items-end">
        <Select label="Measurement" value={kind} onChange={(e) => setKind(e.target.value as MeasurementKind)} className="flex-1">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </Select>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={openNew}>
          Add
        </Button>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Scale className="size-6" />}
          title={`No ${kindLabel(kind).toLowerCase()} entries yet`}
          body={isBw ? 'Weigh in at a similar time of day; a 7-day average smooths out day-to-day changes.' : 'Measurements are optional. Other members never see them; a coach or the AI coach only does if you choose to share measurements.'}
          action={<Button onClick={openNew}>Add {kindLabel(kind).toLowerCase()}</Button>}
        />
      ) : (
        <>
          {chartData.length > 0 ? (
            <div>
              {isBw && <Legend items={[{ label: 'Entries', color: c.faint }, { label: '7-day average', color: c.accent }]} />}
              <ChartFigure
                title={`${kindLabel(kind)} (${u.unit})`}
                summary={summary}
                table={{ headers: ['Date', `Value (${u.unit})`, ...(isBw ? ['7-day avg'] : [])], rows: chartData.map((p) => [formatDate(p.date), p.value, ...(isBw ? [p.avg ?? '–'] : [])]) }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid vertical={false} stroke={c.line} />
                    <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(c)} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis {...axisProps(c)} domain={['auto', 'auto']} width={52} />
                    <Tooltip cursor={{ stroke: c.line }} content={(p) => <ChartTip {...p} labelFmt={(l) => formatDate(l)} valueFmt={(v) => `${v} ${u.unit}`} />} />
                    <Line dataKey="value" name="Entry" stroke={isBw ? 'transparent' : c.accent} strokeWidth={2} dot={{ r: 4, fill: isBw ? c.faint : c.accent, stroke: c.surface, strokeWidth: 2 }} activeDot={{ r: 6 }} isAnimationActive={chartAnimation()} />
                    {isBw && <Line type="monotone" dataKey="avg" name="7-day average" stroke={c.accent} strokeWidth={2} dot={false} isAnimationActive={chartAnimation()} />}
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartFigure>
            </div>
          ) : (
            <p className="text-sm text-muted">No entries in this period.</p>
          )}
          <ul className="-mx-4 divide-y divide-line border-t border-line max-h-80 overflow-y-auto">
            {all.slice(0, 50).map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-4 min-h-12">
                <span className="flex-1 min-w-0">
                  <span className="text-[15px] tabular">{fmt(m)}</span>
                  <span className="block text-xs text-muted truncate">{formatDate(m.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}{m.note ? ` · ${m.note}` : ''}</span>
                </span>
                <IconButton label={`Edit ${kindLabel(kind).toLowerCase()} entry from ${formatDate(m.date)}`} onClick={() => openEdit(m)}>
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
        title={editing === 'new' ? `Add ${kindLabel(kind).toLowerCase()}` : `Edit ${kindLabel(kind).toLowerCase()}`}
        footer={
          <>
            {editing && editing !== 'new' && (
              <Button variant="danger" onClick={() => setConfirmDel(true)} className="mr-auto">
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={busy}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <NumberInput label={`${kindLabel(kind)} (${u.unit})`} value={value} onChange={(v) => { setValue(v); setError(null); }} error={error} suffix={u.unit} />
          <Input label="Date" type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value); setError(null); }} />
          <Input label="Note" hint="Optional" value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} />
        </div>
      </Sheet>
      <ConfirmDialog open={confirmDel} title="Delete this entry?" body="It will be removed from your charts and averages." confirmLabel="Delete" danger onConfirm={remove} onCancel={() => setConfirmDel(false)} />
    </Card>
  );
}
