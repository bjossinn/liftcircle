import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ChevronLeft, Flag, MessageCircle, Send, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, Page, SectionTitle, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { socialApi } from '@/backend/social';
import type { Comment, Post } from '@/domain/types';
import { uuid } from '@/lib/id';
import { friendlyError } from '@/social/pendingPosts';
import { AccessNotice, Avatar, ReportSheet, Time, useSocialAccess } from './common';
import { PostCard } from './PostCard';

const COMMENT_MAX = 1000;

export default function PostPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { access, meId } = useSocialAccess();
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [draftId, setDraftId] = useState(() => uuid());
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toReport, setToReport] = useState<Comment | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setPost(undefined);
    try {
      const p = await socialApi.getPost(id);
      setPost(p);
      if (p) {
        try {
          setComments(await socialApi.listComments(id));
          setCommentsError(null);
        } catch (e) {
          setCommentsError(friendlyError(e, 'Couldn’t load comments.'));
        }
      }
    } catch (e) {
      setError(friendlyError(e, 'Couldn’t load this post.'));
    }
  }, [id]);

  useEffect(() => {
    if (access === 'ok') void load();
  }, [access, load]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending || !post) return;
    setSending(true);
    setSendError(null);
    try {
      // Same client id on retry → the server won't create a duplicate comment.
      const c = await socialApi.addComment(post.id, draftId, text);
      setComments((cur) => (cur.some((x) => x.id === c.id) ? cur : [...cur, c]));
      setPost((p) => (p ? { ...p, commentCount: p.commentCount + 1 } : p));
      setBody('');
      setDraftId(uuid());
    } catch (e) {
      setSendError(friendlyError(e, 'Your comment wasn’t sent. Try again.'));
    } finally {
      setSending(false);
    }
  };

  const removeComment = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await socialApi.deleteComment(toDelete.id);
      setComments((cur) => cur.filter((c) => c.id !== toDelete.id));
      setPost((p) => (p ? { ...p, commentCount: Math.max(0, p.commentCount - 1) } : p));
      setToDelete(null);
      toast.show('Comment removed', { tone: 'success' });
    } catch (e) {
      toast.show(friendlyError(e, 'Couldn’t remove the comment.'), { tone: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  const isPostAuthor = !!post && !!meId && post.authorId === meId;

  return (
    <Page
      title="Post"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <AccessNotice access={access} what="This post" />
      ) : error ? (
        <ErrorState title="Couldn’t load this post" message={error} onRetry={load} />
      ) : post === undefined ? (
        <Spinner label="Loading post" />
      ) : post === null ? (
        <EmptyState title="This post isn’t available" body="It may have been deleted, or it isn’t shared with you." action={<Button onClick={() => nav('/feed')}>Back to feed</Button>} />
      ) : (
        <>
          <PostCard
            post={post}
            meId={meId}
            standalone
            onChange={setPost}
            onRemove={() => nav('/feed', { replace: true })}
            onBlocked={() => nav('/feed', { replace: true })}
          />

          <section aria-labelledby="comments-title">
            <SectionTitle id="comments-title">Comments</SectionTitle>
            {commentsError ? (
              <ErrorState title="Couldn’t load comments" message={commentsError} onRetry={load} />
            ) : comments.length === 0 ? (
              <EmptyState icon={<MessageCircle className="size-6" aria-hidden />} title="No comments yet" body="Say something encouraging." />
            ) : (
              <ul className="flex flex-col gap-1">
                {comments.map((c) => {
                  const mine = c.authorId === meId;
                  const name = c.author?.displayName || (c.author?.username ? `@${c.author.username}` : mine ? 'You' : 'Someone');
                  return (
                    <li key={c.id} className="flex gap-3 rounded-xl px-1 py-2">
                      {c.author?.username ? (
                        <Link to={`/u/${c.author.username}`} aria-label={`${name}’s profile`} className="shrink-0">
                          <Avatar profile={c.author} size={36} />
                        </Link>
                      ) : (
                        <Avatar profile={c.author} size={36} />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <span className="font-semibold">{name}</span> <Time iso={c.createdAt} className="text-xs text-muted" />
                        </p>
                        <p className="text-[15px] whitespace-pre-wrap break-words">{c.body}</p>
                      </div>
                      {mine || isPostAuthor ? (
                        <IconButton label={mine ? 'Delete your comment' : `Remove comment by ${name}`} onClick={() => setToDelete(c)} className="text-muted">
                          <Trash2 className="size-4" />
                        </IconButton>
                      ) : (
                        <IconButton label={`Report comment by ${name}`} onClick={() => setToReport(c)} className="text-muted">
                          <Flag className="size-4" />
                        </IconButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Textarea
                label="Add a comment"
                value={body}
                maxLength={COMMENT_MAX}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-20"
                error={sendError}
                hint={body.length > COMMENT_MAX - 100 ? `${body.length}/${COMMENT_MAX}` : undefined}
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={sending} disabled={!body.trim()} icon={<Send className="size-4" />}>
                  Comment
                </Button>
              </div>
            </form>
          </section>

          <ConfirmDialog
            open={!!toDelete}
            title={toDelete?.authorId === meId ? 'Delete your comment?' : 'Remove this comment?'}
            body={toDelete?.authorId === meId ? 'It will be removed from the post.' : 'It will be removed from your post for everyone.'}
            confirmLabel={toDelete?.authorId === meId ? 'Delete' : 'Remove'}
            danger
            busy={deleting}
            onConfirm={removeComment}
            onCancel={() => setToDelete(null)}
          />
          <ReportSheet open={!!toReport} onClose={() => setToReport(null)} target={{ commentId: toReport?.id, postId: post.id }} what="comment" />
        </>
      )}
    </Page>
  );
}
