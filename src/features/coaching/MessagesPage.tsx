/**
 * /coaching/messages/:relationshipId — private 1:1 coach/client chat (fullscreen route, both roles).
 * Every message is written to the local outbox first and is only labelled "Sent" once the server
 * has returned it. Queued messages re-check the relationship before sending (see src/coaching/outbox.ts).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, Ban, Check, Clock, Copy, Flag, ImagePlus, Loader2, MoreVertical, RefreshCw, Send, Trash2, User, WifiOff, X } from 'lucide-react';
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, ListRow, Notice, Sheet, Spinner, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import { socialApi } from '@/backend/social';
import type { CoachMessage } from '@/backend/coachingContract';
import type { CoachOutboxItem } from '@/db/db';
import { processImage, mediaErrorMessage } from '@/social/media';
import { uuid } from '@/lib/id';
import { localDate } from '@/lib/dates';
import {
  MAX_PHOTOS, MESSAGE_MAX, discardCoachMessage, outboxStatusLabel, processCoachOutbox, retryCoachMessage, useCoachOutbox, useCoachOutboxRunner,
  useOutboxInFlight,
} from '@/coaching/outbox';
import { RETENTION_TEXT, relationshipWritable } from '@/coaching/relationship';
import { coachingError } from '@/coaching/errors';
import { Avatar } from '@/features/social/common';
import { BackButton, CoachingAccessNotice, ReportCoachingSheet, fmtDay, useCoachingAccess } from './tools/common';
import { useConversation } from './tools/useConversation';
import { useCoachDraft } from './tools/coachDraft';
import { useRelationship } from './tools/useRelationship';
import { notifyCoachingUnreadChanged } from './useCoachingUnread';

type Row = { kind: 'server'; m: CoachMessage } | { kind: 'outbox'; o: CoachOutboxItem };

export default function MessagesPage() {
  const { relationshipId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { db, auth, online, account } = useApp();
  const { access } = useCoachingAccess();
  const tz = account.settings.timeZone;
  const meId = auth.userId;
  const accountId = auth.status === 'signed_in' && auth.userId ? auth.userId : null;
  useCoachOutboxRunner();

  const canUseApi = access === 'ok';
  const { rel, error: relError, fromCache: relFromCache, reload: reloadRel } = useRelationship(relationshipId, db, canUseApi);
  const coachLocked = !!rel && rel.viewerIsCoach && rel.coach.suspended; // a suspended coach can't read
  const readable = !!rel && rel.status !== 'requested' && !coachLocked;
  const convo = useConversation(relationshipId, db, canUseApi && readable);
  const outbox = useCoachOutbox(relationshipId);
  const writable = relationshipWritable(rel);
  const other = rel ? (rel.viewerIsCoach ? { id: rel.clientId, name: rel.client.displayName || 'Your client', avatarUrl: rel.client.avatarUrl } : { id: rel.coachId, name: rel.coach.displayName || 'Your coach', avatarUrl: rel.coach.photoUrl }) : null;

  /* ------------------------------------------------ composer (draft saved on this device, per account + conversation) */
  const draft = useCoachDraft(relationshipId, db, search.get('draft'));
  const { body, photos, setBody } = draft;
  const [preparing, setPreparing] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Text handed over in the URL (?draft=) is merged into the saved draft once; drop it so a reload doesn't add it again.
  useEffect(() => {
    if (draft.ready && search.has('draft')) {
      const next = new URLSearchParams(search);
      next.delete('draft');
      setSearch(next, { replace: true });
    }
  }, [draft.ready, search, setSearch]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_PHOTOS - photos.length - preparing;
    const list = [...files].slice(0, Math.max(0, room));
    if (files.length > list.length) toast.show(`You can attach up to ${MAX_PHOTOS} photos.`, { tone: 'warn' });
    for (const f of list) {
      setPreparing((n) => n + 1);
      try {
        const out = await processImage(f);
        draft.addPhoto({ id: uuid(), ...out });
      } catch (e) {
        toast.show(mediaErrorMessage(e), { tone: 'error' });
      } finally {
        setPreparing((n) => n - 1);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  const removePhoto = draft.removePhoto;

  const send = async () => {
    const text = body.trim();
    if ((!text && photos.length === 0) || preparing > 0 || !draft.ready) return;
    if (!writable.ok) return setSendError(writable.reason); // the outbox re-checks with the server before sending, too
    setSendError(null);
    try {
      // Written locally FIRST (draft → outbox in one transaction); the outbox sends it with this same id
      // after re-checking that this relationship still allows messages.
      await draft.send(uuid());
      void processCoachOutbox(db, { accountId });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Couldn’t save your message on this device.');
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  /* ------------------------------------------------ list + read marker */
  const rows: Row[] = useMemo(() => {
    const server = convo.messages ?? [];
    const ids = new Set(server.map((m) => m.id));
    return [...server.map((m) => ({ kind: 'server' as const, m })), ...outbox.filter((o) => !ids.has(o.id)).map((o) => ({ kind: 'outbox' as const, o }))];
  }, [convo.messages, outbox]);

  const lastRead = useRef(0);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (!canUseApi || !readable || !visible || !convo.messages?.length || convo.fromCache) return;
    const maxSeq = Math.max(0, ...convo.messages.filter((m) => m.seq != null).map((m) => m.seq!));
    if (maxSeq <= lastRead.current) return;
    lastRead.current = maxSeq;
    coachingApi
      .markRead(relationshipId, maxSeq)
      .then(notifyCoachingUnreadChanged)
      .catch(() => {
        lastRead.current = 0; // try again on the next update
      });
  }, [canUseApi, readable, visible, convo.messages, convo.fromCache, relationshipId]);

  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const count = rows.length;
  const firstScroll = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !count) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (firstScroll.current || nearBottom) endRef.current?.scrollIntoView?.({ block: 'end' });
    firstScroll.current = false;
  }, [count]);

  /* ------------------------------------------------ menu: report / block */
  const [menuOpen, setMenuOpen] = useState(false);
  const [report, setReport] = useState<{ messageId?: string } | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const block = async () => {
    if (!rel || !other) return;
    setBlocking(true);
    try {
      await socialApi.blockUser(other.id);
      // The server treats a block as ending coaching; ending explicitly as well is harmless.
      await coachingApi.endCoaching(rel.id, 'Blocked').catch(() => {});
      setBlockOpen(false);
      toast.show(`${other.name} is blocked and coaching has ended.`, { tone: 'success' });
      await reloadRel();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t block right now. Try again.'), { tone: 'error' });
    } finally {
      setBlocking(false);
    }
  };

  /* ------------------------------------------------ render */
  const header = (
    <header className="flex items-center gap-2 px-2 pt-2 pb-2 min-h-14 border-b border-line bg-bg">
      <BackButton />
      {other && <Avatar profile={{ displayName: other.name, username: '', avatarUrl: other.avatarUrl }} size={36} />}
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold truncate">{other?.name ?? 'Messages'}</h1>
        {rel && <p className="text-xs text-muted truncate">{rel.viewerIsCoach ? 'Your client' : 'Your coach'} · private conversation</p>}
      </div>
      {rel && (
        <IconButton label="Conversation options" onClick={() => setMenuOpen(true)}>
          <MoreVertical className="size-5" />
        </IconButton>
      )}
    </header>
  );

  let content;
  if (access === 'personal' || access === 'guest' || access === 'loading') {
    content = <CoachingAccessNotice access={access} what="Messaging" />;
  } else if (rel === undefined && relError) {
    content = <ErrorState title="Couldn’t open this conversation" message={relError} onRetry={reloadRel} />;
  } else if (rel === undefined) {
    content = access === 'offline' || access === 'expired' ? <CoachingAccessNotice access={access} what="Messaging" /> : <Spinner label="Loading conversation" />;
  } else if (rel === null) {
    content = (
      <EmptyState title="This conversation isn’t available" body="It may belong to another account, or you no longer have access to it." action={<Button onClick={() => nav('/coaching')}>Go to coaching</Button>} />
    );
  } else if (coachLocked) {
    content = (
      <Notice tone="warn" className="m-4">
        Your coach account is currently suspended, so you can’t read or send coaching messages. Your clients keep their conversation history, workouts and plans.
      </Notice>
    );
  } else if (rel.status === 'requested') {
    content = (
      <div className="p-4 flex flex-col gap-3">
        <Notice>{writable.ok ? '' : writable.reason} Until then, the coach sees only your intake and intro message.</Notice>
        {rel.introMessage && <p className="rounded-2xl bg-surface-2 px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words">{rel.introMessage}</p>}
      </div>
    );
  } else {
    content = (
      <>
        {(access === 'offline' || access === 'expired') && (
          <Notice tone="warn" className="mx-4 mt-3">
            <span className="inline-flex items-center gap-1.5">
              <WifiOff className="size-4" aria-hidden />
              {access === 'offline' ? 'You’re offline. Showing saved messages; new messages are queued and sent when you’re back online.' : 'Your session has expired. Sign in again to send queued messages.'}
            </span>
          </Notice>
        )}
        {!rel.viewerIsCoach && rel.coach.suspended && (
          <Notice tone="warn" className="mx-4 mt-3">
            Your coach’s account is currently suspended. Your data and current plan stay yours; messaging is paused.
          </Notice>
        )}
        {convo.error && convo.messages?.length ? (
          <p role="status" className="mx-4 mt-2 text-xs text-muted">
            Couldn’t refresh messages: retrying automatically.
          </p>
        ) : null}
        {convo.messages === undefined ? (
          <Spinner label="Loading messages" />
        ) : convo.error && !convo.messages.length && !outbox.length ? (
          <ErrorState title="Couldn’t load messages" message={convo.error} onRetry={convo.refresh} />
        ) : rows.length === 0 ? (
          <EmptyState title="No messages yet" body={rel.viewerIsCoach ? `Say hello to ${other?.name}.` : `Say hello to ${other?.name}. Share how training is going or ask a question.`} />
        ) : (
          <ol className="flex flex-col gap-1 px-3 py-3" aria-label="Messages">
            {rows.map((r, i) => {
              const created = r.kind === 'server' ? r.m.createdAt : new Date(r.o.createdAt).toISOString();
              const prev = rows[i - 1];
              const prevCreated = prev ? (prev.kind === 'server' ? prev.m.createdAt : new Date(prev.o.createdAt).toISOString()) : null;
              const day = dayKey(created, tz);
              const showDay = !prevCreated || dayKey(prevCreated, tz) !== day;
              return (
                <li key={r.kind === 'server' ? r.m.id : `o:${r.o.id}`} className="flex flex-col">
                  {showDay && (
                    <div className="flex items-center gap-2 my-3 text-xs text-faint" role="separator" aria-label={fmtDay(created, tz)}>
                      <span className="h-px flex-1 bg-line" />
                      {dayLabel(created, tz)}
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  {r.kind === 'server' ? (
                    <ServerBubble
                      m={r.m}
                      mine={r.m.senderId === meId}
                      tz={tz}
                      selected={selected === r.m.id}
                      onSelect={() => setSelected(selected === r.m.id ? null : r.m.id)}
                      onReport={() => setReport({ messageId: r.m.id })}
                    />
                  ) : (
                    <OutboxBubble item={r.o} tz={tz} online={online} accountId={accountId} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <div ref={endRef} />
      </>
    );
  }

  const showComposer = !!rel && rel.status === 'active' && writable.ok && !coachLocked;
  const readOnly = !!rel && !coachLocked && rel.status !== 'requested' && !writable.ok;

  return (
    <div className="mx-auto w-full max-w-2xl flex flex-col h-dvh">
      {header}
      <div ref={listRef} className="flex-1 overflow-y-auto" aria-live="polite" aria-relevant="additions">
        {relFromCache && relError && (
          <p className="px-4 pt-2 text-xs text-muted" role="status">
            Showing saved details: couldn’t check the latest status.
          </p>
        )}
        {content}
      </div>
      {readOnly && (
        <div className="border-t border-line px-4 py-3 pb-safe bg-surface">
          <p className="text-sm font-medium">{writable.ok ? '' : writable.reason}</p>
          <p className="text-xs text-muted mt-1">{RETENTION_TEXT}</p>
          {draft.ready && (body.trim() || photos.length > 0) && <UnsentDraft body={body} photoCount={photos.length} onDiscard={() => { setBody(''); photos.forEach((p) => removePhoto(p.id)); }} />}
        </div>
      )}
      {showComposer && (
        <form
          className="border-t border-line bg-surface px-3 pt-2 pb-safe"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {(photos.length > 0 || preparing > 0) && (
            <ul className="flex gap-2 pb-2 overflow-x-auto" aria-label="Photos to send">
              {photos.map((p, i) => (
                <li key={p.id} className="relative shrink-0">
                  <img src={p.url} alt={`Photo ${i + 1} to send`} className="size-16 rounded-xl object-cover bg-surface-3" />
                  <button type="button" onClick={() => removePhoto(p.id)} aria-label={`Remove photo ${i + 1}`} className="absolute -top-1.5 -right-1.5 size-7 rounded-full bg-surface-3 border border-line flex items-center justify-center">
                    <X className="size-4" />
                  </button>
                </li>
              ))}
              {preparing > 0 && (
                <li className="size-16 rounded-xl bg-surface-2 flex items-center justify-center" role="status" aria-label="Preparing photo">
                  <Loader2 className="size-5 animate-spin text-muted" aria-hidden />
                </li>
              )}
            </ul>
          )}
          {sendError && (
            <p role="alert" className="text-xs text-danger pb-1">
              {sendError}
            </p>
          )}
          <div className="flex items-end gap-1.5 pb-2">
            <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void addFiles(e.target.files)} />
            <IconButton label="Add photos" onClick={() => fileRef.current?.click()} disabled={photos.length + preparing >= MAX_PHOTOS}>
              <ImagePlus className="size-5" />
            </IconButton>
            <label className="flex-1 min-w-0">
              <span className="sr-only">Message {other?.name}</span>
              <textarea
                value={body}
                readOnly={!draft.ready}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={MESSAGE_MAX}
                rows={1}
                placeholder={online ? 'Message' : 'Message (sends when you’re back online)'}
                className="w-full min-h-11 max-h-40 resize-none rounded-xl bg-field border border-line-input px-3 py-2.5 text-[16px] text-ink placeholder:text-faint focus:border-accent [field-sizing:content]"
              />
            </label>
            <IconButton label="Send message" type="submit" className="ember-fill" disabled={(!body.trim() && photos.length === 0) || preparing > 0}>
              <Send className="size-5" />
            </IconButton>
          </div>
          {body.length > MESSAGE_MAX - 200 && <p className="text-xs text-muted pb-1 text-right">{body.length}/{MESSAGE_MAX}</p>}
        </form>
      )}

      {rel && other && (
        <>
          <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Conversation">
            <ul className="-mx-5 divide-y divide-line">
              <li>
                <ListRow
                  left={<User className="size-5 text-muted" aria-hidden />}
                  title={rel.viewerIsCoach ? `${other.name}’s details` : 'My coach'}
                  subtitle={rel.viewerIsCoach ? 'Intake, shared records and program' : 'Sharing, programs, check-ins and ending coaching'}
                  onClick={() => nav(rel.viewerIsCoach ? `/coaching/client/${rel.id}` : '/coaching/my')}
                />
              </li>
              <li>
                <ListRow
                  left={<Flag className="size-5 text-muted" aria-hidden />}
                  title="Report conversation"
                  subtitle="Tell our moderators about a problem. To report one message, tap it."
                  onClick={() => {
                    setMenuOpen(false);
                    setReport({});
                  }}
                />
              </li>
              <li>
                <ListRow
                  left={<Ban className="size-5 text-danger" aria-hidden />}
                  title={<span className="text-danger">Block {other.name}</span>}
                  subtitle="Ends coaching and stops all messages"
                  onClick={() => {
                    setMenuOpen(false);
                    setBlockOpen(true);
                  }}
                />
              </li>
            </ul>
          </Sheet>
          <ReportCoachingSheet open={!!report} onClose={() => setReport(null)} relationshipId={rel.id} messageId={report?.messageId} what={report?.messageId ? 'message' : 'conversation'} />
          <ConfirmDialog
            open={blockOpen}
            title={`Block ${other.name}?`}
            danger
            confirmLabel="Block and end coaching"
            busy={blocking}
            onCancel={() => setBlockOpen(false)}
            onConfirm={block}
            body={
              <div className="flex flex-col gap-2">
                <p>Blocking ends coaching right away. Neither of you can message the other, and messages still waiting on this device won’t be sent.</p>
                <p>
                  {rel.viewerIsCoach
                    ? 'You lose access to this client’s shared records. Their workouts and accepted programs stay theirs.'
                    : 'Your coach loses access to everything you shared. Your workouts and accepted programs stay yours, and this conversation stays readable to you.'}
                </p>
                <p>You can unblock later from your social settings, but coaching won’t restart automatically.</p>
              </div>
            }
          />
        </>
      )}
    </div>
  );
}

/** A draft that can no longer be sent (coaching ended / paused): kept so the text isn't lost. */
function UnsentDraft({ body, photoCount, onDiscard }: { body: string; photoCount: number; onDiscard: () => void }) {
  const toast = useToast();
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
      <p className="text-xs text-muted">Your unsent draft{photoCount ? ` (${photoCount} photo${photoCount === 1 ? '' : 's'})` : ''} is kept on this device. It won’t be sent.</p>
      {body.trim() && <p className="mt-1 text-sm whitespace-pre-wrap break-words select-text line-clamp-4">{body}</p>}
      <div className="flex gap-1 mt-1">
        {body.trim() && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy className="size-4" />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(body);
                toast.show('Draft copied', { tone: 'success' });
              } catch {
                toast.show('Couldn’t copy automatically: select the text and copy it.', { tone: 'warn' });
              }
            }}
          >
            Copy text
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={onDiscard}>
          Discard draft
        </Button>
      </div>
    </div>
  );
}

/* ================================================================ bubbles */
function timeText(iso: string, tz: string) {
  const t = Date.parse(iso);
  return isFinite(t) ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(t) : '';
}
function dayKey(iso: string, tz: string) {
  const t = Date.parse(iso);
  return isFinite(t) ? localDate(t, tz) : '';
}
function dayLabel(iso: string, tz: string) {
  const k = dayKey(iso, tz);
  const today = localDate(Date.now(), tz);
  const yesterday = localDate(Date.now() - 86_400_000, tz);
  if (k === today) return 'Today';
  if (k === yesterday) return 'Yesterday';
  return fmtDay(iso, tz);
}

function ServerBubble({ m, mine, tz, selected, onSelect, onReport }: { m: CoachMessage; mine: boolean; tz: string; selected: boolean; onSelect: () => void; onReport: () => void }) {
  const inner = (
    <>
      {m.sharedFromAi && <span className="block text-[11px] font-medium text-info mb-1">Shared from the training assistant</span>}
      {m.media.length > 0 && <MediaGrid media={m.media} />}
      {m.body && <span className="block whitespace-pre-wrap break-words text-[15px]">{m.body}</span>}
    </>
  );
  const bubble = cx('max-w-[85%] rounded-2xl px-3.5 py-2 text-left', mine ? 'bg-accent-soft self-end rounded-br-md' : 'bg-surface-2 self-start rounded-bl-md');
  return (
    <div className={cx('flex flex-col', mine ? 'items-end' : 'items-start')}>
      {mine ? (
        <div className={bubble}>{inner}</div>
      ) : (
        <button type="button" className={bubble} onClick={onSelect} aria-expanded={selected}>
          {inner}
        </button>
      )}
      <span className="mt-0.5 px-1 text-[11px] text-faint inline-flex items-center gap-1">
        <time dateTime={m.createdAt}>{timeText(m.createdAt, tz)}</time>
        {mine &&
          (m.status === 'awaiting_media' ? (
            <>
              · <Loader2 className="size-3 animate-spin" aria-hidden /> Uploading photos…
            </>
          ) : (
            <>
              · <Check className="size-3" aria-hidden /> Sent
            </>
          ))}
      </span>
      {!mine && selected && (
        <Button size="sm" variant="ghost" className="text-muted" icon={<Flag className="size-4" />} onClick={onReport}>
          Report this message
        </Button>
      )}
    </div>
  );
}

function MediaGrid({ media }: { media: CoachMessage['media'] }) {
  return (
    <div className={cx('grid gap-1 mb-1.5', media.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
      {media.map((x, i) =>
        x.thumbUrl || x.url ? (
          <a key={x.id} href={x.url ?? x.thumbUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Open photo ${i + 1}`}>
            <img src={x.thumbUrl ?? x.url} alt="" width={x.width} height={x.height} loading="lazy" className="w-full max-h-64 rounded-xl object-cover bg-surface-3" />
          </a>
        ) : (
          <span key={x.id} className="h-24 rounded-xl bg-surface-3 flex items-center justify-center text-xs text-muted">
            Photo processing…
          </span>
        ),
      )}
    </div>
  );
}

function OutboxBubble({ item, tz, online, accountId }: { item: CoachOutboxItem; tz: string; online: boolean; accountId: string | null }) {
  const { db } = useApp();
  const toast = useToast();
  const sending = useOutboxInFlight(item.id);
  const urls = useMemo(() => (item.photos ?? []).map((p) => URL.createObjectURL(p.thumb)), [item.photos]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const failed = item.status === 'failed';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.body);
      toast.show('Message copied', { tone: 'success' });
    } catch {
      toast.show('Couldn’t copy automatically: select the text and copy it.', { tone: 'warn' });
    }
  };
  return (
    <div className="flex flex-col items-end">
      <div className={cx('max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 border', failed ? 'border-danger/40 bg-danger-soft' : 'border-dashed border-line bg-accent-soft/60')}>
        {urls.length > 0 && (
          <div className={cx('grid gap-1 mb-1.5', urls.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
            {urls.map((u, i) => (
              <img key={u} src={u} alt={`Photo ${i + 1}`} className="w-full max-h-48 rounded-xl object-cover bg-surface-3" />
            ))}
          </div>
        )}
        {item.body && <p className="whitespace-pre-wrap break-words text-[15px] select-text">{item.body}</p>}
      </div>
      <span className={cx('mt-0.5 px-1 text-[11px] inline-flex items-center gap-1', failed ? 'text-danger' : 'text-faint')} role="status">
        <time dateTime={new Date(item.createdAt).toISOString()}>{timeText(new Date(item.createdAt).toISOString(), tz)}</time>·
        {failed ? <AlertTriangle className="size-3" aria-hidden /> : online ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Clock className="size-3" aria-hidden />}
        {outboxStatusLabel(item, online, sending)}
      </span>
      {failed && (
        <div className="flex flex-col items-end gap-1 mt-1 max-w-[85%]">
          {item.error && <p className="text-xs text-muted text-right">{item.error}</p>}
          <div className="flex flex-wrap justify-end gap-1">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void retryCoachMessage(item.id, db, accountId)} disabled={!online}>
              Retry
            </Button>
            {item.body && (
              <Button size="sm" variant="ghost" icon={<Copy className="size-4" />} onClick={copy}>
                Copy text
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => void discardCoachMessage(item.id, db)}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
