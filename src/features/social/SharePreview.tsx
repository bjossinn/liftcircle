import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, CloudUpload, Send } from 'lucide-react';
import { Button, Card, Notice, ProgressBar, Segmented, SectionTitle, Textarea, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { ActivityLog, Audience, ID, PostKind, ShareFields, WorkoutSession, WorkoutSnapshot } from '@/domain/types';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { uuid } from '@/lib/id';
import { buildActivitySnapshot, buildWorkoutSnapshot } from '@/social/snapshot';
import { cancelPendingPost, friendlyError, processPendingPosts, queuePost, retryPendingPost, usePendingProgress } from '@/social/pendingPosts';
import { AccessNotice, SnapshotView, useSocialAccess } from './common';
import { AUDIENCE_OPTIONS, CAPTION_MAX } from './PostCard';
import { PhotoPicker, usePhotoPicker } from './PhotoPicker';

type Phase = 'edit' | 'publishing' | 'failed' | 'posted' | 'queued';

export function SharePreview(props: { session?: WorkoutSession; activity?: ActivityLog; records?: { exercise: string; label: string }[]; onDone?: (postId: ID | null) => void }) {
  const { session, activity, records, onDone } = props;
  const { db, auth, account, online } = useApp();
  const settings = account.settings;
  const { access } = useSocialAccess();
  const toast = useToast();
  const { byId } = useExercises();

  const [postId, setPostId] = useState<ID>(() => uuid());
  const [fields, setFields] = useState<ShareFields>(() => ({ ...settings.social.autoShare.fields }));
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<Audience>(settings.social.defaultAudience);
  const [touchedAudience, setTouchedAudience] = useState(false);
  const [phase, setPhase] = useState<Phase>('edit');
  const [failure, setFailure] = useState<string | null>(null);
  const picker = usePhotoPicker();
  const cancelled = useRef(false);
  const progress = usePendingProgress(postId);
  const row = useLiveQuery(() => db.pendingPosts.get(postId), [db, postId]);

  // Settings may arrive after first render: follow the default audience until the user picks one.
  useEffect(() => {
    if (!touchedAudience) setAudience(settings.social.defaultAudience);
  }, [settings.social.defaultAudience, touchedAudience]);

  const kind: PostKind = session ? 'workout' : activity ? 'activity' : 'text';
  const hasRecords = !!records?.length;
  const snapshot: WorkoutSnapshot | null = useMemo(() => {
    if (session) return buildWorkoutSnapshot(session, fields, { byId, unit: settings.units.weight, records });
    if (activity) return buildActivitySnapshot(activity, fields, { distanceUnit: settings.units.distance, records });
    return null;
  }, [session, activity, fields, byId, settings.units.weight, settings.units.distance, records]);

  if (access === 'personal' || access === 'guest' || access === 'loading') {
    return <AccessNotice access={access} guestTitle="Share with friends" />;
  }

  const setField = (k: keyof ShareFields) => (v: boolean) => setFields((f) => ({ ...f, [k]: v, ...(k === 'exerciseNames' && !v ? { weightsReps: false } : {}) }));
  const busy = phase !== 'edit' && phase !== 'failed';
  const canUploadNow = auth.status === 'signed_in' && auth.userId === db.accountKey && online;
  const empty = kind === 'text' && !caption.trim() && picker.photos.length === 0;
  const blockedReason = picker.processing
    ? 'Preparing photos…'
    : picker.hasErrors
      ? 'Remove the photos that couldn’t be added.'
      : empty
        ? 'Write something or add a photo.'
        : null;

  const finishCheck = async () => {
    const r = await db.pendingPosts.get(postId);
    if (cancelled.current) return;
    if (!r) {
      toast.show(audience === 'friends' ? 'Posted to your friends' : 'Posted — only you can see it', { tone: 'success' });
      setPhase('posted');
      onDone?.(postId);
    } else if (r.status === 'error') {
      setFailure(r.error ?? 'The upload didn’t finish.');
      setPhase('failed');
    } else {
      toast.show('Saved. Waiting to upload — it will post automatically.', { tone: 'info' });
      setPhase('queued');
      onDone?.(null);
    }
  };

  const publish = async () => {
    if (busy || blockedReason) return;
    cancelled.current = false;
    setPhase('publishing');
    setFailure(null);
    try {
      await queuePost(
        {
          id: postId,
          kind,
          audience,
          caption: caption.trim(),
          snapshot,
          sourceRecordId: session?.id ?? activity?.id,
          photos: picker.ready.map((p) => ({
            id: p.id,
            blob: p.processed.blob,
            thumb: p.processed.thumb,
            width: p.processed.width,
            height: p.processed.height,
            description: p.description.trim() || undefined,
          })),
        },
        db,
      );
    } catch (e) {
      setPhase('edit');
      toast.show(friendlyError(e, 'Couldn’t save your post on this device.'), { tone: 'error' });
      return;
    }
    if (!canUploadNow) {
      toast.show(
        online ? 'Saved. Waiting to upload — it will post after you sign in again.' : 'Saved. Waiting to upload — it will post when you’re back online.',
        { tone: 'info' },
      );
      setPhase('queued');
      onDone?.(null);
      return;
    }
    await processPendingPosts(db, { accountId: auth.userId });
    await finishCheck();
  };

  const retry = async () => {
    cancelled.current = false;
    setPhase('publishing');
    setFailure(null);
    await retryPendingPost(postId, db);
    await finishCheck();
  };

  const cancelUpload = async () => {
    cancelled.current = true;
    await cancelPendingPost(postId, db);
    setPostId(uuid()); // a fresh id for any new attempt
    setPhase('edit');
    toast.show('Upload cancelled. Nothing was posted.');
  };

  const toggles =
    kind === 'workout' ? (
      <>
        <Toggle label="Duration" checked={fields.duration} onChange={setField('duration')} disabled={busy} />
        <Toggle label="Exercise names" checked={fields.exerciseNames} onChange={setField('exerciseNames')} disabled={busy} />
        <Toggle
          label="Weights and reps"
          description={fields.exerciseNames ? undefined : 'Needs exercise names'}
          checked={fields.weightsReps && fields.exerciseNames}
          onChange={setField('weightsReps')}
          disabled={busy || !fields.exerciseNames}
        />
        <Toggle label="Volume" description="Total free-weight load lifted" checked={fields.volume} onChange={setField('volume')} disabled={busy} />
        {hasRecords && <Toggle label="Records" checked={fields.records} onChange={setField('records')} disabled={busy} />}
      </>
    ) : kind === 'activity' ? (
      <>
        <Toggle label="Duration" checked={fields.duration} onChange={setField('duration')} disabled={busy} />
        <Toggle label="Distance" description="Pace is shown when duration is shared too" checked={fields.volume} onChange={setField('volume')} disabled={busy} />
        {hasRecords && <Toggle label="Records" checked={fields.records} onChange={setField('records')} disabled={busy} />}
      </>
    ) : null;

  return (
    <div className="flex flex-col">
      {access === 'offline' && <Notice className="mb-3">You’re offline. Your post will wait on this device and upload when you’re back online.</Notice>}
      {access === 'expired' && <Notice className="mb-3">Your session has expired. Your post will wait on this device and upload after you sign in again.</Notice>}

      {snapshot && (
        <>
          <SectionTitle>What to include</SectionTitle>
          <Card className="px-4 py-1">{toggles}</Card>
          <p className="text-xs text-muted mt-2 px-1">Only what you choose is copied into the post. The rest of your workout history isn’t posted.</p>
        </>
      )}

      <SectionTitle>Caption</SectionTitle>
      <Textarea
        aria-label="Caption"
        value={caption}
        maxLength={CAPTION_MAX}
        onChange={(e) => setCaption(e.target.value)}
        placeholder={kind === 'text' ? 'What’s on your mind?' : 'How did it go?'}
        disabled={busy}
        hint={caption.length > CAPTION_MAX - 200 ? `${caption.length}/${CAPTION_MAX}` : undefined}
      />

      <SectionTitle>Photos</SectionTitle>
      <PhotoPicker picker={picker} disabled={busy} />

      <SectionTitle>Who can see this</SectionTitle>
      <Segmented
        label="Audience"
        value={audience}
        onChange={(v) => {
          setTouchedAudience(true);
          setAudience(v);
        }}
        options={AUDIENCE_OPTIONS}
      />
      <p className="text-xs text-muted mt-2 px-1">{audience === 'friends' ? 'Your friends can see it, like it and comment.' : 'Only you can see it. You can change this later.'}</p>

      {snapshot && (
        <>
          <SectionTitle>Preview</SectionTitle>
          <SnapshotView snapshot={snapshot} />
        </>
      )}

      <div className="mt-6 flex flex-col gap-3" aria-live="polite">
        {phase === 'publishing' && (
          <Card className="p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CloudUpload className="size-4 text-accent animate-pulse" aria-hidden />
              {row?.status === 'uploading' ? 'Uploading…' : 'Waiting to upload'}
            </div>
            <div className="mt-2">
              <ProgressBar value={Math.round((progress ?? 0) * 100)} max={100} label="Upload progress" />
            </div>
            <p className="text-xs text-muted mt-2">Not posted yet. It appears once the upload finishes.</p>
            <Button className="mt-3" variant="ghost" size="sm" onClick={cancelUpload}>
              Cancel upload
            </Button>
          </Card>
        )}

        {phase === 'failed' && (
          <Notice tone="danger">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4 text-danger" aria-hidden /> Upload failed — not posted
            </p>
            {failure && <p className="mt-1 text-muted">{failure}</p>}
            <p className="mt-1 text-muted">Your workout is saved. The post is kept on this device so you can try again.</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="primary" size="sm" onClick={retry}>
                Retry
              </Button>
              <Button size="sm" onClick={() => onDone?.(null)}>
                Keep for later
              </Button>
              <Button variant="ghost" size="sm" onClick={cancelUpload}>
                Discard post
              </Button>
            </div>
          </Notice>
        )}

        {phase === 'edit' && (
          <>
            {blockedReason && picker.photos.length > 0 && <p className="text-xs text-muted text-center">{blockedReason}</p>}
            <Button variant="primary" size="lg" block onClick={publish} disabled={!!blockedReason} icon={<Send className="size-5" />}>
              {canUploadNow ? 'Share' : 'Save and upload later'}
            </Button>
            {onDone && (
              <Button variant="ghost" block onClick={() => onDone(null)}>
                Not now
              </Button>
            )}
          </>
        )}
        {phase === 'posted' && <Notice tone="accent">Posted. You can see it in your feed.</Notice>}
        {phase === 'queued' && <Notice>Saved on this device — waiting to upload. It isn’t visible to anyone yet.</Notice>}
      </div>
    </div>
  );
}
