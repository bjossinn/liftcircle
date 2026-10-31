/**
 * Editor for a coach's ProposedProgram, built from the existing program editor parts
 * (SessionCard with editable=true, WeekStrip, DaysSheet via SessionCard, ExercisePicker inside it).
 * All edits go through `onChange` — nothing here touches the client's records.
 */
import { useState } from 'react';
import { CalendarClock, Plus } from 'lucide-react';
import { Button, Card, Input, Notice, NumberInput, SectionTitle, Select, Sheet, Textarea } from '@/components/ui';
import type { ProposedProgram } from '@/backend/coachingContract';
import type { Exercise, Experience, Goal, ID, WeightUnit } from '@/domain/types';
import { emptyTemplate, WEEK_ORDER } from '@/domain/program/generator';
import { WEEKDAY_LONG, WEEKDAY_SHORT } from '@/lib/dates';
import { SessionCard, WeekStrip } from '@/features/program/parts';
import { moveSessions, newTemplateId, setSessionDays } from '@/coaching/programDraft';

export function ProgramEditor({
  program, onChange, byId, catalog, unit, weekStart, experience, goal, pickerOnlyIds, pickerOnlyNote,
}: {
  program: ProposedProgram;
  onChange: (p: ProposedProgram) => void;
  byId: Map<ID, Exercise>;
  catalog: Exercise[];
  unit: WeightUnit;
  weekStart: 0 | 1;
  experience?: Experience;
  goal?: Goal;
  pickerOnlyIds?: Set<ID>;
  pickerOnlyNote?: string;
}) {
  const [rescheduling, setRescheduling] = useState(false);
  const doubleBooked = WEEK_ORDER.filter((d) => program.schedule.filter((s) => s.weekday === d).length > 1);
  const addSession = () => {
    const letter = String.fromCharCode(65 + (program.templates.length % 26));
    onChange({ ...program, templates: [...program.templates, emptyTemplate(newTemplateId(), `Session ${letter}`)] });
  };

  return (
    <>
      <Input label="Program name" value={program.name} maxLength={80} onChange={(e) => onChange({ ...program, name: e.target.value })} error={!program.name.trim() ? 'Give the program a name.' : null} />

      <SectionTitle
        action={
          program.schedule.length > 0 ? (
            <Button size="sm" variant="ghost" icon={<CalendarClock className="size-4" />} onClick={() => setRescheduling(true)}>
              Reschedule
            </Button>
          ) : undefined
        }
      >
        Weekly schedule
      </SectionTitle>
      <WeekStrip version={program} weekStart={weekStart} />
      {program.schedule.length === 0 && <p className="text-xs text-muted mt-2 px-1">Use “Days” on a session to place it in the week.</p>}
      {doubleBooked.length > 0 && (
        <Notice tone="warn" className="mt-2">
          {doubleBooked.map((d) => WEEKDAY_SHORT[d]).join(', ')} {doubleBooked.length === 1 ? 'has' : 'have'} two sessions. Move one before sending. The plan allows one session per day.
        </Notice>
      )}

      <SectionTitle
        action={
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={addSession} disabled={program.templates.length >= 14}>
            Add session
          </Button>
        }
      >
        Sessions
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {program.templates.map((t) => (
          <SessionCard
            key={t.id}
            template={t}
            byId={byId}
            catalog={catalog}
            unit={unit}
            pickerOnlyIds={pickerOnlyIds}
            pickerOnlyNote={pickerOnlyNote}
            editable
            experience={experience}
            goal={goal}
            days={program.schedule.filter((s) => s.templateId === t.id).map((s) => s.weekday)}
            defaultOpen={program.templates.length <= 3}
            onChange={(next) => onChange({ ...program, templates: program.templates.map((x) => (x.id === next.id ? next : x)) })}
            onDaysChange={(d) => onChange(setSessionDays(program, t.id, d))}
            onDelete={() => onChange({ ...program, templates: program.templates.filter((x) => x.id !== t.id), schedule: program.schedule.filter((s) => s.templateId !== t.id) })}
          />
        ))}
        {program.templates.length === 0 && (
          <Card className="px-4 py-3 text-sm text-muted">
            No sessions yet.{' '}
            <button type="button" className="underline" onClick={addSession}>
              Add one
            </button>
            .
          </Card>
        )}
      </div>

      <SectionTitle>Block & progression</SectionTitle>
      <Card className="px-4 py-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Block length (weeks)"
            decimals={false}
            min={1}
            max={52}
            value={program.weeks}
            onChange={(v) => {
              const weeks = v ?? 8;
              onChange({ ...program, weeks, reviewWeek: Math.min(program.reviewWeek, weeks) });
            }}
          />
          <NumberInput label="Review in week" decimals={false} min={1} max={program.weeks} value={program.reviewWeek} onChange={(v) => onChange({ ...program, reviewWeek: Math.min(v ?? program.weeks, program.weeks) })} />
        </div>
        <Textarea
          label="Progression instructions"
          maxLength={2000}
          value={program.progressionNotes ?? ''}
          onChange={(e) => onChange({ ...program, progressionNotes: e.target.value })}
          placeholder="e.g. Add 2.5 kg to main lifts when you hit the top of the rep range on all sets. Deload in week 5."
          hint="Shown to the client with the plan."
        />
      </Card>

      <RescheduleSheet open={rescheduling} program={program} onClose={() => setRescheduling(false)} onApply={(p) => (onChange(p), setRescheduling(false))} />
    </>
  );
}

/** Missed sessions / schedule change helper: move scheduled sessions to other weekdays. */
function RescheduleSheet({ open, program, onClose, onApply }: { open: boolean; program: ProposedProgram; onClose: () => void; onApply: (p: ProposedProgram) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Reschedule sessions">
      {open && <RescheduleForm program={program} onCancel={onClose} onApply={onApply} />}
    </Sheet>
  );
}
function RescheduleForm({ program, onCancel, onApply }: { program: ProposedProgram; onCancel: () => void; onApply: (p: ProposedProgram) => void }) {
  const [days, setDays] = useState<number[]>(program.schedule.map((s) => s.weekday));
  const { schedule, clashes } = moveSessions(program.schedule, days);
  const changed = days.some((d, i) => d !== program.schedule[i]?.weekday);
  const nameOf = (id: ID) => program.templates.find((t) => t.id === id)?.name ?? 'Session';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Missed a session or the client’s week changed? Move sessions to other days, then send it as a revised proposal. The client accepts it before anything changes.</p>
      <ul className="flex flex-col gap-2">
        {program.schedule.map((s, i) => (
          <li key={`${s.templateId}-${i}`} className="grid grid-cols-[1fr_9rem] items-center gap-3">
            <span className="text-sm">
              <span className="font-medium">{nameOf(s.templateId)}</span>
              <span className="block text-xs text-muted">now {WEEKDAY_LONG[s.weekday]}</span>
            </span>
            <Select aria-label={`New day for ${nameOf(s.templateId)}`} value={days[i]} onChange={(e) => setDays(days.map((d, j) => (j === i ? Number(e.target.value) : d)))}>
              {WEEK_ORDER.map((w) => (
                <option key={w} value={w}>
                  {WEEKDAY_LONG[w]}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
      {clashes.length > 0 && (
        <p role="alert" className="text-sm text-danger">
          {clashes.map((d) => WEEKDAY_LONG[d]).join(', ')} would have two sessions.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!changed || clashes.length > 0} onClick={() => onApply({ ...program, schedule })}>
          Apply new days
        </Button>
      </div>
    </div>
  );
}
