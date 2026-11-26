/**
 * /coaching/ai/settings — turn the training assistant on/off or pause it, change what data it may use,
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
import { dateTimeText, numberText, useT } from '@/i18n';
import { AI_HISTORY_CACHE_KEY, AI_NOTES_MAX, classifyAiError, isHardUnavailable, providerName, usageLine } from './ai/model';
import { useAiBoot } from './ai/useAi';
import { AiGuest, AiUnavailable, BackButton, CoachStylePicker, DataExplainer, RetentionExplainer, ScopeToggles } from './ai/parts';

export default function AiSettingsPage() {
  const nav = useNavigate();
  const { boot, reload, setSettings } = useAiBoot();
  const { t } = useT();
  const back = <BackButton />;
  const title = t('ai.settings.title');

  if (boot.phase === 'loading')
    return (
      <Page title={title} back={back}>
        <Spinner label={t('ai.settings.loading')} />
      </Page>
    );
  if (boot.phase === 'guest')
    return (
      <Page title={title} back={back}>
        <AiGuest />
      </Page>
    );
  const a = boot.availability;
  if (isHardUnavailable(a) || (!a.available && a.reason === 'offline'))
    return (
      <Page title={title} back={back}>
        <AiUnavailable reason={(a as Extract<AiAvailability, { available: false }>).reason} onRetry={() => void reload()} />
      </Page>
    );
  if (boot.settings === undefined)
    return (
      <Page title={title} back={back}>
        <ErrorState title={t('ai.settings.loadError')} message={boot.settingsError} onRetry={() => void reload()} />
      </Page>
    );
  if (boot.settings === null)
    return (
      <Page title={title} back={back}>
        <div className="flex flex-col items-center text-center px-6 py-10 gap-3">
          <Sparkles className="size-8 text-accent" aria-hidden />
          <h2 className="text-base font-semibold">{t('ai.settings.notSetUp.title')}</h2>
          <p className="text-sm text-muted max-w-xs">{t('ai.settings.notSetUp.body')}</p>
          <Button variant="primary" onClick={() => nav('/coaching/ai/setup')}>
            {t('ai.settings.setup')}
          </Button>
        </div>
      </Page>
    );

  return <SettingsBody provider={providerName(boot.availability)} settings={boot.settings} usage={usageLine(boot.usage)} tokens={boot.usage ? boot.usage.inputTokens + boot.usage.outputTokens : null} setSettings={setSettings} back={back} />;
}

function SettingsBody({ provider, settings, usage, tokens, setSettings, back }: { provider: string | undefined; settings: AiSettings; usage: string | null; tokens: number | null; setSettings: (s: AiSettings) => void; back: ReactNode }) {
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const { t } = useT();
  const timeZone = account.settings.timeZone;
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
    const ok = await save({ scopes: next }, 'scopes', t('ai.settings.accessUpdated'));
    if (!ok) setScopes(prev);
  }

  async function changeStyle(next: CoachStyle) {
    if (next === style) return;
    const prev = style;
    setStyle(next);
    const ok = await save({ coachStyle: next }, 'style', t('ai.settings.styleUpdated'));
    if (!ok) setStyle(prev);
  }

  async function clearHistory() {
    setBusy('history');
    try {
      await aiApi.clearHistory();
      await kvSet(AI_HISTORY_CACHE_KEY, [], db).catch(() => undefined);
      toast.show(t('ai.history.cleared'), { tone: 'success' });
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
    <Page title={t('ai.settings.title')} back={back}>
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold flex-1">{t('ai.title')}</h2>
          <Badge tone={state === 'on' ? 'accent' : state === 'paused' ? 'warn' : 'neutral'}>{t(`ai.settings.${state}`)}</Badge>
        </div>
        <p className="text-sm text-muted mt-1">{t(state === 'on' ? 'ai.settings.onDescription' : state === 'paused' ? 'ai.settings.pausedDescription' : 'ai.settings.offDescription')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {state === 'on' && (
            <Button icon={<Pause className="size-4" />} loading={busy === 'state'} onClick={() => void save({ paused: true }, 'state', t('ai.toast.paused'))}>
              {t('ai.pause')}
            </Button>
          )}
          {state === 'paused' && (
            <Button variant="primary" icon={<Play className="size-4" />} loading={busy === 'state'} onClick={() => void save({ paused: false }, 'state', t('ai.toast.resumed'))}>
              {t('ai.resume')}
            </Button>
          )}
          {state !== 'off' && (
            <Button variant="outline" icon={<Power className="size-4" />} onClick={() => setConfirm('off')}>
              {t('ai.turnOff')}
            </Button>
          )}
          {state === 'off' &&
            (settings.consentAt ? (
              <Button variant="primary" icon={<Power className="size-4" />} loading={busy === 'state'} onClick={() => void save({ enabled: true, paused: false }, 'state', t('ai.toast.enabled'))}>
                {t('ai.turnOn')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => nav('/coaching/ai/setup')}>
                {t('ai.settings.setup')}
              </Button>
            ))}
          {state !== 'off' && (
            <Button variant="ghost" icon={<MessageCircle className="size-4" />} onClick={() => nav('/coach')}>
              {t('ai.openChat')}
            </Button>
          )}
        </div>
        {settings.consentAt && (
          <p className="text-xs text-faint mt-3">
            {t('ai.settings.consentDate', { date: dateTimeText(Date.parse(settings.consentAt), timeZone, { day: 'numeric', month: 'long', year: 'numeric' }) })}
          </p>
        )}
      </Card>

      <SectionTitle id="ai-style">{t('ai.style.label')}</SectionTitle>
      <Card className="p-4" aria-labelledby="ai-style">
        <CoachStylePicker value={style} onChange={(n) => void changeStyle(n)} disabled={busy === 'style'} />
        <p className="text-xs text-muted mt-2">{t('ai.settings.styleUsage')}</p>
      </Card>

      <SectionTitle id="ai-scopes">{t('ai.settings.dataHeading')}</SectionTitle>
      <Card className="px-4 py-1" aria-labelledby="ai-scopes">
        <ScopeToggles value={scopes} onChange={(n) => void changeScopes(n)} disabled={busy === 'scopes'} />
      </Card>
      <p className="text-xs text-muted px-1 mt-2">
        {t('ai.settings.revocation')} {t('ai.settings.storedHistory')}
        {settings.scopesChangedAt ? ` ${t('ai.settings.scopesChanged', { dateTime: dateTimeText(Date.parse(settings.scopesChangedAt), timeZone) })}` : ''}
      </p>

      <SectionTitle id="ai-notes">{t('ai.notes.heading')}</SectionTitle>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted">{t('ai.notes.description')}</p>
        <Textarea label={t('ai.notes.label')} value={notes} maxLength={AI_NOTES_MAX} onChange={(e) => setNotes(e.target.value)} hint={`${notes.length} / ${AI_NOTES_MAX}`} />
        <div className="flex gap-2 flex-wrap">
          <Button variant="primary" disabled={!notesDirty} loading={busy === 'notes'} onClick={() => void save({ profileNotes: notes }, 'notes', t('ai.notes.saved'))}>
            {t('ai.notes.save')}
          </Button>
          {notesDirty && (
            <Button variant="ghost" onClick={() => setNotes(settings.profileNotes ?? '')}>
              {t('ai.notes.undo')}
            </Button>
          )}
          <Button variant="danger" icon={<Trash2 className="size-4" />} disabled={!settings.profileNotes} onClick={() => setConfirm('notes')}>
            {t('ai.notes.clear')}
          </Button>
        </div>
      </Card>

      <SectionTitle>{t('ai.usage.heading')}</SectionTitle>
      <Card className="p-4">
        {usage ? (
          <>
            <p className="text-sm">{usage}</p>
            {tokens != null && <p className="text-xs text-muted mt-1">{t('ai.usage.tokens', { count: numberText(tokens, 0, true) })}</p>}
            <p className="text-xs text-muted mt-1">{t('ai.usage.limitReason')}</p>
          </>
        ) : (
          <p className="text-sm text-muted">{t('ai.usage.unavailable')}</p>
        )}
      </Card>

      <SectionTitle>{t('ai.history.title')}</SectionTitle>
      <Card className="p-4">
        <p className="text-sm text-muted">{t('ai.history.clearDescription')}</p>
        <Button className="mt-3" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm('history')}>
          {t('ai.history.clear')}
        </Button>
      </Card>

      <SectionTitle>{t('ai.data.heading')}</SectionTitle>
      <Card className="p-4 space-y-3">
        <DataExplainer provider={provider} />
        <RetentionExplainer provider={provider} />
      </Card>

      {state !== 'off' && (
        <Notice className="mt-4">{t('ai.medicalNotice')}</Notice>
      )}

      <ConfirmDialog
        open={confirm === 'off'}
        title={t('ai.settings.offConfirm.title')}
        confirmLabel={t('ai.turnOff')}
        danger
        busy={busy === 'state'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (await save({ enabled: false }, 'state', t('ai.toast.disabled'))) setConfirm(null);
        }}
        body={t('ai.settings.offConfirm.body')}
      />
      <ConfirmDialog
        open={confirm === 'notes'}
        title={t('ai.notes.clearConfirm.title')}
        confirmLabel={t('ai.notes.clear')}
        danger
        busy={busy === 'clearNotes'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (await save({ profileNotes: '' }, 'clearNotes', t('ai.notes.cleared'))) {
            setNotes('');
            setConfirm(null);
          }
        }}
        body={t('ai.notes.clearConfirm.body')}
      />
      <ConfirmDialog
        open={confirm === 'history'}
        title={t('ai.history.clearConfirm.title')}
        confirmLabel={t('ai.history.clear')}
        danger
        busy={busy === 'history'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void clearHistory()}
        body={t('ai.history.clearConfirm.body')}
      />
    </Page>
  );
}
