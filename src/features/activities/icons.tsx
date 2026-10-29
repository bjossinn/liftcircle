import { Activity, Bike, Flower2, Footprints, Mountain, Move, Ship, StretchHorizontal, Trophy, Users, Waves, Zap, type LucideIcon } from 'lucide-react';
import type { ActivityType } from '@/domain/types';

export const ACTIVITY_ICONS: Record<ActivityType, LucideIcon> = {
  walk: Footprints,
  run: Zap,
  cycle: Bike,
  hike: Mountain,
  swim: Waves,
  row: Ship,
  sport: Trophy,
  class: Users,
  yoga: Flower2,
  mobility: Move,
  stretch: StretchHorizontal,
  custom: Activity,
};

export function ActivityIcon({ type, className = 'size-5' }: { type: ActivityType; className?: string }) {
  const I = ACTIVITY_ICONS[type] ?? Activity;
  return <I className={className} aria-hidden />;
}
