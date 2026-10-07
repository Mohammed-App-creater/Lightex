# Lightex frontend plan

Status: living document. Written at step 1, before any app code.

## 0. Inputs and what was found

- **Design**: a single bundled file, `Lightex Design System.html`. It holds 23 nested page bundles. They were
  unpacked into `design/clean/NN-*.html` (readable, font-face CSS stripped) and summarised into
  exact-value specs in `design/notes/*.md`:

  | Board | Topic | Notes file |
  |---|---|---|
  | 01–06 | Foundations: color, type, space, motion, controls, cards/tabs/panel, overlays, states | read directly |
  | 07–08 | Logo directions + final "cut x" | `logo.md`, `logo-mark*.svg`, `favicon*.svg` |
  | 09, 10, 14 | Task detail (interactive, states, panel v2) | `task-detail.md` |
  | 11, 12 | Project overview (populated, new project) | `project-overview.md` |
  | 13, 15 | Sidebar navigation, list view | `sidebar-and-list.md` |
  | 16, 17 | Objectives & milestones, reports | `objectives-and-reports.md` |
  | 18, 20 | Members & roles, profile & workspace settings | `members-and-settings.md` |
  | 19, 21 | Notifications, auth flow | `notifications-and-auth.md` |
  | 22, 23 | Command palette, edge screens, onboarding | `palette-edge-onboarding.md` |

- **Docs**: `/docs` did not exist. There is no data-model, permission or API-contract document beyond the
  build brief. The brief is therefore treated as the behavioural spec ("docs win for behavior"), and the
  assumed REST contract is written down in `docs/api-contract.md`. Every endpoint in it is listed as a
  *requested API addition* in the final report, so the backend team can confirm or correct it.

## 1. Key decisions

| Topic | Decision |
|---|---|
| Framework | Next.js 16 App Router, React 19, TypeScript strict. |
| Rendering | Shell and screens are client components (the mock API lives in the browser). Server components are used for static layouts and metadata. Each route is its own chunk (route-level splitting). |
| Styling | Tailwind CSS v4. Tokens are CSS variables per theme, exposed to Tailwind via `@theme inline` in `src/styles/tokens.css`. Tailwind v4 has no `tailwind.config.js`; the CSS `@theme` block *is* the config. |
| Themes | next-themes, `attribute="data-theme"`, themes `dark` (Deep navy, the default), `black` (Near-black), `light`, plus `system` (resolves to navy or light). Blocking script means no flash. |
| Fonts | `next/font/google`: Inter 400/500/600 and JetBrains Mono 400/500, self-hosted at build. |
| Motion | `motion` (Framer Motion). Tokens: fast 120ms, base 180ms, slow 250ms, data 700ms; `ease-out (.16,1,.3,1)`, `ease-in-out (.65,0,.35,1)`, `spring-snappy (.34,1.56,.64,1)`. A single `useReducedMotion` gate removes tilt, scale and shimmer and turns transitions into 100ms fades. |
| Server state | TanStack Query v5. Query keys live in one factory. Optimistic mutations use snapshot + rollback + toast. `refetchOnWindowFocus`, and 30s polling for the board and inbox only while the tab is visible. |
| API | One typed client (`src/lib/api`). Endpoint functions are written once against a `Transport` interface. `HttpTransport` (live) and `MockTransport` (in-browser router over an in-memory DB) are the two adapters, chosen by `NEXT_PUBLIC_API_MODE`. Swapping to the backend touches only the transport. |
| Errors | One shape everywhere: `ApiError { code, message, details, status }`. |
| Auth (live) | Access token kept in memory only. Refresh token is an httpOnly cookie set by the backend; `POST /auth/refresh` with `credentials: 'include'`. On 401: one refresh, one retry, then sign-out. No tokens in localStorage. |
| Auth (mock) | The session user id is kept in `localStorage` (mock only; it is not a token). |
| Permissions | `useCan(permission, scope)` and `<Can>` read only `my_permissions` from the workspace or project response. Workspace and project scopes never override each other. Hidden means not rendered. Any disabled control carries a visible reason (tooltip + `aria-describedby`). |
| Drag and drop | dnd-kit (core + sortable). Positions use string fractional indexing (own ~60-line util). Moves send `version`; a 409 `version_conflict` shows the "Someone else changed this card" toast and refetches. |
| Rich text | Tiptap (StarterKit incl. code blocks, Placeholder, Link, Mention). Stored as Tiptap JSON; never rendered as raw HTML. |
| Forms | react-hook-form + zod; schemas shared with the mock for server-side validation. |
| Palette | cmdk, inside our own dialog shell. |
| Charts | Recharts with design colours (`--c1` orchid, `--c2` olive, `--cref` reference grey). |
| Icons | lucide-react, plus the custom status glyphs and priority bars (CSS, as in the design). |
| Virtualization | `@tanstack/react-virtual` for list view, backlog and inbox (*added dependency*: required by the "virtualized long lists" bar). |
| A11y primitives | `@radix-ui/react-{dialog,dropdown-menu,popover,tooltip}` (*added dependency*: focus trapping, roving focus, typeahead and ARIA for menus and dialogs are hard to get right; cmdk already depends on Radix dialog). Styled entirely with our tokens. |
| Tests | Vitest + Testing Library (jsdom) for units; one Playwright smoke test. |

## 2. Route map

```
/login  /register  /forgot-password  /reset-password  /invite/[token]      (auth)/ group, centred card on grid+bolt bg
/onboarding                                                                 3 steps + "You're ready"
/[workspace]                         home (my work, projects, activity)     ┐
/[workspace]/inbox                   notifications inbox + preview          │
/[workspace]/my-tasks                tasks assigned to me, grouped          │
/[workspace]/search?q=               global search results page             │ app shell:
/[workspace]/projects/[key]          overview                               │ sidebar (264/64),
/[workspace]/projects/[key]/board    kanban                                 │ top bar,
/[workspace]/projects/[key]/list     list view                              │ palette,
/[workspace]/projects/[key]/backlog  backlog + sprint planning              │ drawer < 1024
/[workspace]/projects/[key]/sprints  sprints (active, planned, completed)   │
/[workspace]/projects/[key]/objectives                                      │
/[workspace]/projects/[key]/milestones   (list + timeline* views)           │
/[workspace]/projects/[key]/reports                                         │
/[workspace]/projects/[key]/settings general, statuses, members            │
/[workspace]/tasks/[taskKey]         full-page task                         │
/[workspace]/settings → general | members | roles | notifications | profile ┘
/dev/ui                              component gallery, both themes (dev only)
not-found, error, global-error, 403 (in project layout), offline banner, session-expired modal
```

`?task=PRJ-42` on any project view opens the task side panel (desktop) or bottom sheet (mobile). The card
morphs into the panel with a shared `layoutId`.

\* The milestone timeline is drawn in the design as part of the Objectives & Milestones screen and is
not a project "timeline/calendar view", so it is built. The project-level "Timeline" tab shown in boards
04 and 15 is v2 and is hidden.

## 3. Folder structure

```
src/
  app/                      routes only (thin; compose features)
  components/
    ui/                     base library (button, input, select, badge, avatar, card, tabs, tooltip,
                            dropdown-menu, modal, side-panel, sheet, toast, skeleton, empty-state,
                            progress-ring, progress-bar, kbd, status-glyph, priority-bars, checkbox,
                            switch, radio, segmented, command-shell, spark)
    brand/                  logo mark, wordmark, app loader
    shell/                  sidebar, rail, top bar, drawer, workspace switcher, theme toggle,
                            shortcuts help, offline banner, session-expired, dev role switcher
  features/
    auth/ onboarding/ workspace/ projects/ board/ tasks/ list/ backlog/ sprints/
    objectives/ milestones/ reports/ members/ roles/ notifications/ settings/ search/ palette/
      → each: api hooks (queries.ts), components, local utils
  lib/
    api/                    types.ts, errors.ts, transport.ts, http-transport.ts, endpoints/*.ts,
                            query-keys.ts, index.ts (mode switch)
    mock/                   db.ts (store + persistence), seed.ts, router.ts, handlers/*.ts, latency.ts
    permissions/            catalogue, useCan, <Can>, scope context
    hooks/                  hotkeys, visibility polling, media query, reduced motion
    utils/                  fractional-index, dates, cn, keys, files
  styles/                   tokens.css, globals.css
tests/                      vitest setup; unit tests sit next to code as *.test.ts(x)
e2e/                        playwright smoke
```

## 4. Component inventory (from the design)

- **Foundations**: tokens (3 themes), type scale (display…mono-code), spacing, radii (4/6/8/12/16/full),
  control heights (24/28/32/40/44 touch), elevation e0–e3 and focus, motion tokens.
- **Controls**: Button (primary, secondary, ghost, danger, danger-ghost; sm/md/lg/icon; loading; disabled
  with reason), Kbd, Input, Textarea, Field (label, hint, error), Select (status/priority with glyphs),
  inline-edit title, Checkbox, Switch, Radio, Segmented control, Badge (status, priority), Entity chip,
  Label chip, Copy-key button, Avatar (oklch hue, sizes 20/24/32/40, presence, unassigned, stack).
- **Surfaces**: Card, Task card (default, hover, selected, dragging, drop placeholder), Tabs (sliding
  indicator), Filter pills, Side panel (480–520), Bottom sheet, Modal (confirmations only), Tooltip
  (200ms delay, shortcut keys), Dropdown menu (header, separator, danger, shortcuts), Toast
  (status glyph, action + key, undo), Command palette shell.
- **Feedback**: Skeleton (shimmer 1.4s), Empty state (dashed icon tile), Error card (ref id, retry),
  Offline banner (amber), Progress ring (84px, 40px, 30px, 24px), Progress bar, Stat tile (count-up),
  App loader (logo animation), Spark completion.
- **Shell**: Sidebar (workspace switcher, search trigger, New task, Inbox/My tasks, Pinned views, Projects
  accordion with sliding sub-nav indicator, sprint card, settings, shortcuts, account menu), Rail (64px
  with tooltips), Mobile drawer (300px, 44px targets), Top bar (breadcrumb, view switcher, actions).

## 5. Data model (frontend types)

User, Workspace (+ `my_permissions`), WorkspaceMember, Role (`scope`, `isSystem`, `permissions`),
Permission (catalogue), Project (`key`, + `my_permissions`), ProjectMember, Status (`category`),
Objective, Milestone, Epic, Sprint, Task (`key`, `type`, `priority`, `assigneeId`, `reporterId`,
`estimate`, `dueDate`, `epicId`, `milestoneId`, `sprintId`, `parentId`, `objectiveIds[]`, `position`,
`version`), Label, Comment, Attachment, Notification, NotificationPreference, ActivityEntry,
AccessRequest, Invite. Progress for objectives, milestones and sprints is derived from tasks in a single
`progress.ts`, never stored.

## 6. Build order (each step: typecheck + lint + tests green, then a commit)

1. Plan (this file) and `docs/api-contract.md`.
2. Foundation: tokens, fonts, theming, motion tokens, base components, `/dev/ui` gallery.
3. Data layer: types, transport, endpoints, mock DB + seed + router, auth, permissions, query hooks.
4. App shell: sidebar, rail, top bar, workspace switcher, theme toggle, drawer, palette, shortcuts.
5. Screens, in this order: auth → onboarding → workspace home → project overview → board → task
   detail (panel + page) → list → backlog & sprints → objectives & milestones → reports → members
   & roles → notifications & settings → global search → error and edge screens.
6. Polish: animation pass, keyboard shortcuts, a11y pass, responsive pass, tests, README, final report.

## 7. Seed data (mock)

Two workspaces ("Platform team", "Design guild"). Three projects (PRJ Platform Rebuild, MOB Mobile App,
INF Infra). 45+ tasks, reusing the design's copy (PRJ-31…PRJ-63 etc.). Three sprints per project,
objectives, milestones and epics. Eight users with a dev role switcher covering the seven default roles
(workspace Owner/Admin/Member; project Project Admin/Manager/Member/Viewer). One user has workspace
access but no project membership, to exercise the 403 + request-access flow.
