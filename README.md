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

## Mock vs live

Everything goes through one typed client in `src/lib/api`. Screens call `api.tasks.update(...)` and similar,
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
```

The backend must:

- allow this origin with credentials (CORS);
- implement the contract in [`docs/api-contract.md`](docs/api-contract.md): REST under `/api/v1`, errors as
  `{ code, message, details }`, cursor pagination, `filter[...]`, `sort`, `?q=`;
- return `my_permissions` on workspace and project responses.

The UI decides what to render **only** from `my_permissions`. Nothing is inferred from role names.

All variables are public (`NEXT_PUBLIC_*`) and documented in [`.env.example`](.env.example). There are no secrets
in the client.

## Folder structure

```
src/
  app/                      Routes (App Router). Pages are thin: they render a screen from features/.
    (auth)/                 login, register, forgot/reset password, invite/[token]
    onboarding/
    [workspace]/            home, inbox, my-tasks, search, settings/*, tasks/[taskKey]
      projects/[key]/       overview, board, list, backlog, sprints, objectives, milestones, reports, settings
    dev/ui/                 component gallery (dev tools only)
  components/
    ui/                     design-system primitives (button, menu, modal, side panel, toast, glyphs, ...)
    shell/                  sidebar, top bar, hotkeys, dev tools, edge screens (404/403/500), offline banner
    brand/                  logo, app loader
  features/                 one folder per product area: screens, queries, mutations, and their tests
    auth/ onboarding/ workspace/ projects/ board/ list/ sprints/ tasks/ goals/
    reports/ members/ notifications/ settings/ palette/
  lib/
    api/                    types, endpoints, transports, query keys, optimistic helpers, uploads
    mock/                   seed, in-memory DB, router and handlers (mock backend)
    permissions/            permission catalogue, useCan / <Can>, scopes
    domain/                 computed progress and risk (never stored)
    hooks/ utils/           hotkeys, media queries, fractional indexing, dates, ...
  styles/tokens.css         design tokens for the dark (navy), black and light themes
docs/
  frontend-plan.md          plan and key decisions
  frontend-conventions.md   rules every screen follows (states, permissions, motion, a11y)
  api-contract.md           the REST contract the client expects
  final-report.md           what was built, deviations, requested API additions, known gaps
design/                     the design source (HTML boards) and extracted notes
e2e/                        Playwright smoke suite
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
