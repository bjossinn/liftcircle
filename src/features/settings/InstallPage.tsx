import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CheckCircle2, ChevronLeft, MoreVertical, PlusSquare, Share } from 'lucide-react';
import { Button, Card, IconButton, Notice, Page, SectionTitle } from '@/components/ui';
import { BRAND } from '@/config/brand';
import { BrandMoment } from '@/components/BrandMark';
import { clearInstallPrompt, getInstallPrompt, isStandalone, onInstallChange } from '@/pwa/install';
import { useT, type MessageKey } from '@/i18n';

function platform(): 'ios' | 'android' | 'other' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

/** A translated sentence with inline elements (icons, bold UI labels) in place of its {{placeholders}}. */
function Rich({ k, parts }: { k: MessageKey; parts: Record<string, ReactNode> }) {
  const { t } = useT();
  const text = t(k, Object.fromEntries(Object.keys(parts).map((name) => [name, `{{${name}}}`])));
  return (
    <>
      {text.split(/\{\{(\w+)\}\}/).map((chunk, i) => (
        <Fragment key={i}>{i % 2 ? parts[chunk] : chunk}</Fragment>
      ))}
    </>
  );
}

export default function InstallPage() {
  const nav = useNavigate();
  const { t } = useT();
  const [canPrompt, setCanPrompt] = useState(!!getInstallPrompt());
  const [installed, setInstalled] = useState(isStandalone());
  useEffect(
    () =>
      onInstallChange(() => {
        setCanPrompt(!!getInstallPrompt());
        if (!getInstallPrompt()) setInstalled(isStandalone());
      }),
    [],
  );
  const p = platform();
  const inSafari = p === 'ios' && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

  return (
    <Page
      title={t('settings.installPage.install_the_app')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <div className="mb-4">
        <BrandMoment size={64} />
      </div>
      {installed ? (
        <Card className="p-5 flex items-center gap-3">
          <CheckCircle2 className="size-6 text-accent" aria-hidden />
          <p>{t('settings.installPage.installed', { app: BRAND.name })}</p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted mb-4">{t('settings.installPage.intro', { app: BRAND.name })}</p>
          {canPrompt && (
            <Button
              variant="primary"
              size="lg"
              block
              onClick={async () => {
                const deferred = getInstallPrompt();
                if (!deferred) return;
                await deferred.prompt();
                const r = await deferred.userChoice;
                clearInstallPrompt();
                setCanPrompt(false);
                if (r.outcome === 'accepted') setInstalled(true);
              }}
            >
              {t('settings.installPage.install_named', { app: BRAND.name })}
            </Button>
          )}

          {(p === 'ios' || p === 'other') && (
            <>
              <SectionTitle>{t('settings.installPage.iphone_ipad')}</SectionTitle>
              <Card className="p-4">
                {p === 'ios' && !inSafari && <Notice tone="warn" className="mb-3">{t('settings.installPage.open_this_page_in_safari_to')}</Notice>}
                <ol className="space-y-3 text-[15px]">
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">1</span>
                    <span>
                      <Rich k="settings.installPage.ios_step1" parts={{ icon: <Share className="inline size-4 -mt-1" aria-label={t('workout.share.share')} /> }} />
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">2</span>
                    <span>
                      <Rich
                        k="settings.installPage.ios_step2"
                        parts={{ icon: <PlusSquare className="inline size-4 -mt-1" aria-hidden />, option: <strong>{t('settings.installPage.add_to_home_screen_2')}</strong> }}
                      />
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">3</span>
                    <span>
                      <Rich
                        k="settings.installPage.ios_step3"
                        parts={{ toggle: <strong>{t('settings.installPage.open_as_web_app')}</strong>, add: <strong>{t('foodLog.add')}</strong> }}
                      />
                    </span>
                  </li>
                </ol>
              </Card>
            </>
          )}
          {(p === 'android' || p === 'other') && !canPrompt && (
            <>
              <SectionTitle>{t('settings.installPage.android')}</SectionTitle>
              <Card className="p-4">
                <ol className="space-y-3 text-[15px]">
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">1</span>
                    <span>
                      <Rich k="settings.installPage.android_step1" parts={{ icon: <MoreVertical className="inline size-4 -mt-1" aria-label={t('settings.installPage.menu_icon')} /> }} />
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">2</span>
                    <span>
                      <Rich
                        k="settings.installPage.android_step2"
                        parts={{ install: <strong>{t('settings.installPage.install_app')}</strong>, add: <strong>{t('settings.installPage.add_to_home_screen')}</strong> }}
                      />
                    </span>
                  </li>
                </ol>
              </Card>
            </>
          )}
          <p className="text-xs text-muted mt-4">{t('settings.installPage.installing_also_makes_it_less_likely')}</p>
        </>
      )}
    </Page>
  );
}
