# Verification report: Hard Earned rebrand (v1.0.0, 31 Oct 2026)

Branch `hard-earned`: the visual-refresh work (bjossinn/liftcircle#10) with main merged in (protein preferences,
v0.9.0), then the rebrand. Environment: Windows 11, Node 24, Chromium via Playwright. Everything below was run locally
on this machine; nothing was deployed.

## Commands and results

| Check | Command | Result |
|---|---|---|
| TypeScript (app, tooling, tests) | `npm run typecheck` | ✅ 0 errors |
| Unit and UI tests (Vitest, jsdom; backends and AI provider mocked) | `npx vitest run` | ✅ **1191 / 1191** in 53 files |
| Contrast against the brand kit (part of the above) | `npx vitest run tests/unit/themeContrast.test.ts` | ✅ **367 / 367**: every kit role value, every approved pair in contrast-matrix.json (both themes), the kit's rejected uses, and the app's own text/UI pairs |
| Production build (includes the CSP inline-script hash check) | `npm run build` | ✅ PWA precache 191 entries, ~3.76 MB; new icons in the precache |
| Browser e2e (Playwright, production build + service worker) | `npm run test:e2e` | ⚠️ **26 / 27**. The failure is `units-backup.spec.ts › unit changes preserve the recorded values exactly`, a pre-existing timing race: it fails the same way on main (run twice here on main's code, failing at the same step), at a varying step each run |
| Database / RLS | `npm run test:rls` | ⏳ **not run**: needs PostgreSQL 16 binaries, not installed on this machine. CI runs it on the PR |
| Training assistant database checks | `npm run test:ai-db` | ⏳ **not run**: same reason; CI runs it |
| Old-name scan | `rg -i -o --hidden -g '!.git' -g '!node_modules' -g '!dist' -g '!dev-dist' -g '!test-results' -g '!playwright-report' -g '!brand/hard-earned/**' 'lift[[:space:]_-]*circle' .` | 173 → see docs/BRAND_AUDIT.md for the after count and the full allowlist; 0 user-facing |
| Old-name scan of the build | `rg -i 'lift[[:space:]_-]*circle' dist` | Only the backup format id, the IndexedDB name and the push tag default (all kept identifiers) |

Baseline vs new failures: the only failing check (units-backup e2e) also fails on main. No new failures.

## Flows exercised

- **e2e (automated):**
  - first-run picker → applies the theme live, sets theme-color, Continue → welcome;
  - onboarding;
  - logging a workout offline and online, finishing it, the summary;
  - history and editing;
  - exercises, programs;
  - nutrition;
  - coaching hub with no AI provider;
  - PWA manifest, icons, service worker and offline navigation;
  - storage-health banners;
  - backup export/import.
- **Screenshot run (automated, demo data):**
  - fresh device → picker;
  - welcome/onboarding;
  - empty history;
  - install page;
  - demo → Today;
  - start a workout, log and tick a set;
  - finish → summary;
  - session detail → delete dialog → Keep workout;
  - Progress and a chart;
  - Nutrition, a recipe;
  - Feed, Coaching, Training assistant;
  - Settings → Appearance.
- **Unit/UI:** the picker, Settings appearance, coach cheers popup, AI chat and welcome, push texts, coaching
  directory, outbox labels, meal plan and recipes screens.

## Screenshots

`docs/screenshots/hard-earned/`: 34 PNGs, 390 × 844, in dark and light (`dark-NN-*.png`, `light-NN-*.png`):
1. first-run picker
2. welcome/onboarding
3. empty state (history)
4. install page
5. Today
6. active workout
7. workout summary
8. dialog (delete workout)
9. Progress
10. Progress chart
11. Nutrition
12. recipe
13. Feed
14. Coaching
15. Training assistant (the "not set up" state, since there's no backend locally)
16. Settings
17. Settings → Appearance

Regenerate with `npx vite preview --port 4174` and `node scripts/screenshots.mjs`.

## Responsive, theme and accessibility coverage

- **Theme and colour:**
  - Dark and light were checked in every screenshot.
  - Match my phone follows the browser's colour scheme (unit test and e2e).
  - Saved theme preferences and the stored values (`dark` / `light` / `system`) are unchanged.
- **Accessibility:**
  - Keyboard focus is a 3 px outline 3 px from the control, in the theme's focus colour (global style).
  - Inputs no longer remove their outline.
  - Disabled controls are solid colours.
  - Reduced motion switches off all transitions and the celebration (existing global rule; the celebration also checks it).
  - Tap targets: existing ≥ 44 px kept, and the set ✓ is 48 px. Set rows are ≥ 56 px.
- **Layout:** checked at 390 px (screenshots) and in Playwright's Pixel 7 emulation (e2e). Wider layouts weren't
  re-screenshotted, since layouts didn't change.

## Limits

- **Not tested on a physical iPhone or Android phone:**
  - the installed-app icon, name and status-bar colour;
  - maskable icon cropping;
  - VoiceOver/TalkBack;
  - font rendering on device.

  See the "Hard Earned brand (1.0.0)" section in docs/DEVICE_CHECKS.md. iOS only refreshes a Home Screen icon and name
  when the app is removed and added again.
- **No live AI calls:** the training assistant tests use a mocked provider, so the new prompt wording hasn't been
  seen by a real model.
- **Database not run locally:** the new migration (`20261105000001_hard_earned_brand_text.sql`) hasn't run against a
  real database here. CI's RLS suite applies every migration in order and checks the new push title.
- **Not changed:** external settings (Supabase Auth emails, Netlify site name, GitHub repo name, Supabase project
  name). See the owner tasks in docs/BRAND_AUDIT.md.
