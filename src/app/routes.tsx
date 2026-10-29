/* Route table. Pages are lazy-loaded; every chunk is precached by the service worker for offline use. */
import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Shell } from './Shell';
import { Spinner, Page, EmptyState, Button } from '@/components/ui';
import { RouteError } from './RouteError';

const L = (f: () => Promise<{ default: ComponentType }>) => {
  const C = lazy(f);
  return (
    <Suspense fallback={<Spinner />}>
      <C />
    </Suspense>
  );
};

function NotFound() {
  return (
    <Page title="Not found">
      <EmptyState title="This page doesn’t exist" action={<Button onClick={() => history.back()}>Go back</Button>} />
    </Page>
  );
}

export const router = createBrowserRouter([
  {
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: L(() => import('@/features/today/TodayPage')) },
      { path: '/train', element: L(() => import('@/features/train/TrainPage')) },
      { path: '/train/session/:id', element: L(() => import('@/features/train/SessionPage')) },
      { path: '/train/summary/:id', element: L(() => import('@/features/train/SummaryPage')) },
      { path: '/train/history', element: L(() => import('@/features/train/HistoryPage')) },
      { path: '/train/history/:id', element: L(() => import('@/features/train/SessionDetailPage')) },
      { path: '/train/templates', element: L(() => import('@/features/train/TemplatesPage')) },
      { path: '/train/program', element: L(() => import('@/features/program/ProgramPage')) },
      { path: '/train/exercises', element: L(() => import('@/features/exercises/ExerciseLibraryPage')) },
      { path: '/train/exercises/:id', element: L(() => import('@/features/exercises/ExerciseDetailPage')) },
      { path: '/train/activity/new', element: L(() => import('@/features/activities/ActivityFormPage')) },
      { path: '/train/activity/:id', element: L(() => import('@/features/activities/ActivityFormPage')) },
      { path: '/train/intervals', element: L(() => import('@/features/activities/IntervalTimerPage')) },
      { path: '/onboarding', element: L(() => import('@/features/onboarding/OnboardingPage')) },
      { path: '/progress', element: L(() => import('@/features/progress/ProgressPage')) },
      { path: '/nutrition', element: L(() => import('@/features/nutrition/NutritionPage')) },
      { path: '/nutrition/recipes', element: L(() => import('@/features/nutrition/RecipesPage')) },
      { path: '/nutrition/recipes/:id', element: L(() => import('@/features/nutrition/RecipeDetailPage')) },
      { path: '/nutrition/plan', element: L(() => import('@/features/nutrition/MealPlanPage')) },
      { path: '/nutrition/shopping', element: L(() => import('@/features/nutrition/ShoppingListPage')) },
      { path: '/nutrition/log', element: L(() => import('@/features/nutrition/FoodLogPage')) },
      { path: '/nutrition/targets', element: L(() => import('@/features/nutrition/TargetsPage')) },
      { path: '/feed', element: L(() => import('@/features/social/FeedPage')) },
      { path: '/feed/new', element: L(() => import('@/features/social/ComposePage')) },
      { path: '/feed/post/:id', element: L(() => import('@/features/social/PostPage')) },
      { path: '/profile', element: L(() => import('@/features/social/ProfilePage')) },
      { path: '/profile/edit', element: L(() => import('@/features/social/ProfileEditPage')) },
      { path: '/u/:username', element: L(() => import('@/features/social/ProfilePage')) },
      { path: '/friends', element: L(() => import('@/features/social/FriendsPage')) },
      { path: '/notifications', element: L(() => import('@/features/social/NotificationsPage')) },
      { path: '/moderation', element: L(() => import('@/features/social/ModerationPage')) },
      { path: '/settings', element: L(() => import('@/features/settings/SettingsPage')) },
      { path: '/settings/data', element: L(() => import('@/features/settings/DataPage')) },
      { path: '/install', element: L(() => import('@/features/settings/InstallPage')) },
      { path: '/auth', element: L(() => import('@/features/auth/AuthPage')) },
      { path: '/auth/callback', element: L(() => import('@/features/auth/AuthCallbackPage')) },
      { path: '/import-guest', element: L(() => import('@/features/auth/ImportGuestPage')) },
      { path: '/coaching', element: L(() => import('@/features/coaching/CoachingHubPage')) },
      { path: '/coaching/find', element: L(() => import('@/features/coaching/FindCoachPage')) },
      { path: '/coaching/coach/:id', element: L(() => import('@/features/coaching/CoachProfilePage')) },
      { path: '/coaching/request/:coachId', element: L(() => import('@/features/coaching/RequestCoachingPage')) },
      { path: '/coaching/apply', element: L(() => import('@/features/coaching/ApplyPage')) },
      { path: '/coaching/admin', element: L(() => import('@/features/coaching/AdminQueuePage')) },
      { path: '/coaching/admin/reports', element: L(() => import('@/features/coaching/AdminReportsPage')) },
      { path: '/coaching/admin/:coachId', element: L(() => import('@/features/coaching/AdminApplicationPage')) },
      { path: '/coaching/my', element: L(() => import('@/features/coaching/MyCoachPage')) },
      { path: '/coaching/messages/:relationshipId', element: L(() => import('@/features/coaching/MessagesPage')) },
      { path: '/coaching/proposal/:id', element: L(() => import('@/features/coaching/ProposalPage')) },
      { path: '/coaching/checkin/:relationshipId', element: L(() => import('@/features/coaching/CheckInPage')) },
      { path: '/coaching/dashboard', element: L(() => import('@/features/coaching/CoachDashboardPage')) },
      { path: '/coaching/client/:relationshipId', element: L(() => import('@/features/coaching/ClientDetailPage')) },
      { path: '/coaching/client/:relationshipId/program', element: L(() => import('@/features/coaching/ClientProgramPage')) },
      { path: '/coaching/ai', element: L(() => import('@/features/coaching/AiChatPage')) },
      { path: '/coaching/ai/setup', element: L(() => import('@/features/coaching/AiSetupPage')) },
      { path: '/coaching/ai/settings', element: L(() => import('@/features/coaching/AiSettingsPage')) },
      { path: '/coaching/ai/proposals', element: L(() => import('@/features/coaching/AiProposalsPage')) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
