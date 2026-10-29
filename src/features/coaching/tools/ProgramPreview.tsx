import type { ProposedProgram } from '@/backend/coachingContract';
import type { Exercise, ID, WeightUnit } from '@/domain/types';
import { Card, SectionTitle } from '@/components/ui';
import { SessionCard, WeekStrip } from '@/features/program/parts';

/** Read-only preview of proposed program content using the existing program components. */
export function ProgramPreview({ program, byId, catalog, unit, weekStart }: { program: ProposedProgram; byId: Map<ID, Exercise>; catalog: Exercise[]; unit: WeightUnit; weekStart: 0 | 1 }) {
  return (
    <>
      <SectionTitle>Weekly schedule</SectionTitle>
      <WeekStrip version={program} weekStart={weekStart} />
      <p className="text-xs text-muted mt-2 px-1">
        {program.weeks}-week block · review in week {program.reviewWeek}
      </p>
      <SectionTitle>Sessions</SectionTitle>
      <div className="flex flex-col gap-3">
        {program.templates.map((t) => (
          <SessionCard
            key={t.id}
            template={t}
            byId={byId}
            catalog={catalog}
            unit={unit}
            days={program.schedule.filter((s) => s.templateId === t.id).map((s) => s.weekday)}
            defaultOpen={program.templates.length <= 2}
          />
        ))}
      </div>
      {program.progressionNotes?.trim() && (
        <>
          <SectionTitle>How to progress</SectionTitle>
          <Card className="px-4 py-3 text-sm whitespace-pre-wrap break-words">{program.progressionNotes}</Card>
        </>
      )}
    </>
  );
}
