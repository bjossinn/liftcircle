import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { CheckCircle2, ChevronLeft, MoreVertical, PlusSquare, Share } from 'lucide-react';
import { Button, Card, IconButton, Notice, Page, SectionTitle } from '@/components/ui';
import { BRAND } from '@/config/brand';
import { BrandMoment } from '@/components/BrandMark';
import { clearInstallPrompt, getInstallPrompt, isStandalone, onInstallChange } from '@/pwa/install';

function platform(): 'ios' | 'android' | 'other' {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

export default function InstallPage() {
  const nav = useNavigate();
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
      title="Install the app"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
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
          <p>{BRAND.name} is installed and running as an app.</p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted mb-4">Add {BRAND.name} to your home screen to open it full-screen with its own icon. It keeps working offline after the first load.</p>
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
              Install {BRAND.name}
            </Button>
          )}

          {(p === 'ios' || p === 'other') && (
            <>
              <SectionTitle>iPhone & iPad</SectionTitle>
              <Card className="p-4">
                {p === 'ios' && !inSafari && <Notice tone="warn" className="mb-3">Open this page in Safari to add it to your home screen.</Notice>}
                <ol className="space-y-3 text-[15px]">
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">1</span>
                    <span>
                      Tap the <Share className="inline size-4 -mt-1" aria-label="Share" /> Share button in Safari’s toolbar.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">2</span>
                    <span>
                      Scroll and choose <PlusSquare className="inline size-4 -mt-1" aria-hidden /> <strong>Add to Home Screen</strong>.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">3</span>
                    <span>
                      If you see <strong>Open as Web App</strong>, keep it switched on, then tap <strong>Add</strong>.
                    </span>
                  </li>
                </ol>
              </Card>
            </>
          )}
          {(p === 'android' || p === 'other') && !canPrompt && (
            <>
              <SectionTitle>Android</SectionTitle>
              <Card className="p-4">
                <ol className="space-y-3 text-[15px]">
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">1</span>
                    <span>
                      In Chrome, tap the <MoreVertical className="inline size-4 -mt-1" aria-label="menu" /> menu.
                    </span>
                  </li>
                  <li className="flex gap-3">
                    <span className="font-semibold text-accent">2</span>
                    <span>
                      Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.
                    </span>
                  </li>
                </ol>
              </Card>
            </>
          )}
          <p className="text-xs text-muted mt-4">Installing also makes it less likely the browser clears your saved data. Background alarms while the phone is locked still depend on the browser.</p>
        </>
      )}
    </Page>
  );
}
