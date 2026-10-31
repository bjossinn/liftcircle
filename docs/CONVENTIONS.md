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
- **Design (Hard Earned, 1.0):** the brand kit in `brand/hard-earned/` is the source of truth (guide, tokens, contrast
  matrix, icons). Mobile-first (360–430 px), dark (flagship, `data-theme="dark"`) and light (`data-theme="light"`)
  from the same tokens in src/styles.css. Tailwind tokens: `bg-bg bg-surface bg-surface-2 bg-surface-3 bg-field
  border-line border-line-input text-ink text-muted text-faint`; `text-accent` / `border-accent` is the accent ink
  (text, icons, selected boundaries; #A93623 in light); `bg-ember` is the vivid fill for small highlights. Primary
  actions use the `ember-fill` class (ember, charcoal label, 2 px charcoal outline) via `<Button variant="primary">`;
  never put chalk or white text on ember. Selected = `bg-accent-soft border-accent` plus a check or explicit label.
  Status: `text-success` (saved, completed), `text-danger`, `text-warn`, `text-info`, each with `-soft`; destructive
  buttons use `danger-fill`. Disabled controls are solid (`solid-disabled`, `bg-disabled text-disabled-ink`), never
  dimmed with opacity. Focus: 3 px outline in `--c-focus`, 3 px offset (global). Charts use `--c-chart-1…5` with
  `seriesLine(i)` and `<Legend series={i}>` (colour + marker + line style). Use ember sparingly: the next action,
  the selected tab and a few highlights. Never hard-code colours; a new pair must pass tests/unit/themeContrast.test.ts,
  which also checks the kit's palette and matrix. Fonts: Inter for UI and numbers (`tabular` for timers, sets and
  stats); Barlow Semi Condensed 700 only for the wordmark (`.wordmark`) and major headings (`h1`, `font-display`).
  Radii 8 / 12 / 16 / 24 px (`rounded-lg / xl / 2xl / 3xl`: small, control, card, dialog). Motion: 120 ms colour
  changes, 160–200 ms panels, no bouncing; prefers-reduced-motion switches it off. Celebrations (`celebrate()`) are
  brief, only for a real record or a finished workout, behind `settings.workout.celebrations`. Brand moments
  (welcome, install, About) use `<BrandMoment>` from src/components/BrandMark.tsx; the motto appears nowhere else.
  Voice: sentence case, no em dashes, no needless exclamation marks, no guilt or body/food judgement. "Training
  assistant" is the AI; "coach" is a human. Empty states can take an `illustration` from src/components/illustrations.tsx.
  Touch targets ≥ 44 px (`min-h-11`), every input labelled, visible focus, loading/empty/error states.
- **Main tab pages** put `<TopActions />` (from `src/app/TopActions.tsx`) in `Page actions`.
  Sub-pages use a back button: `<IconButton label="Back" onClick={() => nav(-1)}><ChevronLeft/></IconButton>` in `Page back`.
- **Routing:** `react-router` v7 (`useNavigate`, `Link`, `useParams` from 'react-router'). Routes in `src/app/routes.tsx`.
- **No technical setup text** in ordinary user flows; it belongs in docs/.
