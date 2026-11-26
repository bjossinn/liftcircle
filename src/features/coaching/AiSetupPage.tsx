/**
 * /coaching/ai/setup — single-step training assistant consent (roadmap item 7; was a 4-step wizard). The same screen
 * the Coach tab shows the first time (ai/AiConsent.tsx): what it sees and does, Supportive tone by default, and one
 * button that turns it on and opens the Coach. Details, notes, data access and tone are edited later in settings.
 */
import { useNavigate } from 'react-router';
import { Button, Notice, Page, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { AiAvailability } from '@/backend/coachingContract';
import { isHardUnavailable, settingsActive } from './ai/model';
import { useAiBoot } from './ai/useAi';
import { AiGuest, AiUnavailable, BackButton } from './ai/parts';
import { AiConsent } from './ai/AiConsent';
import { useT } from '@/i18n';

export default function AiSetupPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { boot, reload, setSettings } = useAiBoot();
  const { t } = useT();
  const back = <BackButton />;
  const title = t('ai.title');

  if (boot.phase === 'loading')
    return (
      <Page title={title} back={back}>
        <Spinner label={t('ai.loading')} />
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

  const alreadyOn = !!boot.settings && settingsActive(boot.settings, a);
  return (
    <Page title={title} back={back}>
      {alreadyOn && (
        <Notice tone="accent" className="flex items-center gap-3 mb-1">
          <span className="flex-1">{t('ai.setup.alreadyOn')}</span>
          <Button size="sm" variant="primary" onClick={() => nav('/coach')}>
            {t('ai.setup.openCoach')}
          </Button>
        </Notice>
      )}
      <div className="-mx-3">
        <AiConsent
          availability={a}
          settings={boot.settings}
          onEnabled={(saved) => {
            setSettings(saved);
            toast.show(t('ai.setup.enabled'), { tone: 'success' });
            nav('/coach', { replace: true });
          }}
        />
      </div>
    </Page>
  );
}
