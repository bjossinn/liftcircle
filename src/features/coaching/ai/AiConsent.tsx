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
import { classifyAiError, COACH_STYLE_INFO, consentOutdated, DEFAULT_COACH_STYLE, DEFAULT_SCOPES, providerLabel, SCOPE_INFO } from './model';
import { ScopeToggles } from './parts';

export interface AiConsentProps {
  availability: AiAvailability;
  /** null = never set up; a value = agreed before (e.g. for another provider) — its tone and scopes are kept. */
  settings: AiSettings | null | undefined;
  onEnabled: (saved: AiSettings) => void;
}

export function AiConsent({ availability, settings, onEnabled }: AiConsentProps) {
  const [scopes, setScopes] = useState<AiScopes>(settings?.scopes ?? DEFAULT_SCOPES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError(classifyAiError(e).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="ai-consent-title" className="space-y-3 px-3 py-4">
      {reconsent && (
        <Notice tone="warn">
          The training assistant now uses {provider} instead of the provider you agreed to before. Nothing has been sent to {provider} yet. Check what it sees and agree again to keep using it.
        </Notice>
      )}
      {providerDown && <Notice tone="warn">The AI service isn’t responding right now. You can still turn it on; chatting will work once it’s back.</Notice>}
      <div className="flex items-center gap-3">
        <div className="size-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center shrink-0">
          <Sparkles className="size-6" aria-hidden />
        </div>
        <div>
          <h2 id="ai-consent-title" className="text-lg font-semibold">
            Your training assistant
          </h2>
          <p className="text-sm text-muted">Knows your plan and workouts, and helps in the moment.</p>
        </div>
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-2">What it does</h3>
        <ul className="space-y-1.5 text-sm">
          {[
            'Answers questions about your training and progress',
            'Mid-workout: shortens today’s workout when you’re short on time, or swaps an exercise when the equipment is busy',
            'Explains your next weights and targets',
            'Suggests plan and schedule changes. Nothing changes until you tap Apply',
          ].map((t) => (
            <li key={t} className="flex gap-2 items-start">
              <Check className="size-4 mt-0.5 text-accent shrink-0" aria-hidden />
              <span>{t}</span>
            </li>
          ))}
          <li className="flex gap-2 items-start">
            <XCircle className="size-4 mt-0.5 text-muted shrink-0" aria-hidden />
            <span>
              No medical advice or diagnoses. It never changes your plan on its own or reads messages with a human coach.
            </span>
          </li>
        </ul>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-1">What it sees</h3>
        <p className="text-sm">{shared.length ? shared.map((s) => s.title).join(' and ') : 'Only your messages'}, plus your messages and training assistant notes.</p>
        {notShared.length > 0 && <p className="text-xs text-muted mt-1">Not shared: {notShared.map((s) => s.title.toLowerCase()).join(', ')}.</p>}
        <details className="mt-2 group">
          <summary className="cursor-pointer select-none text-sm font-medium text-accent min-h-11 inline-flex items-center gap-1">
            Change what it can see <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <div className="pt-1">
            <ScopeToggles value={scopes} onChange={setScopes} disabled={saving} />
          </div>
        </details>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-1">Tone: {styleInfo.title}{style === DEFAULT_COACH_STYLE ? ' (default)' : ''}</h3>
        <p className="text-sm text-muted">{styleInfo.body} Feeling tired is always a good reason to go lighter or rest.</p>
        <p className="text-xs text-muted mt-1">You can switch to Balanced or Strict any time in training assistant settings.</p>
      </Card>

      <p className="text-xs text-muted flex gap-2 items-start">
        <ShieldCheck className="size-4 shrink-0 text-accent" aria-hidden />
        <span>
          By turning it on, you agree that what it sees is sent from the server to {provider} only when you ask something, to write a reply. Replies are AI suggestions and general
          fitness guidance, not medical advice.
        </span>
      </p>
      {error && (
        <Notice tone="danger">
          <span role="alert">{error}</span>
        </Notice>
      )}
      <Button variant="primary" size="lg" block loading={saving} onClick={() => void enable()}>
        {reconsent ? 'Agree and continue' : 'Turn on training assistant'}
      </Button>
      <p className="text-xs text-muted text-center">You can change what it sees, pause it or turn it off at any time in training assistant settings.</p>
    </section>
  );
}
