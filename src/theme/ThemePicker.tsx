/**
 * First launch: "Pick your look", shown full-screen before the welcome (src/app/Shell.tsx decides when, via
 * shouldShowThemePicker). Tapping a card applies that theme to the whole screen at once (cross-fade, none with
 * reduced motion). Continue saves the choice: on this device always, and in the account's synced settings when it
 * is safe. A signed-in device that hasn't received its account yet keeps the choice locally only, because writing a
 * fresh account record there could overwrite the real one on the server. Works offline: nothing here uses the network.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { useApp } from '@/state/app';
import { ACCOUNT_ROW_ID } from '@/db/db';
import { BRAND } from '@/config/brand';
import { ThemeOptions } from './ThemeOptions';
import { applyTheme, markThemePicked, resolveTheme, setDeviceThemeChoice, systemPrefersLight, watchSystemTheme, type ThemeChoice } from './theme';

export function ThemePicker({ onDone }: { onDone: () => void }) {
  const { db, auth, updateAccount } = useApp();
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [systemTheme, setSystemTheme] = useState(() => (systemPrefersLight() ? 'light' : 'dark') as 'light' | 'dark');
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), []);
  // Keep "Match my phone" live while the picker is open.
  useEffect(
    () =>
      watchSystemTheme(() => {
        const t = systemPrefersLight() ? 'light' : 'dark';
        setSystemTheme(t);
        if (choice === 'system') applyTheme(t, { fade: true });
      }),
    [choice],
  );

  const pick = (t: ThemeChoice) => {
    setChoice(t);
    applyTheme(resolveTheme(t), { fade: true });
  };

  async function finish() {
    setBusy(true);
    setDeviceThemeChoice(choice);
    markThemePicked();
    try {
      const row = await db.account.get(ACCOUNT_ROW_ID);
      if (row || auth.status === 'guest') await updateAccount((a) => ({ ...a, settings: { ...a.settings, theme: choice } }));
    } catch {
      // The device keeps the choice either way; the account picks it up the next time settings are saved.
    }
    onDone();
  }

  return (
    <div className="min-h-dvh flex flex-col pt-safe pb-safe pl-safe pr-safe bg-bg">
      <main className="flex-1 mx-auto w-full max-w-lg px-4 py-6 flex flex-col gap-5">
        <div className="text-center space-y-1.5 pt-2">
          <p className="text-sm font-semibold text-accent">Welcome to {BRAND.name}</p>
          <h1 ref={heading} tabIndex={-1} id="pick-look-title" className="no-focus-ring text-3xl font-extrabold tracking-tight">
            Pick your look
          </h1>
          <p className="text-[15px] text-muted">Tap one to try it. You’ll see it right away.</p>
        </div>
        <ThemeOptions layout="cards" labelledBy="pick-look-title" value={choice} onChange={pick} systemLabel="Match my phone" systemTheme={systemTheme} />
        <div className="mt-auto space-y-3 pt-2">
          <Button variant="primary" size="lg" block loading={busy} onClick={() => void finish()}>
            Continue
          </Button>
          <p className="text-xs text-muted text-center">You can change this anytime in Settings → Appearance.</p>
        </div>
      </main>
    </div>
  );
}
