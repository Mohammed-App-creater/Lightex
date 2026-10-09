# Lightex frontend conventions

Read this before adding a screen. The goal is that every screen looks and behaves like the
design boards and like every other screen.

## Sources
- Design specs (exact values, copy, states): `design/notes/*.md`. Readable boards: `design/clean/*.html`.
- API: `docs/api-contract.md`. All calls go through `api` from `@/lib/api/endpoints` (grouped:
  `api.auth`, `api.workspaces`, `api.roles`, `api.projects`, `api.planning`, `api.tasks`, `api.board`,
  `api.backlog`, `api.comments`, `api.attachments`, `api.reports`, `api.notifications`, `api.search`,
  `api.audit`). Never call `fetch` directly. Types: `@/lib/api/types`.
- Mock backend: `src/lib/mock/**` (handlers mirror the contract). Mock mode is the default.

## Stack rules
- Next.js 16 App Router, client components for screens (`"use client"`). Route files under
  `src/app/**/page.tsx` stay thin and render a feature component from `src/features/<area>/`.
- Next 16: `params` in server `page`/`layout` is a Promise (`const { key } = await params`). In client
  components use `useParams()` or `useRouteInfo()` from `@/lib/routes`. Wrap components that call
  `useSearchParams()` in `<Suspense>`.
- Tailwind v4 with design tokens. Colours: `bg-bg bg-surface bg-raised bg-hover border-line border-line-2
  border-control text-fg text-fg-2 text-fg-3 bg-accent text-accent-t bg-accent-s text-ok text-warn
  text-danger text-info text-orange text-low bg-ok-s bg-warn-s bg-danger-s`, or `var(--token)` in
  arbitrary values. Never hard-code hex colours. Type scale: `text-display text-h1 text-h2 text-h3
  text-title text-body text-ui text-meta text-caption`; mono: `font-mono`. Radii `rounded-xs(4) sm(6)
  md(8) lg(12) xl(16)`. Shadows `shadow-pop shadow-modal`. Easing `ease-out ease-spring`.
- Motion: `motion/react`. Durations 120 / 180 / 250 ms, data animations 700 ms. Animate transform and
  opacity only. `MotionConfig reducedMotion="user"` is global; CSS animations are disabled by the
  reduced-motion media query in globals.css.
- No new dependencies.

## Components (`@/components/ui/*`), use these, don't re-style from scratch
`Button` (variants primary/secondary/ghost/danger/danger-ghost, sizes sm/md/lg, `icon`, `loading`,
`kbd`, `tooltip`+`tooltipKeys`, `disabledReason` = disabled with visible reason), `Kbd`, `Shortcut`,
`Input`, `Textarea`, `Field` (label + error/hint, wires aria), `Checkbox`, `Switch`, `Radio`,
`Segmented`, `Select`, `StatusGlyph` (kind backlog/todo/progress/review/done/canceled, `spark`),
`PriorityIcon`, `priorityMeta`, `glyphLabel`, `Badge`, `StatusBadge`, `PriorityBadge`, `EntityChip`,
`LabelChip`, `CopyKey`, `Avatar`, `AvatarStack`, `UnassignedAvatar`, `ProjectBadge`, `Card`, `Panel`,
`StatTile`, `Tabs`/`TabPanel`, `NavTabs`, `FilterPills`, `Tooltip`, `Menu*` (dropdown),
`Modal`, `ConfirmDialog`, `Sheet`, `Drawer`, `SidePanel`, `toast()` (`toast.success/error/info`, tones
`success|error|info|warning|spark`, `action: {label, key, onClick}` — the key works as a shortcut),
`Skeleton`, `SkeletonRows`, `EmptyState`, `ErrorState`, `ProgressRing`, `ProgressBar`, `CountUp`,
`useCountUp`, `InlineEditText`, `CommandShell`. Brand: `Wordmark`, `LogoMark`, `AppIcon`, `AppLoader`.
See them all at `/dev/ui`.

## Data
- TanStack Query. Keys only from `qk` (`@/lib/api/query-keys`). Shared hooks:
  `@/features/workspace/queries` (useWorkspaces, useWorkspace, useProjects, useWsMembers, useRoles,
  useUnreadCount, useMyTasks), `@/features/projects/queries` (useProject, useStatuses, useLabels,
  useProjectMembers, useEpics, useSprints, useMilestones, useObjectives, useActiveSprint).
- Task writes: `@/features/tasks/mutations` (useUpdateTask, useMoveTask, useCreateTask,
  useDeleteTask) are optimistic with rollback + toast. Other mutations: invalidate the narrowest keys
  (`qk.objectives(projectId)` etc.).
- Current context: `useCurrentWorkspace()`, `useCurrentProject()` (inside project routes),
  `useSession()` / `useMe()` (`@/features/auth/session`), `useRouteInfo()` and `routes.*` for URLs.
- Errors: every rejection is an `ApiError { code, message, details, status, ref, request }`;
  `isForbidden/isNotFound/isConflict/errorMessage` in `@/lib/api/errors`. 422 field errors:
  `error.fieldErrors`.

## Permissions (critical)
- Use `useCan("perm")` / `<Can permission="perm">` from `@/lib/permissions/can`. Workspace keys read
  the workspace's `my_permissions`; project keys read the current project's. Never check role names.
- Hidden means not rendered. If a control is visible but unusable (e.g. a rule like "sprint has open
  tasks"), use `Button disabledReason="…"`; never a bare disabled control.
- Task edit rule: `canEditTask(task, project.my_permissions, me.id)`.

## Every screen must have
loading (skeleton in final positions), empty, and error (with Retry) states; keyboard operation;
visible focus (the global ring); labelled controls; responsive layout (desktop first, ≤1023px tablet
drawer, ≤760px mobile: sheets instead of side panels, 44px touch targets).

## No dead UI
Every visible button does something in mock mode. Features outside v1 (GitHub/GitLab, Telegram/SMS/
Push sending, WebSockets, timeline/calendar *project views*, import) are hidden or marked "Coming soon".
Board 39 (custom fields, dependencies, time tracking) is built in v2; see `docs/final-report.md` §8.

## Checking your work
`npx tsc --noEmit`, `npx eslint <your files>`, `npx vitest run <your tests>`. A dev server runs on
http://localhost:3100. Screenshots: `node <scratchpad>/shot.mjs <url> <out.png> [w] [h] [fullPage]`
with env `SESSION=u_alex` (signs in as Alex; other users: u_jordan, u_sam, u_taylor, u_casey) and an
optional JSON actions argument.
