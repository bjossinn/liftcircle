import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { ScrollReset } from './ScrollReset';
import { useLiveQuery } from 'dexie-react-hooks';
import { Dumbbell, Home, LineChart, MessageCircle, Play, Users, WifiOff } from 'lucide-react';
import { useCoachingUnread } from '@/features/coaching/useCoachingUnread';
import clsx from 'clsx';
import { useApp } from '@/state/app';
import { formatDuration } from '@/lib/dates';
import { lazy, Suspense, useEffect, useState } from 'react';
import { UpdateBanner } from '@/pwa/UpdateBanner';
import { HealthBanner, StorageHealthRunner, useHealth } from '@/pwa/HealthBanner';
import { SyncRunner, SyncStatusBanner } from '@/sync/SyncStatus';
import { PendingPostsRunner } from '@/social/pendingPosts';
import { AnalyticsRunner } from '@/analytics/analytics';
import { GuestImportPrompt } from '@/features/auth/GuestImportPrompt';
import { usePushScheduler } from '@/pwa/pushScheduler';
import { isFeatureEnabled, type FeatureFlag } from '@/config/featureFlags';
import { t as translate, useT, type MessageKey } from '@/i18n';

// The demo module bundles the program generator and the exercise catalogue to seed sample data;
// load it only when the demo is actually open so it stays out of the startup bundle.
const DemoBanner = lazy(() => import('@/features/settings/demo').then((m) => ({ default: m.DemoBanner })));

export interface MainTab {
  to: string;
  /** Display label in the current language. */
  label: string;
  labelKey: MessageKey;
  icon: typeof Home;
  end?: boolean;
  /** Only shown when this feature flag is on. */
  flag?: FeatureFlag;
  /** Other paths that belong to this tab (it stays highlighted there). */
  also?: RegExp;
}

/**
 * Four tabs: Today, Train, Coach, Progress (plus Feed when the socialFeed flag is on). Nutrition, Friends and Settings
 * are reached from Today (nutrition card / quick action) and Profile (header). The Coach tab opens the training
 * assistant; human coaching (/coaching…) belongs to the same tab.
 */
const ALL_TABS: Omit<MainTab, 'label'>[] = [
  { to: '/', labelKey: 'nav.today', icon: Home, end: true },
  { to: '/train', labelKey: 'nav.train', icon: Dumbbell },
  { to: '/coach', labelKey: 'nav.coach', icon: MessageCircle, also: /^\/coaching(\/|$)/ },
  { to: '/progress', labelKey: 'nav.progress', icon: LineChart },
  { to: '/feed', labelKey: 'nav.feed', icon: Users, flag: 'socialFeed' },
];

/** Main tabs, minus any whose feature flag is off (src/config/featureFlags.ts). */
export function mainTabs(): MainTab[] {
  return ALL_TABS.filter((t) => !t.flag || isFeatureEnabled(t.flag)).map((t) => ({ ...t, label: translate(t.labelKey) }));
}

/** Whether `tab` is the current tab for `pathname`. */
export function isTabActive(tab: Pick<MainTab, 'to' | 'end' | 'also'>, pathname: string): boolean {
  const own = tab.end ? pathname === tab.to : pathname === tab.to || pathname.startsWith(`${tab.to}/`);
  return own || !!tab.also?.test(pathname);
}

/** Routes that render full-screen without the tab bar. */
const FULLSCREEN = [/^\/train\/session\//, /^\/onboarding/, /^\/auth/, /^\/coaching\/messages\//, /^\/coaching\/ai$/];
/** The Coach tab's chat: its composer sits right above the tab bar, so no resume bar or extra bottom padding there. */
const CHAT_TAB = /^\/coach\/?$/;

export function Shell() {
  const { pathname } = useLocation();
  const { online, db } = useApp();
  const health = useHealth();
  const { t } = useT();
  const fullscreen = FULLSCREEN.some((r) => r.test(pathname));
  const chatTab = CHAT_TAB.test(pathname);
  // No first-launch theme picker: new users start on Match my phone and can change it in Settings → Appearance.
  return (
    <div className="min-h-dvh flex flex-col pl-safe pr-safe">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:p-2 focus:bg-surface">
        {t('nav.skipContent')}
      </a>
      <div className="pt-safe" />
      {!online && (
        <div role="status" className="flex items-center justify-center gap-2 bg-surface-2 text-muted text-xs py-1.5">
          <WifiOff className="size-4" aria-hidden />
          {health.storage === 'unavailable' || health.storage === 'quota' ? t('nav.offline') : t('nav.offlineSaved')}
        </div>
      )}
      <ScrollReset />
      <SyncRunner />
      <StorageHealthRunner />
      <PendingPostsRunner />
      <AnalyticsRunner />
      <PushRunner />
      {db.isDemo && (
        <Suspense fallback={null}>
          <DemoBanner />
        </Suspense>
      )}
      <HealthBanner />
      <UpdateBanner />
      <SyncStatusBanner />
      <GuestImportPrompt />
      <main
        id="main"
        tabIndex={-1}
        className={clsx('flex-1 focus:outline-none', !fullscreen && (chatTab ? 'pb-[calc(57px+env(safe-area-inset-bottom))]' : 'pb-[calc(140px+env(safe-area-inset-bottom))]'))}
      >
        <Outlet />
      </main>
      {!fullscreen && !chatTab && <ResumeBar />}
      {!fullscreen && <TabBar />}
    </div>
  );
}

/** Keeps this device's push subscription and scheduled reminders current (no-op unless push is on here). */
function PushRunner() {
  usePushScheduler();
  return null;
}

function TabBar() {
  const coachingUnread = useCoachingUnread();
  const { pathname } = useLocation();
  const { t: tr, tp } = useT();
  const tabs = mainTabs();
  return (
    <nav aria-label={tr('nav.main')} className="fixed bottom-0 inset-x-0 z-40 bg-surface/95 backdrop-blur border-t border-line pb-safe">
      <ul className={clsx('mx-auto max-w-2xl grid', tabs.length === 5 ? 'grid-cols-5' : 'grid-cols-4')}>
        {tabs.map((t) => {
          const isActive = isTabActive(t, pathname);
          return (
            <li key={t.to}>
              <Link
                to={t.to}
                aria-current={isActive ? 'page' : undefined}
                className={clsx('flex flex-col items-center justify-center gap-0.5 min-h-14 text-[11px] font-medium', isActive ? 'text-accent' : 'text-muted hover:text-ink')}
              >
                <span className={clsx('relative flex items-center justify-center h-7 w-12 rounded-full transition-colors', isActive && 'bg-accent-soft')}>
                  {/* Remounts when the tab becomes active, so the indicator fades in (styles.css → .tab-bounce). */}
                  <t.icon key={isActive ? 'on' : 'off'} className={clsx('size-6', isActive && 'tab-bounce')} aria-hidden />
                  {t.to === '/coach' && coachingUnread > 0 && <span className="absolute top-0 right-2 size-2 rounded-full bg-ember" aria-hidden />}
                </span>
                {tr(t.labelKey)}
                {t.to === '/coach' && coachingUnread > 0 && <span className="sr-only">{tp('nav.unread', coachingUnread)}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Persistent "Resume workout" action while a session is active. */
function ResumeBar() {
  const { db } = useApp();
  const nav = useNavigate();
  const { t } = useT();
  const active = useLiveQuery(() => db.sessions.where('status').equals('active').filter((s) => !s.deletedAt).first(), [db]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const elapsed = ((active.pausedAt ?? now) - active.startedAt - active.pausedTotalMs) / 1000;
  return (
    <div className="fixed inset-x-0 bottom-[calc(57px+env(safe-area-inset-bottom))] z-40 px-3 pb-2">
      <button
        onClick={() => nav(`/train/session/${active.id}`)}
        className="mx-auto max-w-2xl w-full flex items-center gap-3 rounded-xl ember-fill px-4 min-h-14 shadow-lg"
      >
        <Play className="size-5" aria-hidden />
        <span className="font-semibold flex-1 text-left truncate">{t('nav.resume', { name: active.name })}</span>
        <span className="tabular text-sm font-medium">{active.pausedAt ? t('nav.paused') : formatDuration(elapsed)}</span>
      </button>
    </div>
  );
}
