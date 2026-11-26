/**
 * Route-level feature gates (src/config/featureFlags.ts). When a flag is off the screen behind it isn't loaded;
 * a short explanation with a way back is shown instead, so old links, bookmarks and notifications never dead-end.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Bot, HeartHandshake, Home, UserRound, Users } from 'lucide-react';
import { EmptyState, Page } from '@/components/ui';
import { isFeatureEnabled, type FeatureFlag } from '@/config/featureFlags';
import { TopActions } from './TopActions';

export function FeatureGate({ flag, off, children }: { flag: FeatureFlag; off: ReactNode; children?: ReactNode }) {
  return <>{isFeatureEnabled(flag) ? children : off}</>;
}

const linkBtn = 'inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl text-[15px] transition-colors';
const primaryLink = `${linkBtn} ember-fill font-semibold`;
const secondaryLink = `${linkBtn} bg-surface-2 text-ink hover:bg-surface-3 border border-line`;

/** /feed while the social feed is off. Sharing, post pages, profile and friends keep working. */
export function FeedOff() {
  return (
    <Page title="Feed" actions={<TopActions />}>
      <EmptyState
        icon={<Users className="size-6" aria-hidden />}
        title="The feed isn’t available right now"
        body="You can still share a workout. Posts you share stay on your profile, and links to a post still open it. Nothing has been deleted."
        action={
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <Link to="/profile" className={primaryLink}>
              <UserRound className="size-4" aria-hidden />
              Your profile
            </Link>
            <Link to="/" className={secondaryLink}>
              <Home className="size-4" aria-hidden />
              Back to Today
            </Link>
          </div>
        }
      />
    </Page>
  );
}

/** /coaching/find, coach profiles and new requests while the coach marketplace is off. */
export function CoachMarketplaceOff() {
  return (
    <Page title="Find a coach">
      <EmptyState
        icon={<HeartHandshake className="size-6" aria-hidden />}
        title="Finding a coach isn’t open yet"
        body="The training assistant can help with your plan in the meantime. If you already work with a coach, everything with them keeps working under Coaching."
        action={
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <Link to="/coaching" className={primaryLink}>
              <Bot className="size-4" aria-hidden />
              Go to Coaching
            </Link>
          </div>
        }
      />
    </Page>
  );
}
