# Lightex — web client

The frontend for Lightex, an internal project-management app for software teams: boards, lists, backlog and
sprints, objectives and milestones, reports, members and roles, notifications. Dark-first with a full light theme.

It runs completely on a built-in **mock API**, so it works with no backend. To use the real backend you change
one environment variable; the UI doesn't change.

## Quick start

Requires Node 20+ (developed on Node 24).

```bash
npm install
cp .env.example .env.local      # defaults to mock mode
npm run dev                     # http://localhost:3000
```

Sign in with any seeded account. The password is always `password`:

| Account | Workspace role | Role on Platform Rebuild (PRJ) |
|---|---|---|
| `alex@team.dev` | Owner | Project Admin |
| `jordan@team.dev` | Admin | Manager |
| `sam@team.dev` | Member | Member |
| `taylor@team.dev` | Member | Viewer (read-only) |
| `casey@team.dev` | Admin | not a member (sees the 403 + request-access screen) |

You can also switch user without signing out: use the **Dev** pill in the bottom-right corner. It has a role
switcher for the seven default roles, plus mock controls (error rate, latency, offline, simulated teammates,
reset data). The component gallery is at `/dev/ui`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (Next + React Compiler rules) |
| `npm test` | Vitest unit and component tests |
| `npm run test:e2e` | Playwright smoke suite: sign-in, board, task panel, palette, plus permission hiding for every default role. Reuses a server already running on port 3100, or starts one. Run `npx playwright install chromium` once first. |
| `npm run check` | typecheck + lint + tests |
| `npm run gen:api` | Regenerates `src/api/schema.d.ts` from the backend's `../docs/openapi.yaml` (openapi-typescript) |
| `npm run check:api` | Fails when `src/api/schema.d.ts` is stale (also part of `npm test`) |

## Mock vs live

Everything goes through one typed client in `src/api`. Screens call `api.tasks.update(...)` and similar,
and never call `fetch` directly. A `Transport` underneath is picked by `NEXT_PUBLIC_API_MODE`:

| | `mock` (default) | `live` |
|---|---|---|
| Transport | `MockTransport`: an in-browser router over an in-memory DB | `HttpTransport`: `fetch` to `${NEXT_PUBLIC_API_URL}/api/v1` |
| Data | Seeded: 2 workspaces, 4 projects, 55 tasks, sprints, objectives, milestones, 7 roles. Cached in `localStorage` (`lightex-mock-db`) so edits survive reloads. **Dev → Reset mock data** restores the seed. | The backend |
| Realism | 100–400 ms latency, ~3% injected server errors, permission checks and `version` conflicts enforced server-side, a simulated teammate who edits a task every ~45 s | — |
| Auth | Session user id in `localStorage` (not a token) | Access token **in memory only**. Refresh token is an **httpOnly cookie** set by the backend (`credentials: "include"`). On a 401: one refresh, one retry, then the session-expired modal. No tokens in web storage. |

To switch to the real backend:

```bash
NEXT_PUBLIC_API_MODE=live
NEXT_PUBLIC_API_URL=https://api.example.com     # the client appends /api/v1
NEXT_PUBLIC_UPLOAD_ORIGIN=https://uploads.example.com   # signed-upload host, added to CSP connect-src
NEXT_PUBLIC_DEV_TOOLS=false
NEXT_PUBLIC_APP_URL=https://app.example.com    # absolute Open Graph / icon URLs
```

The backend must:

- allow this origin with credentials (CORS);
- implement `docs/openapi.yaml` (repo root), which the client's types are generated from (`npm run gen:api`;
  [`docs/api-contract.md`](docs/api-contract.md) is the readable summary): REST under `/api/v1`, errors as
  `{ code, message, details }`, cursor pagination, `filter[...]`, `sort`, `?q=`;
- return `my_permissions` on workspace and project responses, with module-namespaced codes (`core.*`,
  `tracking.*`), and serve tracking routes under `/api/v1/tracking/` (see `docs/platform/stage1-contract.md`
  at the repo root);
- serve comments and attachments on the generic `targets/{targetType}/{targetId}/…` routes (for tasks
  `targetType` is `tracking.task` and `targetId` the task id; see `docs/platform/stage2-contract.md`).

The UI decides what to render **only** from `my_permissions`. Nothing is inferred from role names.

All variables are public (`NEXT_PUBLIC_*`) and documented in [`.env.example`](.env.example). There are no secrets
in the client.

## Folder structure

```
src/
  app/                      Routes (App Router). Pages are thin: they render a screen from platform/ or modules/.
    (auth)/                 login, register, forgot/reset password, invite/[token]
    onboarding/
    [workspace]/            home, inbox, my-tasks, search, trash, timesheet, settings/* (incl. audit), tasks/[taskKey]
      projects/[key]/       overview, board, list, backlog, timeline, calendar, epics, sprints, objectives,
                            milestones, reports, dashboards, settings
    dev/ui/, dev/emails/    component gallery and email previews (dev tools only)
  platform/                 core, shared by every module
    shell/                  sidebar, top bar, hotkeys, dev tools, edge screens (404/403/500), offline banner
    realtime/               the SSE stream, leader election, presence and cache updates
    routes.ts               typed URL builders, useRouteInfo, pushUrl / replaceUrl
    auth/ workspace/ settings/ members/ roles/ notifications/ search/ audit/ trash/ onboarding/ palette/ presence/
                            (roles/ also holds the permission catalogue, useCan / <Can> and the role editor)
  modules/
    tracking/               the project-tracking module: projects/ board/ list/ tasks/ sprints/ epics/ goals/
                            filters/ schedule/ reports/ dashboards/ fields/ dependencies/ time/ import/
                            integrations/ development/ my-tasks/ home/ project-settings/
                            module.tsx (its registry entry), services.ts (target types, notification text)
    sales/                  placeholder (platform Stage 3)
  registry/                 module registry: nav items and UI slots (index.ts), non-UI services (services.ts)
  api/                      endpoints, transports, query keys, optimistic helpers, uploads; schema.d.ts (generated
                            from docs/openapi.yaml) and types.ts (aliases into it)
    mock/                   seed, in-memory DB, router and handlers (mock backend)
  ui/                       design-system primitives (button, menu, modal, side panel, toast, glyphs, ...)
    brand/                  logo, app loader, illustrations
  lib/
    domain/                 computed progress and risk (never stored)
    hooks/ utils/           hotkeys, media queries, fractional indexing, dates, ...
  styles/tokens.css         design tokens for the dark (navy), black and light themes
docs/
  frontend-plan.md          plan and key decisions
  frontend-conventions.md   rules every screen follows (states, permissions, motion, a11y)
  api-contract.md           readable summary of the REST contract (docs/openapi.yaml is the source of truth)
  final-report.md           what was built, deviations, requested API additions, known gaps
design/                     the design source (HTML boards) and extracted notes
e2e/                        Playwright smoke suite
emails/                     transactional email templates for the backend (see emails/README.md; preview at /dev/emails)
```

## Conventions in brief

- **States:** every screen has loading (skeletons), empty and error (retry) states.
- **Permissions:** controls you can't use are not rendered. A disabled control always carries a visible reason.
- **Mutations:** optimistic, with rollback and a toast on failure. Board moves send `version`; a conflict shows
  *"Someone else changed this card"*.
- **Freshness:** no WebSockets. Data refetches on window focus, and the board and inbox poll every 30 s while
  the tab is visible.
- **Motion and a11y:** only `transform` and `opacity` are animated, and `prefers-reduced-motion` is honoured.
  WCAG AA contrast, visible focus rings, full keyboard support. Press `?` for shortcuts and Ctrl/⌘ K for the
  palette.

See [`docs/frontend-conventions.md`](docs/frontend-conventions.md) for the full list.
