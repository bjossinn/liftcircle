/**
 * Single-step training assistant consent (roadmap item 7; replaces the 4-step setup wizard). Shown in the Coach tab the
 * first time it's opened (and after an AI provider change), and on /coaching/ai/setup. One screen says what the
 * assistant sees and does, that the tone is Supportive by default (changeable later in settings), and one primary
 * button turns it on: aiApi.saveSettings({ enabled, scopes, coachStyle, acceptConsent, provider }).
 *
 * Profile and training are shared by default (DEFAULT_SCOPES); measurements and nutrition stay off unless switched on
 * here or later. Notes, details and tone are all editable afterwards in training assistant settings.
 */
import { useState } from 'react';
import { Check, ChevronRight, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { Button, Card, Notice } from '@/components/ui';
import { aiApi } from '@/backend/ai';
import type { AiAvailability, AiScopes, AiSettings } from '@/backend/coachingContract';
import { useT, type MessageKey } from '@/i18n';
import { classifyAiError, COACH_STYLE_INFO, consentOutdated, DEFAULT_COACH_STYLE, DEFAULT_SCOPES, providerLabel, SCOPE_INFO, scopeListText } from './model';
import { ScopeToggles } from './parts';

export interface AiConsentProps {
  availability: AiAvailability;
  /** null = never set up; a value = agreed before (e.g. for another provider) — its tone and scopes are kept. */
  settings: AiSettings | null | undefined;
  onEnabled: (saved: AiSettings) => void;
}

const DOES: MessageKey[] = ['aiConsent.answers', 'aiConsent.adjustments', 'aiConsent.targets', 'aiConsent.reviewFirst'];

export function AiConsent({ availability, settings, onEnabled }: AiConsentProps) {
  const { t } = useT();
  const [scopes, setScopes] = useState<AiScopes>(settings?.scopes ?? DEFAULT_SCOPES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const reconsent = consentOutdated(settings, availability);
  const provider = providerLabel(availability);
  const providerId = availability.available ? availability.provider : undefined;
  const providerDown = !availability.available && availability.reason === 'provider_down';
  // The user's own earlier choice is kept; everyone else starts Supportive.
  const style = settings?.coachStyle ?? DEFAULT_COACH_STYLE;
  const styleInfo = COACH_STYLE_INFO.find((s) => s.key === style)!;
  const shared = SCOPE_INFO.filter((s) => scopes[s.key]);
  const notShared = SCOPE_INFO.filter((s) => !scopes[s.key]);

  async function enable() {
    setSaving(true);
    setError(null);
    try {
      const saved = await aiApi.saveSettings({ enabled: true, paused: false, scopes, coachStyle: style, acceptConsent: true, provider: providerId });
      onEnabled(saved);
    } catch (e) {
      setError(classifyAiError(e).key);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="ai-consent-title" className="space-y-3 px-3 py-4">
      {reconsent && (
        <Notice tone="warn">{t('aiConsent.providerChanged', { provider })}</Notice>
      )}
      {providerDown && <Notice tone="warn">{t('aiConsent.providerDown')}</Notice>}
      <div className="flex items-center gap-3">
        <div className="size-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
          <Sparkles className="size-6" aria-hidden />
        </div>
        <div>
          <h2 id="ai-consent-title" className="text-lg font-semibold">
            {t('aiConsent.title')}
          </h2>
          <p className="text-sm text-muted">{t('aiConsent.subtitle')}</p>
        </div>
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-2">{t('aiConsent.whatItDoes')}</h3>
        <ul className="space-y-1.5 text-sm">
          {DOES.map((k) => (
            <li key={k} className="flex gap-2 items-start">
              <Check className="size-4 mt-0.5 text-accent shrink-0" aria-hidden />
              <span>{t(k)}</span>
            </li>
          ))}
          <li className="flex gap-2 items-start">
            <XCircle className="size-4 mt-0.5 text-muted shrink-0" aria-hidden />
            <span>{t('aiConsent.safety')}</span>
          </li>
        </ul>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-1">{t('aiConsent.whatItSees')}</h3>
        {/* No categories: one sentence (not "Only your messages, plus your messages…"). */}
        <p className="text-sm">{shared.length ? t('aiConsent.shared', { categories: scopeListText(shared.map((s) => s.key)) }) : t('aiConsent.sharedNone')}</p>
        {notShared.length > 0 && <p className="text-xs text-muted mt-1">{t('aiConsent.notShared', { categories: scopeListText(notShared.map((s) => s.key), true) })}</p>}
        <details className="mt-2 group">
          <summary className="cursor-pointer select-none text-sm font-medium text-accent min-h-11 inline-flex items-center gap-1">
            {t('aiConsent.changeAccess')} <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <div className="pt-1">
            <ScopeToggles value={scopes} onChange={setScopes} disabled={saving} />
          </div>
        </details>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-1">{t(style === DEFAULT_COACH_STYLE ? 'aiConsent.defaultTone' : 'aiConsent.tone', { style: styleInfo.title })}</h3>
        <p className="text-sm text-muted">
          {styleInfo.body} {t('aiConsent.tired')}
        </p>
        <p className="text-xs text-muted mt-1">{t('aiConsent.changeTone')}</p>
      </Card>

      <p className="text-xs text-muted flex gap-2 items-start">
        <ShieldCheck className="size-4 shrink-0 text-accent" aria-hidden />
        <span>{t('aiConsent.acceptance', { provider })}</span>
      </p>
      {error && (
        <Notice tone="danger">
          <span role="alert">{t(error)}</span>
        </Notice>
      )}
      <Button variant="primary" size="lg" block loading={saving} onClick={() => void enable()}>
        {reconsent ? t('aiConsent.agree') : t('aiConsent.enable')}
      </Button>
      <p className="text-xs text-muted text-center">{t('aiConsent.control')}</p>
    </section>
  );
}
