import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, Check, ChevronLeft, Flag, MoreHorizontal, Pencil, Share2, ShieldCheck, UserCheck, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, IconButton, Page, SectionTitle, Sheet, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import { publicAppUrl } from '@/backend/supabase';
import type { FriendStatus, ID, SocialProfile } from '@/domain/types';
import { friendlyError } from '@/social/pendingPosts';
import { AccessNotice, Avatar, ReportSheet, shareLink, useSocialAccess } from './common';
import { PostCard } from './PostCard';
import { PAGE_SIZE, usePostList } from './usePostList';
import { useMyProfile } from './useMyProfile';

export default function ProfilePage() {
  const { username } = useParams();
  const nav = useNavigate();
  const { access, meId } = useSocialAccess();
  return (
    <Page
      title={username ? `@${username}` : 'Profile'}
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <AccessNotice access={access} what="Profiles" guestTitle={username ? `Connect with @${username}` : undefined} />
      ) : username ? (
        <OtherProfile username={username.toLowerCase()} meId={meId!} />
      ) : (
        <MyProfile meId={meId!} />
      )}
    </Page>
  );
}

/* ================================================================ header */
function ProfileHeader({ profile, children }: { profile: SocialProfile; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-center text-center pt-2" aria-label="Profile">
      <Avatar profile={profile} size={88} />
      <h2 className="text-xl font-bold mt-3 break-words max-w-full">{profile.displayName}</h2>
      <p className="text-sm text-muted">@{profile.username}</p>
      {profile.bio && <p className="text-[15px] mt-3 whitespace-pre-wrap break-words max-w-md">{profile.bio}</p>}
      {profile.interests.length > 0 && (
        <ul className="flex flex-wrap justify-center gap-1.5 mt-3" aria-label="Training interests">
          {profile.interests.map((i) => (
            <li key={i}>
              <Badge tone="accent">{i}</Badge>
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

function UserPosts({ userId, meId, empty, onBlocked }: { userId: ID; meId: string; empty: string; onBlocked?: () => void }) {
  const list = usePostList(`user:${meId}:${userId}`, (c) => socialApi.getUserPosts(userId, c, PAGE_SIZE));
  return (
    <section aria-labelledby="posts-title">
      <SectionTitle id="posts-title">Posts</SectionTitle>
      {list.status === 'loading' ? (
        <Spinner label="Loading posts" />
      ) : list.status === 'error' ? (
        <ErrorState title="Couldn’t load posts" message={list.error ?? undefined} onRetry={() => void list.refresh('initial')} />
      ) : list.items.length === 0 ? (
        <EmptyState title="No posts to show" body={empty} />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {list.items.map((p) => (
              <li key={p.id}>
                <PostCard post={p} meId={meId} onChange={list.update} onRemove={list.remove} onBlocked={onBlocked ?? list.removeAuthor} />
              </li>
            ))}
          </ul>
          {list.hasMore && (
            <div className="flex flex-col items-center py-4">
              {list.moreError && (
                <p role="alert" className="text-sm text-danger mb-2">
                  {list.moreError}
                </p>
              )}
              <Button onClick={() => void list.loadMore()} loading={list.loadingMore}>
                {list.moreError ? 'Try again' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const profileUrl = (username: string) => `${publicAppUrl.replace(/\/$/, '')}/u/${encodeURIComponent(username)}`;

/* ================================================================ me */
function MyProfile({ meId }: { meId: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const { profile, loading, error, reload } = useMyProfile(meId);
  const [moderator, setModerator] = useState(false);
  useEffect(() => {
    let off = false;
    socialApi
      .amModerator()
      .then((v) => !off && setModerator(v))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);

  if (loading) return <Spinner label="Loading your profile" />;
  if (error && !profile) return <ErrorState title="Couldn’t load your profile" message={error} onRetry={reload} />;
  if (!profile)
    return (
      <EmptyState
        icon={<Users className="size-6" aria-hidden />}
        title="Create your profile"
        body="Pick a username so friends can find you. Your age, weight, measurements and health data are never part of your profile."
        action={
          <Button variant="primary" onClick={() => nav('/profile/edit')}>
            Create profile
          </Button>
        }
      />
    );
  return (
    <>
      <ProfileHeader profile={profile}>
        <div className="flex flex-wrap justify-center gap-2 mt-4">
          <Button icon={<Pencil className="size-4" />} onClick={() => nav('/profile/edit')}>
            Edit profile
          </Button>
          <Button icon={<Share2 className="size-4" />} onClick={() => void shareLink(profileUrl(profile.username), `${profile.displayName} on Hard Earned`, toast)}>
            Share profile link
          </Button>
          <Button icon={<Users className="size-4" />} onClick={() => nav('/friends')}>
            Friends
          </Button>
        </div>
        {!profile.discoverable && <p className="text-xs text-muted mt-3">Your profile is hidden from username search. Friends can still see it.</p>}
        {moderator && (
          <Link to="/moderation" className="inline-flex items-center gap-1.5 min-h-11 mt-2 text-sm text-accent font-medium">
            <ShieldCheck className="size-4" aria-hidden /> Moderation queue
          </Link>
        )}
      </ProfileHeader>
      <UserPosts userId={profile.id} meId={meId} empty="Posts you share will appear here." />
    </>
  );
}

/* ================================================================ others */
type Loaded = { profile: SocialProfile; relation: FriendStatus; requestId?: ID };

function OtherProfile({ username, meId }: { username: string; meId: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<Loaded | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'menu' | 'report' | 'block' | 'remove'>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await socialApi.getProfileByUsername(username);
      if (r && r.profile.id === meId) {
        nav('/profile', { replace: true });
        return;
      }
      setData(r && r.relation !== 'blocked_by' ? r : null);
    } catch (e) {
      setError(friendlyError(e, 'Couldn’t load this profile.'));
    }
  }, [username, meId, nav]);

  useEffect(() => {
    setData(undefined);
    void load();
  }, [load]);

  const act = async (fn: () => Promise<void>, ok: string, fallback: string) => {
    setBusy(true);
    try {
      await fn();
      setDialog(null);
      toast.show(ok, { tone: 'success' });
      await load();
    } catch (e) {
      toast.show(friendlyError(e, fallback), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState title="Couldn’t load this profile" message={error} onRetry={load} />;
  if (data === undefined) return <Spinner label="Loading profile" />;
  if (data === null)
    return <EmptyState title="Profile not found" body={`There’s no one we can show you with the username @${username}. Check the spelling: usernames are exact.`} action={<Button onClick={() => nav('/friends')}>Find friends</Button>} />;

  const { profile, relation, requestId } = data;
  const name = profile.displayName || `@${profile.username}`;

  const actions = (() => {
    switch (relation) {
      case 'none':
        return (
          <Button variant="primary" loading={busy} icon={<UserPlus className="size-4" />} onClick={() => act(() => socialApi.sendFriendRequest(profile.id), 'Friend request sent', 'Couldn’t send the request.')}>
            Add friend
          </Button>
        );
      case 'outgoing':
        return (
          <>
            <Badge className="min-h-9 px-3">Requested</Badge>
            <Button
              loading={busy}
              icon={<X className="size-4" />}
              disabled={!requestId}
              onClick={() => requestId && act(() => socialApi.cancelFriendRequest(requestId), 'Request cancelled', 'Couldn’t cancel the request.')}
            >
              Cancel request
            </Button>
          </>
        );
      case 'incoming':
        return (
          <>
            <Button
              variant="primary"
              loading={busy}
              icon={<Check className="size-4" />}
              disabled={!requestId}
              onClick={() => requestId && act(() => socialApi.respondFriendRequest(requestId, true), `You and ${name} are now friends`, 'Couldn’t accept the request.')}
            >
              Accept
            </Button>
            <Button
              loading={busy}
              icon={<X className="size-4" />}
              disabled={!requestId}
              onClick={() => requestId && act(() => socialApi.respondFriendRequest(requestId, false), 'Request declined', 'Couldn’t decline the request.')}
            >
              Decline
            </Button>
          </>
        );
      case 'friends':
        return (
          <>
            <Badge tone="accent" className="min-h-9 px-3">
              <UserCheck className="size-4" aria-hidden /> Friends
            </Badge>
            <Button icon={<UserMinus className="size-4" />} onClick={() => setDialog('remove')}>
              Remove friend
            </Button>
          </>
        );
      case 'blocked':
        return (
          <>
            <Badge tone="danger" className="min-h-9 px-3">
              <Ban className="size-4" aria-hidden /> Blocked
            </Badge>
            <Button loading={busy} onClick={() => act(() => socialApi.unblockUser(profile.id), `${name} is unblocked`, 'Couldn’t unblock.')}>
              Unblock
            </Button>
          </>
        );
      default:
        return null;
    }
  })();

  return (
    <>
      <ProfileHeader profile={profile}>
        <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
          {actions}
          <IconButton label="More options" onClick={() => setDialog('menu')}>
            <MoreHorizontal className="size-5" />
          </IconButton>
        </div>
      </ProfileHeader>

      {relation === 'blocked' ? (
        <EmptyState title="You blocked this person" body="Unblock them to see their profile and posts again." />
      ) : (
        <UserPosts
          key={relation}
          userId={profile.id}
          meId={meId}
          empty={relation === 'friends' ? `${name} hasn’t shared anything with you yet.` : `Posts are shared with friends. Add ${name} as a friend to see theirs.`}
          onBlocked={() => void load()}
        />
      )}

      <Sheet open={dialog === 'menu'} onClose={() => setDialog(null)} title={name}>
        <ul className="flex flex-col">
          <li>
            <button type="button" className="flex items-center gap-3 w-full min-h-12 px-2 rounded-xl hover:bg-surface-2" onClick={() => void shareLink(profileUrl(profile.username), `${name} on Hard Earned`, toast).then(() => setDialog(null))}>
              <Share2 className="size-5" aria-hidden /> Share profile link
            </button>
          </li>
          <li>
            <button type="button" className="flex items-center gap-3 w-full min-h-12 px-2 rounded-xl hover:bg-surface-2" onClick={() => setDialog('report')}>
              <Flag className="size-5" aria-hidden /> Report profile
            </button>
          </li>
          {relation !== 'blocked' && (
            <li>
              <button type="button" className="flex items-center gap-3 w-full min-h-12 px-2 rounded-xl hover:bg-surface-2 text-danger" onClick={() => setDialog('block')}>
                <Ban className="size-5" aria-hidden /> Block {name}
              </button>
            </li>
          )}
        </ul>
      </Sheet>
      <ReportSheet open={dialog === 'report'} onClose={() => setDialog(null)} target={{ userId: profile.id }} what="profile" />
      <ConfirmDialog
        open={dialog === 'block'}
        title={`Block ${name}?`}
        body="You won’t see each other’s posts or profiles, and they can’t send you friend requests. If you’re friends, the friendship ends."
        confirmLabel="Block"
        danger
        busy={busy}
        onConfirm={() => act(() => socialApi.blockUser(profile.id), `${name} is blocked`, 'Couldn’t block.')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'remove'}
        title={`Remove ${name} as a friend?`}
        body="You’ll stop seeing each other’s friends-only posts. They won’t be notified."
        confirmLabel="Remove friend"
        danger
        busy={busy}
        onConfirm={() => act(() => socialApi.removeFriend(profile.id), `${name} removed from friends`, 'Couldn’t remove this friend.')}
        onCancel={() => setDialog(null)}
      />
    </>
  );
}
