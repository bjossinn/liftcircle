import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Apple, Dumbbell, HeartHandshake, Home, LineChart, Play, Users, WifiOff } from 'lucide-react';
import { useCoachingUnread } from '@/features/coaching/useCoachingUnread';
import clsx from 'clsx';
import { useApp } from '@/state/app';
import { formatDuration } from '@/lib/dates';
import { lazy, Suspense, useEffect, useState } from 'react';
import { UpdateBanner } from '@/pwa/UpdateBanner';
import { HealthBanner, StorageHealthRunner, useHealth } from '@/pwa/HealthBanner';
import { SyncRunner, SyncStatusBanner } from '@/sync/SyncStatus';
import { PendingPostsRunner } from '@/social/pendingPosts';
import { GuestImportPrompt } from '@/features/auth/GuestImportPrompt';
import { usePushScheduler } from '@/pwa/pushScheduler';
import { shouldShowThemePicker, themePickedOnDevice } from '@/theme/theme';

// The demo module bundles the program generator and the exercise catalogue to seed sample data;
// load it only when the demo is actually open so it stays out of the startup bundle.
const DemoBanner = lazy(() => import('@/features/settings/demo').then((m) => ({ default: m.DemoBanner })));
// First launch only, so it stays out of the startup bundle too.
const ThemePicker = lazy(() => import('@/theme/ThemePicker').then((m) => ({ default: m.ThemePicker })));

const TABS = [
  { to: '/', label: 'Today', icon: Home, end: true },
  { to: '/train', label: 'Train', icon: Dumbbell },
  { to: '/feed', label: 'Feed', icon: Users },
  { to: '/nutrition', label: 'Nutrition', icon: Apple },
  { to: '/progress', label: 'Progress', icon: LineChart },
  { to: '/coaching', label: 'Coaching', icon: HeartHandshake },
];

/** Routes that render full-screen without the tab bar. */
const FULLSCREEN = [/^\/train\/session\//, /^\/onboarding/, /^\/auth/, /^\/coaching\/messages\//, /^\/coaching\/ai$/];

export function Shell() {
  const { pathname } = useLocation();
  const { online, db, account, accountReady } = useApp();
  const health = useHealth();
  const fullscreen = FULLSCREEN.some((r) => r.test(pathname));
  const [pickedNow, setPickedNow] = useState(false);
  const showPicker =
    !pickedNow &&
    shouldShowThemePicker({ pickedOnDevice: themePickedOnDevice(), accountReady, accountTheme: account.settings.theme, isDemo: db.isDemo, path: pathname });
  if (showPicker) {
    return (
      <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
        <ThemePicker onDone={() => setPickedNow(true)} />
      </Suspense>
    );
  }
  return (
    <div className="min-h-dvh flex flex-col pl-safe pr-safe">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:p-2 focus:bg-surface">
        Skip to content
      </a>
      <div className="pt-safe" />
      {!online && (
        <div role="status" className="flex items-center justify-center gap-2 bg-surface-2 text-muted text-xs py-1.5">
          <WifiOff className="size-3.5" aria-hidden />
          {health.storage === 'unavailable' || health.storage === 'quota' ? 'Offline' : 'Offline: workouts still save on this device'}
        </div>
      )}
      <SyncRunner />
      <StorageHealthRunner />
      <PendingPostsRunner />
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
      <main id="main" tabIndex={-1} className={clsx('flex-1 focus:outline-none', !fullscreen && 'pb-[calc(140px+env(safe-area-inset-bottom))]')}>
        <Outlet />
      </main>
      {!fullscreen && <ResumeBar />}
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
  return (
    <nav aria-label="Main" className="fixed bottom-0 inset-x-0 z-40 bg-surface/95 backdrop-blur border-t border-line pb-safe">
      <ul className="mx-auto max-w-2xl grid grid-cols-6">
        {TABS.map((t) => (
          <li key={t.to}>
            <NavLink
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                clsx('flex flex-col items-center justify-center gap-0.5 min-h-14 text-[11px] font-medium', isActive ? 'text-accent' : 'text-muted hover:text-ink')
              }
            >
              {({ isActive }) => (
                <>
                  <span className={clsx('relative flex items-center justify-center h-7 w-12 rounded-full transition-colors', isActive && 'bg-accent-soft')}>
                    {/* Remounts when the tab becomes active, so the indicator fades in (styles.css → .tab-bounce). */}
                    <t.icon key={isActive ? 'on' : 'off'} className={clsx('size-[22px]', isActive && 'tab-bounce')} aria-hidden />
                    {t.to === '/coaching' && coachingUnread > 0 && <span className="absolute top-0 right-2 size-2 rounded-full bg-ember" aria-hidden />}
                  </span>
                  {t.label}
                  {t.to === '/coaching' && coachingUnread > 0 && <span className="sr-only">, {coachingUnread} unread</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Persistent "Resume workout" action while a session is active. */
function ResumeBar() {
  const { db } = useApp();
  const nav = useNavigate();
  const active = useLiveQuery(() => db.sessions.where('status').equals('active').filter((s) => !s.deletedAt).first(), [db]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
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
        <span className="font-semibold flex-1 text-left truncate">Resume workout · {active.name}</span>
        <span className="tabular text-sm font-medium">{active.pausedAt ? 'Paused' : formatDuration(elapsed)}</span>
      </button>
    </div>
  );
}
