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
import { feedHome } from './feedHome';
import { PostCard } from './PostCard';
import { useT } from '@/i18n';

const COMMENT_MAX = 1000;

export default function PostPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
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
          setCommentsError(friendlyError(e, t('social.couldnt_load_comments')));
        }
      }
    } catch (e) {
      setError(friendlyError(e, t('social.couldnt_load_this_post')));
    }
  }, [id, t]);

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
      setSendError(friendlyError(e, t('social.error.send_comment')));
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
      toast.show(t('social.comment_removed'), { tone: 'success' });
    } catch (e) {
      toast.show(friendlyError(e, t('social.error.remove_comment')), { tone: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  const isPostAuthor = !!post && !!meId && post.authorId === meId;

  return (
    <Page
      title={t('social.post')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? (
        <AccessNotice access={access} what="post" />
      ) : error ? (
        <ErrorState title={t('social.couldnt_load_this_post')} message={error} onRetry={load} />
      ) : post === undefined ? (
        <Spinner label={t('social.loading_post')} />
      ) : post === null ? (
        <EmptyState
          title={t('social.this_post_isnt_available')}
          body={t('social.it_may_have_been_deleted_or_2')}
          action={<Button onClick={() => nav(feedHome().path)}>{feedHome().label}</Button>}
        />
      ) : (
        <>
          <PostCard
            post={post}
            meId={meId}
            standalone
            onChange={setPost}
            onRemove={() => nav(feedHome().path, { replace: true })}
            onBlocked={() => nav(feedHome().path, { replace: true })}
          />

          <section aria-labelledby="comments-title">
            <SectionTitle id="comments-title">{t('settings.comments')}</SectionTitle>
            {commentsError ? (
              <ErrorState title={t('social.couldnt_load_comments')} message={commentsError} onRetry={load} />
            ) : comments.length === 0 ? (
              <EmptyState icon={<MessageCircle className="size-6" aria-hidden />} title={t('social.no_comments_yet')} body={t('social.say_something_encouraging')} />
            ) : (
              <ul className="flex flex-col gap-1">
                {comments.map((c) => {
                  const mine = c.authorId === meId;
                  const name = c.author?.displayName || (c.author?.username ? `@${c.author.username}` : mine ? t('social.you') : t('social.someone'));
                  return (
                    <li key={c.id} className="flex gap-3 rounded-xl px-1 py-2">
                      {c.author?.username ? (
                        <Link to={`/u/${c.author.username}`} aria-label={t('social.xs_profile', { name })} className="shrink-0">
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
                        <IconButton label={mine ? t('social.delete_your_comment') : t('social.remove_comment_by_x', { name })} onClick={() => setToDelete(c)} className="text-muted">
                          <Trash2 className="size-4" />
                        </IconButton>
                      ) : (
                        <IconButton label={t('social.report_comment_by_x', { name })} onClick={() => setToReport(c)} className="text-muted">
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
                label={t('social.add_a_comment')}
                value={body}
                maxLength={COMMENT_MAX}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-20"
                error={sendError}
                hint={body.length > COMMENT_MAX - 100 ? `${body.length}/${COMMENT_MAX}` : undefined}
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={sending} disabled={!body.trim()} icon={<Send className="size-4" />}>
                  {t('social.comment_2')}
                </Button>
              </div>
            </form>
          </section>

          <ConfirmDialog
            open={!!toDelete}
            title={toDelete?.authorId === meId ? t('social.delete_your_comment_2') : t('social.remove_this_comment')}
            body={toDelete?.authorId === meId ? t('social.it_will_be_removed_from_the') : t('social.it_will_be_removed_from_your')}
            confirmLabel={toDelete?.authorId === meId ? t('common.delete') : t('common.remove')}
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
