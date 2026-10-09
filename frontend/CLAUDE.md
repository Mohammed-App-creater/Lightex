@AGENTS.md

# Lightex frontend

Next.js 16 App Router web client for Lightex, a project-management app for software teams (Trello/Linear style,
dark-first). It runs fully on an in-browser **mock API**. Switching to the real backend changes only environment
variables, never UI code.

Start here: `README.md` (setup, mock vs live, folders), `docs/final-report.md` (what's built, deviations, requested
API additions, known gaps), `docs/frontend-conventions.md` (rules every screen follows), `docs/frontend-plan.md`
(key decisions), `docs/api-contract.md` (the REST contract the client expects).

## Commands (run from `frontend/`)

- `npm run dev` — Turbopack dev server.
- `npm run check` — typecheck, lint, then unit tests. All must pass before every commit.
- `npm run typecheck` — runs `next typegen && tsc --noEmit`. `LayoutProps` and `PageProps` only exist after typegen,
  so plain `tsc` fails.
- `npx vitest run <path>` — Vitest 4 with jsdom; setup lives in `tests/setup.ts`.
- `npm run test:e2e` — Playwright smoke suite (`e2e/smoke.spec.ts`). It reuses a server already on port 3100, or
  starts one.
- `npm run build` — must pass. Stop any running `next dev` first, because both use `.next`.

Expected lint state: 0 errors and 1 warning (React Compiler `incompatible-library` on TanStack Virtual's
`useVirtualizer` in `list-screen.tsx`). Ignore Tailwind "canonical class" IDE hints.

## Environment gotchas (Windows, path with spaces)

- **Vitest:** pinned to `^4` (and `@vitejs/plugin-react@^5`). Vitest 5 workers time out on paths containing spaces.
- **Stray dev servers:** stopping a background `next dev` can leave an orphan `node` process holding the port. Free it
  with PowerShell:
  `Get-NetTCPConnection -LocalPort 3100 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`.
- **Hung e2e runs:** if e2e tests hang or time out, check that the dev server is actually serving (`curl` the
  `/login` URL) before blaming the tests.
- **Line endings:** `.gitattributes` forces LF. CRLF warnings on commit are harmless.
- **Next 16 APIs:** route `params` are Promises. `cacheComponents` is deliberately **off**, because Activity route
  preservation kept overlays and hotkeys alive on hidden routes. Read `node_modules/next/dist/docs/` before using
  unfamiliar Next APIs.
- **Performance rules:** the React Compiler is on (Turbopack's Rust port, no Babel plugin), so write plain
  hooks-compliant components and let it memoize. Change only the query string (`?task=`, filters, dialog state)
  with `pushUrl` / `replaceUrl` from `src/lib/routes.ts`, never `router.push`: the router refetches the page for
  every `router.push`, the History API does not. Heavy, open-on-demand modules (Tiptap, cmdk) stay code-split
  through `lazyWithPreload` (`src/lib/hooks/lazy-with-preload.tsx`), warmed at idle; route-only ones (Recharts)
  simply live in their route.

## Architecture

- **`src/app/`** — routes. Pages are thin and render a screen from `src/features/<area>/`.
  - Workspace routes live under `[workspace]/`; project views under `[workspace]/projects/[key]/`.
  - Project views: overview, board, list, backlog, timeline, calendar (v2, board 32), epics, sprints, objectives,
    milestones, reports, settings.
  - Also: `trash`, `settings/{general,members,roles,notifications,profile,audit}`, `tasks/[taskKey]`, `my-tasks`,
    `search`, `inbox`, `timesheet` (v2, board 39).
- **Task side panel:** `?task=KEY` on any project view (`TaskPanelHost`, with a card→panel morph).
- **`src/components/ui/`** — design-system primitives. Always reuse these:
  - Button (`disabledReason`, `kbd`), Menu, Modal/Sheet/Drawer, SidePanel, Tabs/NavTabs/FilterPills, toast;
  - feedback: Skeleton, EmptyState (with `illustration`), ErrorState, ProgressBar/Ring.
- **`src/components/shell/`** — sidebar, top bar (`TopBarActions` portal), global hotkeys, dev tools, edge screens
  (404/403/500).
- **`src/lib/api/`** — the only place that talks to a server.
  - Screens call `api.<group>.<fn>` from `endpoints.ts`, with query keys from `qk` in `query-keys.ts`.
  - `getTransport()` picks `HttpTransport` (live) or `MockTransport` (mock) based on `NEXT_PUBLIC_API_MODE`.
  - Errors: `ApiError { code, message, details, status }`.
- **`src/lib/mock/`** — the mock backend: seed, DB, router, `handlers/*.ts`. Each handler file exports `register<Area>()`,
  which is called from `mock/transport.ts`.
  - The mock enforces permissions and `version` conflicts server-side. Keep the UI's gating identical.
  - Data is cached in localStorage (`lightex-mock-db`). Bump `SCHEMA` in `seed.ts` only when the seed shape really
    changes; new collections are added as optional fields instead.
- **`src/lib/permissions/`** — the permission catalogue, the 7 default roles, and `useCan`, `<Can>`, `can()`,
  `canEditTask`.
- **`src/features/`** — one folder per product area. Each holds its screens, queries, mutations and tests.

## Rules that must not be broken

- **Permissions come only from `my_permissions`** on workspace and project responses.
  - Workspace and project scopes are separate; neither overrides the other.
  - Something you can't do is **not rendered**. A disabled control always carries a visible reason (`disabledReason`).
  - Never infer permissions from role names.
- **Auth tokens:**
  - Live mode: access token in memory only, refresh token in an httpOnly cookie. On a 401, refresh once and retry once.
    Never put tokens in web storage.
  - Mock mode: the session is a user id in `lightex-mock-session`. It is not a token.
- **Mutations:** optimistic, with rollback and a toast (`src/features/tasks/mutations.ts`, `src/lib/api/optimistic.ts`).
  Board moves send `version`; a 409 shows "Someone else changed this card".
- **Freshness:** no WebSockets. Refetch on window focus; poll the board and inbox every 30s, only while visible.
- **Every screen** has loading (skeleton), empty and error (retry) states. It must work at 390px and in the navy,
  black and light themes.
  - Colours come from token classes only (`bg-surface text-fg-2 border-line` …).
  - Animate only transform and opacity, and respect reduced motion.
- **Uploads:** images and code/text only, 10 MB max. Never render HTML or SVG uploads inline. Code files are
  **download-only**, with no preview (the brief beats board 34's code viewer).
- **Rich text** is Tiptap JSON rendered by a safe JSON→React renderer. Never use `innerHTML`.
- **v2 features, only as scoped:**
  - In scope: **board 39** (custom fields, dependencies, time tracking), built from `docs/v2/39-fields-dependencies-time.md`,
    and **board 32** (timeline & calendar), built from `docs/v2/32-timeline-calendar.md` (both at the repo root); see
    `docs/final-report.md` §8.
  - Planned next, still not built: dashboards and presence (33), GitHub/GitLab (37), Telegram/SMS/push sending (38),
    import (40). No WebSockets or live presence.
  - Until a board is in scope, where a design puts it inside an in-scope screen, it is hidden or marked "Coming soon".
- **No new endpoints without the paper trail.** An endpoint or field is only added with all of: types +
  `endpoints.ts`, a mock implementation, and an entry in the "Requested API additions" sections of
  `docs/final-report.md`.
- **No new npm dependencies** without a reason recorded in `docs/final-report.md` §2.

## Design sources

- **Original exports** live in `desing - orignal/` (sic): two bundled design-system HTML files and 7 email templates.
- **Readable boards** are in `design/clean/NN-*.html`: boards 01–23 come from bundle 1, boards 24–40 from bundle 2.
  - They are template mockups: `{{…}}` placeholders, and `data-props` that switch theme, role and state.
  - Fixtures and state logic live in the inline `<script>` blocks.
- **Specs** for boards 01–23 are in `design/notes/*.md`.
- **Precedence:** docs and the brief win for behaviour; the design wins for appearance. Record every conflict in
  `docs/final-report.md`.
- **Generated artefacts:** `design/assets/`, `design/pages/`, `design/NN-*.html` and `design/_index.html` are
  gitignored extraction output.
- **Email templates** for the backend are in `emails/`; `emails/README.md` lists each template's merge tags,
  subject and trigger. The dev preview is at `/dev/emails`.

## Mock accounts and dev tools

- Every account's password is `password`.
- Workspace `platform` has projects PRJ, MOB and INF; workspace `design-guild` has DSN. Dates are seeded relative to
  2026-10-07.

| User id | Email | Workspace role | Role on PRJ |
|---|---|---|---|
| `u_alex` | alex@team.dev | Owner | Project Admin |
| `u_jordan` | jordan@team.dev | Admin | Manager |
| `u_sam` | sam@team.dev | Member | Member |
| `u_taylor` | taylor@team.dev | Member | Viewer |
| `u_casey` | casey@team.dev | Admin | not a member (sees the 403 + request access screen) |

- **Dev pill** (bottom right, on in mock mode): role switcher, mock controls (error rate, latency, offline, simulated
  teammates) and a data reset.
  - Mock controls persist in `lightex-mock-controls`.
  - e2e sets `{ errorRate: 0, teammates: false }` there to stay deterministic.
- **Galleries:** component gallery at `/dev/ui`, email previews at `/dev/emails`.

## Verifying UI changes

- Run Playwright screenshots against the dev server at 1440 and 390, in dark and light, as at least one restricted
  role (`u_taylor` or `u_casey`). Check for console errors.
- Pass a session by seeding `localStorage["lightex-mock-session"]` in an init script.
- An init script that touches `localStorage` throws inside sandboxed iframes (`/dev/emails`). That error comes from
  the test harness, not the app.

## Working in this repo

- The repo root is a monorepo: `frontend/` (this app) and `backend/`, which another session or team works on.
- **Commit only frontend paths** (`git commit -- frontend`); never stage someone else's in-progress `backend/` changes.
- **Backend contract:** the backend publishes `docs/openapi.yaml` at the repo root. `frontend/docs/api-contract.md`
  was written earlier, from the brief. Reconcile the two before switching to live mode.
- **Commit messages** end with the Co-Authored-By attribution line.
