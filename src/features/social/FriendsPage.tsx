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
import { useT } from '@/i18n';

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
  const { t } = useT();
  const { access, meId } = useSocialAccess();
  return (
    <Page
      title={t('profile.friends')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <AccessNotice access={access} what="friends" guestTitle={t('social.access.find_your_friends')} /> : <FriendsContent meId={meId!} />}
    </Page>
  );
}

function FriendsContent({ meId }: { meId: string }) {
  const toast = useToast();
  const { t } = useT();
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
      setError(friendlyError(e, t('social.couldnt_load_your_friends')));
    }
  }, [t]);
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
          <p>{t('social.create_a_profile_so_friends_can_2')}</p>
          <Link to="/profile/edit" className="inline-flex min-h-11 items-center font-semibold text-accent">
            {t('profile.create')}
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
          onClick={() => void shareLink(`${publicAppUrl.replace(/\/$/, '')}/u/${encodeURIComponent(me.profile!.username)}`, t('social.share_title', { name: me.profile!.displayName }), toast)}
        >
          {t('social.share_my_profile_link')}
        </Button>
      )}

      <div className="mt-5">
        <Segmented
          label={t('social.friends_sections')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'friends', label: lists ? t('social.friendsx', { count: lists.friends.length }) : t('profile.friends') },
            { value: 'requests', label: lists && lists.incoming.length ? t('social.requestsx', { count: lists.incoming.length }) : t('social.requests') },
            { value: 'blocked', label: t('social.blocked') },
          ]}
        />
      </div>

      {error ? (
        <ErrorState title={t('social.couldnt_load_your_friends')} message={error} onRetry={load} />
      ) : !lists ? (
        <Spinner label={t('social.loading_friends')} />
      ) : tab === 'friends' ? (
        lists.friends.length === 0 ? (
          <EmptyState illustration={<NoFriendsArt />} title={t('social.no_friends_yet')} body={t('social.training_is_better_together_find_people')} />
        ) : (
          <Card className="mt-3 overflow-hidden">
            <ul className="divide-y divide-line">
              {lists.friends.map((f) => (
                <PersonRow key={f.id} person={f}>
                  <IconButton label={t('social.remove_x_as_a_friend', { name: nameOf(f) })} onClick={() => setConfirmRemove(f)} className="text-muted">
                    <UserMinus className="size-5" />
                  </IconButton>
                </PersonRow>
              ))}
            </ul>
          </Card>
        )
      ) : tab === 'requests' ? (
        <>
          <SectionTitle>{t('social.received')}</SectionTitle>
          {lists.incoming.length === 0 ? (
            <p className="text-sm text-muted px-1">{t('social.no_requests_waiting_for_you')}</p>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {lists.incoming.map((r) => (
                  <PersonRow key={r.id} person={r.other} sub={<> · <Time iso={r.createdAt} /></>}>
                    <Button size="sm" variant="primary" loading={busyId === r.id} icon={<Check className="size-4" />} onClick={() => act(r.id, () => socialApi.respondFriendRequest(r.id, true), t('social.now_friends_with', { name: nameOf(r.other) }), t('social.error.accept'))}>
                      {t('social.accept')}
                    </Button>
                    <IconButton
                      label={t('social.decline_request_from_x', { name: nameOf(r.other) })}
                      disabled={busyId === r.id}
                      onClick={() => act(r.id, () => socialApi.respondFriendRequest(r.id, false), t('social.request_declined'), t('social.error.decline'))}
                    >
                      <X className="size-5" />
                    </IconButton>
                  </PersonRow>
                ))}
              </ul>
            </Card>
          )}
          <SectionTitle>{t('social.sent')}</SectionTitle>
          {lists.outgoing.length === 0 ? (
            <p className="text-sm text-muted px-1">{t('social.you_havent_sent_any_requests')}</p>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {lists.outgoing.map((r) => (
                  <PersonRow key={r.id} person={r.other} sub={<> · {t('social.sent_lower')} <Time iso={r.createdAt} /></>}>
                    <Button size="sm" loading={busyId === r.id} onClick={() => act(r.id, () => socialApi.cancelFriendRequest(r.id), t('social.request_cancelled'), t('social.error.cancel_request'))}>
                      {t('common.cancel')}
                    </Button>
                  </PersonRow>
                ))}
              </ul>
            </Card>
          )}
        </>
      ) : lists.blocked.length === 0 ? (
        <EmptyState icon={<Ban className="size-6" aria-hidden />} title={t('social.no_one_is_blocked')} body={t('social.people_you_block_cant_see_your')} />
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
                <Button size="sm" loading={busyId === b.id} onClick={() => act(b.id, () => socialApi.unblockUser(b.id), t('social.x_unblocked', { name: nameOf(b) }), t('social.error.unblock'))}>
                  {t('social.unblock')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title={confirmRemove ? t('social.remove_x_as_a_friend_2', { name: nameOf(confirmRemove) }) : t('social.remove_friend_2')}
        body={t('social.youll_stop_seeing_each_others_friends')}
        confirmLabel={t('social.remove_friend')}
        danger
        busy={!!confirmRemove && busyId === confirmRemove.id}
        onConfirm={async () => {
          const f = confirmRemove!;
          await act(f.id, () => socialApi.removeFriend(f.id), t('social.x_removed_from_friends', { name: nameOf(f) }), t('social.error.remove_friend'));
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
  const { t } = useT();
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ profile: SocialProfile; relation: FriendStatus; requestId?: ID } | 'none' | 'self' | null>(null);

  const normalized = q.trim().replace(/^@/, '').toLowerCase();
  const search = async () => {
    const problem = usernameProblem(normalized);
    if (problem) {
      setError(normalized ? t('social.username.format') : t('social.username.enter'));
      setResult(null);
      return;
    }
    setError(null);
    setSearching(true);
    try {
      const r = await socialApi.getProfileByUsername(normalized);
      setResult(!r || r.relation === 'blocked_by' ? 'none' : r.profile.id === meId ? 'self' : r);
    } catch (e) {
      setError(friendlyError(e, t('social.error.search')));
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
          label={t('social.find_by_username')}
          placeholder={t('social.exact_username')}
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
        <IconButton label={t('social.search')} type="submit" disabled={searching} className="bg-surface-2 border border-line shrink-0">
          <Search className="size-5" />
        </IconButton>
      </form>
      {searching && <Spinner label={t('coaching.directory.searching')} />}
      {result === 'none' && (
        <p className="text-sm text-muted mt-3" role="status">
          {t('social.no_one_found_with_the_username', { username: normalized })}
        </p>
      )}
      {result === 'self' && (
        <p className="text-sm text-muted mt-3" role="status">
          {t('social.thats_you')}
        </p>
      )}
      {result && typeof result === 'object' && (
        <ul className="mt-2 -mx-3">
          <PersonRow person={result.profile}>
            {result.relation === 'none' && (
              <Button size="sm" variant="primary" loading={busy} icon={<UserPlus className="size-4" />} onClick={() => act(() => socialApi.sendFriendRequest(result.profile.id), t('social.friend_request_sent'), t('social.error.send_request'))}>
                {t('foodLog.add')}
              </Button>
            )}
            {result.relation === 'outgoing' && <Badge>{t('social.requested')}</Badge>}
            {result.relation === 'incoming' && result.requestId && (
              <Button size="sm" variant="primary" loading={busy} icon={<Check className="size-4" />} onClick={() => act(() => socialApi.respondFriendRequest(result.requestId!, true), t('social.now_friends'), t('social.error.accept'))}>
                {t('social.accept')}
              </Button>
            )}
            {result.relation === 'friends' && <Badge tone="accent">{t('profile.friends')}</Badge>}
            {result.relation === 'blocked' && <Badge tone="danger">{t('social.blocked')}</Badge>}
          </PersonRow>
        </ul>
      )}
    </Card>
  );
}
