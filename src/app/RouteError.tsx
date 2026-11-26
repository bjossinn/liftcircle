import { useRouteError } from 'react-router';
import { ErrorState, Page } from '@/components/ui';
import { BRAND } from '@/config/brand';
import { t } from '@/i18n';

/** Messages browsers use when a lazily loaded screen (JS chunk) can't be fetched. */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch|Load failed|ChunkLoadError/i;

/**
 * Uses the plain `t()` (the persisted device language) rather than a hook: this can render outside the providers.
 */
export function RouteError() {
  const err = useRouteError() as Error | undefined;
  const chunk = CHUNK_ERROR.test(err?.message ?? '');
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  // Every screen is saved for offline use when the app is installed, so a missing screen means either the
  // offline copy hasn't finished downloading (offline) or a newer version replaced this one (online).
  return (
    <Page title={BRAND.name}>
      <ErrorState
        title={!chunk ? t('common.screenError') : offline ? t('common.screenOffline') : t('common.appUpdated')}
        message={
          !chunk
            ? t('common.reloadSafe')
            : offline
              ? t('common.offlineDownloadIncomplete')
              : t('common.reloadUpdated')
        }
        onRetry={() => location.reload()}
      />
    </Page>
  );
}
