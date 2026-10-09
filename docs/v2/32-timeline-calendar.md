# v2 · Board 32: Timeline & calendar (API contract)

Status: **contract, not implemented.** The backend (Django + DRF, `backend/`) and the frontend (Next.js,
`frontend/`) are built from this document in parallel. Where this document is silent, the v1 conventions in
`docs/backend-plan.md`, `frontend/docs/api-contract.md` and `frontend/src/lib/api/*.ts` apply unchanged, and so do the
board 39 rules in `docs/v2/39-fields-dependencies-time.md` (this board reads its dependency data).

Design source: `frontend/design/clean/32-Timeline-amp-calendar.html` (frames: Timeline, Timeline · quarter, Mobile,
Resizing, Calendar · month, Loading, Empty, Calendar · week, Error; role prop admin / member / viewer). Precedence is
unchanged: **docs and existing conventions win for behaviour, the design wins for appearance.** Every conflict and
its resolution is in §8.

Contents: 0 Wire conventions · 1 Scope · 2 Data model · 3 Permissions · 4 Endpoints · 5 Side effects · 6 Frontend ·
7 Test plan · 8 Conflicts · 9 Open questions · 10 Delivery checklist.

**Summary of the change.** Board 32 needs **no new endpoint**. It adds one task field (`startDate`), two epic fields
(`startDate`, `dueDate`), three list filters on the existing `GET /projects/:id/tasks` (`filter[from]`,
`filter[to]`, `filter[scheduled]`), one sort key (`startDate`), and two new project views on the frontend. Everything
else (rescheduling, milestones, sprints, dependency arrows) reuses existing endpoints and payloads.

---

## 0. Wire conventions (unchanged, restated so nobody guesses)

- Base `/api/v1`. JSON. camelCase fields; the only snake_case key is `my_permissions`.
- Timestamps are ISO-8601 UTC (`ISODateTime`). Calendar dates are `YYYY-MM-DD` (`ISODate`) and carry **no time
  zone**: a task due `2026-10-09` is due on Oct 9 wherever the viewer is. All date maths in this board works on
  `ISODate` strings (UTC day index), never on local `Date` objects, so DST can't shift a bar.
- Errors: `{ "code": string, "message": string, "details": object }`. Validation is **422** `validation_failed` with
  `details.fields: { "<field>": "<message>" }`. Query-parameter errors use the parameter as the key
  (`"filter[from]"`).
- Paginated lists: `{ "data": T[], "nextCursor": string | null }`, `?cursor=&limit=`.
- Filters: `filter[key]=value`, repeated for OR.
- Update → **200** with the object. Permission failure → 403 `forbidden` with `details.permission`. Not a workspace
  member → 404. Workspace member, not on the project → 403 `project_membership_required`.
- Task writes send `version`; a stale one → 409 `version_conflict` with `details.current` (the fresh `Task`).
- Writes on a soft-deleted task → 409 `task_deleted` "This task was deleted. Restore it to make changes."
- Archived projects are read-only through `my_permissions` (`ARCHIVED_ALLOWED` is unchanged), so every write in this
  document returns 403 there and the UI shows no drag affordance.
- IDs are UUIDs on the backend and opaque strings in the mock (`p_prj-t42`). Clients never parse ids.

---

## 1. Scope

### 1.1 What board 32 shows

Two new **project views**, side by side with Board / List / Backlog (design view switcher):

| Surface | Route | What |
|---|---|---|
| **Timeline** | `/[ws]/projects/[key]/timeline` | Gantt-style lanes: a Milestones lane, a Sprints lane (§8 #10), then one group per epic (epic bar + its task bars) or per assignee. Zoom Week / Month / Quarter, pan, Today. Drag a bar to reschedule, drag an edge to resize. Today marker, weekend shading, dependency arrows (§1.6), unscheduled tray (§1.7). |
| **Calendar** | `/[ws]/projects/[key]/calendar` | Month grid (Mon-first, "+N more" popover) and Week columns. Tasks sit on their **due date**. Drag a chip to another day to reschedule. At ≤ 760 px it becomes the design's **agenda** (week strip + day groups). |

**Workspace-level views:** none. The design only shows project views (its sidebar has no timeline or calendar
entry, and the mobile frame is "Platform Rebuild · October"). A cross-project "My calendar" is an open question
(§9 #1).

Out of scope (not designed, not in this contract): auto-scheduling or dependency-driven shifting, working-day
calendars and holidays, hour-level scheduling, baselines, critical path, sprint or milestone drag on the timeline,
creating a task by drawing on an empty lane, saving timeline/calendar as a saved view layout (§9 #3), printing/export.

### 1.2 Timeline anatomy (desktop, > 760 px)

```
┌ toolbar: ‹ › Today │ Week·Month·Quarter │ Group ▾ │ Dependencies ◻ │ Unscheduled 6 │ (filters) ┐
├ label column ("Epics" / "People") ┬ axis: row 1 = months (week/month zoom) or quarters; row 2 = days / week starts / months ┤
│ ⚑ Milestones                       │        ◆ Beta launch (Oct 21)         ◆ RC                    │
│ ⟳ Sprints                          │ ▭ Sprint 13 ▭ Sprint 14 (active) ▭ Sprint 15                  │
│ ▸ ■ Auth overhaul        5         │ [██████ 45% ─────────────]                                    │
│ ▾ ■ Board performance    6         │      [████ 50% ────────────────────]                          │
│     ◔ PRJ-42 Fix flaky board…      │        [▓▓▓▓▓────]──┐                                         │
│     ○ PRJ-45 …                     │                     └──▶[──────]                              │
│ ▾ No epic                3         │                                                               │
└────────────────────────────────────┴──────── today line (accent) ─────────────────────────────────┘
```

| Element | Rule |
|---|---|
| Zoom | `week` = 28 days shown, day ticks, pan step 7 days · `month` = 91 days, week-start ticks (Monday date), pan step 28 days · `quarter` = 273 days, month ticks, pan step 91 days. Default `month`. (Design `Z` and `STEP`.) |
| Default window (no `at` in the URL) | week → Monday of (today − 7 days); month → 1st of the previous month; quarter → 1st day of the previous quarter. For today = 2026-10-07 that is Sep 28, Sep 1 and Jul 1 (the design's windows). `at` in the URL overrides the window start. |
| Axis | Row 1: month labels "Oct 2026" (week, month zoom) or "Q4 2026" (quarter). Row 2: day numbers with weekend tint and today highlight (week), Monday dates (month), month names (quarter). Major gridlines at row-1 boundaries, minor at row-2. |
| Today marker | Vertical accent line through the body + "Today" pill in the axis, at the middle of the viewer's **local** today. Hidden when today is outside the window. |
| Weekends | Tinted columns at week and month zoom; none at quarter zoom (design). |
| Milestones lane | Always first. One diamond per milestone whose `dueDate` is in the window, label = name (truncated, §8 #12), date "Oct 21" (+ " · done" when `completedAt`). Done milestones use the `done` style. Diamond is a button: opens the Milestones view (`routes.project(ws, key, "milestones")`). Not draggable. A vertical milestone guide line runs through the body (design `tl-mg`). |
| Sprints lane | Second. One thin bar per sprint overlapping the window: name, `startDate → endDate`; active sprint in accent, completed dimmed, planned outlined. Read-only. Click → Sprints view `?sprint=<id>` when the viewer has the Sprints tab (`sprint.manage` or `task.move`), otherwise not interactive. Hidden when no sprint overlaps the window. |
| Group by | `epic` (default; label-column header "Epics") or `assignee` (header "People"). Menu in the toolbar. |
| Epic group | Header row: chevron (expand/collapse), hue square, name, task count, and the **epic bar** (`--h` = epic hue, fill = `epic.progress.percent`, "45%" label). Archived epics get an "Archived" tag and a non-draggable bar. Groups are ordered as `GET /projects/:id/epics` returns them; a final **"No epic"** group (no bar) holds tasks with `epicId: null`. |
| Epic bar span | `epic.startDate → epic.dueDate` when both are set. Otherwise the **derived span** = min task start → max task end of the epic's tasks in the current response, drawn with a dashed outline ("derived"). An epic with no dates and no tasks in the window is not shown. |
| Assignee group | Header row: avatar + name + count, no bar. "Unassigned" last. Former members show "Former member". Rows always expanded. |
| Task row | Label: status glyph, key (mono), title (ellipsis). Bar: `--h` = epic hue (assignee grouping: the epic hue too, or `--text-3` with no epic), fill by status glyph: done 100 %, review 80 %, progress 45 %, else 0 % (design). Done tasks dimmed. |
| Task order in a group | effective start ascending, then task `number`. |
| Which tasks | Live (not deleted) tasks of the project, **including sub-tasks**, whose effective span (§2.1) overlaps the window, minus tasks in a **canceled** status (glyph `canceled`), minus tasks hidden by the filter bar. |
| Expand state | All groups expanded on first visit (§8 #18). The viewer's collapsed groups are remembered per project in `localStorage` (`lightex-timeline-collapsed:<projectId>`, wrapped in try/catch). |
| Bar tooltip while dragging or keyboard-moving | "Oct 1 → Oct 9 · 9d"; the edge being changed is highlighted (design `tl-tip`). |
| Large ranges | Rows are virtualised (TanStack Virtual, already a dependency) once a window has more than 150 rows. |

### 1.3 Calendar anatomy (desktop, > 760 px)

| Element | Rule |
|---|---|
| Modes | `month` (default) and `week`. Toolbar: ‹ period › ("October 2026" / "Oct 5 – Oct 11", `aria-live=polite`), Today, Month·Week, Unscheduled, filters. |
| Month grid | Mon–Sun header; 4 to 6 rows (leading/trailing days of other months dimmed `out`); day number, "Oct 1" style on the 1st; weekend tint; today highlight. |
| Which tasks | Live tasks (incl. sub-tasks) with a **`dueDate`** inside the grid, minus canceled, minus filtered. A chip sits on its `dueDate`. Start-only tasks are not on the calendar (they are on the timeline). |
| Chip | Priority bars, status glyph, key, title; week mode adds the assignee avatar and puts the title on its own line. Done tasks dimmed. A pending-sync dot while the PATCH is in flight (design `cl-sync`). |
| Order within a day | status glyph order progress, review, todo, backlog, done, then priority descending, then `number`. |
| Overflow (month) | Up to **3** chips per cell. With more, the cell shows 2 chips + a "+N more" button that opens a popover (`role=dialog`, title "Wed Oct 7", close button autofocused, Esc closes) listing every chip with avatars. Chips in the popover are draggable too. |
| Week | 7 columns, every chip shown, "—" in an empty column. |
| Empty | The grid always renders (an empty calendar is meaningful). When the range has no chips, the period label gets a muted suffix "· Nothing due". |

### 1.4 Rescheduling (drag, resize, keyboard)

| Gesture | Timeline | Calendar |
|---|---|---|
| Pointer down on the middle of a bar / on a chip, move | **Move**: start and due shift by the same whole number of days. Snaps to days. | **Move** to the day under the pointer (drop target cell highlighted `drop`). Shifts `dueDate` to the new day **and `startDate` by the same delta** when set (keeps the duration). |
| Pointer down within 9 px of the left / right edge (16 px for touch) | **Resize** start / due. Clamped so start ≤ due (minimum 1 day). | — |
| Activation | Mouse/pen: 3 px movement. Touch: press-and-hold 200 ms (tolerance 6 px), so a plain swipe still scrolls. Click without movement opens the task panel. | Same. |
| Commit | On pointer up when the dates changed: optimistic update, one `PATCH /tasks/:id` (§4.3), toast with Undo. Pointer cancel or Esc during a drag reverts with no request. | Same. |
| Keyboard (focused bar/chip) | `←` / `→` move 1 day; `Shift+←/→` resize the **due** edge (design). | `Alt+←/→` ±1 day; `Alt+↑/↓` ±7 days (design). |
| Keyboard commit | Each key press updates the bar at once and announces it; the PATCH is sent **600 ms after the last key** or on blur (one request per burst, §8 #6). `Esc` before the send reverts. | Same; focus stays on the moved chip. |
| Other keys | `Enter`/`Space` opens the task panel (`?task=KEY`). `↑`/`↓` move focus to the previous/next bar (timeline, roving tabindex: only one bar per row group is in the tab order). | `Enter`/`Space` opens the panel. |
| Epic bar | Same move/resize/keyboard rules, `PATCH /epics/:id` (§4.4). Dragging a derived bar writes both dates. `Enter` toggles the group. | — |
| Unscheduled tray item (§1.7) | Drop on a lane → sets `dueDate` = the day under the pointer (start stays null). | Drop on a day → sets `dueDate`. |

Live region (`aria-live=polite`, visually hidden) announces, as in the design: during keyboard moves
"PRJ-34 Session timeout modal: Oct 8 to Oct 12, 5 days"; after a drop "PRJ-34 Session timeout modal: Oct 8 to Oct 12"
(timeline) or "PRJ-34 moved to Thu Oct 8" (calendar); after Undo "Undone".

Toast after a commit (5 s, v1 toast with an **Undo** action): timeline task "**PRJ-34** Oct 6 → Oct 8"; epic "Sprint
engine · Sep 1 → Oct 30"; calendar "**PRJ-34** → Thu Oct 8". Undo is defined in §6.6.

Accessible names: task bar `aria-roledescription="draggable bar"` (or `"bar"` when not editable), `aria-label`
"PRJ-34 Session timeout modal, Oct 6 to Oct 10" + ", blocked by PRJ-48" when `isBlocked` + ". Arrow keys move,
Shift plus arrow resizes" when editable. Chip `role=button`, `aria-roledescription="draggable task"` / `"task"`,
`aria-label` "PRJ-34 Session timeout modal, To do, medium priority, due Oct 10. Alt plus arrow keys reschedule".
Day cells `role=group`, `aria-label` "Wed Oct 7, 3 tasks". Every drag has a non-drag alternative: the keyboard
gestures above and the Start/Due fields in the task panel (WCAG 2.5.7).

### 1.5 Who can do what

Permissions come only from the project's `my_permissions` (§3). "Can edit task" = v1 `canEditTask`: `task.edit_any`,
or `task.edit_own` when the viewer is the task's assignee or reporter.

| Action | Rule | PRJ seed roles |
|---|---|---|
| See Timeline and Calendar tabs and all their data | `project.view` | everyone on the project |
| Drag / resize / keyboard-move a **task** bar or chip; drop from the tray | can edit **that** task | Project Admin, Manager: all tasks · Member: tasks they report or are assigned · Viewer: none |
| Drag / resize an **epic** bar | `epic.manage` | Project Admin, Manager |
| "New task" button (toolbar / mobile FAB) | `task.create` | Project Admin, Manager, Member |
| Empty state "Add dates" button | `task.edit_any` or `task.edit_own` | Project Admin, Manager, Member |
| Unscheduled tray | visible to everyone; items draggable only when the task is editable | |
| Archived project | nothing editable (permissions withheld) | |

A bar or chip the viewer can't edit has no grips, no `ed` class, `cursor: default`, and its accessible description
has no key hints. Nothing is rendered disabled, so no `disabledReason` is needed.

### 1.6 Dependency arrows

- Source: board 39's `Task.openBlockers` (every `Task` payload). An arrow is drawn from each **open blocker** to the
  task it blocks when **both** bars are on screen (both in the response, not filtered out, groups expanded).
  Satisfied dependencies (blocker in Done/Canceled) are not drawn: they no longer constrain the schedule (§9 #2).
- Path: from the right end of the blocker bar to the left end of the blocked bar, orthogonal with one elbow and an
  arrowhead, 1.5 px, `var(--text-3)`, inside an `aria-hidden` SVG layer under the bars.
- **Conflict**: when the blocked task's effective start is on or before the blocker's effective end, the arrow uses
  `var(--danger)`. Drops are never refused because of a dependency.
- Hidden on the calendar and at ≤ 760 px. Toolbar toggle "Dependencies" (`aria-pressed`), on by default, kept in the
  URL as `deps=0` when off. While dragging, only the dragged task's arrows are recomputed.
- The relation is also exposed as text: the bar's `aria-label` suffix ", blocked by PRJ-48" and the board 39
  "Blocked" chip in the task panel.

### 1.7 Unscheduled tray

The design's empty state has an "Add dates" button with no destination; the tray is that destination (§8 #9).

- Toggle button "Unscheduled N" in the toolbar of both views (`aria-expanded`); opens a 300 px right-hand panel inside
  the view (not a modal), listing **open** tasks (status category not `done`) with neither `startDate` nor `dueDate`,
  highest priority first. Row anatomy = the timeline label cell (glyph, key, title) + priority bars + avatar.
- Data: `GET /projects/:id/tasks?filter[scheduled]=false&filter[status]=…open status ids…&sort=-priority&limit=200`
  (§4.2). N is the number loaded; "200+" when `nextCursor` is set, with a footer "Showing the 200 highest priority".
- Items are draggable onto a lane/day when editable (§1.4). Each row also has an "Add dates" button that opens the
  task panel (`?task=KEY`) with the Start and Due fields revealed, the keyboard path.
- Empty tray: "Everything open has a date".
- Hidden at ≤ 760 px.

### 1.8 States

| State | Timeline | Calendar |
|---|---|---|
| Loading (first load of a range) | Design skeleton: axis label bars + 5 lane rows with a skeleton bar each, `aria-busy=true`, `aria-label="Loading timeline"`. The toolbar is live. | Grid with day numbers and 0–2 skeleton chips per cell, `aria-label="Loading calendar"`. |
| Panning / zooming to an uncached range | Previous range stays on screen (`placeholderData: keepPreviousData`) with a 2 px progress bar under the toolbar; no skeleton flash. | Same. |
| Empty (range returned 0 tasks after removing canceled) | Design: icon, **"Nothing scheduled"**, mono meta "0 tasks with dates · Sep 1 – Nov 30", button **"Add dates"** (opens the tray; only with edit rights). Milestones and Sprints lanes still render above it. | Grid renders; period suffix "· Nothing due" (§1.3). |
| Filtered to nothing | v1 filter empty state: "No tasks match these filters" + "Clear filters". | Same, as a banner above the grid. |
| Error | `ErrorState` with title **"Couldn’t load timeline"**, meta `<status> · request <ref>` (mono), **Retry** (design "503 · PRJ timeline"; §8 #16). | "Couldn’t load calendar", same pattern. |
| Truncated (> 2,000 tasks in range) | Banner "Showing the first 2,000 tasks in this range. Zoom in or filter to see the rest." | Same. |
| Epics/milestones/sprints query failed | Lanes that depend on it are omitted and a one-line inline error with Retry sits in the label column; task bars still render. | n/a |

### 1.9 390 px behaviour

- **Calendar** at ≤ 760 px renders the design's **agenda** (Mobile frame) instead of the grid:
  - Header row inside the view: "Calendar", sub-line "Platform Rebuild · October", **Today**, and a "Switch to
    timeline" icon link (`/timeline`). The app shell's top bar and scrollable project tabs stay above it (§8 #13).
  - Week strip: 7 day buttons (letter + number, dot when tasks are due, today ring, selected fill,
    `aria-pressed`), with ‹ › buttons for the previous/next week (§8 #13). Selected day is `?day=YYYY-MM-DD`
    (default local today).
  - Agenda: starting at the selected day, up to 4 day groups within the next 21 days that have tasks; the selected
    day always appears ("Nothing due" when empty). Group heading "Today · Wed, Oct 7" / "Thu, Oct 8" + count.
  - Card: glyph, key, priority bars, title, epic swatch + epic name, avatar. Tap opens the task **sheet**
    (`?task=KEY`, v1 mobile sheet).
  - No drag. Rescheduling on a phone happens in the task sheet's Start/Due fields.
  - FAB "New task" with `task.create`, opening the create dialog with `dueDate` = the selected day.
  - Data: one range query for `[Monday of the selected week, +27 days]`.
- **Timeline** at ≤ 760 px: read-only. Label column narrows to 96 px (glyph + key), zoom control stays, the lanes
  scroll horizontally inside the view's own container (the page never scrolls horizontally), no grips, no arrows, no
  tray. Tap a bar opens the task sheet.
- Touch devices wider than 760 px get the full desktop UI with the press-and-hold activation (§1.4).

---

## 2. Data model

### 2.1 `tasks.Task.start_date` (new column)

| Field | Type | Notes |
|---|---|---|
| `start_date` | `DateField(null=True, blank=True)` | Wire `startDate`. Not to be confused with the existing `started_at` timestamp (set when work starts, never sent). |

Rules (service + DB):

- Both dates are optional and independent. **Start-only** and **due-only** tasks are valid. v1 tasks (due-only or
  undated) are unchanged and keep working everywhere.
- When both are set, `start_date ≤ due_date`:
  `CheckConstraint(condition=Q(start_date__isnull=True) | Q(due_date__isnull=True) | Q(start_date__lte=F("due_date")), name="task_dates_ordered")`.
- **Effective span** (used by the range filter, the timeline and every test vector):
  `spanStart = startDate ?? dueDate`, `spanEnd = dueDate ?? startDate`. A task with neither is **unscheduled**.
  A due-only task is a 1-day bar on its due date; a start-only task is a 1-day bar on its start date.
- Indexes: `Index(fields=["project", "due_date"], name="task_due")`, `Index(fields=["project", "start_date"], name="task_start")`.

### 2.2 `planning.Epic.start_date`, `planning.Epic.due_date` (new columns)

| Field | Type | Notes |
|---|---|---|
| `start_date` | `DateField(null=True, blank=True)` | Wire `startDate`. UI label "Start". |
| `due_date` | `DateField(null=True, blank=True)` | Wire `dueDate` (same name as `Milestone.dueDate`). UI label "Target". |

Constraint: **both or neither**, ordered:
`CheckConstraint(condition=Q(start_date__isnull=True, due_date__isnull=True) | Q(start_date__isnull=False, due_date__isnull=False, start_date__lte=F("due_date")), name="epic_dates_ordered")`.
(Spelled out because a plain `start_date__lte=F("due_date")` passes when one side is NULL.)

Epics have no `version` in v1 and don't get one: epic writes stay last-write-wins (§9 #4).

### 2.3 What does not change

- `Milestone.startDate/dueDate`, `Sprint.startDate/endDate`: used as they are, read-only on the timeline.
- Dependencies, `isBlocked`, `openBlockers`: board 39, unchanged.
- No new model, no new app, no new permission.

### 2.4 Migrations

- `tasks` 00xx: `Task.start_date`, `task_dates_ordered`, indexes `task_due`, `task_start`. Existing rows: `NULL`, so
  the constraint holds.
- `planning` 0003: `Epic.start_date`, `Epic.due_date`, `epic_dates_ordered`.
- No data migration. Order relative to board 39's migrations doesn't matter (different columns); both number after
  whatever is on `v2` when merged.

---

## 3. Permissions

**No new permission keys.** `PROJECT_PERMISSIONS` / `PROJECT_ORDER` are unchanged by this board.

| Need | Key |
|---|---|
| See the views and every payload in them | `project.view` |
| Change a task's `startDate` / `dueDate` (drag, keyboard, tray, panel) | v1 task edit rule: `task.edit_any`, or `task.edit_own` on tasks you report or are assigned. A PATCH with only `startDate`/`dueDate` is **not** a status-only patch, so `task.move` alone is not enough (unchanged `_authorize_patch`). |
| Change an epic's dates | `epic.manage` (existing `PATCH /epics/:id` rule) |
| Create a task from the views | `task.create` |

The frontend gates per item with `canEditTask(task, perms, meId)` and `can("epic.manage")`, never role names.

---

## 4. Endpoints

All under `/api/v1`. No new paths.

### 4.0 Summary

| # | Method | Path | Permission | Change |
|---|---|---|---|---|
| L1 | GET | `/projects/:id/tasks` (existing) | `project.view` | new `filter[from]`, `filter[to]`, `filter[scheduled]`; new sort key `startDate` |
| T1 | PATCH | `/tasks/:id` (existing) | v1 edit rule | accepts `startDate`; validates date order |
| T2 | POST | `/projects/:id/tasks` (existing) | `task.create` | accepts `startDate` |
| T3 | POST | `/projects/:id/tasks/bulk` (existing) | v1 | `patch.dueDate` checked against each task's `startDate`; `startDate` is **not** bulk-editable |
| P1 | GET | `/projects/:id/epics` (existing) | `project.view` | `Epic` gains `startDate`, `dueDate` |
| P2 | POST / PATCH | `/projects/:id/epics`, `/epics/:id` (existing) | `epic.manage` | accept `startDate`, `dueDate` |
| — | GET | `/projects/:id/milestones`, `/projects/:id/sprints` | `project.view` | unchanged, reused |

Every `Task` payload (lists, board, backlog, my tasks, workspace tasks, sprint board, bulk, PATCH/move responses,
`version_conflict.details.current`, search task results, `TaskDetail`) gains `startDate: ISODate | null`.
Every `Epic` payload gains `startDate: ISODate | null` and `dueDate: ISODate | null`. Additive; v1 clients ignore them.

### 4.1 L1 range query: `GET /projects/:id/tasks?filter[from]=&filter[to]=`

New query parameters (combine with every v1 filter, `q`, `sort`, `cursor`, `limit`):

| Parameter | Value | Meaning |
|---|---|---|
| `filter[from]` | `ISODate` | keep tasks whose effective span **ends on or after** `from` (`spanEnd ≥ from`) |
| `filter[to]` | `ISODate` | keep tasks whose effective span **starts on or before** `to` (`spanStart ≤ to`) |
| `filter[scheduled]` | `true` / `false` | `true`: at least one of `startDate`, `dueDate` set. `false`: neither set. |
| `sort` | adds `startDate` / `-startDate` | nulls last ascending (same sentinel approach as `dueDate`) |

- With both `from` and `to` the filter is an **inclusive overlap** test of `[spanStart, spanEnd]` against
  `[from, to]`. Unscheduled tasks never match `from`/`to`.
- `from`/`to` together with `filter[scheduled]=false` → always empty (allowed, not an error).
- Deleted tasks are excluded (v1). Canceled tasks are **included** (the API doesn't special-case status); the client
  drops them.
- Paging: unchanged keyset cursor, `limit` default 500, max 500. Order is `sort` then `id`, stable across pages.

Backend sketch (`tasks.selectors.filter_tasks`):

```python
span_start = Coalesce("start_date", "due_date")
span_end = Coalesce("due_date", "start_date")
if frm: qs = qs.annotate(_span_end=span_end).filter(_span_end__gte=frm)
if to:  qs = qs.annotate(_span_start=span_start).filter(_span_start__lte=to)
if scheduled is True:  qs = qs.filter(Q(start_date__isnull=False) | Q(due_date__isnull=False))
if scheduled is False: qs = qs.filter(start_date__isnull=True, due_date__isnull=True)
```

Validation (422 `validation_failed`):

| Key | Message | When |
|---|---|---|
| `filter[from]` | `Pick a date` | not `YYYY-MM-DD` |
| `filter[to]` | `Pick a date` | not `YYYY-MM-DD` |
| `filter[to]` | `End must be on or after the start` | `to < from` |
| `filter[to]` | `Pick a range of 400 days or less` | both given and `to − from + 1 > 400` |
| `filter[scheduled]` | `Use true or false` | any other value |

Errors otherwise as v1: 404 (not a workspace member / unknown project), 403 `project_membership_required`.

**Request** (timeline, month zoom, window Sep 1 – Nov 30 2026):

```
GET /api/v1/projects/5f0e…/tasks?filter[from]=2026-09-01&filter[to]=2026-11-30&sort=startDate&limit=500
```

**Response 200** (one item shown in full, the rest abbreviated):

```json
{
  "data": [
    {
      "id": "c41a…",
      "projectId": "5f0e…",
      "key": "PRJ-34",
      "number": 34,
      "title": "Session timeout modal",
      "type": "feature",
      "priority": 2,
      "statusId": "a7d2…",
      "assigneeId": "u-sam…",
      "reporterId": "u-alex…",
      "estimate": 2,
      "startDate": "2026-10-06",
      "dueDate": "2026-10-10",
      "epicId": "e-auth…",
      "milestoneId": "m-beta…",
      "sprintId": "s-14…",
      "parentId": null,
      "objectiveIds": [],
      "labelIds": ["l-frontend…", "l-design…"],
      "position": "a1",
      "version": 4,
      "createdAt": "2026-09-30T09:00:00Z",
      "updatedAt": "2026-10-06T08:12:00Z",
      "completedAt": null,
      "deletedAt": null,
      "subtaskCount": 0,
      "subtaskDoneCount": 0,
      "commentCount": 1,
      "attachmentCount": 0,
      "customFields": {},
      "isBlocked": false,
      "openBlockers": [],
      "timeEstimateMinutes": null,
      "loggedMinutes": 0
    },
    { "id": "…", "key": "PRJ-42", "startDate": "2026-10-01", "dueDate": "2026-10-21", "isBlocked": true,
      "openBlockers": [{ "id": "…", "key": "PRJ-48", "title": "Token refresh race on cold start" }], "version": 8 },
    { "id": "…", "key": "PRJ-46", "startDate": null, "dueDate": "2026-10-12", "version": 3 }
  ],
  "nextCursor": null
}
```

**Request** (unscheduled tray):

```
GET /api/v1/projects/5f0e…/tasks?filter[scheduled]=false&filter[status]=<backlog id>&filter[status]=<todo id>&filter[status]=<in progress id>&filter[status]=<review id>&sort=-priority&limit=200
```

Response: the same paginated `Task` shape, every item with `"startDate": null, "dueDate": null`.

**Error example** (422):

```json
{
  "code": "validation_failed",
  "message": "Some fields need fixing.",
  "details": { "fields": { "filter[to]": "Pick a range of 400 days or less" } }
}
```

### 4.2 T1 reschedule: `PATCH /tasks/:id`

New optional body key `startDate: ISODate | null`, alongside the v1 keys. `version` stays required.

**Move** (timeline drag, both edges; calendar move of a task with a start date):

```json
{ "startDate": "2026-10-08", "dueDate": "2026-10-12", "version": 4 }
```

**Resize the start edge** (timeline):

```json
{ "startDate": "2026-10-03", "version": 4 }
```

**Calendar move / tray drop of a due-only or undated task**:

```json
{ "dueDate": "2026-10-08", "version": 3 }
```

**Undo** (sent with the version from the previous response, §6.6):

```json
{ "startDate": "2026-10-06", "dueDate": "2026-10-10", "version": 5 }
```

**Response 200**: the full `Task` with `version` + 1 (once per PATCH, however many keys).

```json
{ "id": "c41a…", "key": "PRJ-34", "startDate": "2026-10-08", "dueDate": "2026-10-12", "version": 5, "updatedAt": "2026-10-09T10:02:11Z", "…": "…" }
```

Rules:

1. **Version first.** Stale or missing → 409 `version_conflict` "Someone else changed this card." with
   `details.current` = the fresh `Task`; missing → 422 `version: "Send the version you edited (optimistic concurrency)."`
   (v1 order: version, then deleted, then keys, then authorisation).
2. Deleted task → 409 `task_deleted`.
3. Authorisation: v1 edit rule. Failure → 403 `forbidden` "You can only edit tasks you reported or are assigned."
   `details.permission: "task.edit_any"`.
4. Order check runs on the **resulting** pair (patched value, else the stored value).

Validation (422 `validation_failed`, `details.fields`):

| Field | Message | When |
|---|---|---|
| `startDate` | `Pick a date` | present, not null, not `YYYY-MM-DD` |
| `dueDate` | `Pick a date` | as v1 |
| `startDate` | `Start date must be on or before the due date` | result has start > due and `startDate` was sent |
| `dueDate` | `Due date must be on or after the start date` | result has start > due and only `dueDate` was sent |

A no-op PATCH (dates equal to the stored ones) still bumps `version`, as every v1 PATCH does. The client never sends
one (it skips commits whose dates didn't change).

| Status | Code | When |
|---|---|---|
| 200 | — | saved |
| 403 | `forbidden` | no edit right on this task; archived project |
| 403 | `project_membership_required` | not on the project |
| 404 | `not_found` | unknown or invisible task |
| 409 | `version_conflict` | stale version (`details.current`) |
| 409 | `task_deleted` | task in Trash |
| 422 | `validation_failed` | table above |

### 4.3 T2 create and T3 bulk

- `POST /projects/:id/tasks` accepts `startDate` (same format and order validation as T1, same messages). The create
  dialog doesn't show it in this release; it exists for API symmetry and the seed.
- `POST /projects/:id/tasks/bulk`: `startDate` is **not** in `BULK_FIELDS` (422
  `patch.startDate: "This field can’t be bulk-edited"`, v1 message). A bulk `patch.dueDate` earlier than any selected
  task's `startDate` fails the whole request (all-or-nothing, v1):
  422 `patch.dueDate: "PRJ-42 starts after this date"` (the first offending key by number). `patch.dueDate: null`
  is always allowed (the task becomes start-only).

### 4.4 Epics: P1, P2

`Epic` shape (fragment):

```json
{
  "id": "e-sprint…", "projectId": "5f0e…", "name": "Sprint engine", "hue": 150,
  "ownerId": null, "milestoneId": "m-beta…", "archivedAt": null,
  "startDate": "2026-09-01", "dueDate": "2026-10-30",
  "progress": { "done": 3, "total": 5, "percent": 60 }
}
```

`PATCH /epics/:id` (epic bar drag; resize sends both too, so the pair is always consistent):

```json
{ "startDate": "2026-09-01", "dueDate": "2026-11-11" }
```

Response 200 `Epic`. `POST /projects/:id/epics` accepts the same two keys.

| Field | Message | When |
|---|---|---|
| `startDate` / `dueDate` | `Pick a date` | bad format |
| `startDate` | `Set both dates or neither` | the result would have exactly one date |
| `dueDate` | `Target date must be on or after the start date` | result start > due |

403 without `epic.manage` (v1). No version, no 409: last write wins (§9 #4). `{ "startDate": null, "dueDate": null }`
clears both (the bar becomes derived again).

### 4.5 Milestones and sprints

Reused as they are: `GET /projects/:id/milestones` (`dueDate`, `completedAt`, `name`) and
`GET /projects/:id/sprints` (`startDate`, `endDate`, `state`, `name`). Both are bounded per-project lists; the client
filters them to the window. No range parameters are added.

### 4.6 Error handling summary for the client

| Response to a reschedule | UI |
|---|---|
| 200 | `commitTask` (new version everywhere); toast with Undo stays |
| 409 `version_conflict` | roll back, v1 `conflictToast()` "Someone else changed this card", invalidate the project's task queries |
| 409 `task_deleted` | roll back, error toast with the server message, invalidate |
| 403 | roll back, error toast with the server message (the item becomes non-draggable after the refetch) |
| 422 | roll back, error toast with the field message |
| network / 5xx | roll back, error toast "Couldn’t save PRJ-34 … Reverted." with **Retry** (v1 `failToast`) |

---

## 5. Side effects

| Write | Effect |
|---|---|
| Task `startDate` change | `Task.version` + 1 (part of the PATCH). Audit `task.updated` with `change("Start date", before, after)` (ISO or null), mirroring the v1 "Due date" change row. Shows in the activity feed as the v1 "updated the task" entry. Search vector unchanged. |
| Task `dueDate` change | Unchanged v1 behaviour (audit, due-soon reminders read `due_date` as before). |
| Epic dates | Audit `epic.updated` with `change("Start date", …)` and `change("Target date", …)` (existing action). |
| Notifications | None new. `startDate` triggers nothing; `due_soon` is unchanged. |
| Sprint scope, burndown, velocity, reports | Unaffected (dates are not scope). |
| Trash / restore | `startDate` is kept like every other column. |
| `seed_demo` | Loads the new seed values through `backend/scripts/frontend-seed/dump-seed.mts` (§6.9). |

---

## 6. Frontend

Lift the ban first: in `frontend/CLAUDE.md`, remove "timeline/calendar" from the "No v2 features" bullet and add
`timeline` and `calendar` to the project views list. Add every field and filter of §4 to "Requested API additions" in
`frontend/docs/final-report.md`, and move board 32 from "Not built" to built in its §7 table (paper-trail rule).
No new npm dependency: drag is hand-written pointer events (as in the design) because dnd-kit's sortable model
doesn't fit day-snapped bars; Radix Popover and TanStack Virtual are already installed.

### 6.1 Routes and tabs

| Path | What |
|---|---|
| `src/app/[workspace]/projects/[key]/timeline/page.tsx` | thin page, `<Suspense><TimelineScreen /></Suspense>` |
| `src/app/[workspace]/projects/[key]/calendar/page.tsx` | thin page, `<Suspense><CalendarScreen /></Suspense>` |
| `src/lib/routes.ts` | `ProjectView` gains `"timeline" \| "calendar"` |
| `features/projects/project-shell.tsx` `projectTabs` | `{ view: "timeline", label: "Timeline", show: true }`, `{ view: "calendar", label: "Calendar", show: true }` right after Backlog |

### 6.2 `src/lib/api/types.ts`

```ts
interface Task {
  /* …v1 and board 39 fields… */
  /** Board 32. Effective span = [startDate ?? dueDate, dueDate ?? startDate]. */
  startDate: ISODate | null;
}

type TaskPatch = /* v1 + board 39 */ & { startDate?: ISODate | null };   // add "startDate" to the Pick<>
interface TaskCreate { /* v1 */ startDate?: ISODate | null }

interface Epic {
  /* v1 */
  /** Board 32: both or neither. Null = the timeline derives the span from the epic's tasks. */
  startDate: ISODate | null;
  dueDate: ISODate | null;
}
type EpicWrite = /* v1 */ & { startDate?: ISODate | null; dueDate?: ISODate | null };

/* ── Timeline & calendar (board 32), client-only ── */
export type TimelineZoom = "week" | "month" | "quarter";
export type TimelineGroup = "epic" | "assignee";
export type CalendarMode = "month" | "week";
```

### 6.3 `src/lib/api/endpoints.ts`

```ts
export const tasks = {
  /* …v1… */
  /** Board 32: tasks whose span overlaps [from, to] (inclusive), one page. */
  range: (projectId: string, from: ISODate, to: ISODate, cursor?: string | null) =>
    http.get<Paginated<Task>>(`/projects/${enc(projectId)}/tasks`, { filter: { from, to }, sort: "startDate", limit: 500, cursor }),
  /** Board 32 tray: open tasks with no dates, highest priority first. */
  unscheduled: (projectId: string, openStatusIds: string[]) =>
    http.get<Paginated<Task>>(`/projects/${enc(projectId)}/tasks`, {
      filter: { scheduled: "false", status: openStatusIds }, sort: "-priority", limit: 200,
    }),
};
// planning.updateEpic and tasks.update are unchanged: the new keys ride in EpicWrite / TaskPatch.
```

### 6.4 `src/lib/api/query-keys.ts`

```ts
/** Board 32: tasks overlapping a window. Under ["p", id] so qk.scope invalidation and patchTasks reach it. */
schedule: (projectId: string, from: string, to: string) => ["p", projectId, "schedule", from, to] as const,
unscheduled: (projectId: string) => ["p", projectId, "unscheduled"] as const,
```

Both caches hold `{ data: Task[]; nextCursor: string | null; truncated?: boolean }`, a shape `mapTasksIn` already
walks (`data` key), so `patchTasks`, `commitTask` and `insertTask` update them with no change to `optimistic.ts`.
Because `insertTask` appends new tasks to any `{ data }` list in the project, **every consumer re-applies its own
predicate in `select`** (range overlap, scheduled/unscheduled, not canceled, not deleted).

Invalidation: reschedule → v1 `useUpdateTask` paths (`commitTask`; `onSettled` already invalidates sprints,
objectives, milestones, summary, activity); tray drop also invalidates `qk.unscheduled`. Epic date write →
`qk.epics(projectId)`. Freshness: no polling; refetch on window focus (v1 default).

### 6.5 Queries (`features/schedule/queries.ts`)

- `useScheduleTasks(projectId, from, to)`: `useQuery({ queryKey: qk.schedule(…), queryFn, placeholderData: keepPreviousData })`.
  `queryFn` follows `nextCursor` for up to **4 pages** (2,000 tasks), merges them into one `{ data, nextCursor: null,
  truncated }` object. `select` keeps tasks that are live, not canceled (status glyph lookup via `useStatuses`), and
  overlap `[from, to]`.
- `useUnscheduled(projectId)`: enabled only while the tray is open; needs `useStatuses` loaded to pass open status
  ids. `select` keeps live, open, undated tasks.
- Epics, milestones, sprints, statuses, members: the existing `features/projects/queries.ts` hooks.
- Filter bar: v1 `useUrlFilters` + `useFilterOptions` + `applyFilters` (client-side, like Board and List), rendered
  through `FilterBar` **without** Save view (`onSave` undefined, §9 #3).

### 6.6 Optimistic reschedule, Undo and rollback (`features/schedule/use-reschedule.ts`)

```ts
type Dates = { startDate: ISODate | null; dueDate: ISODate | null };
function useReschedule(): {
  preview(task: Task, next: Dates): void;      // local only (drag frames, keyboard bursts)
  commit(task: Task, next: Dates, opts: { toast: string; announce: string }): void;
  cancel(taskId: ID): void;                    // Esc / pointercancel: drop the preview, send nothing
};
```

- **Preview** state lives in the dragged bar/chip component (ref + local state), not in the query cache, so a drag
  re-renders one row and its arrows only.
- **Commit** (pointer up, or 600 ms after the last key, or blur): if the dates equal the cached ones → nothing.
  Otherwise call v1 `useUpdateTask().mutate({ task, patch })` with only the changed keys (a move sends both). It
  snapshots, `patchTasks` every task cache in the project (timeline, calendar, list, board, task detail), and on
  error restores the snapshot and shows the v1 toasts (§4.6).
- **Serialisation**: reschedule mutations use `scope: { id: "task:" + task.id }` (TanStack v5 `MutationScope`) so two
  quick commits on one task run in order, and the `mutationFn` reads `version` **from the cache at execution time**
  (a `currentTask(qc, id)` helper that searches the project caches), never from the closure, so the second PATCH
  carries the version the first one returned.
- **Undo** (toast action, 5 s): commits the previous `Dates` through the same path (new PATCH, current version). If
  the original PATCH is still waiting in its 600 ms keyboard window, Undo just cancels it and sends nothing. Live
  region: "Undone".
- **Pending marker**: chips and bars show the `cl-sync` dot while their mutation is pending
  (`useMutationState({ filters: { mutationKey: ["reschedule", task.id], status: "pending" } })`), and a 400 ms
  "land" pulse after it settles (opacity/transform only; none under reduced motion).
- **Epic bars**: `useUpdateEpic` (existing epic mutation, board 27) with an optimistic patch of `qk.epics`, rollback
  + error toast, and the same Undo toast. No version handling.
- Bars are positioned with `left`/`width` percentages that update per frame during a drag; nothing animates `left`
  or `width` (no CSS transitions on them). Only the drop pulse and the toast animate (transform/opacity).

### 6.7 URL state (`schedule-lib.ts` parse/serialise, unit-tested)

| View | Param | Values | Default (omitted from the URL) | Set with |
|---|---|---|---|---|
| Timeline | `zoom` | `week` \| `month` \| `quarter` | `month` | `pushUrl` (zoom change resets `at`) |
| Timeline | `at` | `ISODate`, window start | the zoom's default anchor (§1.2) | `replaceUrl` (‹ › pan, Today removes it) |
| Timeline | `group` | `epic` \| `assignee` | `epic` | `pushUrl` |
| Timeline | `deps` | `0` | on | `replaceUrl` |
| Calendar | `mode` | `month` \| `week` | `month` | `pushUrl` |
| Calendar | `at` | `ISODate`, any day in the month/week (normalised to the 1st / the Monday when written) | today | `replaceUrl` |
| Calendar (≤ 760 px) | `day` | `ISODate`, selected agenda day | today | `replaceUrl` |
| Both | `f`, `view` | v1 filter rules / saved view id | none | v1 `useUrlFilters` (`replaceUrl`) |
| Both | `tray` | `1` | closed | `replaceUrl` |
| Both | `task` | task key | none | v1 task panel (`pushUrl`) |

Invalid values are ignored (fall back to the default) and are not rewritten until the user changes something. Never
`router.push` for any of these (frontend `CLAUDE.md`).

### 6.8 Components (`src/features/schedule/`)

| File | What |
|---|---|
| `schedule-lib.ts` | Pure: `dayIndex`/`fromDayIndex` on `ISODate`, `span(task)`, `overlaps`, zoom windows/anchors/steps, axis ticks, bar geometry (`left%`, `width%`), drag delta → dates (move / resize-left / resize-right with clamps), keyboard reducer, calendar grid (Mon-first, 4–6 rows), day sort, overflow split (cap 3), dependency conflict test, task fill % by glyph, URL parse/serialise. No React. |
| `queries.ts` | §6.5 |
| `use-reschedule.ts` | §6.6 |
| `use-bar-drag.ts` | Pointer capture, 3 px / 200 ms touch activation, edge zones 9 / 16 px, day snapping from the lane width, Esc/pointercancel revert. Shared by bars, chips and tray items (`kind: "bar" \| "chip" \| "tray"`). |
| `schedule-toolbar.tsx` | ‹ › Today, period label (calendar), Zoom / Mode segmented control (design `seg`), Group menu, Dependencies toggle, Unscheduled toggle, filter bar slot. "New task" goes to `TopBarActions` (v1 pattern, `shell.openCreateTask({ projectId })`). |
| `timeline-screen.tsx` | Composes axis, lanes, groups, arrows, tray, states; switches to read-only mobile layout at ≤ 760 px. |
| `timeline-axis.tsx` | Two tick rows, today pill (design `tl-head`). |
| `timeline-lanes.tsx` | Milestones lane, Sprints lane, overlay (weekends, gridlines, milestone guides, today line). |
| `timeline-group.tsx` | Group header + epic bar + virtualised task rows. |
| `timeline-bar.tsx` | One bar: grips, fill, tooltip, keyboard handler, aria. |
| `dependency-arrows.tsx` | SVG layer; geometry from row offsets and bar spans; conflict tone. |
| `unscheduled-tray.tsx` | §1.7 |
| `calendar-screen.tsx`, `calendar-month.tsx`, `calendar-week.tsx`, `calendar-chip.tsx`, `more-popover.tsx` | §1.3; popover on Radix Popover. |
| `agenda.tsx` | 390 px agenda (§1.9). |
| `schedule-states.tsx` | Skeletons, empty, error, truncated banner. |

Edits to existing files:

- `features/tasks/task-properties.tsx`: a **Start date** row above Due date (same date-picker popover, Mon-first,
  Today, Clear), shown when set or revealed through "Add property → Start date"; the picker disables days after the
  due date and the Due picker disables days before the start date, with the §4.2 messages as the inline error if
  the server still refuses. Display "Oct 1 → Oct 9" in the compact header line when both are set.
- `features/list/list-model.ts` + `list-screen.tsx`: optional **Start date** column (id `start`, hidden by default,
  sortable, nulls last).
- `features/epics/*` (board 27 epic dialog): optional **Start** and **Target** date fields (both or neither, §4.4
  messages) so explicit epic dates can be set and cleared outside the timeline.
- `components/shell/shell-state.ts`: `CreateTaskDefaults` gains `dueDate?: ISODate`; the create dialog pre-fills it
  (used by the agenda FAB).
- `lib/mock/derive.ts` (`toTask`, `toEpic`), `lib/mock/handlers/tasks.ts`, `handlers/planning.ts` (§6.9).

Appearance follows board 32 (classes `tl-*`, `cl-*`, `ph-*`, `tc-*` are the reference), token classes only, in navy,
black and light.

### 6.9 Mock backend and seed

Handler changes (same status codes, codes and messages as §4):

- `GET /projects/:id/tasks`: `filter[from]`, `filter[to]`, `filter[scheduled]` with the §2.1 span rules and the §4.1
  validation; `sort=startDate` with nulls last (the current generic sort puts `""` first; give dates a sentinel).
- `PATCH /tasks/:id` and `POST /projects/:id/tasks`: `startDate`, date format check (`Pick a date`, also for
  `dueDate`, which the mock doesn't validate today), order check with the field-specific messages.
- `POST /projects/:id/tasks/bulk`: refuse `patch.startDate`; check `patch.dueDate` against starts.
- `POST /projects/:id/epics`, `PATCH /epics/:id`: `startDate`/`dueDate` with the §4.4 rules.
- `toTask` returns `startDate: t.startDate ?? null`; `toEpic` returns `startDate`/`dueDate` `?? null` (cached
  databases predate the fields).

DB shape: no `SCHEMA` bump. `TaskRec` and `EpicRec` gain optional `startDate?`, `dueDate?` (epic). Upgrade marker
`ext32?: boolean` on `MockDB`; `ensureExt32(db)` runs from `createSeed()` and on the first request to any project
view route, applies the seed values below once, and sets `ext32 = true`. It only fills `startDate` where it is still
null and the `dueDate` still equals the seeded one, so user edits in a cached DB survive.

Seed (PRJ, dates through the seed's `D()`, relative to 2026-10-07; mirrors the design fixture where titles match):

| Task | startDate | dueDate (v1, unchanged) | Note |
|---|---|---|---|
| PRJ-31 | 2026-09-24 | 2026-09-30 | done |
| PRJ-33 | 2026-10-02 | 2026-10-14 | |
| PRJ-34 | 2026-10-06 | 2026-10-10 | Sam (Member) can drag it |
| PRJ-38 | 2026-10-09 | 2026-10-16 | |
| PRJ-40 | 2026-09-22 | 2026-10-02 | done |
| PRJ-42 | 2026-10-01 | 2026-10-21 | blocked by PRJ-48 (board 39) |
| PRJ-44 | 2026-10-05 | 2026-10-08 | sub-task of PRJ-42 |
| PRJ-48 | 2026-10-05 | 2026-10-09 | blocks PRJ-42 → **conflict arrow** (48 ends after 42 starts) |
| PRJ-49 | 2026-09-03 | 2026-09-10 | done |
| PRJ-50 | 2026-09-29 | 2026-10-06 | |
| PRJ-52 | 2026-10-14 | 2026-10-20 | |
| PRJ-53 | 2026-09-25 | 2026-09-29 | done |
| PRJ-54 | 2026-10-12 | 2026-10-14 | |
| PRJ-57 | 2026-10-05 | 2026-10-15 | blocks PRJ-58 (board 39) → **conflict arrow** |
| PRJ-58 | 2026-10-12 | 2026-10-17 | Sam can drag it |
| PRJ-60 | 2026-09-01 | 2026-09-08 | done |
| PRJ-61 | 2026-09-24 | 2026-10-01 | done |
| PRJ-62 | 2026-09-21 | 2026-09-28 | done |
| PRJ-65 | 2026-10-01 | 2026-10-05 | done |
| PRJ-66 | 2026-10-13 | 2026-10-18 | |
| PRJ-67 | 2026-10-20 | 2026-10-26 | |
| PRJ-71 | 2026-10-14 | 2026-10-19 | |

- Left **due-only** on purpose (1-day bars, backward-compatible path): PRJ-46, 51, 56, 64, 69, and every MOB and INF
  task.
- **Unscheduled** open tasks (tray): PRJ-36, 45, 47, 55, 68, 70. PRJ-63 is canceled (never shown); PRJ-43 is a done
  sub-task with no dates (not in the tray).
- New dependency (only when board 39's `dependencies` collection exists): **PRJ-50 blocks PRJ-52**, a satisfied-order
  arrow (50 ends Oct 6, 52 starts Oct 14) so both arrow tones are visible.
- Epic dates (design): Auth overhaul 2026-09-14 → 2026-10-23, Board performance 2026-09-21 → 2026-11-06, Sprint engine
  2026-09-01 → 2026-10-30, Billing v2 2026-09-01 → 2026-11-20. MOB "Offline mode" and INF "Edge cache" stay null
  (derived bars).
- Milestones and sprints: unchanged v1 seed (Alpha done Sep 12, Beta Oct 21, RC Nov 18, GA Dec 9 match the design).

---

## 7. Test plan

### 7.1 Backend (pytest, PostgreSQL; gates unchanged: ruff, mypy, coverage ≥ 85 %, `apps/access` ≥ 95 %)

- **Migrations/models:** `makemigrations --check`; `task_dates_ordered` rejects start > due and accepts start-only,
  due-only, equal dates; `epic_dates_ordered` rejects one-sided and reversed pairs.
- **Range filter** (shared vectors with the frontend, §7.3): due-only, start-only, both, neither; spans touching
  `from`/`to` exactly (inclusive); spans enclosing the window; `from` only; `to` only; combined with
  `filter[assignee]`, `filter[epic]`, `q`; deleted tasks excluded; canceled included; `scheduled=true|false`;
  every 422 of §4.1 (bad dates, reversed, 401-day span, bad `scheduled`); 404/403 project resolution; paging across
  two pages with a stable order under `sort=startDate`; `sort=startDate` / `-startDate` puts nulls last / first as
  specified; constant query count for 5 vs 50 tasks (`django_assert_num_queries`).
- **PATCH:** set/clear `startDate`; move both; resize each edge; each §4.2 message with the right field key; result
  order uses stored values for the unsent key; version checked first and bumped once; `edit_own` on own task
  allowed, on others 403; `task.move`-only user refused for a dates-only PATCH; deleted task 409; archived project
  403; audit row has `change("Start date", …)`.
- **Create:** `startDate` accepted and validated.
- **Bulk:** `patch.startDate` refused; `patch.dueDate` before a selected task's start → 422 with that key, nothing
  written; `patch.dueDate: null` allowed.
- **Epics:** create/patch with both dates, clear both, one-sided 422, reversed 422, Member/Viewer 403, audit changes,
  `startDate`/`dueDate` in list and detail payloads.
- **Payloads:** `startDate` present in board, backlog, my tasks, workspace tasks, sprint board, search, bulk
  response and `version_conflict.details.current`.
- **OpenAPI:** regenerate `docs/openapi.yaml`; drift check passes. `seed_demo` loads the §6.9 values.

### 7.2 Frontend (`npm run check`; Vitest with `--maxWorkers=2` on this machine)

- **Unit, `schedule-lib.ts`:** default anchors for each zoom (today = 2026-10-07 → Sep 28 / Sep 1 / Jul 1; also a
  January today for the quarter rollover); window lengths 28/91/273 and pan steps 7/28/91; ticks across a month and a
  year boundary; day maths across the DST changes (Mar 29 and Oct 25 2026 in Europe, Mar 8 and Nov 1 in the US: no
  off-by-one); bar geometry; drag deltas (move, resize-left clamped to due, resize-right clamped to start); keyboard
  reducer (← → Shift, Esc); calendar grid for Oct 2026 (starts Sep 28, 5 rows), Feb 2027 (starts on a Monday:
  exactly 4 rows), and a 6-row month (Aug 2026); day sort; overflow split (3 → 3, 4 → 2 + "+2"); conflict test; fill % by glyph; URL parse /
  serialise round-trip including invalid values.
- **Unit, `use-reschedule`** (with a `QueryClient` and a fake transport): optimistic patch then commit; rollback on
  422/403/500 with the right toast; 409 → conflict toast + invalidation; two quick commits on one task run in order
  and the second uses the first response's version; Undo during the 600 ms window sends nothing; Undo after commit
  sends the old dates with the new version.
- **Mock handlers** (`mock.test.ts` style): every §4.1 filter vector and 422; PATCH/create/bulk/epic validation
  messages; `version` conflict; `ensureExt32` upgrades a v1-cached DB once and doesn't overwrite an edited date.
- **Permissions:** `can.test.tsx` unchanged keys; a component test that a bar is draggable for `task.edit_own` only
  when the viewer is assignee/reporter, and epic bars only with `epic.manage`.
- **e2e (Playwright, port 3100):**
  - As `u_alex`: open Timeline → milestones and sprints lanes and epic groups render; drag PRJ-34's bar 2 days right
    → request body `{startDate, dueDate, version}`, toast "PRJ-34 Oct 6 → Oct 8", Undo restores; resize PRJ-34's
    left edge; keyboard: focus a bar, `→ → Shift+→`, wait → exactly one PATCH; zoom Week/Quarter and pan update the
    URL (`zoom` pushed, `at` replaced) and Back returns to the previous zoom; red arrow PRJ-48 → PRJ-42 and grey
    arrow PRJ-50 → PRJ-52 visible; toggle Dependencies off → `deps=0`; open the tray, drag PRJ-36 onto Oct 12 → it
    leaves the tray and appears as a 1-day bar; resize the Sprint engine epic bar.
  - Calendar month: drag PRJ-34's chip to another day (start shifts too: check the PATCH body); `Alt+↓` moves a
    week; "+N more" popover opens, Esc closes and returns focus; week mode.
  - Conflict: bump PRJ-34's `version` in the mock DB from `page.evaluate`, then drag → "Someone else changed this
    card" and the bar returns.
  - As `u_sam` (Member): PRJ-34 and PRJ-58 draggable, PRJ-42 not (no grips, `aria-roledescription="bar"`), epic bars
    not draggable. As `u_taylor` (Viewer): nothing draggable, no New task, no Add dates. As `u_casey`: the v1 403
    screen on `/timeline` and `/calendar`.
  - 390 px: Calendar shows the agenda, week strip `?day=` changes groups, tap a card opens the sheet; Timeline is
    read-only with horizontal scroll inside its container.
- **Visual sweep:** Timeline (month, quarter, dragging), Calendar (month, week), agenda, tray, loading, empty, error
  at 1440 and 390, navy/black/light, as `u_alex` and `u_taylor`; no console errors; no horizontal page scroll;
  reduced motion has no pulse.
- **Live mode:** with `seed_demo`, both views load with no failed API call, and a drag round-trips.

### 7.3 Shared span/overlap vectors

One JSON file of cases `{ startDate, dueDate, from, to, expected }`, checked into
`backend/apps/tasks/tests/data/span_vectors.json` and copied (or imported by path) by the frontend
`schedule-lib.test.ts`, so the server filter and the client `select` agree.

---

## 8. Conflicts (design vs conventions) and resolutions

| # | Design | Conventions | Resolution |
|---|---|---|---|
| 1 | One role prop gates everything (`canEdit = role !== 'viewer'`) | Permissions only from `my_permissions`; never role names; Member has `task.edit_own` only | Per item: `canEditTask` for task bars/chips/tray, `epic.manage` for epic bars, `task.create` for New task (§1.5). A Member sees some bars draggable and others not. |
| 2 | `TODAY` and the windows are hard-coded (2026-10-07, Sep 1…) | Rolling dates; local today on the client | Anchors computed from local today (§1.2); the seed is relative via `D()`. |
| 3 | View switcher (Board · List · Backlog · Timeline · Calendar) inside the view header | v1 project `NavTabs` | Timeline and Calendar become tabs after Backlog; the toolbar keeps period nav, Today, zoom/mode, New task goes to `TopBarActions`. |
| 4 | Epic bars have start/end dates and are resizable | `Epic` has no dates | New `Epic.startDate/dueDate` (both or neither); undated epics get a derived, dashed span (§1.2). |
| 5 | Task bars have a start (`s`) and a due | `Task` has `dueDate` only | New `Task.startDate`, optional and independent; span rules in §2.1. |
| 6 | Each arrow key press applies at once (would be one request per key) | Every change is a server write with `version` | Local at once + announced; one PATCH 600 ms after the burst or on blur (§1.4). |
| 7 | Undo restores local state only | Server is the source of truth | Undo sends a PATCH with the previous dates and the current version; cancels instead if not yet sent (§6.6). |
| 8 | Canceled tasks hidden on the timeline only; calendar shows every task | One rule | Canceled tasks are hidden on both. Done tasks stay, dimmed. |
| 9 | Empty state "Add dates" button with nowhere to go; no unscheduled list | A control must do something | Unscheduled tray (§1.7), built from the design's label-row anatomy; "Add dates" opens it. |
| 10 | No sprint overlay | Requested scope | A read-only Sprints lane using the Milestones lane anatomy. |
| 11 | No dependency arrows | Board 39 dependencies are in the model | SVG arrows for open blockers, danger tone on conflict, toggleable (§1.6). |
| 12 | Quarter zoom uses short milestone names ("Beta", "RC", "GA") from a fixture field | `Milestone` has no short name | Name truncated with an ellipsis at quarter zoom; full name in `aria-label` and tooltip. |
| 13 | Mobile frame has its own top bar and a fixed week strip with no way to change week | App shell top bar + tabs at 390; users must reach other weeks | Keep the shell; the agenda header sits in the view; ‹ › buttons added to the week strip. |
| 14 | Mobile shows only a calendar agenda with a "switch to timeline" icon; no mobile timeline | Every screen must work at 390 | Icon links to `/timeline`, which renders read-only with internal horizontal scroll (§1.9). |
| 15 | Mobile cards link to `Task-Detail.dc.html` | Task panel via `?task=KEY` | Cards open the v1 task sheet. |
| 16 | Error meta "503 · PRJ timeline" | v1 `ErrorState` with status and request ref | `ErrorState` keeps the design title, meta `<status> · request <ref>`. |
| 17 | "+N more" popover with a full-screen click catcher (`tc-catch`) | Radix Popover primitive | Radix Popover (outside click, Esc, focus return). |
| 18 | Epic groups mostly collapsed in the demo state | Behaviour decision | All expanded on first visit; collapse remembered per project in `localStorage`. |
| 19 | Only grouping by epic | Requested "grouping" | Group menu: Epic (default) or Assignee; same row anatomy, no group bar for people. |
| 20 | Epic % is a fixture; task fill by status | Progress is computed server-side | Epic fill = `epic.progress.percent`; task fill by glyph as designed (done 100, review 80, progress 45, else 0). |
| 21 | Month zoom pans 28 days while the window starts on the 1st | — | Kept as designed (pan steps 7/28/91). |
| 22 | No saved-view layout for timeline/calendar | Saved views are `board` \| `list` | Filter bar without "Save view" on these views (§9 #3). |
| 23 | Drag edge zone 9 px; pointer-only | Touch support; scrolling on touch | 9 px mouse, 16 px touch, 200 ms press-and-hold on touch. |
| 24 | Calendar chip move changes only the due date | Tasks now have a start; start ≤ due must hold | Calendar move shifts the start by the same delta (keeps the duration). |
| 25 | `frontend/CLAUDE.md` bans timeline/calendar; final report §3 item 3 hid the Timeline tab | The user lifted the ban | Frontend updates the CLAUDE.md bullet and the final report (§6). |

---

## 9. Open questions

None blocks implementation; each has a default above that both sides build to. Confirm or change before release:

1. **Workspace "My calendar".** Default: none (not designed). If wanted, add the same three filters to
   `GET /workspaces/:slug/tasks` (`filter[assignee]=me`), which is a small backend change.
2. **Satisfied dependency arrows.** Default: only open blockers are drawn, because that is what `Task.openBlockers`
   carries. Drawing done ones too needs every edge in the payload (a `blockers` list on `Task` or a
   `GET /projects/:id/dependencies?filter[from]&filter[to]` endpoint).
3. **Saving a timeline/calendar as a view.** Default: not possible; the filter bar has no "Save view" here. Adding it
   means `SavedView.layout` gains `timeline` \| `calendar` and pinned views route to these tabs.
4. **Epic write concurrency.** Default: last write wins (epics have no `version` in v1). If two planners resizing the
   same epic is a real risk, add `Epic.version` with the task 409 semantics.
5. **Weekends in durations.** Default: calendar days ("9d" includes weekends), no working-day calendar.
6. **Start date in the filter builder.** Default: not added (`due` stays the only date filter). Easy follow-up:
   `start` with the same ops as `due`.
7. **Create dialog start date.** Default: the dialog doesn't show Start; it can be set in the panel after creation.

---

## 10. Delivery checklist

Backend: `Task.start_date` + constraint + indexes · `Epic.start_date/due_date` + constraint · migrations · list
filters `from`/`to`/`scheduled` + `startDate` sort · PATCH/create/bulk validation · epic create/patch validation ·
`startDate` in every task payload, dates in every epic payload · audit changes · `seed_demo` values · tests (§7.1)
· `docs/openapi.yaml` regenerated.

Frontend: CLAUDE.md ban lifted + final-report paper trail · types, endpoints, query keys · routes + tabs · mock
handlers + `ensureExt32` + seed · `features/schedule/*` (timeline, calendar, agenda, tray, arrows, reschedule hook) ·
task panel Start date · list Start column · epic dialog dates · create-dialog `dueDate` default · tests (§7.2) ·
visual sweep.

Order: ship after board 39 (arrows read `openBlockers`). Deploy the backend before a frontend that reads `startDate`
(the frontend types declare it required).
