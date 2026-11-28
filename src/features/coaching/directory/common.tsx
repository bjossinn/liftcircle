/**
 * Shared pieces for the coaching directory, application and admin screens:
 * access states, error text, a small async loader, coach photos and badges.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { BadgeCheck, Bot, GraduationCap, Lock, Search, ServerOff, WifiOff } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Notice, Spinner, cx } from '@/components/ui';
import { useApp } from '@/state/app';
import { friendlyError } from '@/social/pendingPosts';
import { initials } from '@/domain/coaching/display';
import { authHref } from '@/features/auth/authReturn';
import { isFeatureEnabled } from '@/config/featureFlags';
import { t as tr, useT } from '@/i18n';

/* ================================================================ access */
export type CoachingAccess = 'personal' | 'loading' | 'guest' | 'expired' | 'offline' | 'ok';

export function useCoachingAccess(): { access: CoachingAccess; meId: string | undefined } {
  const { backendConfigured, auth, online } = useApp();
  let access: CoachingAccess = 'ok';
  if (!backendConfigured) access = 'personal';
  else if (auth.status === 'loading') access = 'loading';
  else if (auth.status === 'guest') access = 'guest';
  else if (auth.status === 'expired') access = 'expired';
  else if (!online) access = 'offline';
  return { access, meId: auth.status === 'signed_in' ? auth.userId : undefined };
}

export function CoachingAccessNotice({ access }: { access: Exclude<CoachingAccess, 'ok'> }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { t } = useT();
  switch (access) {
    case 'loading':
      return <Spinner />;
    case 'personal':
      return (
        <EmptyState
          icon={<ServerOff className="size-6" aria-hidden />}
          title={t('coaching.directory.coaching_needs_the_online_version')}
          body={t('coaching.directory.coaching_connects_you_with_real_coaches')}
        />
      );
    case 'guest':
      return (
        <EmptyState
          icon={<GraduationCap className="size-6" aria-hidden />}
          title={isFeatureEnabled('coachMarketplace') ? t('coaching.directory.train_with_a_coach') : t('aiConsent.title')}
          body={
            isFeatureEnabled('coachMarketplace')
              ? t('coaching.directory.find_an_approved_coach_near_you')
              : t('coaching.directory.sign_in_to_use_the_training')
          }
          action={
            <Button variant="primary" onClick={() => nav(authHref('signup', pathname))}>
              {t('ai.guest.signIn')}
            </Button>
          }
        />
      );
    case 'expired':
      return (
        <EmptyState
          icon={<Lock className="size-6" aria-hidden />}
          title={t('settings.signInAgain')}
          body={t('coaching.directory.your_session_has_expired_sign_in')}
          action={
            <Button variant="primary" onClick={() => nav(authHref('signin', pathname))}>
              {t('settings.signIn')}
            </Button>
          }
        />
      );
    case 'offline':
      return <EmptyState icon={<WifiOff className="size-6" aria-hidden />} title={t('ai.unavailable.offline.title')} body={t('coaching.directory.coaching_needs_a_connection_your_workouts')} />;
  }
}

/** Sign-in link that returns to `path` afterwards. */
/** For guests: opens account creation (with a link to sign in) and returns to `path` afterwards. */
export const authLink = (path: string) => authHref('signup', path);

/** Two ways to be coached, explained before asking a guest to sign in. */
export function GuestCoachingIntro({ browse = true }: { browse?: boolean }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { t } = useT();
  // Marketplace off: AI-first, no human-coach pitch a guest couldn't act on.
  const marketplace = isFeatureEnabled('coachMarketplace');
  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-[15px] text-muted px-1">
        {marketplace ? t('coaching.directory.choose_how_youd_like_to_be') : t('coaching.directory.get_answers_and_plan_suggestions_from')}
      </p>
      {marketplace && (
        <Card as="section" aria-labelledby="guest-human" className="p-4 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="size-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
              <GraduationCap className="size-5" aria-hidden />
            </span>
            <h2 id="guest-human" className="font-semibold">
              {t('coaching.directory.a_human_coach')}
            </h2>
          </div>
          <p className="text-sm">{t('coaching.directory.a_real_coach_approved_by_our')}</p>
          <p className="text-sm text-muted">
            <span className="font-medium text-ink">{t('coaching.directory.what_they_see')}</span> {t('coaching.directory.only_your_request_and_intro_until')}
          </p>
          {browse && (
            <Link to="/coaching/find" className="mt-1 inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl bg-surface-2 text-ink hover:bg-surface-3 border border-line text-[15px]">
              <Search className="size-4" aria-hidden />
              {t('coaching.directory.browse_approved_coaches')}
            </Link>
          )}
        </Card>
      )}
      <Card as="section" aria-labelledby="guest-ai" className="p-4 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="size-10 rounded-xl bg-surface-3 text-info flex items-center justify-center shrink-0">
            <Bot className="size-5" aria-hidden />
          </span>
          <h2 id="guest-ai" className="font-semibold">
            {t('coaching.directory.the_training_assistant')}
          </h2>
        </div>
        <p className="text-sm">{t('coaching.directory.an_automated_assistant_that_answers_questions')}</p>
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">{t('coaching.directory.what_it_sees')}</span> {t('coaching.directory.only_the_categories_you_turn_on')}
        </p>
      </Card>
      <Notice>{marketplace ? t('coaching.directory.both_need_an_account') : t('coaching.directory.it_needs_an_account')}</Notice>
      <Button variant="primary" size="lg" block onClick={() => nav(authLink(pathname))}>
        {t('ai.guest.signIn')}
      </Button>
    </div>
  );
}

/** Human-readable error for coaching calls. */
export function coachingError(e: unknown, fallback: string = tr('sync.genericError')): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/not implemented/i.test(raw)) return tr('coaching.directory.coaching_unavailable_try_later');
  return friendlyError(e, fallback);
}

/* ================================================================ loader */
export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
  set: (v: T) => void;
}

/** Runs `fn` when `enabled` and the deps change; ignores stale responses. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean; fallback?: string } = {}): Loaded<T> {
  const enabled = opts.enabled ?? true;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const fallback = opts.fallback;
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (v) => {
        if (stale) return;
        setData(v);
        setLoading(false);
      },
      (e) => {
        if (stale) return;
        setError(coachingError(e, fallback));
        setLoading(false);
      },
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, set: setData };
}

/* ================================================================ visuals */
export function CoachPhoto({ name, url, size = 56, className }: { name: string; url?: string | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.36)) };
  if (url && !broken) {
    return <img src={url} alt="" width={size} height={size} style={style} onError={() => setBroken(true)} className={cx('rounded-2xl object-cover bg-surface-3 shrink-0', className)} />;
  }
  return (
    <span aria-hidden style={style} className={cx('rounded-2xl bg-accent-soft text-accent font-semibold inline-flex items-center justify-center shrink-0', className)}>
      {initials(name)}
    </span>
  );
}

/** Platform approval only — deliberately not "verified" or "certified". */
export function ApprovedBadge() {
  const { t } = useT();
  return (
    <Badge tone="accent">
      <BadgeCheck className="size-3.5" aria-hidden />
      {t('coaching.hub.listed_coach')}
    </Badge>
  );
}

export function TagList({ items, label }: { items: string[]; label: string }) {
  if (!items.length) return null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <li key={s} className="rounded-full bg-surface-2 border border-line px-2.5 py-0.5 text-xs text-ink">
          {s}
        </li>
      ))}
    </ul>
  );
}

export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-[15px] text-ink">{children}</dd>
    </div>
  );
}
