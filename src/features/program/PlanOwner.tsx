import { Bot, HeartHandshake } from 'lucide-react';
import type { Program } from '@/domain/types';
import { Badge } from '@/components/ui';

/** Who manages the active plan, in words. null for a self-managed plan. */
export function planOwnerText(p: Pick<Program, 'managedBy'> | null | undefined): string | null {
  const m = p?.managedBy;
  if (!m || m.kind === 'self') return null;
  if (m.kind === 'coach') return m.coachName ? `Assigned by ${m.coachName}` : 'Managed by your coach';
  return 'AI-suggested plan you accepted';
}

/** Small label shown next to the plan on Today, Train and the program editor. */
export function PlanOwnerBadge({ program, className }: { program: Pick<Program, 'managedBy'> | null | undefined; className?: string }) {
  const text = planOwnerText(program);
  if (!text) return null;
  const Icon = program?.managedBy?.kind === 'coach' ? HeartHandshake : Bot;
  return (
    <Badge tone={program?.managedBy?.kind === 'coach' ? 'accent' : 'info'} className={className}>
      <Icon className="size-3.5 mr-1 inline" aria-hidden />
      {text}
    </Badge>
  );
}
