import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ShieldOff } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import { EmptyState, ErrorState, Spinner, cx } from '@/components/ui';
import { useT } from '@/i18n';
import { useLoad } from '../directory/common';

/** Renders children only for server-confirmed admins; otherwise a 403 state. */
export function AdminGate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const roles = useLoad(() => coachingApi.myRoles(), [], { fallback: t('coaching.admin.couldnt_check_your_permissions_retry') });
  if (roles.loading && !roles.data) return <Spinner label={t('coaching.checking_permissions')} />;
  if (roles.error) return <ErrorState title={t('coaching.couldnt_check_your_permissions')} message={roles.error} onRetry={roles.reload} />;
  if (!roles.data?.admin)
    return <EmptyState icon={<ShieldOff className="size-6" aria-hidden />} title={t('coaching.admins_only')} body={t('coaching.you_dont_have_permission_to_review')} />;
  return <>{children}</>;
}

/** Horizontally scrollable tab list with roving focus (arrow keys). */
export function ScrollTabs<T extends string>({ tabs, value, onChange, label, panelId }: { tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string; panelId: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + tabs.length) % tabs.length;
    refs.current[n]?.focus();
    onChange(tabs[n]!.value);
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none]">
      {tabs.map((t, i) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(t.value)}
            className={cx('shrink-0 min-h-10 px-3.5 rounded-full border text-sm whitespace-nowrap transition-colors', on ? 'bg-accent-soft border-accent text-accent font-medium' : 'border-line text-ink hover:bg-surface-2')}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
