/**
 * The Hard Earned mark for in-app brand spots (welcome, install, About). It's the approved 1024 px master from
 * brand/hard-earned/assets, scaled down, never redrawn. The kit asks for clear space around the mark of at least one
 * inner plate's width, so it sits in its own padded box, apart from text. No lettering goes inside the icon.
 * The motto belongs only to brand moments, never under every card.
 */
import clsx from 'clsx';
import iconUrl from '@/assets/brand/hard-earned-icon-1024.png';
import { BRAND } from '@/config/brand';

export function BrandMark({ size = 56, className }: { size?: number; className?: string }) {
  return (
    <span className={clsx('inline-flex shrink-0 p-1.5', className)}>
      <img src={iconUrl} width={size} height={size} alt="" decoding="async" className="rounded-lg block" style={{ width: size, height: size }} />
    </span>
  );
}

/** Mark, wordmark and the primary line. `title` adds a heading (e.g. "Welcome to Hard Earned"). */
export function BrandMoment({ title, size = 56 }: { title?: string; size?: number }) {
  return (
    <div className="flex items-center gap-3">
      <BrandMark size={size} />
      <div className="min-w-0">
        <div className="wordmark text-[22px] leading-6 text-ink">{BRAND.wordmark}</div>
        <div className="text-sm text-muted">{BRAND.tagline}</div>
        {title && <div className="font-semibold text-ink mt-1">{title}</div>}
      </div>
    </div>
  );
}
