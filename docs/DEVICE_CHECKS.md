# Device checks, offline/PWA behaviour and security headers

Status labels: **passed** = automated check passed in the build environment; **blocked** = needs a physical
device or the deployed site, so it hasn't been run. Everything in §1 is **blocked** until someone runs it on real hardware.

## 1. Physical-device checklist (blocked: needs real phones)

Run on **iPhone (iOS 17+ Safari)** and **Android (Chrome 120+)** against the deployed HTTPS site. Before you start,
use a fresh profile or clear the site's data. Tick each item, and write down the device, OS and app version.

### Install
1. Open the site in Safari (iOS) / Chrome (Android). Wait for the "Ready to work offline" toast. It must appear only once, on the first visit.
2. Android: open Settings → Install app, and accept the browser prompt. iOS: Share → Add to Home Screen (the Install page shows these steps).
3. Launch from the home-screen icon. Check that it opens **standalone** (no browser address bar) and that the icon, the name "LiftCircle" and the dark splash/background colour are correct.
4. Check the status bar and notch area: the top content isn't hidden under the notch or Dynamic Island. The tab bar and Resume bar sit above the home indicator, with no overlap.
5. Open a deep link (for example `/train/exercises`) from another app, such as Notes. It should open the right screen.

### Offline
6. Use the app online once: visit Today, Train, Progress and Nutrition. Then turn on **Airplane mode** and force-quit the app.
7. Reopen it from the icon while offline. The app loads, and the "Offline — workouts still save on this device" strip is visible.
8. While offline: start a workout, log 3 sets, start the rest timer, switch to another app for 2 minutes, then come back.
   - The rest timer shows the correct remaining or elapsed time (it is calculated from timestamps).
   - The entered sets are still there.
9. Force-quit during the workout and reopen. The workout, its sets and the timer are restored, and the Resume bar works.
10. Finish the workout offline. The summary screen opens.
11. Turn Airplane mode off. If you're signed in, the change uploads with no "edited on two devices" prompt, and the workout appears on a second device.

### Background, resume and the keyboard
12. Lock the phone for 5+ minutes during a rest timer. On unlock, the timer is correct and the end-of-rest sound/vibration either played or is reported as missed. Note the iOS limits.
13. Tap a weight or reps field. You get the **decimal keypad**, with a comma on locales that use one, and the page does **not** zoom in.
14. With the keyboard open, check that the focused field and the sheet's buttons stay visible:
    - "Add exercise" search
    - Rename-workout sheet
    - Food-log quick-add sheet
    - Any ConfirmDialog
15. Rotate to landscape (the app is portrait-first). Nothing should become unusable.

### Updates
16. Deploy a new version while the installed app is open on **Today**. Within an hour, or after reopening, the banner "Update available" shows with **Update**. Tap it: the app reloads into the new version.
17. Deploy again while a **workout is active**. The banner says "You can install it after you finish your workout", with no Update button and no reload.
    - Finish the workout. The Update button then appears.
18. With two tabs or windows (desktop/Android), tap Update in one while the other has an active workout. The second tab shows "It will reload when you finish this workout" and reloads only after Finish.

### Storage and private mode
19. iOS Safari **private** tab and Firefox **private** window:
    - The app either works, or shows "This browser isn't letting LiftCircle save on this device".
    - It must never get stuck on an endless "Loading…".
20. Android: Settings → Apps → Chrome → Storage → clear the site's data while the app is closed. On reopen, a guest starts empty and a signed-in user's data comes back from sync after signing in.
21. As a guest with at least one finished workout, the notice "Your workouts are only on this device…" may appear on browsers that don't grant persistent storage. "Back up or protect your data" opens Settings → Data, and dismissing the notice is remembered.

### Accessibility on device
22. VoiceOver (iOS) and TalkBack (Android):
    - The tab names are read, plus "N unread" on Coaching.
    - Sheets are announced by their title.
    - Set buttons are read as "Mark set 1 done".
    - The rest timer is announced.
23. System "Reduce motion" on: no animations. Largest text size: the tab labels and the logger remain usable.

## 2. What's automated (passed in this environment)

The checks below run on a production build with the service worker, Chromium, and Pixel 7 emulation (360–1280 px for the layout checks):

| Area | Where |
|---|---|
| Precache: every build asset is cached before "Ready to work offline"; no foreign or Supabase URLs in caches | `tests/e2e/pwa.spec.ts` |
| SW has only precache plus a navigation fallback; no runtime routes; Supabase `/auth|rest|storage|functions/v1` are deny-listed | `tests/e2e/pwa.spec.ts` |
| Offline navigation after the first load | `tests/e2e/pwa.spec.ts` |
| Offline log / reload / reopen / finish; rest timer recalculated from the stored deadline | `tests/e2e/logging.spec.ts`, `tests/unit/sessionOps.test.ts` |
| SW registration failure shown, and the tracker still works | `tests/e2e/pwa.spec.ts`, `tests/unit/pwaUpdate.test.ts` |
| IndexedDB blocked or missing → clear alert, navigation still works | `tests/e2e/pwa.spec.ts`, `tests/unit/pwaHealth.test.ts` |
| Quota errors recognised (also wrapped by `saveRecord`) | `tests/unit/pwaHealth.test.ts` |
| Update waits during an active workout; a cross-tab activation reloads only after Finish | `tests/unit/pwaUpdate.test.ts` |
| Expired session / offline: logging continues; one coalesced op per record; tombstones queued; another account never flushes them | `tests/unit/pwaOffline.test.ts`, `tests/unit/sync.test.ts` |
| Conflicts, lost responses, tombstones, account isolation | `tests/unit/sync.test.ts` |
| Dexie v1 → current upgrade keeps an active workout and queued ops; no table dropped; older code opens a newer DB | `tests/unit/pwaDexieUpgrade.test.ts` |
| No horizontal overflow on 10 key routes at 360/375/390/430/768/1280 px; six tabs ≥ 44 px and unclipped | `tests/e2e/mobile.spec.ts` |
| Numeric inputs use the decimal/numeric keypad with ≥ 16 px font; long exercise names wrap; sheets named, Esc closes and returns focus; shared controls have ≥ 44 px hit areas; reduced motion; skip link | `tests/e2e/mobile.spec.ts` |

Keyboard overlap is handled in code but needs a device to confirm (§1 item 14). `Sheet` follows `visualViewport`, lifting itself above the on-screen keyboard and keeping the focused field in view.

## 3. Security headers (`public/_headers`)

These headers take effect on the next Netlify deploy. Netlify Drop also reads `_headers` from `dist/`.

- `Content-Security-Policy`:

  ```
  default-src 'self'
  script-src 'self' 'sha256-…'                          ← inline theme script in index.html
  style-src 'self'
  img-src 'self' blob: data: https://haryomdlsgrgrnsbdxui.supabase.co
  connect-src 'self' https://haryomdlsgrgrnsbdxui.supabase.co
  font-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'
  object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  ```

  - No `unsafe-eval`: zod probes `new Function` and falls back. That probe is reported as one harmless violation.
  - No `unsafe-inline`.
  - No Google Fonts: the app uses system fonts.
  - No websocket: realtime channels aren't used. If you add them, also add `wss://haryomdlsgrgrnsbdxui.supabase.co`.
  - **If you change the inline script in `index.html`, the build fails with the new hash to paste.** The check is `cspInlineScriptCheck` in `vite.config.ts`.
  - **If the Supabase project changes**, replace the origin in `img-src` and `connect-src`.
- The file also sets `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin` (sign-in uses redirects, not popups), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` and `Permissions-Policy` (camera/geolocation self, no microphone).
- **How it was verified:** the production build was served with exactly these headers by a small static server, in Connected mode, with the Supabase origin mocked. Both guest and signed-in sessions visited 16 routes and started a workout. The results:
  - There were 0 unexpected violations.
  - Storage signed-URL images, blob: and data: images, and Edge Function calls (including the AI coach) loaded.
  - The service worker registered.
  - Requests to other origins and `eval` were blocked.
- **Still to do after deploying:** check the live site's response headers and open sign-in, a photo post, coach photos and the AI chat with DevTools open. Any `Refused to …` console message is a CSP gap.

## 4. Performance (production build; 4× CPU throttling, Pixel 7 emulation, median of 5 cold loads)

| | before | after |
|---|---|---|
| Startup chunk `index-*.js` | 900 KB raw / 267 KB gzip | 114 KB raw / 38 KB gzip + vendor chunks: react 316/101, backend (supabase-js) 224/59, dexie 101/33 KB |
| First-load JS+CSS for `/` | ≈ 1 040 KB raw / 312 KB gzip / 269 KB brotli | same (the code is needed; it's split, not removed) |
| FCP / first heading `/` | ≈ 415 / 645–680 ms | ≈ 440 / 720–730 ms (within run-to-run noise) |
| Main-thread script time | ≈ 410 ms, 2 long tasks (≈ 260 ms) | ≈ 400 ms, 2 long tasks (≈ 250–280 ms) |
| Re-download after an app-only release | 709 KB gzip (every chunk's hash changes) | 501 KB gzip (vendor chunks keep their hashes) |
| Logger: tap "Mark set done" → DOM updated | 84–180 ms; worst Event Timing entry 40–56 ms | 96–160 ms; worst 32–40 ms |

The "before" and "after" columns come from the same source snapshot, built with and without the change.

- Recharts (≈ 120 KB gzip) is already lazy-loaded with the Progress page. The demo seeding module (program generator and exercise catalogue) now loads only when the demo is open. Today and Train need the same code anyway, so startup is unchanged.
- **Remaining startup cost:** React DOM (~100 KB gzip) and supabase-js (~59 KB gzip) are parsed on every start. Deferring supabase-js would mean making `src/backend/supabase.ts` asynchronous, which touches many files. It hasn't been done because the measured startup (≈ 0.7 s to the first heading at 4× CPU) isn't a demonstrated bottleneck.
- **To reproduce:**

  ```
  npx vite build --outDir /tmp/lc-audit-dist --emptyOutDir
  ```

  Then serve the folder with the `_headers` rules, and run a Playwright script using CDP `Emulation.setCPUThrottlingRate` with a `longtask`/`event` PerformanceObserver.
