# Lightex frontend — final report

**Status:** all brief steps (plan → foundation → data layer → shell → screens → polish) are done and committed.
Each step passed its checks before it was committed.

| Check | Result |
|---|---|
| `npm run build` | passes |
| `npm run typecheck` | clean (TypeScript strict) |
| `npm run lint` | 0 errors, 1 warning (expected React Compiler note on TanStack Virtual's `useVirtualizer`) |
| `npm test` | 16 files, 107 tests passing |
| `npm run test:e2e` | 8 Playwright tests passing (sign-in → board → task panel → palette; role-hiding matrix) |
| Route sweep | 29 routes × {navy 1440, light 1440, near-black 390, light 390}: all render, no console errors, no horizontal scroll |

---

## 1. What was built

**Foundation**
- Tokens for three themes: Deep navy (the default), Near-black and Light, plus `system`. Persisted, with no flash.
- Inter and JetBrains Mono, and motion tokens with a reduced-motion fallback.
- About 25 design-system primitives, shown in the `/dev/ui` gallery.

**Data layer**
- One typed API client in `src/lib/api` over a `Transport` seam.
- Mock mode:
  - an in-browser REST router with server-side permission checks;
  - `version` conflicts, latency, injected errors and an offline switch;
  - a simulated teammate who edits a task now and then;
  - data cached in localStorage.
- Live mode: `fetch`, with the access token in memory and the refresh token in an httpOnly cookie. On a 401 it refreshes once and retries once.
- TanStack Query with optimistic updates, rollback and a toast.
- Uploads: signed URL → PUT with progress → confirm. Client-side checks allow only images and code/text files up to 10 MB. HTML and SVG are never rendered inline, and code files are download-only.

**Permissions**
- `useCan` / `<Can>` read only `my_permissions`. Workspace and project scopes are kept separate, with no override.
- What you can't do is hidden. A disabled control always shows its reason.
- A project 403 screen with request and withdraw access.
- A dev role switcher covering all 7 default roles. The e2e suite asserts the hiding for each of them.

**Shell**
- Sidebar with a collapsible rail, a drawer on smaller screens, and an animated sub-nav indicator.
- Top bar with breadcrumbs, and an offline banner.
- Session-expired modal.

**Shortcuts and palette**
- Global shortcuts: `C`, `[`, `⌘/Ctrl B`, `?`, `G B / G L / G S`, `⌘/Ctrl K`. Shortcuts are shown in tooltips.
- Command palette with recent, tasks, projects, people and actions, the `>` `#` `@` prefixes, and a preview pane.

**Screens, in brief order**
- **Auth:** login, register, forgot and reset password, accept invite.
- **Onboarding.**
- **Workspace home:** My work grouped by due date, projects with sprint progress, activity.
- **My tasks** (views: open, due, bugs, done; works for any assignee) and **global search**.
- **Project overview:** KPIs, objectives, milestone timeline, epics, sprint burndown, activity, setup checklist.
- **Board:** dnd-kit drag with lift/tilt, reflow and drop highlight, and fractional positions. Sends `version` on moves and shows a conflict toast. Polls every 30 s and fires a spark animation on completion.
- **Task detail** as a side panel with a card-to-panel morph, as a full page, and as a mobile bottom sheet:
  - inline editing of every field;
  - Tiptap descriptions and comments with code blocks and @mentions, rendered through a safe JSON-to-React renderer (no `innerHTML`);
  - subtasks, attachments and activity.
- **List view:** virtualized, grouped, with bulk actions.
- **Backlog and sprint planning:** start, complete with carry-over, and edit sprints.
- **Objectives and milestones.**
- **Reports:** burndown, velocity, cycle time, throughput, progress and KPI tiles.
- **Members and roles:** invites, a role editor and the permission matrix.
- **Notifications:** inbox, plus email preferences. Telegram, SMS and Push show as "Coming soon".
- **Settings:** workspace general, profile, and project settings.
- **Edge screens:** 404, 403 and 500 with a reference id, and a global error fallback.

**Quality**
- Loading, empty and error states on every screen.
- Only transform and opacity are animated.
- Accessibility: focus rings, ARIA roles and labels, and editable titles keep their heading semantics.
- Responsive down to 390 px: drawer, bottom sheet and scrollable tabs.
- Code splitting: per route, and the task detail (Tiptap), palette, create-task and shortcuts overlays load lazily.
- Memoised board cards.

---

## 2. Dependencies added beyond the brief's stack

| Package | Reason |
|---|---|
| `@radix-ui/react-{dialog,dropdown-menu,popover,tooltip,slot}` | Accessible primitives: focus trapping, roving focus, typeahead and ARIA for menus, dialogs and tooltips. cmdk already depends on Radix Dialog. Styled entirely with our tokens. |
| `@tanstack/react-virtual` | The brief requires virtualized long lists (list view). |
| `clsx`, `tailwind-merge` | Class composition with Tailwind conflict resolution in the `cn()` helper. Tiny. |
| `@tiptap/extension-{mention,placeholder}`, `@tiptap/suggestion`, `@hookform/resolvers` | Parts of the chosen Tiptap and react-hook-form + zod stack, not new libraries. |

---

## 3. Design / docs conflicts

The rule applied was: docs win for behaviour, design wins for appearance.

1. **`/docs` did not exist.** There was no data-model, permission or API document. The build brief was treated as
   the behavioural spec, and the assumed contract was written to `docs/api-contract.md` (see §5).
2. **Permission keys and role names.** The design boards use their own permission names and the roles
   Guest/Contributor/Observer. The brief's catalogue and its 7 default roles are used instead. The design's
   permission-matrix grouping and layout are kept.
3. **Project "Timeline" tab** (design) vs the brief's "no timeline/calendar views in v1": the tab is hidden. The
   milestone timeline strip on Overview and Milestones is kept, because it is a progress visual, not a scheduling view.
4. **"Blocked" pinned view** (design) depends on task dependencies, which are v2. Dropped.
5. **"Import CSV"** (design, new-project flow) is v2 import. Omitted.
6. **Members & roles** is a single page in the design, but the brief's routes require separate `settings/members` and
   `settings/roles`. Built as two pages that share a header and a tab strip.

## 4. Design deviations (appearance or behaviour)

- `cacheComponents` (Next 16 Activity route preservation) is **off**. Preserved hidden routes kept their overlays and
  hotkey listeners alive, which broke the panel morph and global shortcuts.
- **Google SSO** button: shown, but disabled with the reason "Coming soon". It isn't in the contract.
- **Onboarding invite step:** only Member and Admin can be chosen. Owner can't be assigned, and project roles are given per project.
- **Notifications** page: the page header and the inbox toolbar make two stacked bars, where the design merges them.
- **Reports export:** the PNG and PDF items show as "Coming soon". CSV export works.
- **Inbox** loads the most recent page and has no infinite scroll.
- **Workspace home and My tasks** aren't fully specified in the design. They are composed from the design's list-row,
  panel and card patterns.
- **Search results page** isn't in the design either. The palette is the designed path, and `/[workspace]/search` reuses its row anatomy.

---

## 5. Requested API additions

`docs/api-contract.md` was written from the brief, so **the whole contract needs backend confirmation**. These
items were needed by the designed screens and go beyond what the brief names. All are implemented in the mock.

**Endpoints the client calls, implemented in the mock**

| Method | Path | Needed for |
|---|---|---|
| GET | `/workspaces/:slug/project-directory` | 403 screen context (project admins), and "assign project admin" |
| GET | `/projects/:id/access-requests` | Pending requests for project admins |
| DELETE | `/projects/:id/access-requests/mine` | Withdraw my request |
| GET | `/projects/:id/active-sprint` | Sidebar sprint card, home project cards |
| GET | `/tasks/:id/attachments` | Attachment list with fresh signed URLs |
| GET | `/me/recents` | Palette "Recent" section |
| GET | `/projects/:id/reports/kpis` | Reports KPI tiles |
| GET | `/notifications?filter[workspace]=` + `counts` | Workspace-scoped inbox and tab counters |
| POST | `/notifications/read-all` (`{ ids }`, returns changed ids; `{ ids, unread: true }` undoes) | Mark all read, with undo |
| GET | `/workspaces/:slug/tasks?filter[assignee]=` | Another person's tasks (palette → person) |
| POST | `/tasks/:id/restore`, `POST /projects/:id/tasks/bulk` | Undo delete; list-view bulk actions |

**Avatar upload (stopgap):** the profile page validates the image (PNG/JPG/WebP, 2 MB max) and sends it as a
data URL in `PATCH /auth/me { avatarUrl }`. That's fine for the mock, but live mode needs a signed-upload
endpoint for avatars (like attachments), so the client can send a URL instead.

**Needed by the design, with no client call yet** (the related control is hidden, omitted, or shown as
"Coming soon" until the backend confirms an endpoint):

- Deny a project access request.
- Restore a deleted workspace during a grace period.
- Change a pending invite's role.
- "Request a different role" for read-only users.
- Report PNG/PDF export jobs.
- Google OAuth.

**Fields**

- `Role.systemKey` and `Role.assignable`.
- `Workspace.taskCount`.
- `Milestone.taskIds` and `Milestone.ownerId`.
- `ProgressRow.dueDate`.
- `Report.completedSprints`.
- `Invite.{inviterHue, roleDescription, inviteeName}`.
- `Notification.{glyph, category}`.
- Search task results include `status { name, glyph }`.
- Paging beyond 500 items for the board and milestone task lists.

---

## 6. Known gaps

- **Live mode is untested against a real backend,** because none was available. The HTTP transport, refresh/retry
  logic and query-string format have unit tests, and everything else was proven in mock mode only.
- **Virtualization:** only the list view is virtualized. The backlog and inbox render every row. This is fine for the
  seeded sizes, but they need virtualization or paging for large projects.
- **Mock search** uses substring matching with no ranking, and the result tabs count only the current result set.
- **Not-found outside a workspace:** an unknown path like `/platform/nope/x` gets the stand-alone 404 without the
  shell. Known-shape paths with a bad id (an unknown project or task) do get the in-shell 404.
- **Onboarding** wasn't part of the automated sweep. It needs a user with no workspace, which you get by registering
  a new account in mock mode. It was checked by hand during its build step.
- **Test depth:** the unit tests cover the domain logic (progress, fractional positions, list model, permissions,
  mock API, hotkeys, transports, forms). Screens are covered by the e2e smoke suite and the screenshot sweep, not by
  per-screen component tests.
- **Design mismatches still open:** the notification double header (§4).
