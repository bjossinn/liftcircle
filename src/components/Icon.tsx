/**
 * Direction B icon system: Lucide outlines on a strict 16 / 20 / 24 px grid, stroke 1.75, `currentColor`.
 * Colour always comes from the caller's token classes (`text-ink`, `text-muted`, `text-accent`, `text-danger`), never a hex.
 *
 *  - `Icon`: one Lucide mark at `sm` (16) / `md` (20) / `lg` (24).
 *  - `IconTile`: the duotone well (`rounded-xl bg-surface-2 text-accent`), 44 px (`md`) or 36 px (`sm`), with a 24 / 20 px mark.
 */
import clsx from 'clsx';
import type { ComponentType, ReactNode, SVGProps } from 'react';

export type IconSize = 'sm' | 'md' | 'lg';
export const ICON_PX: Record<IconSize, number> = { sm: 16, md: 20, lg: 24 };
export const ICON_CLASS: Record<IconSize, string> = { sm: 'size-4', md: 'size-5', lg: 'size-6' };
export const ICON_STROKE = 1.75;

type LucideLike = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string; absoluteStrokeWidth?: boolean }>;

export function Icon({ icon: Mark, size = 'md', className, label }: { icon: LucideLike; size?: IconSize; className?: string; label?: string }) {
  return (
    <Mark
      strokeWidth={ICON_STROKE}
      className={clsx(ICON_CLASS[size], 'shrink-0', className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    />
  );
}

/** Duotone well around a mark (Direction B). Children are the mark; pass `icon` for a Lucide component. */
export function IconTile({
  icon,
  children,
  size = 'md',
  className,
  badge,
  label,
}: {
  icon?: LucideLike;
  children?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  /** Optional corner badge (e.g. the A/B/C variant letter of a program session). */
  badge?: ReactNode;
  /** Accessible name; without it the tile is decorative. */
  label?: string;
}) {
  return (
    <span
      className={clsx(
        'relative inline-flex shrink-0 items-center justify-center rounded-xl bg-surface-2 text-accent',
        size === 'md' ? 'size-11' : 'size-9',
        className,
      )}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {icon ? <Icon icon={icon} size={size === 'md' ? 'lg' : 'md'} /> : children}
      {badge}
    </span>
  );
}
