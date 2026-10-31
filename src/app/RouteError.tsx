import { useRouteError } from 'react-router';
import { ErrorState, Page } from '@/components/ui';

/** Messages browsers use when a lazily loaded screen (JS chunk) can't be fetched. */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch|Load failed|ChunkLoadError/i;

export function RouteError() {
  const err = useRouteError() as Error | undefined;
  const chunk = CHUNK_ERROR.test(err?.message ?? '');
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  // Every screen is saved for offline use when the app is installed, so a missing screen means either the
  // offline copy hasn't finished downloading (offline) or a newer version replaced this one (online).
  return (
    <Page title="Hard Earned">
      <ErrorState
        title={!chunk ? 'Something went wrong' : offline ? 'This screen isn’t available offline yet' : 'Hard Earned was updated'}
        message={
          !chunk
            ? 'Your saved workouts are safe on this device. Try reloading.'
            : offline
              ? 'The offline copy of the app hasn’t finished downloading. Reconnect and reload once. Your workouts are safe.'
              : 'Reload to open the latest version. Your workouts are safe.'
        }
        onRetry={() => location.reload()}
      />
    </Page>
  );
}
