/**
 * /coaching/ai/settings — turn the AI coach on/off or pause it, change what data it may use,
 * view/edit its notes (its only persistent memory), see today's usage and how data is kept.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { MessageCircle, Pause, Play, Power, Sparkles, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Notice, Page, SectionTitle, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { aiApi } from '@/backend/ai';
import type { AiAvailability, AiScopes, AiSettings } from '@/backend/coachingContract';
import type { CoachStyle } from '@/domain/types';
import { kvSet } from '@/db/repo';
import { useApp } from '@/state/app';
import { AI_HISTORY_CACHE_KEY, AI_NOTES_MAX, classifyAiError, isHardUnavailable, providerLabel, usageLine } from './ai/model';
import { useAiBoot } from './ai/useAi';
import { AiGuest, AiUnavailable, BackButton, CoachStylePicker, DataExplainer, RetentionExplainer, ScopeToggles } from './ai/parts';

export default function AiSettingsPage() {
  const nav = useNavigate();
  const { boot, reload, setSettings } = useAiBoot();
  const back = <BackButton />;

  if (boot.phase === 'loading')
    return (
      <Page title="AI coach settings" back={back}>
        <Spinner label="Loading settings" />
      </Page>
    );
  if (boot.phase === 'guest')
    return (
      <Page title="AI coach settings" back={back}>
        <AiGuest />
      </Page>
    );
  const a = boot.availability;
  if (isHardUnavailable(a) || (!a.available && a.reason === 'offline'))
    return (
      <Page title="AI coach settings" back={back}>
        <AiUnavailable reason={(a as Extract<AiAvailability, { available: false }>).reason} onRetry={() => void reload()} />
      </Page>
    );
  if (boot.settings === undefined)
    return (
      <Page title="AI coach settings" back={back}>
        <ErrorState title="Couldn’t load your AI coach settings" message={boot.settingsError} onRetry={() => void reload()} />
      </Page>
    );
  if (boot.settings === null)
    return (
      <Page title="AI coach settings" back={back}>
        <div className="flex flex-col items-center text-center px-6 py-10 gap-3">
          <Sparkles className="size-8 text-accent" aria-hidden />
          <h2 className="text-base font-semibold">You haven’t set up the AI coach</h2>
          <p className="text-sm text-muted max-w-xs">It’s optional. Set it up to choose what it may use and agree to how it works.</p>
          <Button variant="primary" onClick={() => nav('/coaching/ai/setup')}>
            Set up AI coach
          </Button>
        </div>
      </Page>
    );

  return <SettingsBody provider={providerLabel(boot.availability)} settings={boot.settings} usage={usageLine(boot.usage)} tokens={boot.usage ? boot.usage.inputTokens + boot.usage.outputTokens : null} setSettings={setSettings} back={back} />;
}

function SettingsBody({ provider, settings, usage, tokens, setSettings, back }: { provider: string; settings: AiSettings; usage: string | null; tokens: number | null; setSettings: (s: AiSettings) => void; back: ReactNode }) {
  const nav = useNavigate();
  const toast = useToast();
  const { db } = useApp();
  const [scopes, setScopes] = useState<AiScopes>(settings.scopes);
  const [notes, setNotes] = useState(settings.profileNotes ?? '');
  const [style, setStyle] = useState<CoachStyle>(settings.coachStyle);
  const [busy, setBusy] = useState<null | 'state' | 'scopes' | 'style' | 'notes' | 'clearNotes' | 'history'>(null);
  const [confirm, setConfirm] = useState<null | 'off' | 'notes' | 'history'>(null);

  useEffect(() => setScopes(settings.scopes), [settings.scopes]);
  useEffect(() => setStyle(settings.coachStyle), [settings.coachStyle]);

  async function save(patch: Partial<AiSettings>, kind: NonNullable<typeof busy>, ok?: string): Promise<boolean> {
    setBusy(kind);
    try {
      const s = await aiApi.saveSettings(patch);
      setSettings(s);
      if (ok) toast.show(ok, { tone: 'success' });
      return true;
    } catch (e) {
      toast.show(classifyAiError(e).message, { tone: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function changeScopes(next: AiScopes) {
    const prev = scopes;
    setScopes(next);
    const ok = await save({ scopes: next }, 'scopes', 'Data access updated');
    if (!ok) setScopes(prev);
  }

  async function changeStyle(next: CoachStyle) {
    if (next === style) return;
    const prev = style;
    setStyle(next);
    const ok = await save({ coachStyle: next }, 'style', 'Coach style updated');
    if (!ok) setStyle(prev);
  }

  async function clearHistory() {
    setBusy('history');
    try {
      await aiApi.clearHistory();
      await kvSet(AI_HISTORY_CACHE_KEY, [], db).catch(() => undefined);
      toast.show('Conversation cleared', { tone: 'success' });
      setConfirm(null);
    } catch (e) {
      toast.show(classifyAiError(e).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const state = !settings.enabled ? 'off' : settings.paused ? 'paused' : 'on';
  const notesDirty = notes !== (settings.profileNotes ?? '');

  return (
    <Page title="AI coach settings" back={back}>
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold flex-1">AI coach</h2>
          <Badge tone={state === 'on' ? 'accent' : state === 'paused' ? 'warn' : 'neutral'}>{state === 'on' ? 'On' : state === 'paused' ? 'Paused' : 'Off'}</Badge>
        </div>
        <p className="text-sm text-muted mt-1">
          {state === 'on'
            ? 'It replies when you ask and uses only the data you allow below.'
            : state === 'paused'
              ? 'Paused: it won’t read your data or reply until you resume. Your conversation and notes are kept.'
              : 'Off: it won’t read your data or reply. Your conversation and notes are kept until you clear them.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {state === 'on' && (
            <Button icon={<Pause className="size-4" />} loading={busy === 'state'} onClick={() => void save({ paused: true }, 'state', 'AI coach paused')}>
              Pause
            </Button>
          )}
          {state === 'paused' && (
            <Button variant="primary" icon={<Play className="size-4" />} loading={busy === 'state'} onClick={() => void save({ paused: false }, 'state', 'AI coach resumed')}>
              Resume
            </Button>
          )}
          {state !== 'off' && (
            <Button variant="outline" icon={<Power className="size-4" />} onClick={() => setConfirm('off')}>
              Turn off
            </Button>
          )}
          {state === 'off' &&
            (settings.consentAt ? (
              <Button variant="primary" icon={<Power className="size-4" />} loading={busy === 'state'} onClick={() => void save({ enabled: true, paused: false }, 'state', 'AI coach is on')}>
                Turn on
              </Button>
            ) : (
              <Button variant="primary" onClick={() => nav('/coaching/ai/setup')}>
                Set up AI coach
              </Button>
            ))}
          {state !== 'off' && (
            <Button variant="ghost" icon={<MessageCircle className="size-4" />} onClick={() => nav('/coaching/ai')}>
              Open chat
            </Button>
          )}
        </div>
        {settings.consentAt && <p className="text-xs text-faint mt-3">You agreed on {new Date(settings.consentAt).toLocaleDateString()}.</p>}
      </Card>

      <SectionTitle id="ai-style">Coach style</SectionTitle>
      <Card className="p-4" aria-labelledby="ai-style">
        <CoachStylePicker value={style} onChange={(n) => void changeStyle(n)} disabled={busy === 'style'} />
        <p className="text-xs text-muted mt-2">Used in chat and for the cheers in the workout logger.</p>
      </Card>

      <SectionTitle id="ai-scopes">Data it may use</SectionTitle>
      <Card className="px-4 py-1" aria-labelledby="ai-scopes">
        <ScopeToggles value={scopes} onChange={(n) => void changeScopes(n)} disabled={busy === 'scopes'} />
      </Card>
      <p className="text-xs text-muted px-1 mt-2">
        Switching a category off stops it being used from your next message, and earlier conversation that included it won’t be sent again as context.
        Messages already stored stay in your history until you clear it.
        {settings.scopesChangedAt ? ` Last changed ${new Date(settings.scopesChangedAt).toLocaleString()}.` : ''}
      </p>

      <SectionTitle id="ai-notes">AI coach notes</SectionTitle>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted">
          These notes are the only thing the AI coach remembers about you apart from your conversation. Only you can change them — the AI never edits them.
        </p>
        <Textarea label="Notes" value={notes} maxLength={AI_NOTES_MAX} onChange={(e) => setNotes(e.target.value)} hint={`${notes.length} / ${AI_NOTES_MAX}`} />
        <div className="flex gap-2 flex-wrap">
          <Button variant="primary" disabled={!notesDirty} loading={busy === 'notes'} onClick={() => void save({ profileNotes: notes }, 'notes', 'Notes saved')}>
            Save notes
          </Button>
          {notesDirty && (
            <Button variant="ghost" onClick={() => setNotes(settings.profileNotes ?? '')}>
              Undo changes
            </Button>
          )}
          <Button variant="danger" icon={<Trash2 className="size-4" />} disabled={!settings.profileNotes} onClick={() => setConfirm('notes')}>
            Clear notes
          </Button>
        </div>
      </Card>

      <SectionTitle>Usage today</SectionTitle>
      <Card className="p-4">
        {usage ? (
          <>
            <p className="text-sm">{usage}</p>
            {tokens != null && <p className="text-xs text-muted mt-1">{tokens.toLocaleString()} tokens processed today.</p>}
            <p className="text-xs text-muted mt-1">There’s a daily limit per person so the service stays available for everyone.</p>
          </>
        ) : (
          <p className="text-sm text-muted">No usage information is available right now.</p>
        )}
      </Card>

      <SectionTitle>Conversation</SectionTitle>
      <Card className="p-4">
        <p className="text-sm text-muted">Clearing deletes your AI coach messages from your account and this device. Notes and applied plan changes are kept.</p>
        <Button className="mt-3" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm('history')}>
          Clear history
        </Button>
      </Card>

      <SectionTitle>Your data</SectionTitle>
      <Card className="p-4 space-y-3">
        <DataExplainer provider={provider} />
        <RetentionExplainer provider={provider} />
      </Card>

      {state !== 'off' && (
        <Notice className="mt-4">The AI coach gives general fitness guidance, not medical advice. For pain, injuries or health conditions, talk to a health professional.</Notice>
      )}

      <ConfirmDialog
        open={confirm === 'off'}
        title="Turn off the AI coach?"
        confirmLabel="Turn off"
        danger
        busy={busy === 'state'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (await save({ enabled: false }, 'state', 'AI coach turned off')) setConfirm(null);
        }}
        body="It stops reading your data and replying. Your conversation and notes stay in your account until you clear them, and you can turn it back on later."
      />
      <ConfirmDialog
        open={confirm === 'notes'}
        title="Clear AI coach notes?"
        confirmLabel="Clear notes"
        danger
        busy={busy === 'clearNotes'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (await save({ profileNotes: '' }, 'clearNotes', 'Notes cleared')) {
            setNotes('');
            setConfirm(null);
          }
        }}
        body="The AI coach won’t use them any more. Your profile and plan aren’t affected."
      />
      <ConfirmDialog
        open={confirm === 'history'}
        title="Clear AI conversation?"
        confirmLabel="Clear history"
        danger
        busy={busy === 'history'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void clearHistory()}
        body="This deletes your AI coach messages from your account and this device. It can’t be undone."
      />
    </Page>
  );
}
