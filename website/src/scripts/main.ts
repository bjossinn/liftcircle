/**
 * All site behaviour in one small module: scroll reveals, gentle parallax, the hero "log a set" demo,
 * protein chips and install tabs. Everything degrades to a complete static page without JS, and motion
 * stops entirely with prefers-reduced-motion.
 */
const root = document.documentElement;
root.classList.replace('no-js', 'js');
if (!CSS.supports('selector(:has(*))')) root.classList.add('no-has');

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/* Header border once the page scrolls. */
const header = document.querySelector<HTMLElement>('.site-header');
const onScrollHeader = () => header?.classList.toggle('scrolled', scrollY > 8);

/* Scroll reveals, staggered by data-i. */
const revealIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      revealIO.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -10% 0px' },
);
document.querySelectorAll<HTMLElement>('[data-reveal]').forEach((el) => {
  el.style.setProperty('--i', el.dataset.i ?? '0');
  revealIO.observe(el);
});

/* Parallax: translate a few elements by a fraction of their distance from the viewport centre. */
const parallaxEls = [...document.querySelectorAll<HTMLElement>('[data-parallax]')];
let ticking = false;
function parallax() {
  ticking = false;
  // Phones get no parallax: there is no spare room around the frames for them to drift into.
  if (reduced.matches || innerWidth < 640) {
    for (const el of parallaxEls) el.style.translate = '';
    return;
  }
  const mid = innerHeight / 2;
  for (const el of parallaxEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom < -200 || r.top > innerHeight + 200) continue;
    const f = Number(el.dataset.parallax) || 0;
    el.style.translate = `0 ${((r.top + r.height / 2 - mid) * f).toFixed(1)}px`;
  }
}
addEventListener(
  'scroll',
  () => {
    onScrollHeader();
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(parallax);
    }
  },
  { passive: true },
);
onScrollHeader();
parallax();

/* Hero demo: weight and reps tick in, the tick pops, the rest ring counts down (sped up), repeat. */
const demo = document.getElementById('demo');
if (demo) {
  const row = demo.querySelector<HTMLElement>('[data-demo-row]')!;
  const kg = demo.querySelector<HTMLElement>('[data-demo-kg]')!;
  const reps = demo.querySelector<HTMLElement>('[data-demo-reps]')!;
  const ring = demo.querySelector<SVGCircleElement>('[data-demo-ring]')!;
  const time = demo.querySelector<HTMLElement>('[data-demo-time]')!;
  const toggle = demo.querySelector<HTMLButtonElement>('[data-demo-toggle]')!;
  const C = 150.8; // ring circumference (r = 24)
  const REST = 150; // seconds shown
  const SPEED = 25; // demo runs this many times faster than real time

  let playing = !reduced.matches;
  let visible = true;
  let raf = 0;
  let t0 = 0;
  let paused = 0; // elapsed ms when paused

  // Timeline in ms.
  const T_KG = 900, T_REPS = 1500, T_TICK = 1900, T_REST_END = T_TICK + (REST * 1000) / SPEED, T_END = T_REST_END + 1400;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const ease = (x: number) => 1 - Math.pow(1 - x, 3);

  function render(ms: number) {
    const typingKg = ms < T_KG;
    const typingReps = ms >= T_KG && ms < T_REPS;
    kg.textContent = ms < 150 ? '' : typingKg ? (Math.round(ease(ms / T_KG) * 41) * 2.5).toFixed(1).replace('.', ',').replace(',0', '') : '102,5';
    reps.textContent = ms < T_KG + 100 ? '' : typingReps ? String(Math.max(1, Math.round(ease((ms - T_KG) / (T_REPS - T_KG)) * 8))) : '8';
    kg.classList.toggle('typing', typingKg);
    reps.classList.toggle('typing', typingReps);
    const done = ms >= T_TICK;
    if (done && !row.classList.contains('done')) {
      row.classList.add('done', 'pop');
      setTimeout(() => row.classList.remove('pop'), 400);
    } else if (!done) row.classList.remove('done');
    const restMs = Math.min(Math.max(ms - T_TICK, 0), T_REST_END - T_TICK);
    const left = done ? REST - (restMs * SPEED) / 1000 : REST;
    time.textContent = fmt(Math.max(0, Math.ceil(left)));
    ring.style.strokeDashoffset = String(C * (1 - left / REST));
  }

  function frame(now: number) {
    const ms = (now - t0) % T_END;
    render(ms);
    paused = ms;
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (!playing || !visible || raf) return;
    t0 = performance.now() - paused;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  function setPlaying(p: boolean) {
    playing = p;
    toggle.textContent = p ? toggle.dataset.labelPause! : toggle.dataset.labelPlay!;
    toggle.setAttribute('aria-pressed', String(!p));
    document.body.classList.toggle('paused', !p); // also pauses the ticker
    p ? start() : stop();
  }

  toggle.hidden = false;
  toggle.addEventListener('click', () => setPlaying(!playing));
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    visible ? start() : stop();
  }).observe(demo);
  reduced.addEventListener('change', () => setPlaying(!reduced.matches));
  setPlaying(playing);
  if (!playing) render(T_TICK); // static final state: set done, timer full
}

/* Protein chips: none → like → not for me → none, as in the app. */
const chipList = document.querySelector<HTMLElement>('[data-chip-states]');
if (chipList) {
  const labels = JSON.parse(chipList.dataset.chipStates!) as Record<string, string>;
  const order = ['none', 'like', 'no'];
  chipList.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.chip');
    if (!b) return;
    const next = order[(order.indexOf(b.dataset.state!) + 1) % order.length];
    b.dataset.state = next;
    b.setAttribute('aria-label', `${b.dataset.name}: ${labels[next]}`);
  });
}

/* Install tabs (ARIA tabs pattern with arrow keys). Without JS all panels show. */
document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((wrap) => {
  const tabs = [...wrap.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')!)!);
  const select = (i: number, focus = false) => {
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', String(i === j));
      t.tabIndex = i === j ? 0 : -1;
      panels[j].hidden = i !== j;
    });
    if (focus) tabs[i].focus();
  };
  // Start on the visitor's platform when it is obvious.
  const ua = navigator.userAgent;
  select(/iPhone|iPad|Macintosh.*Mobile/.test(ua) ? 0 : /Android/.test(ua) ? 1 : /Mobi/.test(ua) ? 0 : 2);
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(i));
    t.addEventListener('keydown', (e) => {
      const k = e.key;
      const n = k === 'ArrowRight' ? i + 1 : k === 'ArrowLeft' ? i - 1 : k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : null;
      if (n === null) return;
      e.preventDefault();
      select((n + tabs.length) % tabs.length, true);
    });
  });
});
