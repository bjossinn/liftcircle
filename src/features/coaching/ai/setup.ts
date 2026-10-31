/** Setup-step helpers (pure). */
import { EQUIPMENT_LABELS } from '@/data/exerciseMeta';
import type { Allergen, DietTag, Equipment, Experience, Goal, LimitationArea } from '@/domain/types';
import { AI_NOTES_MAX } from './model';

export interface SetupDetails {
  goal?: Goal;
  experience?: Experience;
  limitations: LimitationArea[];
  dietTags: DietTag[];
  allergens: Allergen[];
  days?: number;
  sessionMinutes?: number;
  equipment?: Equipment[];
}

const SETUP_PREFIX = 'Training setup:';

/** One readable line for the training assistant notes describing corrected training setup. */
export function trainingSetupLine(d: Pick<SetupDetails, 'days' | 'sessionMinutes' | 'equipment'>): string {
  const parts: string[] = [];
  if (d.days != null) parts.push(`${d.days} training day${d.days === 1 ? '' : 's'} a week`);
  if (d.sessionMinutes != null) parts.push(`${d.sessionMinutes}-minute sessions`);
  if (d.equipment) parts.push(`equipment: ${d.equipment.length ? d.equipment.map((e) => EQUIPMENT_LABELS[e]).join(', ') : 'bodyweight only'}`);
  return `${SETUP_PREFIX} ${parts.join('; ')}.`;
}

/** Replace (or add) the training-setup line at the top of the notes. */
export function upsertSetupLine(notes: string, line: string | null): string {
  const rest = notes
    .split('\n')
    .filter((l) => !l.startsWith(SETUP_PREFIX))
    .join('\n')
    .trim();
  return (line ? (rest ? `${line}\n${rest}` : line) : rest).slice(0, AI_NOTES_MAX);
}
