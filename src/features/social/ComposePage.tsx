import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { Button, EmptyState, IconButton, Page, Spinner } from '@/components/ui';
import { useDb } from '@/state/app';
import { SharePreview } from './SharePreview';

/** /feed/new — standalone text/photo post, or share a finished workout (?session=) / activity (?activity=). */
export default function ComposePage() {
  const nav = useNavigate();
  const db = useDb();
  const [params] = useSearchParams();
  const sessionId = params.get('session');
  const activityId = params.get('activity');

  const source = useLiveQuery(async () => {
    if (sessionId) {
      const s = await db.sessions.get(sessionId);
      return { kind: 'session' as const, session: s && !s.deletedAt ? s : null };
    }
    if (activityId) {
      const a = await db.activities.get(activityId);
      return { kind: 'activity' as const, activity: a && !a.deletedAt ? a : null };
    }
    return { kind: 'text' as const };
  }, [db, sessionId, activityId]);

  const title = sessionId ? 'Share workout' : activityId ? 'Share activity' : 'New post';
  const done = () => nav('/feed', { replace: true });

  let body;
  if (!source) body = <Spinner />;
  else if (source.kind === 'session' && !source.session)
    body = <EmptyState title="Workout not found" body="It may have been deleted or isn’t on this device." action={<Button onClick={() => nav(-1)}>Go back</Button>} />;
  else if (source.kind === 'session' && source.session!.status !== 'completed')
    body = <EmptyState title="Finish the workout first" body="You can share a workout once it’s completed." action={<Button onClick={() => nav(`/train/session/${source.session!.id}`)}>Back to workout</Button>} />;
  else if (source.kind === 'activity' && !source.activity)
    body = <EmptyState title="Activity not found" body="It may have been deleted or isn’t on this device." action={<Button onClick={() => nav(-1)}>Go back</Button>} />;
  else
    body = (
      <SharePreview
        key={sessionId ?? activityId ?? 'text'}
        session={source.kind === 'session' ? source.session! : undefined}
        activity={source.kind === 'activity' ? source.activity! : undefined}
        onDone={done}
      />
    );

  return (
    <Page
      title={title}
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {body}
    </Page>
  );
}
