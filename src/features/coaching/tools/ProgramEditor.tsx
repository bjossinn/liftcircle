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
import { weekdayLong, weekdayShort } from '@/lib/dates';
import { SessionCard, WeekStrip } from '@/features/program/parts';
import { moveSessions, newTemplateId, setSessionDays } from '@/coaching/programDraft';
import { useT } from '@/i18n';
import { sessionDisplayName } from '@/domain/program/localize';

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
  const { t, tp } = useT();
  const [rescheduling, setRescheduling] = useState(false);
  const doubleBooked = WEEK_ORDER.filter((d) => program.schedule.filter((s) => s.weekday === d).length > 1);
  const addSession = () => {
    const letter = String.fromCharCode(65 + (program.templates.length % 26));
    onChange({ ...program, templates: [...program.templates, emptyTemplate(newTemplateId(), t('onboarding.manualSessionName', { letter }))] });
  };

  return (
    <>
      <Input label={t('coaching.editor.program_name')} value={program.name} maxLength={80} onChange={(e) => onChange({ ...program, name: e.target.value })} error={!program.name.trim() ? t('coaching.editor.give_the_program_a_name') : null} />

      <SectionTitle
        action={
          program.schedule.length > 0 ? (
            <Button size="sm" variant="ghost" icon={<CalendarClock className="size-4" />} onClick={() => setRescheduling(true)}>
              {t('today.reschedule')}
            </Button>
          ) : undefined
        }
      >
        {t('program.schedule')}
      </SectionTitle>
      <WeekStrip version={program} weekStart={weekStart} />
      {program.schedule.length === 0 && <p className="text-xs text-muted mt-2 px-1">{t('coaching.editor.use_days_on_a_session_to')}</p>}
      {doubleBooked.length > 0 && (
        <Notice tone="warn" className="mt-2">
          {tp('coaching.editor.days_have_two_sessions', doubleBooked.length, { days: doubleBooked.map((d) => weekdayShort(d)).join(', ') })}
        </Notice>
      )}

      <SectionTitle
        action={
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={addSession} disabled={program.templates.length >= 14}>
            {t('program.add_session')}
          </Button>
        }
      >
        {t('aiCard.proposal.sessions')}
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {program.templates.map((tpl) => (
          <SessionCard
            key={tpl.id}
            template={tpl}
            byId={byId}
            catalog={catalog}
            unit={unit}
            pickerOnlyIds={pickerOnlyIds}
            pickerOnlyNote={pickerOnlyNote}
            editable
            experience={experience}
            goal={goal}
            days={program.schedule.filter((s) => s.templateId === tpl.id).map((s) => s.weekday)}
            defaultOpen={program.templates.length <= 3}
            onChange={(next) => onChange({ ...program, templates: program.templates.map((x) => (x.id === next.id ? next : x)) })}
            onDaysChange={(d) => onChange(setSessionDays(program, tpl.id, d))}
            onDelete={() => onChange({ ...program, templates: program.templates.filter((x) => x.id !== tpl.id), schedule: program.schedule.filter((s) => s.templateId !== tpl.id) })}
          />
        ))}
        {program.templates.length === 0 && (
          <Card className="px-4 py-3 text-sm text-muted">
            {t('coaching.editor.no_sessions_yet')}{' '}
            <button type="button" className="underline" onClick={addSession}>
              {t('coaching.editor.add_one')}
            </button>
            .
          </Card>
        )}
      </div>

      <SectionTitle>{t('coaching.editor.block_progression')}</SectionTitle>
      <Card className="px-4 py-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label={t('coaching.editor.block_length_weeks')}
            decimals={false}
            min={1}
            max={52}
            value={program.weeks}
            onChange={(v) => {
              const weeks = v ?? 8;
              onChange({ ...program, weeks, reviewWeek: Math.min(program.reviewWeek, weeks) });
            }}
          />
          <NumberInput label={t('coaching.editor.review_in_week')} decimals={false} min={1} max={program.weeks} value={program.reviewWeek} onChange={(v) => onChange({ ...program, reviewWeek: Math.min(v ?? program.weeks, program.weeks) })} />
        </div>
        <Textarea
          label={t('coaching.editor.progression_instructions')}
          maxLength={2000}
          value={program.progressionNotes ?? ''}
          onChange={(e) => onChange({ ...program, progressionNotes: e.target.value })}
          placeholder={t('coaching.editor.e_g_add_2_5_kg')}
          hint={t('coaching.editor.shown_to_the_client_with_the')}
        />
      </Card>

      <RescheduleSheet open={rescheduling} program={program} onClose={() => setRescheduling(false)} onApply={(p) => (onChange(p), setRescheduling(false))} />
    </>
  );
}

/** Missed sessions / schedule change helper: move scheduled sessions to other weekdays. */
function RescheduleSheet({ open, program, onClose, onApply }: { open: boolean; program: ProposedProgram; onClose: () => void; onApply: (p: ProposedProgram) => void }) {
  const { t } = useT();
  return (
    <Sheet open={open} onClose={onClose} title={t('coaching.editor.reschedule_sessions')}>
      {open && <RescheduleForm program={program} onCancel={onClose} onApply={onApply} />}
    </Sheet>
  );
}
function RescheduleForm({ program, onCancel, onApply }: { program: ProposedProgram; onCancel: () => void; onApply: (p: ProposedProgram) => void }) {
  const { t, tp } = useT();
  const [days, setDays] = useState<number[]>(program.schedule.map((s) => s.weekday));
  const { schedule, clashes } = moveSessions(program.schedule, days);
  const changed = days.some((d, i) => d !== program.schedule[i]?.weekday);
  const nameOf = (id: ID) => {
    const tpl = program.templates.find((x) => x.id === id);
    return tpl ? sessionDisplayName(tpl) : t('coaching.editor.session');
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('coaching.editor.missed_a_session_or_the_clients')}</p>
      <ul className="flex flex-col gap-2">
        {program.schedule.map((s, i) => (
          <li key={`${s.templateId}-${i}`} className="grid grid-cols-[1fr_9rem] items-center gap-3">
            <span className="text-sm">
              <span className="font-medium">{nameOf(s.templateId)}</span>
              <span className="block text-xs text-muted">{t('coaching.editor.now_x', { day: weekdayLong(s.weekday) })}</span>
            </span>
            <Select aria-label={t('coaching.editor.new_day_for_x', { name: nameOf(s.templateId) })} value={days[i]} onChange={(e) => setDays(days.map((d, j) => (j === i ? Number(e.target.value) : d)))}>
              {WEEK_ORDER.map((w) => (
                <option key={w} value={w}>
                  {weekdayLong(w)}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
      {clashes.length > 0 && (
        <p role="alert" className="text-sm text-danger">
          {tp('coaching.editor.days_would_have_two_sessions', clashes.length, { days: clashes.map((d) => weekdayLong(d)).join(', ') })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!changed || clashes.length > 0} onClick={() => onApply({ ...program, schedule })}>
          {t('coaching.editor.apply_new_days')}
        </Button>
      </div>
    </div>
  );
}
