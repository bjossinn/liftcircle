/** Sound, vibration and screen wake lock — all capability-detected and best-effort. */
let ctx: AudioContext | null = null;

/** Must be called from a user gesture once so iOS allows later beeps. */
export function primeAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* unsupported */
  }
}

export function beep(times = 2) {
  try {
    if (!ctx) primeAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.3);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.3 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.3 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + i * 0.3);
      o.stop(t0 + i * 0.3 + 0.25);
    }
  } catch {
    /* ignore */
  }
}

export function vibrate(pattern: number | number[] = [200, 100, 200]) {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

export const wakeLockSupported = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator;

/** Keep the screen on while mounted; re-acquire after the page becomes visible again. */
export function holdWakeLock(): () => void {
  if (!wakeLockSupported()) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let released = false;
  const acquire = async () => {
    try {
      if (document.visibilityState === 'visible' && !released) sentinel = await navigator.wakeLock.request('screen');
    } catch {
      /* denied (battery saver etc.) */
    }
  };
  const onVis = () => void acquire();
  void acquire();
  document.addEventListener('visibilitychange', onVis);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVis);
    void sentinel?.release().catch(() => {});
  };
}
