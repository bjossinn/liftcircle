/** Shared building blocks for the training assistant screens. */
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { authHref } from '@/features/auth/authReturn';
import { Bot, ChevronLeft, CloudOff, LogIn, RefreshCw, Share2, Sparkles } from 'lucide-react';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Notice, Segmented, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { coachingApi } from '@/backend/coaching';
import type { AiAvailability, AiScopes, CoachingRelationship } from '@/backend/coachingContract';
import type { CoachStyle } from '@/domain/types';
import { uuid } from '@/lib/id';
import { BRAND } from '@/config/brand';
import { t as tNow, useT } from '@/i18n';
import { alwaysSentText, clip, COACH_MESSAGE_MAX, COACH_STYLE_INFO, coachStyleSafetyText, DEFAULT_COACH_STYLE, neverSentText, SCOPE_INFO } from './model';

export function BackButton({ to }: { to?: string }) {
  const nav = useNavigate();
  const { t } = useT();
  return (
    <IconButton
      label={t('ai.back')}
      onClick={() => {
        if (to) nav(to);
        else if (window.history.length > 1) nav(-1);
        else nav('/coach');
      }}
    >
      <ChevronLeft />
    </IconButton>
  );
}

/** Small "AI" marker used on every AI-authored message and suggestion. */
export function AiBadge({ children }: { children?: ReactNode }) {
  const { t } = useT();
  return (
    <Badge tone="info" className="uppercase tracking-wide">
      <Sparkles className="size-3" aria-hidden />
      {children ?? t('ai.badge')}
    </Badge>
  );
}

type UnavailableReason = Extract<AiAvailability, { available: false }>['reason'];
const UNAVAILABLE_KEYS = {
  not_configured: ['ai.unavailable.notConfigured.title', 'ai.unavailable.notConfigured.body'],
  backend_missing: ['ai.unavailable.notConfigured.title', 'ai.unavailable.backendMissing.body'],
  provider_down: ['ai.unavailable.providerDown.title', 'ai.unavailable.providerDown.body'],
  offline: ['ai.unavailable.offline.title', 'ai.unavailable.offline.body'],
  disabled: ['ai.unavailable.disabled.title', 'ai.unavailable.disabled.body'],
} as const satisfies Record<UnavailableReason, readonly [string, string]>;

/** Title and body for an unavailable state, in the app language. */
export function availabilityCopy(reason: UnavailableReason): { title: string; body: string } {
  const [title, body] = UNAVAILABLE_KEYS[reason];
  return { title: tNow(title), body: tNow(body, { brand: BRAND.name }) };
}

export function AiUnavailable({ reason, onRetry }: { reason: Extract<AiAvailability, { available: false }>['reason']; onRetry?: () => void }) {
  const { t } = useT();
  const c = availabilityCopy(reason);
  return (
    <EmptyState
      icon={reason === 'offline' ? <CloudOff className="size-6" /> : <Bot className="size-6" />}
      title={c.title}
      body={c.body}
      action={
        onRetry && reason !== 'not_configured' && reason !== 'backend_missing' ? (
          <Button onClick={onRetry} icon={<RefreshCw className="size-4" />}>
            {t('ai.tryAgain')}
          </Button>
        ) : undefined
      }
    />
  );
}

export function AiGuest() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { t } = useT();
  return (
    <EmptyState
      icon={<LogIn className="size-6" />}
      title={t('ai.guest.title')}
      body={t('ai.guest.body')}
      action={
        <Button variant="primary" onClick={() => nav(authHref('signup', pathname))}>
          {t('ai.guest.signIn')}
        </Button>
      }
    />
  );
}

/** Supportive / Balanced / Strict, with what each one means. */
export function CoachStylePicker({ value, onChange, disabled }: { value: CoachStyle; onChange: (next: CoachStyle) => void; disabled?: boolean }) {
  const { t } = useT();
  const info = COACH_STYLE_INFO.find((s) => s.key === value) ?? COACH_STYLE_INFO.find((s) => s.key === DEFAULT_COACH_STYLE)!;
  return (
    <div className={disabled ? 'opacity-60 pointer-events-none' : undefined} aria-disabled={disabled || undefined}>
      <Segmented<CoachStyle> label={t('ai.style.label')} value={value} onChange={onChange} options={COACH_STYLE_INFO.map((s) => ({ value: s.key, label: s.title }))} />
      <p className="text-sm text-muted mt-2" aria-live="polite">
        {info.body}
      </p>
      <p className="text-xs text-faint mt-1">{coachStyleSafetyText()}</p>
    </div>
  );
}

/** Data categories with plain explanations of what is sent. */
export function ScopeToggles({ value, onChange, disabled }: { value: AiScopes; onChange: (next: AiScopes) => void; disabled?: boolean }) {
  const { t } = useT();
  return (
    <div className="divide-y divide-line">
      {SCOPE_INFO.map((s) => (
        <div key={s.key} className="py-1">
          <Toggle
            checked={value[s.key]}
            disabled={disabled}
            onChange={(v) => onChange({ ...value, [s.key]: v })}
            label={s.title}
            description={t('ai.scope.sends', { description: s.sends })}
          />
        </div>
      ))}
    </div>
  );
}

/** Puts `first` where a {{placeholder}} first appears in a localized sentence (e.g. a bold name), `rest` after that. */
function withNode(sentence: (marker: string) => string, first: ReactNode, rest: ReactNode): ReactNode {
  const MARK = '\u0000';
  return sentence(MARK)
    .split(MARK)
    .flatMap((part, i) => (i === 0 ? [part] : [<span key={i}>{i === 1 ? first : rest}</span>, part]));
}

/**
 * `provider`: the named company the server sends AI requests to (from aiApi.status(), via providerName()); omitted
 * when unknown, which selects the generic sentence. A proper name is inserted unchanged.
 */
export function DataExplainer({ provider }: { provider?: string }) {
  const { t } = useT();
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>
        {provider
          ? withNode((m) => t('ai.data.processing', { brand: BRAND.name, provider: m }), <strong className="text-ink">{provider}</strong>, provider)
          : t('ai.data.processingGeneric', { brand: BRAND.name })}
      </p>
      <p>
        <span className="text-ink font-medium">{t('ai.data.alwaysLabel')}</span> {alwaysSentText()}
      </p>
      <p>
        <span className="text-ink font-medium">{t('ai.data.neverLabel')}</span> {neverSentText()}
      </p>
    </div>
  );
}

export function RetentionExplainer({ provider }: { provider?: string }) {
  const { t } = useT();
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>{t('ai.retention.account')}</p>
      <p>{provider ? t('ai.retention.provider', { provider }) : t('ai.retention.providerGeneric')}</p>
    </div>
  );
}

/**
 * Explicit confirm before sending AI text into the human-coach conversation.
 * The message id is created once per dialog so a retry can't send it twice.
 */
export function ShareWithCoachDialog({ open, text, relationship, onClose, what }: { open: boolean; text: string; relationship: CoachingRelationship; onClose: () => void; what?: string }) {
  const toast = useToast();
  const { t } = useT();
  const shared = what ?? t('ai.share.whatMessage');
  const [id] = useState(() => uuid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = clip(text, COACH_MESSAGE_MAX);
  const coachName = relationship.coach.displayName || null;

  async function share() {
    setBusy(true);
    setError(null);
    try {
      await coachingApi.sendMessage({ id, relationshipId: relationship.id, body, sharedFromAi: true });
      toast.show(coachName ? t('ai.share.success', { coachName }) : t('ai.share.successGeneric'), { tone: 'success' });
      onClose();
    } catch {
      // The raw error (network/database, English) isn't shown.
      setError(t('ai.share.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={t('ai.share.confirmTitle')}
      confirmLabel={t('ai.share.action')}
      busy={busy}
      onCancel={onClose}
      onConfirm={share}
      body={coachName ? t('ai.share.confirmBody', { what: shared, coachName }) : t('ai.share.confirmBodyGeneric', { what: shared })}
    >
      <blockquote className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap break-words max-h-60 overflow-y-auto">{body}</blockquote>
      {body.length < text.length && <p className="mt-2 text-xs text-muted">{t('ai.share.truncated')}</p>}
      {error && (
        <Notice tone="danger" className="mt-3">
          <span role="alert">{error}</span>
        </Notice>
      )}
    </ConfirmDialog>
  );
}

export function ShareButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <Button size="sm" variant="ghost" icon={<Share2 className="size-4" />} onClick={onClick}>
      {t('ai.share.button')}
    </Button>
  );
}
