import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ban, Check, ChevronLeft, Search, Share2, UserMinus, UserPlus, X } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Input, Notice, Page, Segmented, SectionTitle, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import { publicAppUrl } from '@/backend/supabase';
import type { FriendRequest, FriendStatus, ID, SocialProfile } from '@/domain/types';
import { friendlyError } from '@/social/pendingPosts';
import { AccessNotice, Avatar, Time, shareLink, usernameProblem, useSocialAccess } from './common';
import { useMyProfile } from './useMyProfile';
import { NoFriendsArt } from '@/components/illustrations';

type Tab = 'friends' | 'requests' | 'blocked';
type PersonLike = Pick<SocialProfile, 'id' | 'username' | 'displayName' | 'avatarUrl'>;

interface Lists {
  friends: SocialProfile[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  blocked: SocialProfile[];
}

function PersonRow({ person, sub, children }: { person: PersonLike; sub?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 min-h-16">
      <Link to={`/u/${person.username}`} className="flex items-center gap-3 min-w-0 flex-1 min-h-11">
        <Avatar profile={person} />
        <span className="min-w-0">
          <span className="block font-medium truncate">{person.displayName || `@${person.username}`}</span>
          <span className="block text-xs text-muted truncate">
            @{person.username}
            {sub}
          </span>
        </span>
      </Link>
      {children && <div className="flex items-center gap-1.5 shrink-0">{children}</div>}
    </li>
  );
}

export default function FriendsPage() {
  const nav = useNavigate();
  const { access, meId } = useSocialAccess();
  return (
    <Page
      title="Friends"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <AccessNotice access={access} what="Friends" guestTitle="Find your friends" /> : <FriendsContent meId={meId!} />}
    </Page>
  );
}

function FriendsContent({ meId }: { meId: string }) {
  const toast = useToast();
  const me = useMyProfile(meId);
  const [tab, setTab] = useState<Tab>('friends');
  const [lists, setLists] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<ID | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SocialProfile | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [friends, reqs, blocked] = await Promise.all([socialApi.listFriends(), socialApi.listFriendRequests(), socialApi.listBlocked()]);
      setLists({ friends, incoming: reqs.incoming, outgoing: reqs.outgoing, blocked });
    } catch (e) {
      setError(friendlyError(e, 'Couldn’t load your friends.'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    // Open on requests when someone is waiting for an answer.
    if (lists && lists.incoming.length > 0 && lists.friends.length === 0) setTab('requests');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists === null]);

  const act = async (id: ID, fn: () => Promise<void>, ok: string, fallback: string) => {
    setBusyId(id);
    try {
      await fn();
      toast.show(ok, { tone: 'success' });
      await load();
    } catch (e) {
      toast.show(friendlyError(e, fallback), { tone: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const nameOf = (p: PersonLike) => p.displayName || `@${p.username}`;

  return (
    <>
      {me.known && !me.profile && (
        <Notice tone="accent" className="mb-3">
          <p>Create a profile so friends can find you by username.</p>
          <Link to="/profile/edit" className="inline-flex min-h-11 items-center font-semibold text-accent">
            Create profile
          </Link>
        </Notice>
      )}

      <FindByUsername meId={meId} onChanged={load} />

      {me.profile && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          icon={<Share2 className="size-4" />}
          onClick={() => void shareLink(`${publicAppUrl.replace(/\/$/, '')}/u/${encodeURIComponent(me.profile!.username)}`, `${me.profile!.displayName} on Hard Earned`, toast)}
        >
          Share my profile link
        </Button>
      )}

      <div className="mt-5">
        <Segmented
          label="Friends sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'friends', label: `Friends${lists ? ` (${lists.friends.length})` : ''}` },
            { value: 'requests', label: `Requests${lists && lists.incoming.length ? ` (${lists.incoming.length})` : ''}` },
            { value: 'blocked', label: 'Blocked' },
          ]}
        />
      </div>

      {error ? (
        <ErrorState title="Couldn’t load your friends" message={error} onRetry={load} />
      ) : !lists ? (
        <Spinner label="Loading friends" />
      ) : tab === 'friends' ? (
        lists.friends.length === 0 ? (
          <EmptyState illustration={<NoFriendsArt />} title="No friends yet" body="Training is better together. Find people by their exact username, or share your profile link." />
        ) : (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-line">
              {lists.friends.map((f) => (
                <PersonRow key={f.id} person={f}>
                  <IconButton label={`Remove ${nameOf(f)} as a friend`} onClick={() => setConfirmRemove(f)} className="text-muted">
                    <UserMinus className="size-5" />
                  </IconButton>
                </PersonRow>
              ))}
            </ul>
          </Card>
        )
      ) : tab === 'requests' ? (
        <>
          <SectionTitle>Received</SectionTitle>
          {lists.incoming.length === 0 ? (
            <p className="text-sm text-muted px-1">No requests waiting for you.</p>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {lists.incoming.map((r) => (
                  <PersonRow key={r.id} person={r.other} sub={<> · <Time iso={r.createdAt} /></>}>
                    <Button size="sm" variant="primary" loading={busyId === r.id} icon={<Check className="size-4" />} onClick={() => act(r.id, () => socialApi.respondFriendRequest(r.id, true), `You and ${nameOf(r.other)} are now friends`, 'Couldn’t accept the request.')}>
                      Accept
                    </Button>
                    <IconButton label={`Decline request from ${nameOf(r.other)}`} disabled={busyId === r.id} onClick={() => act(r.id, () => socialApi.respondFriendRequest(r.id, false), 'Request declined', 'Couldn’t decline the request.')}>
                      <X className="size-5" />
                    </IconButton>
                  </PersonRow>
                ))}
              </ul>
            </Card>
          )}
          <SectionTitle>Sent</SectionTitle>
          {lists.outgoing.length === 0 ? (
            <p className="text-sm text-muted px-1">You haven’t sent any requests.</p>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {lists.outgoing.map((r) => (
                  <PersonRow key={r.id} person={r.other} sub={<> · sent <Time iso={r.createdAt} /></>}>
                    <Button size="sm" loading={busyId === r.id} onClick={() => act(r.id, () => socialApi.cancelFriendRequest(r.id), 'Request cancelled', 'Couldn’t cancel the request.')}>
                      Cancel
                    </Button>
                  </PersonRow>
                ))}
              </ul>
            </Card>
          )}
        </>
      ) : lists.blocked.length === 0 ? (
        <EmptyState icon={<Ban className="size-6" aria-hidden />} title="No one is blocked" body="People you block can’t see your profile or posts, or send you requests." />
      ) : (
        <Card className="mt-3 overflow-hidden">
          <ul className="divide-y divide-line">
            {lists.blocked.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-3 py-2 min-h-16">
                <Avatar profile={b} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium truncate">{nameOf(b)}</span>
                  <span className="block text-xs text-muted truncate">@{b.username}</span>
                </span>
                <Button size="sm" loading={busyId === b.id} onClick={() => act(b.id, () => socialApi.unblockUser(b.id), `${nameOf(b)} is unblocked`, 'Couldn’t unblock.')}>
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title={confirmRemove ? `Remove ${nameOf(confirmRemove)} as a friend?` : 'Remove friend?'}
        body="You’ll stop seeing each other’s friends-only posts. They won’t be notified."
        confirmLabel="Remove friend"
        danger
        busy={!!confirmRemove && busyId === confirmRemove.id}
        onConfirm={async () => {
          const f = confirmRemove!;
          await act(f.id, () => socialApi.removeFriend(f.id), `${nameOf(f)} removed from friends`, 'Couldn’t remove this friend.');
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}

/* ================================================================ search */
function FindByUsername({ meId, onChanged }: { meId: string; onChanged: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ profile: SocialProfile; relation: FriendStatus; requestId?: ID } | 'none' | 'self' | null>(null);

  const normalized = q.trim().replace(/^@/, '').toLowerCase();
  const search = async () => {
    const problem = usernameProblem(normalized);
    if (problem) {
      setError(normalized ? 'Usernames are 3–20 lowercase letters, numbers or underscores.' : 'Enter a username.');
      setResult(null);
      return;
    }
    setError(null);
    setSearching(true);
    try {
      const r = await socialApi.getProfileByUsername(normalized);
      setResult(!r || r.relation === 'blocked_by' ? 'none' : r.profile.id === meId ? 'self' : r);
    } catch (e) {
      setError(friendlyError(e, 'Search didn’t work. Try again.'));
    } finally {
      setSearching(false);
    }
  };

  const refresh = async () => {
    const r = await socialApi.getProfileByUsername(normalized).catch(() => null);
    if (r && r.relation !== 'blocked_by') setResult(r);
  };

  const act = async (fn: () => Promise<void>, ok: string, fallback: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show(ok, { tone: 'success' });
      await refresh();
      onChanged();
    } catch (e) {
      toast.show(friendlyError(e, fallback), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <form
        role="search"
        className="flex gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="flex-1">
        <Input
          label="Find by username"
          placeholder="exact_username"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setResult(null);
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          error={error}
        />
        </div>
        <IconButton label="Search" type="submit" disabled={searching} className="bg-surface-2 border border-line shrink-0">
          <Search className="size-5" />
        </IconButton>
      </form>
      {searching && <Spinner label="Searching" />}
      {result === 'none' && (
        <p className="text-sm text-muted mt-3" role="status">
          No one found with the username @{normalized}. Usernames are exact: check the spelling.
        </p>
      )}
      {result === 'self' && (
        <p className="text-sm text-muted mt-3" role="status">
          That’s you!
        </p>
      )}
      {result && typeof result === 'object' && (
        <ul className="mt-2 -mx-3">
          <PersonRow person={result.profile}>
            {result.relation === 'none' && (
              <Button size="sm" variant="primary" loading={busy} icon={<UserPlus className="size-4" />} onClick={() => act(() => socialApi.sendFriendRequest(result.profile.id), 'Friend request sent', 'Couldn’t send the request.')}>
                Add
              </Button>
            )}
            {result.relation === 'outgoing' && <Badge>Requested</Badge>}
            {result.relation === 'incoming' && result.requestId && (
              <Button size="sm" variant="primary" loading={busy} icon={<Check className="size-4" />} onClick={() => act(() => socialApi.respondFriendRequest(result.requestId!, true), 'You’re now friends', 'Couldn’t accept the request.')}>
                Accept
              </Button>
            )}
            {result.relation === 'friends' && <Badge tone="accent">Friends</Badge>}
            {result.relation === 'blocked' && <Badge tone="danger">Blocked</Badge>}
          </PersonRow>
        </ul>
      )}
    </Card>
  );
}
