/**
 * A brief, restrained burst for a real new personal record and a finished workout (Hard Earned: subtle and short).
 * Plain canvas, no library (~1 KB). Used sparingly:
 * - at most one burst at a time (a second call while one is running is ignored);
 * - never with prefers-reduced-motion;
 * - callers check Settings → Workout → "Celebrations" (settings.workout.celebrations !== false).
 * Colours come from the current theme's tokens (ember, the text colour, gold). The canvas is aria-hidden and
 * never takes taps; the screen's own text says what happened.
 */
const DURATION_MS = 900;
let running = false;

export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

/** Fire one burst. Returns false when it was skipped (reduced motion, already running, no canvas support). */
export function celebrate(opts: { intensity?: 'small' | 'big' } = {}): boolean {
  if (running || reducedMotion() || typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return false;
  running = true;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.className = 'celebrate-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);

  const css = getComputedStyle(document.documentElement);
  const colors = ['--c-ember', '--c-text', '--c-celebrate'].map((v) => css.getPropertyValue(v).trim() || '#ff694f');
  const count = opts.intensity === 'big' ? 36 : 20;
  const originY = h * 0.35;
  const parts = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.7;
    const speed = 4 + Math.random() * 4;
    return {
      x: w / 2 + (Math.random() - 0.5) * 40,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 4 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
      round: i % 3 === 0,
    };
  });

  const start = performance.now();
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - DURATION_MS * 0.6) / (DURATION_MS * 0.4));
    for (const p of parts) {
      p.vy += 0.28;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < DURATION_MS) requestAnimationFrame(frame);
    else {
      canvas.remove();
      running = false;
    }
  };
  requestAnimationFrame(frame);
  return true;
}

/** Celebrate a moment only once per browser tab, e.g. a finished workout's summary (reloads don't replay it). */
export function celebrateOnce(key: string, opts?: { intensity?: 'small' | 'big' }): boolean {
  try {
    const k = `lc-celebrated:${key}`;
    if (sessionStorage.getItem(k)) return false;
    sessionStorage.setItem(k, '1');
  } catch {
    /* no storage: still celebrate */
  }
  return celebrate(opts);
}
