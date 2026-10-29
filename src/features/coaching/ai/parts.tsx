/** Shared building blocks for the AI coach screens. */
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { authHref } from '@/features/auth/authReturn';
import { Bot, ChevronLeft, CloudOff, LogIn, RefreshCw, Share2, Sparkles } from 'lucide-react';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Notice, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';
import { coachingApi } from '@/backend/coaching';
import type { AiAvailability, AiScopes, CoachingRelationship } from '@/backend/coachingContract';
import { uuid } from '@/lib/id';
import { BRAND } from '@/config/brand';
import { ALWAYS_SENT, clip, COACH_MESSAGE_MAX, NEVER_SENT, SCOPE_INFO } from './model';

export function BackButton({ to }: { to?: string }) {
  const nav = useNavigate();
  return (
    <IconButton
      label="Back"
      onClick={() => {
        if (to) nav(to);
        else if (window.history.length > 1) nav(-1);
        else nav('/coaching');
      }}
    >
      <ChevronLeft />
    </IconButton>
  );
}

/** Small "AI" marker used on every AI-authored message and suggestion. */
export function AiBadge({ children = 'AI' }: { children?: ReactNode }) {
  return (
    <Badge tone="info" className="uppercase tracking-wide">
      <Sparkles className="size-3" aria-hidden />
      {children}
    </Badge>
  );
}

const UNAVAILABLE_COPY: Record<Extract<AiAvailability, { available: false }>['reason'], { title: string; body: string }> = {
  not_configured: {
    title: 'AI coach isn’t set up on this server yet',
    body: `Whoever runs this ${BRAND.name} server hasn’t connected an AI provider. Your workouts, plan, nutrition and coaching all keep working as usual.`,
  },
  backend_missing: {
    title: 'AI coach isn’t set up on this server yet',
    body: `This ${BRAND.name} server doesn’t offer the AI coach. Your workouts, plan, nutrition and coaching all keep working as usual.`,
  },
  provider_down: {
    title: 'The AI coach is temporarily unavailable',
    body: 'The AI service isn’t responding right now. Please try again in a little while — everything else keeps working.',
  },
  offline: {
    title: 'You’re offline',
    body: 'The AI coach needs an internet connection. Your workouts and plan keep working offline.',
  },
  disabled: {
    title: 'The AI coach is turned off',
    body: 'Turn it on in AI coach settings whenever you like.',
  },
};

export function availabilityCopy(reason: Extract<AiAvailability, { available: false }>['reason']) {
  return UNAVAILABLE_COPY[reason];
}

export function AiUnavailable({ reason, onRetry }: { reason: Extract<AiAvailability, { available: false }>['reason']; onRetry?: () => void }) {
  const c = UNAVAILABLE_COPY[reason];
  return (
    <EmptyState
      icon={reason === 'offline' ? <CloudOff className="size-6" /> : <Bot className="size-6" />}
      title={c.title}
      body={c.body}
      action={
        onRetry && reason !== 'not_configured' && reason !== 'backend_missing' ? (
          <Button onClick={onRetry} icon={<RefreshCw className="size-4" />}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

export function AiGuest() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  return (
    <EmptyState
      icon={<LogIn className="size-6" />}
      title="Sign in to use the AI coach"
      body="The AI coach runs on the server and keeps your conversation in your account, so it needs you to be signed in."
      action={
        <Button variant="primary" onClick={() => nav(authHref('signup', pathname))}>
          Sign in or create an account
        </Button>
      }
    />
  );
}

/** Data categories with plain explanations of what is sent. */
export function ScopeToggles({ value, onChange, disabled }: { value: AiScopes; onChange: (next: AiScopes) => void; disabled?: boolean }) {
  return (
    <div className="divide-y divide-line">
      {SCOPE_INFO.map((s) => (
        <div key={s.key} className="py-1">
          <Toggle
            checked={value[s.key]}
            disabled={disabled}
            onChange={(v) => onChange({ ...value, [s.key]: v })}
            label={s.title}
            description={<>Sends: {s.sends}</>}
          />
        </div>
      ))}
    </div>
  );
}

/** `provider`: the company the server sends AI requests to (from aiApi.status()); generic wording when unknown. */
export function DataExplainer({ provider }: { provider?: string }) {
  const named = provider && provider !== 'the AI provider';
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>
        Your request is processed on the {BRAND.name} server, which sends the categories you allow to{' '}
        {named ? (
          <>
            <strong className="text-ink">{provider}</strong>, the AI provider,
          </>
        ) : (
          'the AI provider'
        )}{' '}
        to write a reply. Nothing is sent from your device directly to {named ? provider : 'the provider'}.
      </p>
      <p>
        <span className="text-ink font-medium">Always sent:</span> {ALWAYS_SENT}
      </p>
      <p>
        <span className="text-ink font-medium">Never sent:</span> {NEVER_SENT}
      </p>
    </div>
  );
}

export function RetentionExplainer({ provider }: { provider?: string }) {
  const p = provider && provider !== 'the AI provider' ? provider : 'the AI provider';
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>Your AI conversation, suggestions and notes are stored in your account’s database until you clear them or delete your account.</p>
      <p>
        What {p} does with the requests it receives is governed by {p === 'the AI provider' ? 'its' : `${p}’s`} API data policy. Clearing your history here
        removes it from your account; it can’t delete anything on {p === 'the AI provider' ? 'the provider’s' : `${p}’s`} side.
      </p>
    </div>
  );
}

/**
 * Explicit confirm before sending AI text into the human-coach conversation.
 * The message id is created once per dialog so a retry can't send it twice.
 */
export function ShareWithCoachDialog({ open, text, relationship, onClose, what = 'this AI coach message' }: { open: boolean; text: string; relationship: CoachingRelationship; onClose: () => void; what?: string }) {
  const toast = useToast();
  const [id] = useState(() => uuid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = clip(text, COACH_MESSAGE_MAX);
  const coachName = relationship.coach.displayName || 'your coach';

  async function share() {
    setBusy(true);
    setError(null);
    try {
      await coachingApi.sendMessage({ id, relationshipId: relationship.id, body, sharedFromAi: true });
      toast.show(`Shared with ${coachName}`, { tone: 'success' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t share it. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Share with your coach?"
      confirmLabel="Share"
      busy={busy}
      onCancel={onClose}
      onConfirm={share}
      body={
        <>
          Only {what} is sent to {coachName} in your coaching messages, marked as coming from the AI coach. The rest of your AI conversation stays private.
        </>
      }
    >
      <blockquote className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap break-words max-h-60 overflow-y-auto">{body}</blockquote>
      {body.length < text.length && <p className="mt-2 text-xs text-muted">Long messages are shortened to fit.</p>}
      {error && (
        <Notice tone="danger" className="mt-3">
          <span role="alert">{error}</span>
        </Notice>
      )}
    </ConfirmDialog>
  );
}

export function ShareButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" icon={<Share2 className="size-4" />} onClick={onClick}>
      Share with my coach
    </Button>
  );
}
