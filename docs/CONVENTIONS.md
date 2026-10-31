# Code conventions (for contributors)

- **Layers:** `src/domain/**` = pure, testable TypeScript (no React, no Dexie, no network).
  `src/db/**` = local persistence (Dexie, account-scoped). `src/sync/**` = outbox + sync engine.
  `src/backend/**` = Supabase access. `src/features/<area>/**` = screens. `src/components/**` = shared UI.
- **Types:** shared types live in `src/domain/types.ts`. Canonical units: kg, cm, metres, seconds, epoch ms.
  Local calendar dates are `YYYY-MM-DD` strings (see `src/lib/dates.ts`).
- **Persistence:** read with `useLiveQuery(() => db.table..., [db])` where `db = useDb()`.
  Write synced records only via `saveRecord(entity, record, db)` / `deleteRecord(entity, id, db)` from `src/db/repo.ts`
  (writes immediately and queues sync). Create with `newRecord({...})`. Filter tombstones with `alive()`.
- **Settings/profile:** `const { account, updateAccount } = useApp()`; `account.settings.units` for display units.
  Format with `src/domain/units.ts` (`formatWeight`, `toKg`, `formatDistance`, `formatPace`…).
- **UI kit:** `src/components/ui.tsx` (Page, Card, Button, IconButton, Input, NumberInput, Select, Toggle,
  Segmented, ChipGroup, Sheet, ConfirmDialog, EmptyState, ErrorState, Spinner, Notice, ListRow, Stat, Badge,
  ProgressBar, SectionTitle). Toasts: `useToast().show(msg, { tone, action })`. Icons: `lucide-react`.
- **Design:** mobile-first (360–430 px), two themes from the same tokens (src/styles.css): Midnight
  (`data-theme="dark"`) and Daylight (`data-theme="light"`). Tailwind tokens: `bg-bg bg-surface bg-surface-2
  bg-surface-3 border-line text-ink text-muted text-faint text-accent bg-accent text-accent-ink bg-accent-soft
  text-danger bg-danger-soft text-warn bg-warn-soft`, plus supporting accents `text-accent-2` (nutrition,
  highlights), `text-celebrate` (records), `text-streak` (streaks) with matching `-soft` fills. Summary cards can use
  `<Card tint="accent" | "2" | "celebrate" | "streak">`. Never hard-code colours. A new text/background pair must
  pass tests/unit/themeContrast.test.ts (WCAG AA) in both themes. Headings use the display font (Nunito, `font-display`;
  h1/h3 get it automatically); numbers use `tabular`. Motion lives in styles.css (`pressable`, `set-pop`,
  `tab-bounce`, sheet transitions), stays ≤ 300 ms, and is switched off by prefers-reduced-motion. Confetti
  (`celebrate()` in src/components/celebrate.ts) is for records and finished workouts only, behind
  `settings.workout.celebrations`. Empty states can take an `illustration` from src/components/illustrations.tsx.
  Touch targets ≥ 44 px (`min-h-11`), every input labelled, visible focus, loading/empty/error states.
- **Main tab pages** put `<TopActions />` (from `src/app/TopActions.tsx`) in `Page actions`.
  Sub-pages use a back button: `<IconButton label="Back" onClick={() => nav(-1)}><ChevronLeft/></IconButton>` in `Page back`.
- **Routing:** `react-router` v7 (`useNavigate`, `Link`, `useParams` from 'react-router'). Routes in `src/app/routes.tsx`.
- **No technical setup text** in ordinary user flows; it belongs in docs/.
