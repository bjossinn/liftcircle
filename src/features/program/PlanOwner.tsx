import { Bot, HeartHandshake } from 'lucide-react';
import type { Program } from '@/domain/types';
import { Badge } from '@/components/ui';
import { t, useT } from '@/i18n';

/** Who manages the active plan, in words. null for a self-managed plan. */
export function planOwnerText(p: Pick<Program, 'managedBy'> | null | undefined): string | null {
  const m = p?.managedBy;
  if (!m || m.kind === 'self') return null;
  if (m.kind === 'coach') return m.coachName ? t('program.owner.assignedBy', { coach: m.coachName }) : t('program.owner.coach');
  return t('program.owner.ai');
}

/** Small label shown next to the plan on Today, Train and the program editor. */
export function PlanOwnerBadge({ program, className }: { program: Pick<Program, 'managedBy'> | null | undefined; className?: string }) {
  useT(); // re-render on a language change
  const text = planOwnerText(program);
  if (!text) return null;
  const Icon = program?.managedBy?.kind === 'coach' ? HeartHandshake : Bot;
  return (
    <Badge tone={program?.managedBy?.kind === 'coach' ? 'accent' : 'info'} className={className}>
      <Icon className="size-4 mr-1 inline" aria-hidden />
      {text}
    </Badge>
  );
}
