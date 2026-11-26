/** The program preview at the end of onboarding: the suggested plan, editable before it's saved. */
import { useState } from 'react';
import { LayoutGrid, Shuffle } from 'lucide-react';
import { Badge, Button, Card, Notice, SectionTitle, Sheet } from '@/components/ui';
import { weekdaysText } from '@/domain/program/explain';
import { regenerateTemplates, suggestProgramName } from '@/domain/program/generator';
import { effectiveLiftingDays, resolveSplit, splitKeyOfVersion } from '@/domain/program/splits';
import { localizeGeneratedText, programDisplayName, splitLabel } from '@/domain/program/localize';
import { locale, t, useT } from '@/i18n';
import type { Exercise, ID, OnboardingAnswers, ProgramVersion, SessionTemplate, SplitKey } from '@/domain/types';
import { PlanLegend, SessionCard, WeekStrip, WhyItFits } from '@/features/program/parts';
import { trainingDaysOf, type Draft } from './draft';
import { EXPERIENCE_OPTIONS, GOAL_OPTIONS, limitationLabel, LOCATION_OPTIONS, SplitPicker } from './steps';

/** One line restating the six answers, e.g. "Build muscle · New to lifting · Mon, Wed, Fri · 60 min · Gym". */
export function answersSummary(a: OnboardingAnswers): string {
  const parts = [
    GOAL_OPTIONS.find((g) => g.value === a.goal)?.title,
    EXPERIENCE_OPTIONS.find((o) => o.value === a.experience)?.title,
    weekdaysText(trainingDaysOf(a)),
    t('onboarding.result.minutes', { minutes: a.sessionMinutes }),
    LOCATION_OPTIONS.find((o) => o.value === a.location)?.title,
    a.limitations.length ? t('onboarding.result.carefulWith', { areas: a.limitations.map((l) => limitationLabel(l).toLocaleLowerCase(locale())).join(', ') }) : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function ResultStep({
  d,
  version,
  catalog,
  byId,
  onVersion,
  onShuffle,
  onSplit,
  setDraft,
  today,
}: {
  d: Draft;
  version: ProgramVersion;
  catalog: Exercise[];
  byId: Map<ID, Exercise>;
  onVersion: (v: ProgramVersion) => void;
  /** Re-pick exercises within the same split. */
  onShuffle: () => void;
  /** Choose another split structure. */
  onSplit: (key: SplitKey) => void;
  setDraft: (fn: (d: Draft) => Draft) => void;
  /** The block's start date, already formatted for display (not an ISO date). */
  today: string;
}) {
  const { t } = useT();
  const a = d.a;
  const unit = a.units.weight;
  const days = (t: SessionTemplate) => version.schedule.filter((s) => s.templateId === t.id).map((s) => s.weekday);
  const regenerate = (t: SessionTemplate) => {
    const n = (d.regen[t.id] ?? 0) + 1;
    setDraft((x) => ({ ...x, regen: { ...x.regen, [t.id]: n } }));
    onVersion(regenerateTemplates(version, [t.id], a, catalog, d.variant + n));
  };
  const totalMin = version.schedule.reduce((s, slot) => s + (version.templates.find((t) => t.id === slot.templateId)?.estimatedMinutes ?? 0), 0);
  const [splitOpen, setSplitOpen] = useState(false);
  const split = resolveSplit(a, effectiveLiftingDays(a));
  const shownKey = splitKeyOfVersion(version) ?? split.key;
  const canShuffle = version.templates.some((t) => t.exercises.length > 0);
  return (
    <div className="flex flex-col">
      <Card className="px-4 py-3">
        <h2 className="text-lg font-semibold">{programDisplayName(suggestProgramName(a, version))}</h2>
        <p className="text-sm mt-1" data-testid="answers-summary">
          {answersSummary(a)}
        </p>
        <p className="text-sm text-muted mt-1">
          {t('onboarding.result.block', { weeks: version.weeks, date: today, reviewWeek: version.reviewWeek, minutes: Math.round(totalMin / 5) * 5 })}
        </p>
        <div className="mt-3">
          <WeekStrip version={version} />
        </div>
        {shownKey && (
          <p className="text-sm mt-3">
            <span className="text-muted">{t('onboarding.result.splitLabel')} </span>
            <span className="font-medium">{splitLabel(shownKey)}</span>
            {split.recommended && shownKey === split.key && ' '}
            {split.recommended && shownKey === split.key && (
              <Badge tone="accent" className="ml-1">
                {t('onboarding.result.recommended')}
              </Badge>
            )}
          </p>
        )}
        {split.adjustment && (
          <Notice tone="warn" className="mt-2 py-2.5">
            {localizeGeneratedText(split.adjustment.message)}
          </Notice>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          {split.options.length > 1 && (
            <Button size="sm" icon={<LayoutGrid className="size-4" />} onClick={() => setSplitOpen(true)}>
              {t('onboarding.result.changeSplit')}
            </Button>
          )}
          {canShuffle && (
            <Button size="sm" variant="ghost" icon={<Shuffle className="size-4" />} onClick={onShuffle}>
              {t('onboarding.result.shuffle')}
            </Button>
          )}
        </div>
      </Card>

      <WhyItFits version={version} defaultOpen={false} experience={a.experience} />

      <SectionTitle>{t('onboarding.result.sessions')}</SectionTitle>
      <PlanLegend />
      <div className="flex flex-col gap-3">
        {version.templates.map((t) => (
          <SessionCard
            key={t.id}
            template={t}
            byId={byId}
            catalog={catalog}
            unit={unit}
            editable
            experience={a.experience}
            goal={a.goal}
            days={days(t)}
            defaultOpen={t.kind === 'lifting'}
            onChange={(next) => onVersion({ ...version, templates: version.templates.map((x) => (x.id === next.id ? next : x)) })}
            onRegenerate={t.exercises.length ? () => regenerate(t) : undefined}
          />
        ))}
      </div>

      <Sheet open={splitOpen} onClose={() => setSplitOpen(false)} title={t('onboarding.result.changeSplit')}>
        {splitOpen && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t('onboarding.result.splitDescription', { count: split.liftingDays })}</p>
            <SplitPicker
              a={a}
              showTitle={false}
              onSelect={(key) => {
                setSplitOpen(false);
                if (key !== shownKey) onSplit(key);
                else if (a.splitPreference !== key)
                  // Same structure as shown: just make the choice explicit and keep any edits.
                  setDraft((x) => {
                    const na = { ...x.a, splitPreference: key };
                    return { ...x, a: na, versionKey: x.version && x.versionKey === JSON.stringify(x.a) ? JSON.stringify(na) : x.versionKey };
                  });
              }}
            />
          </div>
        )}
      </Sheet>

    </div>
  );
}
