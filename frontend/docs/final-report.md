# Lightex frontend — final report

**Status:** all brief steps (plan → foundation → data layer → shell → screens → polish) are done and committed.
Each step passed its checks before it was committed.

| Check | Result |
|---|---|
| `npm run build` | passes |
| `npm run typecheck` | clean (TypeScript strict) |
| `npm run lint` | 0 errors, 1 warning (expected React Compiler note on TanStack Virtual's `useVirtualizer`) |
| `npm test` | 52 files, 814 tests passing (after board 38; run with `--maxWorkers=2` on this machine) |
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
- **Notifications:** inbox, plus preferences. Since v2 board 38 (§8): Telegram, SMS and Web Push channels, a 6 × 5
  preference matrix and quiet hours.
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

Board 33 (realtime, dashboards) adds **no** dependency: the SSE parser is hand-written, the stream uses `fetch`,
leader election uses the Web Locks and BroadcastChannel browser APIs (with a per-tab fallback), drag and resize are
pointer events, and the widget charts reuse Recharts.

Board 37 (integrations) adds **no** dependency: key matching, branch names and the connect fragment are plain
TypeScript, and the Create branch popover reuses Radix Popover.

Board 38 (notification channels) adds **no** dependency. The spec (§8.10) proposes **`uqr`** (unjs, zero-dependency,
~12 KB min, lazily loaded with the Telegram dialog) to draw the Telegram QR code. **Pending the user's decision; not
installed.** Until it is approved the dialog has no QR (a TODO marks the spot in `telegram-dialog.tsx`); the
"Open Telegram" deep link and the 6-character code cover every device. SHA-256 (the push "this browser" hash), the
service worker and the OTP input are plain code.

---

## 3. Design / docs conflicts

The rule applied was: docs win for behaviour, design wins for appearance.

1. **`/docs` did not exist.** There was no data-model, permission or API document. The build brief was treated as
   the behavioural spec, and the assumed contract was written to `docs/api-contract.md` (see §5).
2. **Permission keys and role names.** The design boards use their own permission names and the roles
   Guest/Contributor/Observer. The brief's catalogue and its 7 default roles are used instead. The design's
   permission-matrix grouping and layout are kept.
3. **Project "Timeline" tab** (design) vs the brief's "no timeline/calendar views in v1": the tab was hidden in v1.
   **Back in v2** (board 32, §8): Timeline and Calendar are project tabs after Backlog. The milestone timeline strip
   on Overview and Milestones is unchanged (a progress visual, not a scheduling view).
4. **"Blocked" pinned view** (design) depends on task dependencies, which were v2. Dropped in v1; **back in v2**
   (board 39, §8) as a seeded personal saved view "Blocked" (`blocked is true`) for every PRJ member.
5. **"Import CSV"** (design, new-project flow) was v2 import, omitted in v1. **Back in v2** (board 40, §8): a fresh
   project's overview checklist offers "Import CSV" next to "New task" (contract E1); the wizard doesn't create
   projects.
6. **Members & roles** is a single page in the design, but the brief's routes require separate `settings/members` and
   `settings/roles`. Built as two pages that share a header and a tab strip.

## 4. Design deviations (appearance or behaviour)

- `cacheComponents` (Next 16 Activity route preservation) is **off**. Preserved hidden routes kept their overlays and
  hotkey listeners alive, which broke the panel morph and global shortcuts.
- **Google SSO** button: works in live mode (see §5). The mock has no Google, so there it is disabled with the reason
  "Available with the live API".
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
| POST | `/projects/:id/access-requests/:requestId/deny` | Decline a request (Members tab); the backend already serves it |
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

- Restore a deleted workspace during a grace period.
- Change a pending invite's role.
- "Request a different role" for read-only users.
- Report PNG/PDF export jobs.

**Google sign-in (live mode only, added with the backend):** `GET /auth/google/start?next=` is a page navigation,
not a fetch, so it has no mock implementation; the button is disabled in mock mode instead. The API redirects to
Google, then back to `next` with the refresh cookie set, and the session restores like on any page load. On
failure it returns to `/login?error=google|google_cancelled|google_unavailable`, which the login form turns into a
banner (none for a cancel). Built from `api.auth.googleStartUrl()`.

**Fields**

- `Role.systemKey` and `Role.assignable`.
- `Workspace.taskCount`.
- `Milestone.taskIds` and `Milestone.ownerId`.
- `ProgressRow.dueDate`.
- `Report.completedSprints`.
- `Invite.{inviterHue, roleDescription, inviteeName}`.
- `Notification.{glyph, category}`.
- `User.hasPassword`, only on the signed-in user (`/auth/me` and sign-in responses). It is false for accounts
  made with Google sign-in: Profile shows "Set password" (no current password; `PUT /auth/me/password` accepts a
  missing `currentPassword` for them), and the session-expired dialog offers Google instead of a password field.
- `Notification.type: "access"` with `payload.projectKey` (+ the request message as `payload.quote`): a project
  access request, sent in-app and by email (`access_request` template) to the project's member managers and lead.
  It has no preferences row, so it can't be switched off. Workspace access requests are email-only, because
  in-app notifications always belong to a project.
- Search task results include `status { name, glyph }`.
- Paging beyond 500 items for the board and milestone task lists.

### v2 · Board 39: custom fields, dependencies, time tracking

The contract is `docs/v2/39-fields-dependencies-time.md` (repo root); the backend builds the same document in
parallel. Every item below is typed in `src/lib/api/types.ts`, has an `endpoints.ts` function and a `qk` key, and is
implemented in the mock (`src/lib/mock/handlers/extensions.ts`, tested in `src/lib/mock/extensions.test.ts`).

**Endpoints**

| # | Method | Path | Permission | Client |
|---|---|---|---|---|
| F1 | GET | `/projects/:id/custom-fields` | `project.view` | `api.customFields.list` · `qk.customFields` |
| F2 | POST | `/projects/:id/custom-fields` | `field.manage` | `api.customFields.create` |
| F3 | PATCH | `/custom-fields/:fieldId` (options = complete ordered list; removed options clear their values) | `field.manage` | `api.customFields.update` |
| F4 | DELETE | `/custom-fields/:fieldId` (hard delete; client waits out a 5 s Undo first) | `field.manage` | `api.customFields.remove` |
| F5 | PUT | `/projects/:id/custom-fields/order` `{ ids }` | `field.manage` | `api.customFields.reorder` |
| T1 | PATCH | `/tasks/:id` gains `customFields` (merge, `null` clears) and `timeEstimateMinutes` | v1 edit rule | `api.tasks.update` |
| D1 | GET | `/tasks/:id/dependencies` | `project.view` | `api.dependencies.list` (data also embedded in `TaskDetail`) |
| D2 | POST | `/tasks/:id/dependencies` `{ relation, taskId }` → 201 `TaskDependencies` | can edit `:id` | `api.dependencies.add` |
| D3 | DELETE | `/tasks/:id/dependencies/:dependencyId` | can edit either task | `api.dependencies.remove` |
| E1 | GET | `/tasks/:id/time-entries` | `project.view` | `api.time.entries` · `qk.timeEntries` |
| E2 | POST | `/tasks/:id/time-entries` `{ minutes, date, note }` | `time.log` | `api.time.log` |
| E3 | DELETE | `/time-entries/:entryId` | own + `time.log`, or `time.delete_any` | `api.time.remove` |
| R1 | GET | `/me/timer` → `{ timer }` | signed in | `api.time.timer` · `qk.myTimer` |
| R2 | POST | `/tasks/:id/timer` `{ date }` → `{ timer, stopped }` (switching logs the old timer) | `time.log` | `api.time.startTimer` |
| R3 | POST | `/me/timer/stop` `{ date, note }` → `{ entry }` | `time.log` | `api.time.stopTimer` |
| S1 | GET | `/workspaces/:slug/timesheet?filter[week]=&filter[project]=` | workspace member | `api.time.timesheet` · `qk.timesheet` |
| — | GET | `/projects/:id/tasks?filter[blocked]=true\|false` | `project.view` | (mock + contract; the UI filters client-side) |

Error codes the client handles: 422 `validation_failed` with the §4 messages, 409 `field_limit`,
`dependency_exists`, `dependency_cycle` (`details.path`, shown in a toast), `dependency_limit`, `task_deleted`,
and 403 / 409 on timer stop (timer discarded).

**Fields**

- `Task.customFields`, `Task.isBlocked`, `Task.openBlockers[]`, `Task.timeEstimateMinutes`, `Task.loggedMinutes` on
  every task payload; `TaskDetail.dependencies`.
- `TaskPatch.customFields`, `TaskPatch.timeEstimateMinutes` (not accepted by create or bulk).
- New types `CustomField`, `CustomFieldOption`, `CustomFieldInput/Patch`, `TaskDependencies`, `DependencyItem`,
  `TimeEntry`, `RunningTimer`, `Timesheet` (+ rows, cells, slices), `FIELD_COLORS` (the 8-token palette).
- Permissions `field.manage`, `time.log`, `time.delete_any` in `PROJECT_PERMISSIONS` (exact §3.3 order) and the
  catalogue; default roles: Project Admin and Manager get all three, project Member gets `time.log`.
- `ActivityVerb` gains `dependency_added` and `dependency_removed`; new audit actions
  `task.dependency_added|removed`, `task.time_logged`, `task.time_entry_deleted`,
  `project.custom_field_created|updated|deleted`, `project.custom_fields_reordered`.
- Saved-view rules: `FilterField` gains `blocked` and `cf.<fieldId>`; `FilterOp` gains `set`, `gt`, `lt`. The server
  drops `cf` rules for unknown fields or ops that don't suit the type, ignores rules on fields deleted after saving,
  and counts views on the derived task (`isBlocked`, `customFields`).

### v2 · Board 32: timeline & calendar

The contract is `docs/v2/32-timeline-calendar.md` (repo root). **No new endpoint**: board 32 adds fields, filters, a
sort key and validation to existing endpoints. Every item is typed in `src/lib/api/types.ts`, reachable through
`endpoints.ts` / `qk`, and implemented in the mock (`src/lib/mock/handlers/schedule.ts`, wired into `tasks.ts` and
`planning.ts`; tested in `src/lib/mock/schedule.test.ts`).

**Fields**

- `Task.startDate: ISODate | null` on every task payload (lists, board, backlog, my tasks, workspace tasks, sprint
  board, bulk, PATCH / move responses, `version_conflict.details.current`, search task results, `TaskDetail`).
  Effective span = `[startDate ?? dueDate, dueDate ?? startDate]`; neither = unscheduled.
- `TaskPatch.startDate` and `TaskCreate.startDate` (the create dialog doesn't show it; contract §9 #7).
- `Epic.startDate`, `Epic.dueDate` (UI "Start" / "Target"; both or neither) on every epic payload;
  `EpicWrite.startDate` / `dueDate` on `POST /projects/:id/epics` and `PATCH /epics/:id`.
- Client-only types `TimelineZoom`, `TimelineGroup`, `CalendarMode`.

**Filters and sort on `GET /projects/:id/tasks`** (combine with every v1 filter, `q`, `sort`, `cursor`, `limit`)

| Parameter | Value | Meaning | Client |
|---|---|---|---|
| `filter[from]` | `ISODate` | span ends on or after `from` | `api.tasks.range` · `qk.schedule` |
| `filter[to]` | `ISODate` | span starts on or before `to` (with `from`: inclusive overlap) | `api.tasks.range` · `qk.schedule` |
| `filter[scheduled]` | `true` / `false` | at least one date / neither | `api.tasks.unscheduled` · `qk.unscheduled` |
| `sort` | `startDate` / `-startDate` | missing dates last ascending, first descending (the mock applies the same to `dueDate`) | `api.tasks.range` |
| `limit` | ≤ 500 | the range query pages at 500 (the mock's cap for this list rose from 200 to 500) | up to 4 pages = 2,000 tasks |

**Validation (422 `validation_failed`, `details.fields`)**

- Query: `filter[from]` / `filter[to]` "Pick a date"; `filter[to]` "End must be on or after the start" and
  "Pick a range of 400 days or less"; `filter[scheduled]` "Use true or false".
- `PATCH /tasks/:id`, `POST /projects/:id/tasks`: `startDate` / `dueDate` "Pick a date"; order checked on the
  resulting pair: `startDate` "Start date must be on or before the due date" (start sent) or `dueDate` "Due date must
  be on or after the start date" (only due sent). A dates-only PATCH is not status-only, so `task.move` alone is refused.
- `POST /projects/:id/tasks/bulk`: `patch.startDate` "This field can’t be bulk-edited"; a `patch.dueDate` before any
  selected task's start fails the whole request with `patch.dueDate` "PRJ-42 starts after this date" (first key by
  number); `patch.dueDate: null` is allowed. (The mock's bulk now applies `patch.dueDate`; it ignored it before.)
- Epics: "Pick a date"; `startDate` "Set both dates or neither"; `dueDate` "Target date must be on or after the start
  date". `{ startDate: null, dueDate: null }` clears both. No `version` (last write wins).

**Seed / upgrade:** `ensureExt32` (marker `ext32`, no `SCHEMA` bump) fills the contract's PRJ start dates only where
the start is empty and the due date still equals the seeded one, sets the four design epic dates, and adds the
dependency PRJ-50 → PRJ-52 (a non-conflict arrow next to the PRJ-48 → PRJ-42 conflict).

**Shared test vectors:** `src/features/schedule/span-vectors.json` (20 cases) drives both the client `inRange` test
and the mock filter test. The contract wants the backend copy at `backend/apps/tasks/tests/data/span_vectors.json`;
that path is the backend's to add (this frontend change doesn't touch `backend/`).

### v2 · Board 40: import wizard

The contract is `docs/v2/40-import-wizard.md` (repo root). Every item is typed in `src/lib/api/types.ts`, reachable
through `endpoints.ts` (`api.imports.*`, `uploadImportFile` in `uploads.ts`) and `qk` (`imports`, `importJob`,
`importRows`), and implemented in the mock (`src/lib/mock/handlers/imports.ts` + `src/lib/mock/import/*`; tested in
`src/lib/mock/imports.test.ts` and `src/lib/mock/import/import.test.ts`).

**Endpoints** (all under `/api/v1`; same codes and messages as the contract)

| # | Method | Path | Permission | Response | Client |
|---|---|---|---|---|---|
| I1 | POST | `/projects/:id/imports` `{ source, fileName, size }` | `project.import` + `task.create` | 201 `{ job, upload: UploadTicket }` (`Content-Type: text/csv`) | `api.imports.create` |
| — | PUT | `upload.url` (signed storage URL, not the API) | signature | 200 | `putToSignedUrl` (existing, incl. `mock-upload://`) |
| I2 | POST | `/imports/:id/analyze` | creator | 200 `ImportJob` (`ready`) | `api.imports.analyze` |
| I3 | GET | `/imports/:id` | `project.import` | 200 `ImportJob` (polled 1 s while queued / running) | `api.imports.get` · `qk.importJob` |
| I4 | PUT | `/imports/:id/mapping` (whole mapping, `revision` + 1) | creator | 200 `ImportJob` | `api.imports.saveMapping` |
| I5 | GET | `/imports/:id/rows` `filter[outcome]`, `limit` ≤ 100, `cursor` | `project.import` | 200 `Paginated<ImportRowPreview>` | `api.imports.rows` · `qk.importRows` |
| I6 | POST | `/imports/:id/start` (also the retry of a failed job) | creator | 202 `ImportJob` (`queued`) | `api.imports.start` |
| I7 | POST | `/imports/:id/cancel` | creator or `project.update` | 200 `ImportJob` | `api.imports.cancel` |
| I8 | GET | `/imports/:id/error-report` | `project.import` | 200 `{ url, fileName, expiresAt }` | `api.imports.errorReport` |
| I9 | GET | `/projects/:id/imports` | `project.import` + `task.create` | 200 `ImportJobSummary[]` (newest 20, no drafts) | `api.imports.list` · `qk.imports` |

**Types:** `ImportSource`, `ImportPreset`, `ImportStatus`, `ImportField`, `ImportTaskType`, `ImportColumnType`,
`ImportDateOrder`, `ImportTimeUnit`, `ImportFileInfo`, `ImportColumn`, `ImportColumnMapping`, `ImportMapping`,
`ImportValue`, `ImportBlocker(Code)`, `ImportValidation`, `ImportIssue`, `ImportOutcome`, `ImportRowValues`,
`ImportRowPreview`, `ImportLogLine`, `ImportProgress`, `ImportResult`, `ImportJob`, `ImportJobSummary` (§6.1 shapes).

**Changed payloads (additive)**

- New project permission `project.import` (group Tasks, "Import tasks"), placed after `task.move` in
  `PROJECT_PERMISSIONS` and `my_permissions`; granted to the Project Admin, Manager and Member system roles, not
  Viewer. Cached mock databases get it through `ensureExt40` (marker `ext40`, custom roles untouched).
- `Project.nextTaskNumber` (`task_seq + 1`) on every project payload: the picker's next key (`PRJ-73`).
- `NotificationType` gains `"import"`; `Notification.payload` gains `importId`, `imported`, `skipped`,
  `importStatus` (+ the existing `projectKey`). One in-app row to the job's creator, no email, no preference row.
- `ActivityVerb` gains `"imported"` (`project.import_completed` in project / workspace feeds; `task.imported` in the
  task's own feed only).
- `AuditEntry.source` gains `"import"`; new audit actions `project.import_started`, `task.imported`,
  `project.import_completed` (plus `label.created`, `epic.created`, `project.custom_field_updated` from the run).

**Errors:** 422 `validation_failed` with `details.fields` (I1 `source` / `file`; I2 `file` + `details.file.reason`
from the §4.3 table; I4 `columns`, `columns.N.field|customFieldId`, `statuses.<key>`, `types.<key>`,
`people.<key>`; I6 `mapping` + `details.blockers`); 403 `forbidden` with `details.permission` (or none for "Only the
person who started this import can change it."); 409 `import_state`, `mapping_conflict` (`details.current`),
`import_in_progress` (`details.jobId`); 404 "This import has no error report."; 429 `rate_limited` (20 jobs / hour).

**Mock specifics:** 1,000-row cap (`too_many_rows` with `details.file.mock: true`, meta "1,240 rows · max 1,000 in
the mock API"); parsed rows live in memory only, so a reload fails `ready` / `queued` / `running` jobs with
`file_missing`; the runner ticks every 150 ms, 4 rows per tick; the report is a `blob:` URL revoked after 60 s.

**Shared test vectors and fixtures** (the contract puts the backend copies under
`backend/apps/imports/tests/data/`; this change doesn't touch `backend/`):

- `src/lib/mock/import/fixtures/import_vectors.json`: decoding, delimiter sniffing, parsing, header synonyms,
  suggestions, presets, status / type / people / priority matching, dates and `dateOrder`, numbers, durations,
  `csv_safe`.
- `src/lib/mock/import/fixtures/jira-export.csv` (the contract's 6-row Jira export) and
  `src/lib/mock/import/fixtures/sample.ts` (the design's 48-row sample).
- `public/import-template.csv`: the live-mode "Download template" file.

### v2 · Board 33: dashboards, presence and realtime

The contract is `docs/v2/33-dashboards-presence.md` (repo root). Every item is typed in `src/lib/api/types.ts` and
`src/lib/realtime/events.ts`, reachable through `endpoints.ts` (`api.dashboards.*`, `api.reports.workload`,
`api.presence.*`, `api.realtime.streamPath`) and `qk` (`dashboards`, `dashboard`, `presence`, `myProjectTasks`), and
implemented in the mock (`src/lib/mock/handlers/dashboards.ts`, `handlers/presence.ts`, `mock/realtime.ts`; tested in
`src/lib/mock/dashboards.test.ts`).

**Endpoints** (all under `/api/v1`; same codes and messages as the contract)

| # | Method | Path | Permission | Response | Client |
|---|---|---|---|---|---|
| DB1 | GET | `/projects/:id/dashboards` | `project.view` | 200 `DashboardSummary[]` (shared A–Z, then your personal A–Z) | `api.dashboards.list` · `qk.dashboards` |
| DB2 | POST | `/projects/:id/dashboards` `{ name, visibility, template? }` | `dashboard.create` | 201 `Dashboard` (`version: 1`) | `api.dashboards.create` |
| DB3 | GET | `/dashboards/:id` | can_view (someone else's personal → 404) | 200 `Dashboard` (every widget) | `api.dashboards.get` · `qk.dashboard` |
| DB4 | PATCH | `/dashboards/:id` `{ name?, visibility?, version }` | can_edit (visibility: owner + `dashboard.create`) | 200 `Dashboard` | `api.dashboards.update` |
| DB5 | PUT | `/dashboards/:id/layout` `{ version, widgets }` (the complete ordered list) | can_edit | 200 `Dashboard` | `api.dashboards.saveLayout` |
| DB6 | DELETE | `/dashboards/:id` | can_edit | 204 (sent when the 5 s Undo toast expires) | `api.dashboards.remove` |
| W1 | GET | `/projects/:id/reports/workload` `filter[sprint]`, `filter[unit]=points\|hours`, `filter[person]=assignee\|<customFieldId>` | `report.view` | 200 `WorkloadReport` (hours in minutes) | `api.reports.workload` · `qk.reports(id, "workload", sprint, unit, person)` |
| P1 | PUT | `/workspaces/:slug/presence/:sessionId` `{ location, state, field, typing }` | member + `project.view` on the location | 200 `{ expiresAt, heartbeatSec, roster }` (the whole project's roster) | `api.presence.put` |
| P2 | DELETE | `/workspaces/:slug/presence/:sessionId` | member | 204, idempotent (`fetch` `keepalive` on `pagehide`) | `api.presence.leave` |
| P3 | GET | `/workspaces/:slug/presence?filter[project]=` | `project.view` | 200 `PresenceRoster` | `api.presence.roster` · `qk.presence` |
| S1 | GET | `/workspaces/:slug/stream?v=1` (`Accept: text/event-stream`, `Authorization: Bearer`, `Last-Event-ID`) | member | 200 `text/event-stream` | `src/lib/realtime/http-source.ts` |

**Types:** `WidgetType`, `WidgetConfigMap`, `DashboardWidget`, `DashboardWidgetInput`, `DashboardVisibility`,
`DashboardTemplate`, `Dashboard`, `DashboardSummary`, `WorkloadRow`, `WorkloadReport`, `PresenceLocationKind`,
`PresenceLocation`, `PresencePerson`, `PresenceRoster`, `PresenceUpdate`, `PresenceHeartbeat` (§5.1, §5.3, §7.2); the
envelope `RealtimeEnvelope`, the `RealtimeEvent` union and `RealtimeStatus` (§2.4).

**Event catalogue (protocol v1, §2.4):** `hello`; `reset` (`unknown_cursor | gap | slow_consumer | broker_restart`);
`reconnect` (`lifetime | token_expiry | access_changed | shutdown`, `retryMs`); the durable `task.changed` (`taskId,
key, op, version, fields`), `tasks.bulk_changed` (`taskIds | null, op`), `comment.changed`, `attachment.changed`,
`project.changed` (`areas`), `dashboard.changed` (`dashboardId, op, version`), `inbox.changed` (`unread`) and
`access.changed` (`projectId`); the volatile `presence.updated` (`location, people, at`). `import.progress` is
reserved and not used. Unknown types and fields are ignored.

**Changed payloads (additive)**

- New project permissions `dashboard.create` ("Create dashboards") and `dashboard.manage` ("Manage shared
  dashboards"), group Reports, right before `report.view` in the catalogue, `PROJECT_PERMISSIONS` and
  `my_permissions` (the §4.4 order). Project Admin and Manager get both, Member gets `dashboard.create`, Viewer neither.
  Cached mock databases get them through `ensureExt33` (marker `ext33`, custom roles untouched).
- `ProgressRow.quarter` (`string | null`; null on milestone rows) on `GET /projects/:id/reports/progress`.
- Audit actions `dashboard.created`, `dashboard.updated`, `dashboard.layout_updated` and `dashboard.deleted` (entity
  type `dashboard`; audit only, not in activity feeds).
- `RequestOptions.keepalive` (passed to `fetch` by `HttpTransport`, ignored by the mock).

**Errors:** 422 `validation_failed` with `details.fields` (DB2 / DB4 `name`, `visibility`, `template`; DB5 `widgets`,
`widgets.N.id|type|w|h` and `widgets.N.config.<key>` with the §3.3 messages, plus "You can’t view this report"; W1
`filter[unit]`, `filter[person]`; P1 `location.kind`, `location.id`, `state`, `field`, `typing`; P3
`filter[project]`); 409 `version_conflict` with `details.current` (DB4, DB5); 409 `dashboard_limit` (20 shared per
project, 10 personal per user per project); 403 `forbidden` with `details.permission` (`dashboard.create` or
`dashboard.manage`, and "Only the owner can change who sees this dashboard."); 404 "Dashboard not found." and "Sprint
not found.". Stream errors before streaming: 401, 404, 406, 429 `throttled` with `Retry-After`, and 503
`realtime_unavailable` / `realtime_busy` with `Retry-After`.

**Also needed from the backend for a cross-origin frontend:** `last-event-id` in `CORS_ALLOW_HEADERS` (§2.9), and
`Retry-After` in `Access-Control-Expose-Headers`, so the client can read the 503 / 429 back-off. Without the second,
the client uses its own exponential backoff.

**Mock specifics:** presence sessions live in memory only (never in `lightex-mock-db`). `MockRealtimeSource` plays
the stream in-process, with no network: hello, replay from the last 500 durable events (an older cursor gets
`reset`), a ping every 15 s, and `reconnect` after 5 minutes. The mock control "Realtime: polling" answers
`realtime_unavailable` with `Retry-After: 300`, and the loop is woken at once when the control changes back. The
presence field pattern also accepts `_`, because mock ids contain it (`cf.p_prj-cf-qaowner`).

**Shared test vectors:** `src/features/dashboards/pack-vectors.json` (first-fit packing, §8.3). The backend copy is
`backend/apps/dashboards/tests/pack_vectors.json`; `src/features/dashboards/layout-lib.test.ts` hashes both and fails
when they differ (they are identical today).

### v2 · Board 37: integrations & development (GitHub and GitLab)

The contract is `docs/v2/37-integrations-github-gitlab.md` (repo root). Every item is typed in `src/lib/api/types.ts`
and `src/lib/realtime/events.ts`, reachable through `endpoints.ts` (`api.integrations.*`, `api.development.*`) and
`qk` (`integrations`, `availableRepos`, `development`, `devRules`), and implemented in the mock
(`src/lib/mock/handlers/integrations.ts`, `src/lib/mock/dev-derive.ts`; tested in `src/lib/mock/integrations.test.ts`).

**Endpoints** (all under `/api/v1`; same codes and messages as the contract)

| # | Method | Path | Permission | Response | Client |
|---|---|---|---|---|---|
| G1 | GET | `/workspaces/:slug/integrations` | member | 200 `IntegrationsOverview` (non-managers: no `manageUrl`, no repositories scoped only to projects they can't view) | `api.integrations.overview` · `qk.integrations` |
| G2 | POST | `/workspaces/:slug/integrations/github/connect` `{}` | `integration.manage` | 200 `{ authorizeUrl }`; 503 `integrations_unavailable` | `api.integrations.connectGitHub` |
| G3 | POST | `/workspaces/:slug/integrations/gitlab/connect` `{ method: "oauth" }` or `{ method: "token", baseUrl, token }` | `integration.manage` | 200 `{ authorizeUrl }` · 201 `Integration` (token); 422 `baseUrl` / `token`; 409 `integration_exists` (`details.integrationId`) | `api.integrations.connectGitLab` |
| G4 | GET | `/integrations/github/setup` | browser, `state` | 302 (browser only; the client never calls it) | — |
| G5 | GET | `/integrations/{github,gitlab}/callback` | browser, `state` | 302 → `/<slug>/settings/integrations#connect=<attempt>.<token>` or `#connect_error=<code>` | read by `IntegrationsScreen` |
| G6 | POST | `/workspaces/:slug/integrations/confirm` `{ attempt, token }` | `integration.manage` (re-checked) | 200 `Integration`; any mismatch 404 | `api.integrations.confirm` |
| G7 | GET | `/integrations/:id` | member | 200 `Integration` | `api.integrations.get` |
| G8 | GET | `/integrations/:id/available-repositories?q=` | `integration.manage` | 200 `AvailableRepository[]`; 409 `integration_error`; 502 `provider_failed` | `api.integrations.availableRepositories` · `qk.availableRepos` |
| G9 | PUT | `/integrations/:id/repositories` `{ repositories: [{ externalId, projectIds? }] }` (the complete set, 1–200) | `integration.manage` | 200 `Integration`; 422 `repositories`, `repositories.N.externalId`, `repositories.N.projectIds` | `api.integrations.setRepositories` |
| G10 | PATCH | `/repositories/:id` `{ projectIds }` (`[]` = all projects) | `integration.manage` | 200 `Repository` | `api.integrations.scopeRepository` |
| G11 | POST | `/integrations/:id/sync` | `integration.manage` | 202 `Integration` (`syncing: true`); 429 `sync_throttled` (`details.nextSyncAt`, `Retry-After`); 409 `integration_error` | `api.integrations.sync` |
| G12 | POST | `/integrations/:id/reconnect` `{}` or `{ token }` (GitLab token) | `integration.manage` | 200 `{ authorizeUrl }` · 200 `Integration`; 422 `token` | `api.integrations.reconnect` |
| G13 | DELETE | `/integrations/:id` | `integration.manage` | 204 (links stay on tasks) | `api.integrations.disconnect` |
| W1 / W2 | POST | `/webhooks/github`, `/webhooks/gitlab/:integrationId` | signature / token | provider-facing only; the client never calls them | — |
| D1 | GET | `/tasks/:idOrKey/development` | `project.view` | 200 `TaskDevelopment` | `api.development.get` · `qk.development` |
| D2 | POST | `/tasks/:idOrKey/development/links` `{ url }` | `development.link` | 201 `DevItem` (200 when already linked); 422 `url` | `api.development.link` |
| D3 | DELETE | `/tasks/:idOrKey/development/links/:linkId` | `development.link` | 204 (manual → deleted, auto / created → suppressed) | `api.development.unlink` |
| D4 | POST | `/tasks/:idOrKey/development/branches` `{ repositoryId, name }` | `development.link` | 201 `DevBranch`; 422 `name` / `repositoryId`; 409 `branch_exists` | `api.development.createBranch` |
| A1 | GET | `/projects/:id/dev-automation` | `project.view` | 200 `DevAutomationRule[]` (always the three triggers, in order) | `api.development.rules` · `qk.devRules` |
| A2 | PUT | `/projects/:id/dev-automation` (the same array) | `status.manage` | 200 `DevAutomationRule[]`; 422 `rules.N.statusId` ("Choose a status." / "Pick a Done status.") | `api.development.setRules` |

**Types:** `Provider`, `IntegrationErrorCode`, `ProviderInfo`, `RepoVisibility`, `Repository`, `Integration`,
`AvailableRepository`, `IntegrationsOverview`, `RepoRef`, `DevAuthor`, `CheckState`, `DevCheck`, `DevLinkSource`,
`DevPullRequest`, `DevBranch`, `DevCommit`, `DevItem`, `DevRepositoryOption`, `TaskDevelopment`, `TaskDevSummary`,
`DevTrigger`, `DevAutomationRule` (§5.1, §9.1); the realtime `IntegrationChangedEvent`.

**Changed payloads (additive)**

- `Task.dev: TaskDevSummary | null` (required) on every task payload: the headline PR (most recently updated
  open / draft, else merged in the last 14 days, else null; closed never) and the PR / branch / commit counts.
- `Project.devEnabled: boolean` (required): an active integration has a tracked repository that applies to the
  project.
- `ActivityEntry.actorName?: string | null` and `actorKind?: "user" | "integration"`; `ActivityVerb` gains
  `dev_linked`, `dev_branch_created` and `dev_pr_merged`.
- `AuditEntry.source` gains `"webhook"`; `actorKind: "integration"` rows (actorId = the integration id, `actorName`
  "GitHub" / "GitLab").
- `Notification.payload.via?: "github" | "gitlab"` (automation status changes; actorId null).
- New permissions: workspace `integration.manage` ("Manage integrations", Administration, after
  `workspace.manage_roles` in the catalogue; in `my_permissions` after `project.assign_admin`, before `audit.view`) and
  project `development.link` ("Link code", Tasks, after `project.import`, before `time.log`). Owner and Admin get
  `integration.manage`; Project Admin, Manager and Member get `development.link`; Viewer and workspace Member get
  neither. Cached mock databases get them through `ensureExt37` (marker `ext37`, custom roles untouched).
- Audit actions `integration.connected`, `.reconnected`, `.repositories_updated`, `.repository_scoped`,
  `.sync_requested`, `.error`, `.disconnected`, `task.dev_linked`, `task.dev_unlinked`, `task.dev_branch_created`,
  `task.dev_pr_state`, `project.dev_automation_updated`, and `task.status_changed` made by the integration.
- Realtime: `integration.changed` (`{ integrationId, op: connected | updated | synced | error | disconnected }`,
  `projectId: null`, delivered to **every member of the workspace**); `task.changed` with `fields: ["development"]`
  and `version: null` for link changes; `project.changed` area `"development"`.

**Errors:** 503 `integrations_unavailable`; 409 `integration_exists`, `integration_error`, `branch_exists`; 429
`sync_throttled`; 502 `provider_failed`; 422 `validation_failed` with the §5.3 / §5.6 / §5.8 field messages; 404
`not_found` for every confirm mismatch.

**Shared test vectors:** `src/features/integrations/lib/dev-vectors.json` (task keys, `suggestBranch`,
`validateBranch`, check aggregation and `hashHue`, §12.3), read by `src/features/integrations/lib/dev-lib.test.ts`.
The spec's canonical copy is `docs/v2/vectors/37-dev.json` at the repo root, outside `frontend/`; the backend's copy
should be created from this file, and the two must stay identical.

### v2 · Board 38: Telegram, SMS and push notification channels

The contract is `docs/v2/38-telegram-sms-push.md` (repo root). Every item is typed in `src/lib/api/types.ts` and
`src/lib/realtime/events.ts`, reachable through `endpoints.ts` (`api.channels.*`, the widened
`api.notifications.preferences` / `savePreferences`, `api.workspaces.update`) and `qk` (`channels`, `telegramLink`;
existing `prefs`, `workspace`), and implemented in the mock (`src/lib/mock/handlers/channels.ts`,
`src/lib/mock/channels-dispatch.ts`, P1 in `handlers/notifications.ts`, W1 in `handlers/workspaces.ts` /
`derive.ts`; tested in `src/lib/mock/channels.test.ts`).

**Endpoints** (all under `/api/v1`, any signed-in user unless noted; the same codes and `details` as the contract)

| # | Method | Path | Response / errors | Client |
|---|---|---|---|---|
| C1 | GET | `/me/notification-channels` | 200 `NotificationChannels` | `api.channels.get` · `qk.channels` (staleTime 30 s) |
| C2 | POST | `/me/notification-channels/telegram/link` `{ timezone? }` | 201 `TelegramLink`; 409 `already_connected`; 429 `throttled`; 503 `channel_unavailable` | `api.channels.startTelegram` |
| C3 | GET | `/me/notification-channels/telegram/link/:linkId` | 200 `TelegramLink` (no `code` / `deepLink` unless pending); 404 | `api.channels.telegramLink` · `qk.telegramLink` (2 s poll) |
| C4 | DELETE | `/me/notification-channels/telegram/link/:linkId` | 204 | `api.channels.cancelTelegram` |
| C5 | DELETE | `/me/notification-channels/telegram` | 204 (idempotent) | `api.channels.disconnectTelegram` |
| C6 | POST | `/me/notification-channels/sms/verifications` `{ country, nationalNumber, timezone? }` | 201 `SmsVerification`; 422 `fields.nationalNumber` / `fields.country`; 409 `already_connected`; 429 `throttled` (`reason`: hourly / daily / phone / global limit, `retryAt`); 502 `channel_send_failed`; 503 | `api.channels.startSms` |
| C7 | POST | `…/sms/verifications/:id/resend` | 200 `SmsVerification` (tries reset); 429 `resend_cooldown`; 410 `verification_closed`; 404 | `api.channels.resendSms` |
| C8 | POST | `…/sms/verifications/:id/verify` `{ code }` | 200 `{ connection }`; 422 `invalid_code` (`attemptsLeft`) / `too_many_attempts` / `fields.code`; 410 `code_expired` | `api.channels.verifySms` |
| C9 | DELETE | `/me/notification-channels/sms` | 204 | `api.channels.removeSms` |
| C10 | GET | `/push/vapid-public-key` (**public**) | 200 `{ publicKey }`; 503 | `api.channels.vapidKey` (anonymous) |
| C11 | PUT | `/me/push-subscriptions` `PushSubscriptionInput` | 200/201 `PushDevice`; 422 `subscription.endpoint` / `.keys.p256dh` / `.keys.auth`; refresh 404 | `api.channels.savePush` |
| C12 | POST | `/me/push-subscriptions/remove` `{ endpoint }` | 204 (idempotent) | `api.channels.removePushByEndpoint` |
| C13 | DELETE | `/me/push-subscriptions/:id` | 204; 404 for another user's | `api.channels.removePushDevice` |
| C14 | POST | `/me/notification-channels/:channel/test` `{ deviceId?, workspace? }` | 200 `ChannelTestResult`; 409 `channel_not_connected`; 502 `channel_send_failed` (`reason`); 429 `throttled` (`test_limit` / `daily_cap`); 503 | `api.channels.test` |
| P1 | GET / PUT | `/notification-preferences` | adds `telegram` / `sms` / `push` per event and `quietHours`; PUT merges per channel key, replaces `quietHours`; 422 `quietHours.from` / `.to` / `.timezone` / `.days` | `api.notifications.preferences` / `savePreferences` · `qk.prefs` |
| W1 | GET / PATCH | `/workspaces/:slug` | `notificationPolicy: { sms }`; PATCH needs `workspace.update` (403 `details.permission`); audit `workspace.updated` with `changes` `smsNotifications` | `api.workspaces.update` · `qk.workspace` |
| H1–H3 | POST | `/webhooks/telegram`, `/webhooks/twilio/sms`, `/webhooks/twilio/status` | provider-facing only; the client never calls them (the dev pill simulates them) | — |

**Types:** `ExternalChannel`, `NotificationChannel` (widened), `QuietHours`, `NotificationPreferences.quietHours`
(required), `TelegramConnection`, `SmsConnection`, `PushDevice`, `SmsCountry`, `NotificationChannels`, `TelegramLink`,
`SmsVerification`, `PushSubscriptionInput`, `TestableChannel`, `ChannelTestResult`, `Workspace.notificationPolicy?`;
the realtime `ChannelsChangedEvent`.

**Realtime:** `channels.changed` `{ channel, op: "linked" | "disconnected" | "status" }`, durable and user-targeted
(only the owner; published in each of the user's workspaces' streams). The client invalidates `qk.channels()` and
refetches an open Telegram link at once. Polling stays the fallback.

**C14 body:** the client sends the current workspace in the body (`{ workspace }`, as §8.3's code does); §6.4 words
it as `?workspace=`. The backend should accept the body field (or say which it wants).

**Shared test vectors:** `src/features/notifications/channels/phone-vectors.json` (formatting per pattern and the
§5.6 validation table: NANP rules, trunk 0 for GB / DE, mobile prefixes, digit counts, IN only when allowed), read by
`channels-lib.test.ts`. The spec names the backend copy `backend/apps/channels/tests/data/phone_vectors.json`, which
doesn't exist yet: it should be created from this file, and the two must stay identical.

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

---

## 7. Design bundle 2 (boards 24–40)

A second design file (`desing - orignal/Lightex Design System (1).html`) added 17 boards. They are unpacked
into `design/clean/24-…40-*.html`, next to boards 01–23.

### Scope decision

| Board | Status |
|---|---|
| 24 Workspace home, 25 My tasks | **Built.** Reworked to match. |
| 26 Sprints & review | **Built.** Table, sprint board (`?sprint=`), 3-step close: review → carry over → done. |
| 27 Epics | **Built.** New project view at `/[ws]/projects/[key]/epics`. |
| 28 Project settings | **Built.** General / Workflow / Labels / Members tabs, archive, delete to Trash. |
| 29 Trash | **Built.** New, at `/[ws]/trash`. Covers tasks, comments and projects, with 30-day retention. |
| 30 Create task, filters & views | **Built.** New create dialog, one shared filter builder for Board and List (kept in the URL), saved and pinned views. |
| 31 Audit log & activity | **Built.** At `/[ws]/settings/audit`, gated by `audit.view`. A shared `ActivityFeed` component is available but not placed on a screen yet (see gaps). |
| 34 Attachments & shortcuts | **Built.** Image viewer and shortcuts modal. Code preview is **not** built (brief conflict below). |
| 35 Illustrations, icons, OG, loading | **Built.** Empty-state illustrations, app icons and manifest, OG image, splash loader. |
| 36 Email templates | **Delivered** as `emails/*.html` plus `emails/README.md` (merge tags, subjects, triggers), with a dev preview at `/dev/emails`. Sending emails is the backend's job. |
| 32 Timeline & calendar | **Built in v2** (see §8). |
| 33 Dashboards & presence | **Not built.** Live presence needs realtime updates (no WebSockets in v1), and dashboards are not in the brief. |
| 37 Integrations (GitHub/GitLab) | **Not built.** v2. |
| 38 Telegram / SMS / Push | **Built in v2** (see §8). The QR code waits on a dependency decision. |
| 39 Custom fields, dependencies, time | **Built in v2** (see §8). |
| 40 Import wizard | **Built in v2** (see §8). |

### Conflicts (the brief wins on behaviour)

- **Code preview.** Board 34 shows a read-only code preview, but the brief says code files are download-only. Code,
  text, SVG and HTML files get a download card.
- **Audit permission name.** Board 31 uses `audit.read`; the brief's `audit.view` is used.
- **Project key format.** Board 28 allows letters and digits; the API contract (letters only, 2–5) is kept.
- **Shortcut list.** Board 34 lists keys that don't exist in the app (E, S, P, A, I, X, J/K). The modal lists only
  real shortcuts.

### Deviations

- **My tasks:** the open count and the List/Board toggle sit in the top bar's action area.
- **Mobile workspace switcher and "Create workspace"** (board 24) are not built; they are shell work.
- **Epics** has no sidebar entry because board 27's sidebar shows none; the project tab strip is the way in.
- **Trash** opens from the settings navigation, not the sidebar, matching board 29.
- **No Undo after deleting a status or label.** Undo is built for role changes, member removal, Trash restore,
  epic archive, attachment delete and view delete.
- **Quick-add on board columns** (board 30) is not built; the column "+" opens the create dialog.
- **OG image font:** uses the bundled Geist font, because Satori can't load the app's Inter woff2.

### Requested API additions (bundle 2)

All of these are implemented in the mock and typed in `src/lib/api`.

- **Projects:**
  - templates gain `simple`, and each template creates its own statuses;
  - new fields `Project.doneTaskCount` and `hue` (on PATCH).
- **Workspace access requests:** `GET`, `POST` and `DELETE /workspaces/:slug/access-requests[/mine]`, for members who
  are on no project.
- **Epics:**
  - new fields `ownerId`, `milestoneId` and `archivedAt`;
  - PATCH accepts `archived`, and names must be unique per project;
  - `tasks/bulk` must honour `patch.epicId`.
- **Statuses:**
  - `color` (PATCH) and `taskCount`;
  - DELETE takes `{ moveTo }`, and returns 409 `status_in_use` or 409 `last_in_category`.
- **Labels:** `PATCH` and `DELETE /projects/:id/labels/:labelId`, plus a `taskCount` field.
- **Members:** 409 `last_admin` on project member PATCH and DELETE.
- **Trash:**
  - `GET /workspaces/:slug/trash`, `POST …/trash/restore` and `POST …/trash/purge`;
  - project and comment deletes become soft deletes;
  - the server records `deletedBy` and purges after 30 days.
- **Saved views:**
  - `GET` and `POST /workspaces/:slug/views`, `PATCH` and `DELETE /views/:id`, `PUT /workspaces/:slug/views/order`;
  - a server-computed `count` for each view;
  - `TaskCreate.estimate`.
- **Audit:**
  - filters `filter[actor|action|entity|since]` and a `total`;
  - new fields on `AuditEntry`: `actorName`, `actorKind`, `entityType`, `entityKey`, `source`, `requestId`, `changes[]`.
- **Notifications:** a `sprint_completed` preference event, and the backend must HTML-escape email merge values.

### Known gaps (bundle 2)

- **Sprint close** takes two calls (bulk move, then complete), so it isn't atomic.
- **Velocity of completed sprints** ignores carried-over points, which aren't stored.
- **Pending deletes** (attachments, views) are sent after a 5-second undo window. They are lost if the browser
  crashes inside that window.
- **Saved views** each belong to one project.
- **The audit log's filters** aren't kept in the URL.
- **The shared `ActivityFeed`** isn't on any screen yet. The overview keeps its compact panel from board 11.

---

## 8. v2

The user lifted the "no v2 features" rule for boards 39, 32, 40, 33, 37 and 38. No v2 board remains unbuilt.

### Board 39: custom fields, dependencies, time tracking (built)

Spec: `docs/v2/39-fields-dependencies-time.md`. API additions are listed in §5 ("v2 · Board 39").

- **Task panel** (`?task=`, full page, mobile sheet): "Blocked" and running-timer chips next to status/priority/
  assignee; a "Custom fields" group after Labels (rows with a value, required rows, rows revealed through
  "Add property"; per-type editors; "Manage" link for `field.manage`); "Add property" gains "Time estimate" and a
  "Custom fields" heading; main column order Description → Dependencies → Time → Sub-tasks → Attachments → Comments.
- **Dependencies:** Blocked by / Blocks groups, task picker (combobox over `GET /projects/:id/tasks?q=`, 6 results,
  ↑↓ ↵ Esc), remove buttons; cycle errors toast the loop.
- **Time:** total / estimate with bar and "+… over", Start/Stop timer with a live clock (1 s tick only while running and
  visible), Log time form (`1h 30m`, `1:30`, `1.5`, …), entries with delete by permission.
- **Project settings → Custom fields** (`?tab=fields`): list, drag or Alt+↑↓ reorder, create/edit dialog, delete with a
  5 s Undo (pending-delete pattern), read-only note without `field.manage`.
- **Timesheet** at `/[ws]/timesheet` (sidebar item for every member): week × person heat grid, project selector, week
  navigation, hover/focus breakdown, CSV export gated on `report.view`. Week and project live in the URL.
- **Board card:** Blocked badge (tooltip lists open blockers), running-timer chip (click stops and logs), first select
  field chip. **List:** a "Blocked" glyph by the title and one optional, sortable column per custom field (hidden by
  default, "Custom fields" in the Columns menu). **Filters:** "Blocked" and one entry per custom field under a
  "Custom fields" heading; "greater/less than" takes a typed number.
- **Mock:** `ensureExt39` upgrades browsers with v1 data once (marker `ext39`): new permissions on cached system roles,
  PRJ seed (5 fields, values, 5 dependencies, time entries, a deterministic two-week timesheet), and the "Blocked"
  pinned view. No `SCHEMA` bump.

### Deviations (board 39)

- **Header chips** sit in the property chip row (with status, priority and assignee), where the existing panel keeps
  its chips; the design draws the same chips in that row.
- **Board card extras** (Blocked, timer, field chip) get their own row above the glyph/priority row instead of
  sharing it, so v1 cards keep their layout at 272 px column width.
- **List custom-field cells are read-only** (values are edited in the panel); sorting works.
- **Timesheet export** is a button in the page header at every width (no top-bar portal).
- **Heat text colour:** cells keep `text-fg` in every theme (the design switches to white at ≥ 60 % in dark themes;
  `--text` is already near-white there).
- **Time entry delete** has no Undo (the design has none); deleting an entry asks no confirmation.
- **Dependency rows** open the linked task when the title is clicked (the design rows are inert).
- **Dependency groups** sit side by side only on the full page; in the 520 px side panel and on mobile they stack,
  so task titles stay readable.

### Known gaps (board 39)

- Custom-field filtering is client-side (the server only filters `blocked`), as in v1.
- The archived-project rule (writes withheld) is not modelled by the mock's permission derivation; the backend
  enforces it.
- A field delete still waiting on its Undo is committed on `pagehide`; a crash inside the 5 s window loses it.
- Live mode is untested against the backend until `docs/openapi.yaml` includes these endpoints.

### Board 32: timeline & calendar (built)

Spec: `docs/v2/32-timeline-calendar.md`. API additions are listed in §5 ("v2 · Board 32"). Code: `src/features/schedule/`.

- **Timeline** (`/[ws]/projects/[key]/timeline`): Milestones lane (diamonds link to Milestones, guide lines), Sprints
  lane (active / completed / planned; links to `sprints?sprint=` when the viewer has that tab), then one group per epic
  (explicit bar, or a dashed derived bar from its tasks; "Archived" tag; "No epic" last) or per assignee (Former
  member, Unassigned last). Zoom Week / Month / Quarter (28 / 91 / 273 days, pan 7 / 28 / 91), Today, weekend
  shading, today marker, two axis rows. Collapsed groups are remembered per project in `localStorage`. Over 150 rows
  the rows are virtualised (TanStack Virtual).
- **Rescheduling:** hand-written pointer drag (`use-bar-drag.ts`): the middle moves, 9 px edges (16 px touch) resize,
  3 px activation for mouse/pen, 200 ms press-and-hold for touch, Esc / pointercancel revert. Keyboard: ← → move,
  Shift+← → resize the due edge, ↑ ↓ move between bars, Enter opens (epic: toggles). Keyboard bursts send one PATCH
  600 ms after the last key or on blur. Tooltip "Oct 1 → Oct 9 · 9d", live-region announcements, 5 s Undo toast,
  pending-sync ring and a 400 ms "land" pulse (none under reduced motion).
- **Ordered optimistic writes** (`use-reschedule.ts`): drag previews live in an external store (one bar and its
  arrows re-render per frame); a commit patches every task cache, sends only the changed keys, reads `version` from
  the cache when it executes, and rolls back with the v1 toasts (contract §4.6: conflict, deleted, 403, 422,
  network + Retry). Undo re-sends the previous dates with the current version, or cancels a burst still in its window.
- **Dependency arrows** from board 39 `openBlockers` (SVG, `--text-3`, `--danger` on conflict); the toggle is kept as
  `deps=0`.
- **Unscheduled tray** (300 px, open tasks with no dates, priority order, "200+" cap): drag a row onto a lane or day to
  set its due date, or "Add dates" opens the panel with Start and Due revealed (`?reveal=dates`). The empty state's
  "Add dates" opens it.
- **Calendar** (`/[ws]/projects/[key]/calendar`): month grid (Mon-first, 4–6 rows, 3 chips then "+N more" on a Radix
  popover) and week columns; chips sit on their due date; drag to another day (the start shifts too) or Alt+arrows
  (±1 / ±7); "· Nothing due" suffix on empty ranges.
- **390 px:** the calendar becomes the agenda (week strip with ‹ ›, `?day=`, up to 4 day groups, cards open the sheet,
  the FAB pre-fills the due date); the timeline is read-only with a 96 px label column and horizontal scroll inside
  its own box.
- **States:** skeletons, the previous range kept on screen with a 2 px progress bar, "Nothing scheduled" empty state,
  filtered empty, error with `<status> · request <ref>` and Retry, 2,000-task banner, inline lane error with Retry.
- **URL state:** `zoom` / `group` / `mode` pushed; `at` / `deps` / `tray` / `day` replaced; filters via `useUrlFilters`.
- **Elsewhere:** task panel "Start date" row (and "Add property → Start date"; the pickers disable days that would
  break start ≤ due) plus an "Oct 1 → Oct 9" chip when both dates are set; List "Start" column (Columns menu, off by
  default, sortable); epic panel "Start" / "Target" fields (both or neither); the create dialog accepts a `dueDate`
  default.

### Deviations (board 32)

- **Mutation scope:** reschedules share one TanStack mutation scope per project (`reschedule:<projectId>`), not one per
  task. `useMutation`'s `scope` is fixed per hook; a project-wide queue still guarantees per-task order.
- **Toast text:** a task toast reports the edge that changed, old → new ("PRJ-34 Oct 6 → Oct 8", as in the contract's
  example); an epic toast shows the new span ("Sprint engine · Sep 1 → Nov 11"). The design showed the new span for both.
- **Epic date writes** live in `use-reschedule.ts` (optimistic `qk.epics` patch, rollback, Undo); board 27 had no
  `useUpdateEpic` to reuse.
- **Conflict arrows** that can't enter from the left run along the row boundary above the blocked bar (two extra
  bends), so they never hide under it; non-conflicting arrows keep the single elbow.
- **Resizing a single-date task** writes both dates (a due-only bar becomes a span), unless the result is one day.
- **Tray count** shows once the tray has been opened (the query only runs while it's open, per §6.5).
- **List Start cells are read-only**; Start is edited in the task panel (one place for the start ≤ due rules).
- **Task panel date errors:** the pickers prevent an invalid pick; a server refusal shows the field message in the v1
  error toast rather than inline under the field.
- **390 px calendar** hides the desktop toolbar (the design's mobile frame has none); filters in the URL still apply.
- **Pending ring on timeline bars** sits just right of the bar (the design only drew it on calendar chips).

### Known gaps (board 32)

- The Playwright smoke suite (`e2e/smoke.spec.ts`) is not extended. Drag, keyboard, Undo, tray, calendar and role
  gating were verified with a scripted Playwright run and screenshots, not with committed e2e tests.
- Live mode is untested against the backend until `docs/openapi.yaml` carries `startDate`, the epic dates and the
  range filters.
- Start date is not in the filter builder (contract §9 #6) or the create dialog (§9 #7); epic writes are last-write-wins.
- A keyboard burst still inside its 600 ms window when the page closes is lost.

### Board 40: import wizard (built)

Spec: `docs/v2/40-import-wizard.md`. API additions are listed in §5 ("v2 · Board 40"). Code: `src/features/import/`
(UI), `src/lib/mock/import/` (parser, presets, matching, conversion, planner, report) and
`src/lib/mock/handlers/imports.ts` (I1–I9, the runner).

- **Wizard** (`?import=new`, then `?import=<jobId>` with `replaceUrl`): a `DialogShell` modal (new bare dialog
  primitive in `components/ui/modal.tsx`), 760 × 640 on desktop, a full-height sheet at ≤ 760 px. Head (icon,
  "Import", "into" project badge, ×), 4-step stepper (done / current / spinning dot, back-navigation only during
  setup), body, footer (warning reason line with `role=status` that shakes when Next is pressed while blocked;
  Next is `aria-disabled` + `aria-describedby`).
- **Step 1 · Source:** Trello (disabled "Coming soon", reason in a tooltip and `aria-describedby`), Jira ("Issues ·
  CSV export"), CSV tiles as a radiogroup with roving focus (arrows skip Trello); "Import into" picker of projects
  where the viewer can import (key badge, name, next key).
- **Step 2 · Upload:** drop zone ("Drop to upload" while dragging), Jira helper line, client pre-checks with the
  design copy, "Uploading … · 42%" and "Reading …" notes, 422 alerts built from `details.file`, file card (meta with
  delimiter and encoding suffixes, Replace, ×), preset note, "Detected columns" chips. Mock: "Use sample file"; live:
  "Download template". Changing the project or source after a file was chosen discards the draft and re-uploads the
  same `File`.
- **Step 3 · Map:** Fields table (native selects with "More fields" / "Custom fields" optgroups, `auto` tag,
  duplicate tint, unit select for numeric time-estimate columns), Statuses / Types / People value tables
  (Epic type only with `epic.manage`; people limited to "You" without `task.assign`), Preview of the first 5 rows
  (status glyphs, avatars, priority bars, `3 pts`, `Oct 14`, label pills, `Missing title` / `Unmapped` in danger
  italics, skipped rows tinted with "Will skip: …"). Saves are debounced 300 ms, one PUT in flight, latest wins,
  409 `mapping_conflict` adopts the server copy.
- **Step 4 · Import:** summary (Tasks / Will skip / Statuses / People tiles, route with key range, skip summary,
  "Creates 1 label"), running (progress bar via `scaleX`, `processed / total rows`, %, last 7 log lines, shimmer
  overlay on the stepper, "Runs in the background", **Stop import** for the creator or `project.update`, "Stopping
  after the current batch…"), result (complete / stopped / failed with Retry; Imported / Skipped tiles, error table
  with the first 50 issues, "and N more in the report", **Download report**, **Import more**, **Open project**).
- **Polling:** `useImportJob` polls I3 every 1 s while queued / running and the tab is visible; a terminal job runs
  the §6.3 invalidation once. Jobs started in this tab are watched after the wizard closes and toast "Import
  finished · 44 tasks added to PRJ · 4 skipped" with **View**.
- **Entry points** (rendered only with `project.import` + `task.create` on an active project): overview setup
  checklist ("Type them or import a CSV" + **Import CSV**), board and list empty states (**Import CSV**), project
  settings → **Import** tab (history: status pill, file, key range, counts, who, when, Report, Open, **New import**;
  skeleton, empty, error + Retry), command palette **Import tasks…**, and the inbox `import` row ("Open import").
- **Lock panel** for a hand-typed `?import=` without permission: the design's lock layout with "Your role (Viewer)
  can’t import tasks into Platform Rebuild" and the project admins; no "Ask an admin".
- **Mock:** hand-written decoder (UTF-8 BOM, UTF-16 LE/BE, strict UTF-8, Windows-1252), delimiter sniffing,
  RFC 4180 reader with the §1.5 limits, Jira / Linear / Asana presets, matching and conversion rules, planner and
  validation (the design's sample → 44 tasks, 4 skipped; the Jira export → 1 epic, 4 tasks, 1 skip, 1 warning),
  batched runner, formula-safe report (`csvSafe`), notification, audit and activity.
- **Tests:** 171 parser / planner tests against the shared vectors, 17 mock-endpoint tests, 16 client helper tests.

### Deviations (board 40)

- **Open project** opens the List view, not the board: imports land in the backlog (§9 #27), so the active-sprint
  board wouldn't show them. The inbox row and the toast's **View** still open `board?import=<id>` as specified.
- **Settings tab visibility:** the project Settings tab now also shows for anyone who can import, so a project
  Member reaches the Import tab (they land on it; the other tabs stay read-only, as for any role without their
  permission).
- **Wide mapping step:** at ≥ 1280 px viewports step 3 widens the modal to 1180 × 860 for the design's two-column
  S3 frame; every other step keeps 760 × 640. Below 1280 px the mapping stacks.
- **`auto` tags on columns** are tracked per job in `sessionStorage` (columns the user touched), not from the API;
  after a new browser session every mapped column shows `auto` again. Value tables use the server's `auto` flag.
- **Analysis errors discard the draft at once** (the contract discards it on Replace); the alert stays.
- **Changing the source tile** after an upload also re-uploads (the contract names only the project change).
- **A job that never started** (canceled, or failed because the file is gone) reopens at step 2 with "Couldn’t
  read file" and the server message.
- **Start import** is disabled ("Saving the mapping…") while a mapping save is pending, so the run never uses a
  stale mapping.
- **Lock panel** is 620 × 420 and keeps the wizard head (title and ×) but no stepper.
- **History** labels the report button "Report" (row space); the result step keeps "Download report".
- **Parser details recorded in the vectors:** CR inside a quoted cell is stripped like any C0 control, so an
  embedded CRLF becomes LF; a quote closed early keeps the rest of the field (lenient, not `strict=True`); the
  `list` inference uses the contract's ≥ 30 % rule, so the sample's Tags column infers `text` (the contract's
  abridged example says `list`; suggestions are unaffected).
- **Run-time warnings** in the mock: "Status was deleted · used Todo" (without the deleted status's name, which is
  gone by then) and "Assignee left the project · left unassigned" (the contract names the case but not the copy).
- **Delimiter meta** also covers `|` (" · | separated").
- **`uploadImportFile`** takes an optional sixth argument, `onCreated(job)`, so the wizard can discard a draft
  whose analysis failed.
- **Task feed entry** "imported this task from …" is derived in the mock from the import rows instead of being
  stored per task, so a 1,000-row import doesn't flush the 500-entry mock activity log.

### Known gaps (board 40)

- The Playwright smoke suite (`e2e/smoke.spec.ts`) is not extended. The flows (sample and Jira imports, Stop,
  close-while-running toast, palette, keyboard tiles, oversized / non-CSV files, Sam's Epic and people gating,
  viewer lock, reload of a finished job, Open project) were verified with scripted Playwright runs and screenshots
  at 1440 and 390 in dark and light, with no console errors.
- Live mode is untested against the backend until `docs/openapi.yaml` includes the import endpoints.
- The mock has no retention purge (`purge_imports`), no runner recovery after a reload (jobs fail `file_missing`
  instead) and no Linear / Asana file fixtures (their presets are covered by header vectors only).
- An error report larger than 200 KB lives in memory only; after a reload I8 returns 404 for it.
- The finish toast only fires while a project view is open (the watcher lives in the project shell); the inbox row
  covers the rest.

### Board 33: dashboards & presence, realtime over SSE (built)

Spec: `docs/v2/33-dashboards-presence.md`. API additions are listed in §5 ("v2 · Board 33"). Code:
`src/features/dashboards/` (UI), `src/features/presence/` (presence UI and hooks), `src/lib/realtime/` (the stream
client), `src/lib/domain/dashboards.ts` (widget catalogue and `pack()`), and in the mock `handlers/dashboards.ts`,
`handlers/presence.ts`, `mock/realtime.ts`, `mock/publish-routes.ts` and the presence part of `mock/teammates.ts`.

- **Rules lifted:** SSE is the agreed exception to "no WebSockets" (`frontend/CLAUDE.md` freshness rule rewritten;
  board 33 moved to "in scope"). There is still no WebSocket anywhere.
- **Dashboards tab** (after Reports, everyone on the project): `/dashboards` opens the last dashboard you opened in
  this project (localStorage), else the first shared one, else your first personal one, else "No dashboards yet"
  (**New dashboard** with `dashboard.create`, otherwise "Ask a project admin to create one").
  `/dashboards/[dashboardId]` shows one dashboard.
- **Header:** crumb picker "Dashboards / Sprint 14 health ▾" (Shared and Personal sections, ✓ on the current one,
  New dashboard…, Rename…, Share with project / Make personal, Delete… with the `alertdialog` copy and a 5 s Undo),
  "Jordan is editing the layout" pill, the "Viewing now" stack (others with the pulsing ring and green dot, you last,
  at most 4 + "+N"), and **Edit layout** (only for editors per §4.3, above 760 px, not on archived projects).
- **Grid:** 12 columns, first-fit `pack()` of the ordered layout, row unit 152 px at ≥ 1024 px grid width (128 px
  below), cards placed with `transform: translate` (the only animated property). Widgets the viewer can't read
  (`report.view`) are not rendered and packing skips them; "Nothing to show" when none remain.
- **Edit mode:** guides, dimmed widget bodies, grip ⠿ (pointer drag with capture, 4 px threshold, touch
  press-and-hold 200 ms; ←/↑ →/↓ reorder with focus kept on the grip), × remove, corner resize (pointer snapping and
  arrow keys, size badge, 900 ms after a key), a settings gear per type with options (sprint, show done, quarter, unit
  / sprint / person field, range), **Add widget** gallery (dialog; "N of 6 added", "✓ Added" tiles `aria-disabled`,
  first free tile focused, Esc closes; unreadable types not shown), Cancel (snapshot restored) and **Save layout**
  (no request when unchanged; one PUT with `version`; "Layout saved · 6 widgets"; 409 "Someone else changed this
  dashboard" with **Reload**, the draft kept until Reload or Cancel; 422 shows the first message and stays). All six
  live-region messages are announced verbatim.
- **Widgets** (each with its own query, skeleton, inline "Couldn’t load" + Retry and empty copy): Burndown
  (Recharts, remaining line with a light area, dashed ideal, Today rule, end dot, the spec's aria text), My tasks
  (open by due date then done in the last 7 days, rows by height, complete / reopen through `useUpdateTask` with the
  status-only rule, plain glyph without permission, row opens `?task=`), Objective progress (quarter filter, expected
  tick, danger when > 10 behind), Workload by person (stacked in progress / to do, capacity tick, `11/10` in danger
  when over, points or hours, a Person custom field), Velocity (grouped bars, "avg N", "Velocity needs 3 completed
  sprints"), Recent activity (v1 activity text, mono key, "now" in the live tone, "live" meta only while live).
  Burndown and Velocity reuse the Reports chart bodies, now exported as `BurndownChart` / `VelocityChart` with a
  `fill` mode (Reports looks the same).
- **Phones (≤ 760 px):** widgets stack in layout order at the design's stack heights; no edit mode; the presence
  stack moves into `TopBarActions`; the empty state's **Add widget** opens the gallery as a sheet and saves at once.
- **Presence:** each tab claims one location (board, dashboard, task; the most specific wins) and the tab's engine
  sends the heartbeat PUT every 20 s while visible and 300 ms after a change, DELETE after 30 s hidden and on
  `pagehide` (keepalive). Board: header stack (in `TopBarActions`) and, on each card, the people with that task open
  (20 px live avatars on the top edge, the card border in the first person's hue). Task panel / page / sheet: header
  stack, "Jordan is editing" / "Jordan and 1 other are editing" pill, a name flag and inset ring on the property
  being edited (status, priority, assignee, estimate, start, due, sprint, milestone, epic, labels, title, custom
  fields), a ring and flag on the description while someone edits it (no streamed characters), and "Sam is typing" /
  "Sam and Riley are typing" / "3 people are typing" under the comments (live only). Which inline editor is open is
  read from the DOM (`data-pf` rows with an open popover or focused input), so no editor had to change.
- **Realtime client:** fetch-based SSE (`http-source.ts`: Bearer header, `Last-Event-ID`, refresh before connecting
  without a token, refresh once on 401, `?v=1`) and an incremental parser (`sse-parser.ts`: every field, CR / LF /
  CRLF across chunks, BOM, multi-byte splits). `loop.ts`: hello → live; 3 failed connects, 503, 404 or the watchdog
  twice in 2 min → polling (keeps retrying with 1–30 s full-jitter backoff or `Retry-After`); `reconnect` waits
  `retryMs` + 0–2 s and refreshes the token first after `token_expiry`; 401 after a refresh → off + the v1 re-auth
  modal; 45 s without bytes aborts; the failure count resets after 60 s up; offline aborts, online reconnects at
  once. `leader.ts` + `client.ts`: one stream per browser per workspace through Web Locks, events / status / last id
  to the other tabs over BroadcastChannel, followers report visibility every 20 s, the stream closes when every tab
  has been hidden 2 minutes and reconnects with `Last-Event-ID` when one becomes visible; without those APIs every
  tab streams. `apply-event.ts` implements the §7.8 table (batched per frame + 150 ms, `refetchType: "active"`,
  version skip for echoes, paused during a board drag, stale presence snapshots ignored). `useLiveInterval` replaces
  the literal 30 s in the board, inbox, unread count and saved views, and drives the widget queries.
- **"Updated just now by Riley · Burndown"** (live only, someone else's change, at most one per 4 s) with the changed
  rows flashing 1.6 s (static under reduced motion); in the task panel the toast names the field ("PRJ-42 · Due")
  and the field flashes.
- **Dev pill:** "Realtime: live / polling / off" and the new **Realtime** control (Live (SSE) / Polling); the
  teammates switch now also drives presence every 7 s.
- **Tests:** SSE parser (incl. every byte split), backoff and `useLiveInterval`, the loop (live, 3 failures →
  polling → recovery with one invalidation, Retry-After, token refresh order, unauthorized → off, watchdog, hidden /
  visible with `Last-Event-ID`, online / offline, build flag, failure reset), the HTTP source, leader election with two
  simulated tabs, every §7.8 row, presence labels / flags / roster merge, `pack` vectors and layout / widget helpers,
  the §4.3 truth table and §4.2 grants, and the mock: DB1–DB6 (every 422, both 409 limits, version conflicts,
  personal 404, archived), W1, progress `quarter`, P1–P3, publish-on-commit, the §6.2 events, `MockRealtimeSource`
  replay / reset / polling / offline / access change, `ensureExt33` once, and the simulator off / on.

### Deviations (board 33)

- **`RealtimeSource.run`** resolves `{ kind, retryAfterMs? }` (`ended | unauthorized | unavailable | failed |
  aborted`) instead of the three strings, so the loop can honour `Retry-After` and tell a watchdog abort from an
  error.
- **First hello of a page load** also triggers the blanket invalidation (the §7.8 row read literally: "hello after
  connecting"). It costs one refetch of the active queries when the stream starts.
- **Cache keys:** the activity widget uses `[...qk.activity(id), "widget"]` (10 rows) because the overview already
  keeps 8 rows under `qk.activity(id)`; it is still under that prefix, so every activity invalidation reaches it.
  The velocity widget key `qk.reports(id, "velocity", range)` is not shared with the Reports screen's
  `(range, from, to)` key.
- **Reopen** in My tasks moves the task to the first *todo*-category status that isn't Backlog (the seed's Backlog
  is todo-category and comes first).
- **"Editing" excludes `comment`:** someone typing a comment shows in the typing row, not as "X is editing".
- **Field names:** flags use the §3.4 Task field names (`statusId`, `assigneeId`, …, `cf.<id>`); the §1.5 short
  names (`status`, `assignee`, `sprint`, `epic`) and `customFields.<id>` map onto them.
- **"Updated just now" toast** uses the app's toast stack (bottom right, one id, replaced in place) with a new
  `icon` option on `toast()` for the live avatar, rather than a separate dashboard toast; the save toast is the
  normal success toast ("Layout saved · 6 widgets").
- **Description editor flag** is an outline with a 6 px offset in the editor's hue (no layout shift) rather than
  a border.
- **Task panel header:** in the side panel the project name gives way to the avatars when people are present; the
  editing pill is hidden at ≤ 760 px (the sheet keeps the avatars).
- **Presence stacks** show only when someone else is present on the board and in the task header too (the spec says
  so for dashboards).
- **Workload** doesn't draw the `unassigned` bucket (the design has no row for it). In the mock, capacity comes from
  PRJ's only two completed sprints, so most people show as over capacity.
- **Mock publishing:** planning and settings routes publish `project.changed` / `access.changed` from one route table
  in the transport (`mock/publish-routes.ts`) instead of a call in each handler; dependency and time changes publish
  `task.changed` with `version: null` (the task's version doesn't move), so they always refetch.
- **Simulator:** typists need `comment.create`, field editors need edit rights on the task, and changes (the 7 s
  dashboard tick and v1's ~45 s edit) are made by teammates with `task.move`, so a Viewer never appears to act.
- **Files:** the editing pill, field flag and typing indicator live in `features/presence/presence-ui.tsx` (not three
  files), the toast in `features/presence/live-toast.tsx`.
- **Delete** from the picker sends you to the index, which opens the next dashboard; **Undo** puts it back in the
  list and returns to it.
- **Top bar:** the crumb now names Dashboards, and also Timeline and Calendar (they were blank).

### Known gaps (board 33)

- The Playwright smoke suite (`e2e/smoke.spec.ts`) is not extended. The two-user flows of §8.2 (Alex and Jordan in two
  contexts) can't run against the mock, because each browser context has its own in-browser database. Verified
  instead with scripted Playwright runs at 1440 and 390, dark and light, as `u_alex`, `u_taylor` and `u_sam`, with no
  console errors and no horizontal scroll: pointer drag, keyboard move and resize, remove, Cancel, Save and reload,
  the 409 path (rename while editing, then save), new blank dashboard → Add widget, delete with Undo, the phone sheet
  that saves at once, live presence (board cards, panel stack, pill, field flag, description flag, typing row) and
  polling mode (avatars through the heartbeat, no typing row).
- Live mode is untested against the backend (built in parallel); it needs the CORS items in §5.
- Board presence covers the board view only (§10 #9); list, backlog and timeline report nothing.
- No character-level co-editing, remote cursors or remote selections (out of scope, §9 #8 and #9).
- `import.progress` is not used; the import wizard keeps its 1 s poll (§10 #8).
- Objectives and the time estimate in the task panel have no field flag.

### Board 37: integrations & development, GitHub and GitLab (built)

Spec: `docs/v2/37-integrations-github-gitlab.md`. API additions are listed in §5 ("v2 · Board 37"). Code:
`src/features/integrations/` (settings page, dialogs, picker, task keys, and `lib/` with key matching, branch names
and copy helpers), `src/features/development/` (task panel section, Create branch popover, PR chip, project settings
tab), and in the mock `handlers/integrations.ts` (routes, fake provider, automations, dev-pill simulators) and
`dev-derive.ts` (`Task.dev`, `Project.devEnabled`).

- **Rules lifted:** board 37 moved to "in scope" in `frontend/CLAUDE.md`. No new npm dependency.
- **Settings → Integrations** (`/[ws]/settings/integrations`): the nav item "Integrations" (Plug icon) sits after
  Roles, for every member. Holders of `integration.manage` see a warning dot when a connection is in error.
  - **Source control:** a card per connection, then a tile per provider not connected yet.
    - Card: logo, provider + account, and "Connected" or the §9.7 error badge. Meta "4 repos · last sync 2m",
      "expired 3d ago · 4 repos paused" or "token expires in 5d".
    - Card actions: Sync now (spinner; a disabled reason during the 2-minute window), Edit repos, Reconnect in
      error, Disconnect.
    - Repository rows: "12 open PRs", last sync / "syncing" / "queued" / "paused", and an "All projects ▾" scope menu
      for managers. "Add organization" / "Add GitLab connection" in the card footer.
    - Tile: chips and Connect; "Waiting for authorization…" + Cancel; "Choosing repositories…"; the lock note "Can’t
      connect · needs Manage integrations"; or a disabled Connect with "GitHub isn’t set up on this server."
  - **Connect flow:** G2 / G3 → `sessionStorage["lightex-int-connect"]` → `location.assign(authorizeUrl)`.
    - On return, `#connect=<attempt>.<token>` is removed with `replaceUrl` before G6. A connect opens **Choose
      repositories**; a reconnect toasts "GitHub reconnected"; a 404 shows "That connection link expired. Try again."
    - `#connect_error` shows the §5.3 copy in an inline banner (info tone for cancellations). A return without a
      fragment (live mode) shows "Connection cancelled."
    - Mock mode: `#mock-authorize=<provider>.<attempt>` opens the design's "Authorize Lightex" dialog with the real
      permission names. Authorize / Cancel produce the same fragments as the real callback.
  - **GitLab dialog:** GitLab.com (OAuth; hidden without `oauth` in `methods`) or Access token (instance URL + token,
    with help text naming role Maintainer and scope `api`). Field errors come from the 422; `integration_exists`
    offers Reconnect. Token reconnect has its own small dialog.
  - **Choose repositories:**
    - search (60 chars); groups by owner with a tri-state select-all and `n/m`; visibility; relative update time;
    - skeleton; "No repositories match “q”" + Clear search; error + Retry;
    - "N selected", and "Connect N repos" / "Save · N repos" (disabled at 0 with "Choose at least one repository");
    - `trackedElsewhere` rows disabled ("Connected through another account"); "Missing a repository? Change access on
      GitHub".
    - Cancel on the first picker after a connect disconnects (§11 #20). Saving keeps the project scope of
      repositories already tracked.
  - **Disconnect:** the design's alertdialog (Cancel focused, Esc closes), optimistic removal with rollback, toast
    "GitHub disconnected".
  - **Task keys:** the three examples with the keys marked, and the branch generator over your open assigned tasks
    (first 20; hidden when none), plain / feature/, Copy → "Copied" for 1.4 s.
  - States: the design's loading skeleton, ErrorState + Retry, and every error code's badge.
- **Task panel → Development:** above Description (side panel, full page and sheet). Shown when
  `project.devEnabled || task.dev`.
  - Header: the count "4 PRs · 2 branches" ("MRs" when all are GitLab) and the "Branch created" flash.
  - With `development.link`: **Create branch** (popover; suggested name, Copy, "from {defaultBranch} in [repo ▾]",
    client validation, spinner, 409 / 422 inline) and ⋯ "Link pull request or commit…" (URL dialog, D2).
  - PR rows: state pill (Open / Draft dashed / Merged / Closed), ref, and the title with keys marked (opens the PR).
    The checks button (`aria-expanded`, "Checks Failing, 1 of 3 passing") expands check rows with durations. Author
    avatar: the member, or initials + `hashHue(login)`.
  - Branch rows with "3 ahead" and Copy. Commit rows with the 7-char sha, first line, avatar and time; "Show all N on
    GitHub" when the commits are in one repository.
  - Row menu **Unlink**: optimistic, with the toast "Unlinked #214" and Undo (→ D2).
  - Empty: "No linked work yet", the suggested branch + Copy, "Use PRJ-58 in a branch, PR or commit". Loading
    skeleton; inline error + Retry. Polls every 30 s only while a check is running and the stream is down.
- **Board card chip** (`task.dev.pr`): `#214 · Failing ✕`, `#221 · Open`, `#187 · Merged`, and a muted Draft, with
  the §9.5 tooltip and aria-label. The list shows a compact icon chip in the key column (see deviations).
- **Project settings → Development** (`?tab=development`, only when `devEnabled`): the repositories that apply (with
  a link to workspace settings for managers) and the three rules, each with a switch and a status select (done-only
  for merges). Saved with the v1 SaveBar; the read-only note without `status.manage`.
- **Activity, inbox, audit:**
  - the three new verbs ("linked PR #214", "created branch …", "GitHub · PR #198 merged");
  - integration rows named by `actorName`, with the square integration avatar (task activity, project overview,
    activity feed, dashboard widget);
  - the inbox lead "GitHub moved PRJ-42 to Done" from `payload.via`; audit "via webhook".
- **Realtime** (`apply-event.ts`):
  - `task.changed` + `development` → `qk.development(taskId)`;
  - `integration.changed` → the overview, projects (`devEnabled`) and task-scoped queries;
  - `project.changed` `development` → the rules and projects.
  - The mock stream delivers `integration.changed` to every member of the workspace (it has no project).
- **Mock:**
  - Seed: `int_gh_platform` (platform-team; `web`, `api`, `board-engine`, `mobile-app`; last sync 2 min). PRJ-42 has
    PRs #214 / #209 / #198 / #190, two branches and four commits; PRJ-41 has #221 (open, passing, 1 review); PRJ-29 has
    #187 (merged into main); PRJ-58 is empty. PRJ's automation `pr_merged → Done` is on.
  - Fake provider: the design's eight repositories (700 ms). GitHub connects `platform-team`, then `alexkim`; GitLab
    OAuth connects `akim` on gitlab.com; token mode accepts `fake-token`.
  - Automations (§7.10) run as the integration: forward-only guards, version bump, activity / audit with
    `actorKind: "integration"`, notifications to the assignee and reporter with `via`, and `task.changed`.
  - **Dev pill → Integrations:** Open PR on task, Merge PR, Fail checks, Expire GitHub token.
- **Tests:**
  - shared vectors and helpers (`dev-lib.test.ts`): keys, branch names, checks, `hashHue`, chip text, count label,
    `parseConnectFragment`, error copy, meta;
  - the mock (`integrations.test.ts`): seed and `ensureExt37`, the `my_permissions` order, D1 shape / ordering and
    the `Task.dev` headline rules, G1 filtering, G2 → consent → G6 with every 404 case, cancel, GitLab OAuth and token
    errors, 403 / 503, reconnect, G8–G13, D2–D4 (URL parsing, suppression and re-link, 409), permissions per seeded
    user and archived projects, A1 / A2 validation, automations through the dev-pill simulators, and
    `integration.changed` reaching a member who is on no project;
  - the realtime mapping (`apply-event.test.ts`);
  - components (`integrations.test.tsx`): page states, lock note, disabled reason, error card, the full connect flow,
    cancelled and expired links, disconnect focus / Esc, GitLab field errors, picker tri-state / search /
    `trackedElsewhere`, Development ready / empty / loading / Viewer / Create branch 409 / Unlink, the settings tab,
    the chip.

### Deviations (board 37)

- **Conflicts** are resolved exactly as the spec's §11 (#1–#23): a card per connection plus tiles; the consent dialog
  only in mock mode; an installation-scoped picker; permission keys instead of roles; "Can’t connect · needs Manage
  integrations" / "Ask a workspace admin to reconnect"; Sync now for managers only; per-code error badges; the scope
  menu; the GitLab dialog; manual link / unlink; the Development settings tab; "from {defaultBranch}"; deterministic
  branch names; highlighting by the workspace's keys; real relative times; initials + hue avatars; real tasks in the
  generator; Integrations after Roles; a non-optimistic Create branch; disconnect on the first picker's Cancel; MRs;
  draft chips.
- **Shared vectors** live at `src/features/integrations/lib/dev-vectors.json`. The spec names
  `docs/v2/vectors/37-dev.json`, which is outside `frontend/`.
- **Mock consent page:** the fake provider's dialog is the app's `Modal` (title "GitHub · authorize", the paired logos
  with the animated dots, chips, Cancel / Authorize), without the design's fake browser bar. It calls `fakeAuthorize()`
  directly, because the backend's fake authorize route is a browser redirect, not a JSON endpoint.
- **Picker search** filters the loaded list locally (G8 is called once, without `q`), so the selection survives a
  search. `api.integrations.availableRepositories(id, q)` still sends `q`.
- **List view:** the key column shows a compact chip (the state icon only; same tooltip and aria-label), and its
  default width grows from 70 to 92 px. The full chip didn't fit.
- **Design tasks:** the v1 seed has no PRJ-41 or PRJ-29, so `ensureExt37` adds them: PRJ-41 "Virtualize board column
  lists" (In review, Riley) and PRJ-29 "Board drag preview" (Done, Taylor), both in Sprint 14. PRJ-41's title differs
  from the design's "Virtualize board columns" because PRJ-40 already has that title.
- **"Expire GitHub token"** (dev pill) sets `token_expired` on the GitHub connection, as the design shows, although a
  real GitHub App never has an expiring token (§11 #7).
- **Mock-only details:** `branch_exists` also carries `details.fields.name`; G8's 700 ms delay is
  `fakeTiming.listMs`.
- **`validateBranch`** adds messages for the cases the contract doesn't word: empty ("Enter a branch name."), the
  start / end characters, and `//`.
- **The Development section** also shows when the project has no connection but the task still has links (after a
  disconnect), without Create branch or Link (D2 / D4 need a tracked repository).

### Known gaps (board 37)

- Live mode is untested against the backend (built in parallel). G4 / G5 / W1 / W2 are browser- or provider-facing,
  and the client has no code for them beyond reading the fragment.
- The Playwright smoke suite (`e2e/smoke.spec.ts`) is not extended. Verified instead with scripted Playwright runs at
  1440 and 390, dark and light, as `u_alex` and `u_taylor`: settings, the task panel (PRJ-42 with expanded checks,
  PRJ-58 empty), board chips, list, the project Development tab, the picker, GitLab dialog, disconnect, consent, first
  picker, and the connected and error states. No console errors and no horizontal scroll.
- The "partial sync" tooltip (§7.4 `stats.partial`) isn't shown: the payload has no field for it.

### Board 38: Telegram, SMS and push notification channels (built)

Spec: `docs/v2/38-telegram-sms-push.md`. API additions are listed in §5 ("v2 · Board 38"). Code:
`src/features/notifications/preferences.tsx` (the page) and `src/features/notifications/channels/` (sections, dialogs,
pure logic and tests), `public/sw.js` + `public/push-badge.png`, and in the mock `handlers/channels.ts` and
`channels-dispatch.ts`.

- **Rules lifted:** board 38 moved to "in scope" in `frontend/CLAUDE.md`; no v2 board is banned any more. **No new
  npm dependency** (see the QR decision below and §2).
- **Settings → Notifications** (`/[ws]/settings/notifications`), "Coming soon" removed:
  - **Channels:** In-app ("Always on", client-only test preview), Email (address, C14 test), Telegram, SMS and Push,
    each with the §8.5 status line (✓ / dashed / spinner / ⚠) and actions (Send test, Connect / Reconnect / Enable /
    Check again, × Disconnect). Every state of the table is rendered: Telegram not connected / waiting / `@handle` /
    bot blocked / not available; SMS off by admin (× kept when a number exists) / not connected / number / replied
    STOP / can't receive SMS; Push unsupported / iOS "Add Lightex to your Home Screen" / Off · N other devices /
    Waiting for browser… / This browser · N more devices / blocked / this browser's subscription expired. "Devices"
    opens a menu of the other browsers with per-device remove (C13).
  - **Admin row** "SMS for {workspace}" with the `admin` tag and a switch, rendered only with `workspace.update`;
    an optimistic workspace PATCH with rollback and a toast.
  - **Preferences:** the 6 × 5 matrix. Unusable columns are hatched with dashed `role="img"` cells ("Mentioned,
    Telegram: not connected"); headers offer Connect (opens the flow) or say Off by admin / Blocked / STOP /
    Unavailable / Retry (when C1 failed). Short labels App / Mail / TG / SMS / Push at ≤ 760 px. v1's Email delivery
    control stays under it (§10 #4).
  - **Quiet hours:** switch + mono summary (`22:00–08:00 · Mon–Fri · New York`), From / To (`type="time"`, committed
    on blur / Enter), every IANA zone labelled `City · GMT±h` with the browser's first, the 24 h bar (two hatched
    parts overnight), day toggles (`aria-pressed`), "Urgent still notifies" with the 4-bar glyph. From = To is refused
    client-side ("End must differ from start"); without a zone a note says quiet hours start once one is set.
  - Matrix, email delivery, quiet hours and the policy switch share "Saving / Saved" in the header (v1's 400 ms
    debounced, optimistic save with rollback). States: the design skeleton (5 channel rows + 4 matrix rows), page
    error + Retry when P1 fails, an inline Channels error with external columns "Retry" when only C1 fails.
- **Telegram dialog** (380 px modal, a bottom sheet at ≤ 760 px; lazily loaded): C2 with the browser zone → "Open
  Telegram" deep link, "or send to @lightex_bot", the code in 3 + 3 cells with Copy (check for 1.4 s), "Waiting for
  confirmation…" and the countdown (warn at ≤ 1:00); C3 every 2 s while visible; Code expired (struck-through code,
  `role=alert`) → New code; "Connected as @handle" with the spark check, Send test / Done; errors (409 / 429 / 503)
  with Try again; × / Escape before linking cancels (C4).
- **SMS dialog:** country select (C1 countries) + national number formatted as you type (placeholder `(000)
  000-0000`, trunk 0 dropped), help `10 digits` → `Valid number` → error; Enter / Send code (C6). OTP step: "Code sent
  to … · Edit", six boxes (`one-time-code` on box 1, `inputmode=numeric`, typing advances, 3+ digits spread, 6 start
  at box 1, Backspace / ← →), auto-verify on 6 digits ("Verifying…", read-only), `Wrong code · 2 tries left` with
  shake (none under reduced motion), boxes cleared and box 1 focused, `Too many tries · resend a code` (read-only
  until Resend), `Code expired · resend a code`, "Resend in 0:24" → Resend code (C7, tries reset). Verified: spark
  check, Send test / Done. Closing before verifying calls nothing.
- **Push:** `PushPlatform` (`push.ts`) with the browser, mock (real permission + real SW registration, fake
  subscription, never a push service) and `fakePushPlatform` implementations. Enable (permission in the click → SW
  `register("/sw.js", { scope: "/", updateViaCache: "none" })` → subscribe → C11; unsubscribes again if C11 fails),
  Turn off (C12, local unsubscribe even if C12 fails), Check again ("Still blocked in browser"), "This browser" by
  `endpointHash`, `usePushSync` once per tab session in the workspace shell (key rotation → re-subscribe; refresh
  404 → local unsubscribe; also on the SW's `lightex:push-resync`), logout clean-up before the anonymous logout call
  (≤ 1.5 s, errors ignored), and `ServiceWorkerBridge` in `Providers` (`lightex:navigate` → `pushUrl` for the same
  route, `router.push` for another).
- **`public/sw.js`:** plain static file, no imports, no fetch listener; install / activate / push / notificationclick /
  pushsubscriptionchange as §8.6, same-origin URLs only. `next.config.ts` adds the `/sw.js` header rule after
  `/:path*` (checked on the dev server: `application/javascript`, `no-cache, no-store`, its own CSP). The page CSP is
  unchanged. `public/push-badge.png` is a 96 × 96 white "cut X" glyph on transparent.
- **Send test:** spinner, C14 (`{ workspace }`), toast "Test sent · Telegram" + the device-style preview card (top
  right, 4 s) with the neutral `test` copy; error toasts with the §5.11 copy, then C1 refetches (a permanent failure
  changes the connection).
- **Realtime:** `channels.changed` → `qk.channels()` and the open Telegram link (`apply-event.ts`).
- **Mock:**
  - Seed: `u_alex` has Telegram `@alexkim` and push on "Chrome on macOS" (another device), quiet hours in
    `America/New_York`; everyone else has nothing. `ensureExt38` (marker `ext38`, no `SCHEMA` bump) adds the
    collections, merges the channel keys and quiet hours into cached preferences (in_app / email untouched) and sets
    `smsEnabled` on workspaces.
  - Telegram codes rotate through the design's `K7MQ2X`, `R4TZ9P`, `B8WN3H`, `J2XC7V`; links scan themselves after
    5 s unless "Telegram: manual" (then "Simulate scan (mock)", `data-mock-scan`, in the dialog). SMS code `482913`
    with a dev toast through `mockBus` (`mock.sms_code`, never forwarded to the stream); `…5550000` numbers fail with
    502 `invalid_number`. Every §7.5 limit is enforced with the server's numbers (connect 20/h, OTP 5/h and 10/day
    per user, 5/h per number across users, 100/day overall, resend 30 s, tests 12/h, the SMS daily cap 10).
  - **Dispatcher** (`channels-dispatch.ts`): every notification also fans out to the wanted, usable external targets
    (even with in-app off; SMS needs the workspace policy and the caps; one row per push device), deferred during
    quiet hours to the window's end (Urgent bypass), released lazily as the original or one summary (originals
    `coalesced`), stale after 24 h, re-timed when quiet hours are saved. It is the delivery log only (nothing is
    sent; no UI shows it); C1's `sentToday` counts it.
  - **Dev pill → Notification channels:** Telegram: manual, Channel failures (one-shot), Block bot, Reply STOP,
    Reply START.
- **Tests:** `channels-lib.test.ts` (shared phone vectors; quiet hours: segments, labels, zones, same-day / overnight
  windows and day semantics, Urgent bypass, window end and DST gap / overlap; sha256; push view; columns; every row
  state; preference helpers; the Telegram and SMS machines; OTP editing), `push.test.ts` (enable / denied /
  dismissed / C11 failure / Check again / Turn off / sync incl. key rotation and 404 / logout order and the 1.5 s cap;
  `public/sw.js` push, malformed push, open-redirect guard, notificationclick focus vs open, pushsubscriptionchange),
  `src/lib/mock/channels.test.ts` (seed and `ensureExt38`, C1–C14 incl. every limit and error, P1 merge and
  validation, W1 permission and audit, the dispatcher), `preferences.test.tsx` (matrix, page per role, policy switch,
  saves, quiet-hours validation, Send test success / 502, disconnect, the SMS flow incl. lock-out and send failure,
  the Telegram flow incl. cancel, scan, countdown warn and New code, push enable / blocked), and the realtime mapping.

### Deviations (board 38)

- **No QR code (dependency pending).** The spec draws the Telegram QR with the new npm package `uqr` (§8.10). The
  user hasn't approved new dependencies, so it is **not installed** and the dialog has no QR: a TODO comment in
  `telegram-dialog.tsx` marks the spot. The "Open Telegram" deep link is therefore the primary action on **every**
  device (the spec shows it on coarse pointers only, §10 #2), and the code covers the "send to @lightex_bot" path. The
  mock's simulated scan is a "Simulate scan (mock)" link instead of a click on the QR. When `uqr` is approved: add it
  to §2, draw `qr.tsx` (one `<path>` of `M x y h1v1h-1z` runs on a white tile, blurred "Expired" overlay) at the TODO,
  and show "Open Telegram" on coarse pointers only.
- The design's "Show QR code" start step isn't built: opening the dialog requests the code at once (§8.5 step 1).
- The spec's conflicts are resolved as its §10 says: dialog copy without quick replies (#1), "Reply STOP to opt out"
  (#3), Email delivery kept (#4), quiet hours default every day (#5), all IANA zones (#6), a plain-text email test
  (#7), a device menu (#8, as a "Devices" link next to the status), unsupported / iOS states (#9), "Bot blocked in
  Telegram" + Reconnect (#10), × kept when off by admin (#11), IN listed in the mock (#12), neutral test copy with no
  `PRJ-42` in the preview (#13), the admin row in the Channels card (#14), "Code expired" (#15).
- **`public/sw.js` fix:** the spec's `safeUrl()` turned a payload without `url` into `/undefined`; it now returns `/`
  for a missing or non-string URL (`SW_VERSION` 38.2). A `null` JSON body also shows the default notification.
- **`PushPlatform`** gains `requestPermission()` (so the row can show "Waiting for browser…" before subscribing) and
  `currentKey()` (the applicationServerKey for the rotation check); `PushSubscriptionJSON` carries neither.
- **"This browser"** hashes the endpoint with a small synchronous SHA-256 (`sha256.ts`, FIPS-vector tested) instead of
  SubtleCrypto, which is async and missing outside secure contexts; the mock uses the same function.
- **Matrix notes** beyond the design: "STOP" (replied STOP), "Unavailable" (server disabled / unsupported browser) and
  "Retry" (C1 failed). Dead cells say why ("…: not connected", "off by admin", "blocked in browser").
- **The Push column is live while any of the user's browsers has an active subscription** (the server delivers to all,
  §6.2 #3), not only when this browser is on.
- **No "Code sent" toast** (design `flash('Code sent')`): the OTP step says it inline, and at 390 px a toast covered
  the bottom sheet. "Code resent" is kept.
- **The page reads the workspace query** (`useWorkspace`) for `notificationPolicy`, so the optimistic switch shows
  at once.
- **Overlapping dialog mounts share one C2** (StrictMode's double effect and the lazy chunk's swap in dev): a second
  C2 cancelled the code the surviving mount showed, so it read "Code expired" at once. Found in the screenshot sweep.
- **OTP focus moves synchronously** (not after a frame): fast typing or autofill otherwise landed in the same box.
- **Mock-only:** extra optional collections `otpSends`, `channelDeliveries`, `channelThrottle`; Telegram handles come
  from the user's name (`Taylor Ng` → `@taylorng`); C2 and C6 share the connect throttle; "Channel failures" is
  one-shot and applies the permanent failure to the connection (blocked / opted out / expired), as §6.8 does.
- **C14 workspace** goes in the body (`{ workspace }`, §8.3's code), not `?workspace=` (§6.4's wording).

### Known gaps (board 38)

- Live mode is untested against the backend (no `apps/channels` there yet). Webhooks H1–H3 are provider-facing; the
  dev pill simulates them.
- **QR code** pending the `uqr` decision (above).
- The Playwright smoke suite (`e2e/smoke.spec.ts`) is not extended. Verified instead with scripted Playwright runs at
  1440 and 390, dark and light, as `u_alex` (admin row) and `u_taylor` (no admin row): the page, Telegram pending and
  linked, the SMS wrong-code error, the Send-test preview, push blocked (old headless Chromium reports "denied") and
  push on (new headless with the permission granted; the SW registered as `/sw.js`), and the loading skeleton. No
  console errors and no horizontal scroll.
- Toasts stack above a bottom sheet at 390 px (app-wide toaster placement); the mock's dev code toast can cover the
  OTP step on a phone.
- The mock fan-out writes the delivery log but shows no OS notification for events (only Send test does, through the
  service worker); deferred rows are released when C1 or a new event reads the log, not on a timer.
