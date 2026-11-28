import type { ProposedProgram } from '@/backend/coachingContract';
import type { Exercise, ID, WeightUnit } from '@/domain/types';
import { Card, SectionTitle } from '@/components/ui';
import { SessionCard, WeekStrip } from '@/features/program/parts';
import { useT } from '@/i18n';

/** Read-only preview of proposed program content using the existing program components. */
export function ProgramPreview({ program, byId, catalog, unit, weekStart }: { program: ProposedProgram; byId: Map<ID, Exercise>; catalog: Exercise[]; unit: WeightUnit; weekStart: 0 | 1 }) {
  const { t } = useT();
  return (
    <>
      <SectionTitle>{t('program.schedule')}</SectionTitle>
      <WeekStrip version={program} weekStart={weekStart} />
      <p className="text-xs text-muted mt-2 px-1">
        {t('coaching.editor.week_block_review_in_week', { weeks: program.weeks, reviewWeek: program.reviewWeek })}
      </p>
      <SectionTitle>{t('aiCard.proposal.sessions')}</SectionTitle>
      <div className="flex flex-col gap-3">
        {program.templates.map((tpl) => (
          <SessionCard
            key={tpl.id}
            template={tpl}
            byId={byId}
            catalog={catalog}
            unit={unit}
            days={program.schedule.filter((s) => s.templateId === tpl.id).map((s) => s.weekday)}
            defaultOpen={program.templates.length <= 2}
          />
        ))}
      </div>
      {program.progressionNotes?.trim() && (
        <>
          <SectionTitle>{t('coaching.editor.how_to_progress')}</SectionTitle>
          <Card className="px-4 py-3 text-sm whitespace-pre-wrap break-words">{program.progressionNotes}</Card>
        </>
      )}
    </>
  );
}
