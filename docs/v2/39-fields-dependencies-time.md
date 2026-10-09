# v2 · Board 39: custom fields, dependencies, time tracking (API contract)

Status: **contract, not implemented.** The backend (Django + DRF, `backend/`) and the frontend (Next.js,
`frontend/`) are built from this document in parallel. Where this document is silent, the v1 conventions in
`docs/backend-plan.md`, `frontend/docs/api-contract.md` and `frontend/src/lib/api/*.ts` apply unchanged.

Design source: `frontend/design/clean/39-Custom-fields-dependencies-time.html` (frames: Panel, Mobile, Board
cards, Create field dialog, Custom fields settings, Empty, Timesheet, Empty week, Fields loading, Fields failed,
Timesheet loading, Timesheet failed, Viewer). Precedence is unchanged: **docs and existing conventions win for
behaviour, the design wins for appearance.** Every conflict and its resolution is in §8.

Contents: 1 Scope · 2 Data model · 3 Permissions · 4 Endpoints · 5 Side effects · 6 Frontend · 7 Test plan ·
8 Conflicts · 9 Open questions · 10 Delivery checklist.

---

## 0. Wire conventions (unchanged, restated so nobody guesses)

- Base `/api/v1`. JSON. camelCase fields; the only snake_case key is `my_permissions`.
- Timestamps ISO-8601 UTC (`ISODateTime`); calendar dates `YYYY-MM-DD` (`ISODate`).
- Errors: `{ "code": string, "message": string, "details": object }`. Validation is **422**
  `validation_failed` with `details.fields: { "<field path>": "<message>" }`. Nested paths are dotted
  (`customFields.<fieldId>`, `options.2.color`).
- Paginated lists: `{ "data": T[], "nextCursor": string | null }`. Every list in this document is a **plain
  array** (bounded sets) except where noted; none needs a cursor.
- Filters: `filter[key]=value`, repeated for OR.
- Create → **201** with the created object. Delete → **204** with no body. Update → **200** with the object.
- Permission failure → 403 `forbidden` with `details.permission`. Not a workspace member → 404. Workspace
  member, not on the project → 403 `project_membership_required` (v1 resolution, unchanged).
- Writes on a soft-deleted task → 409 `task_deleted` "This task was deleted. Restore it to make changes."
- Archived projects are read-only: every new project permission below is withheld by
  `ARCHIVED_ALLOWED` (no change to that set), so all writes in this document return 403 there.
- IDs are UUIDs on the backend and opaque strings in the mock (`p_prj-cf-browser`). Clients never parse ids.

---

## 1. Scope

### 1.1 What board 39 shows

Three task-detail extensions plus their supporting screens:

| Feature | Surfaces |
|---|---|
| **Custom fields** (5 types: Text, Number, Select, Date, Person) | Task panel "Custom fields" group · "Add property" menu · Project settings → Custom fields tab (list, reorder, create/edit dialog, delete confirm with Undo) · Board card chip · List view columns · Filter builder |
| **Dependencies** (one relation, seen from both sides: **Blocked by** / **Blocks**) | Task panel "Dependencies" section with a task picker · "Blocked" chip in the panel header · Board card "Blocked" badge + tooltip · Filter builder ("Blocked is Yes/No") · the **"Blocked" pinned view** dropped in v1 (`frontend/docs/final-report.md` §3 item 4) |
| **Time tracking** (timer + manual log + time estimate) | Task panel "Time" section (total / estimate bar, over-estimate flag, Start/Stop timer, Log time form, entries list) · running-timer chip in the panel header · Board card timer chip · **Timesheet** page (week × person heat grid, project selector, CSV export) |

Out of scope (not in the design, not in this contract): bulk-editing custom fields, custom fields in the
create-task dialog, notifications for dependency changes, editing an existing time entry, timer pause/resume,
time reports beyond the timesheet, cross-project dependencies (see §9).

### 1.2 Surfaces, states and who sees what

"Can edit task" below means v1's rule: `task.edit_any`, or `task.edit_own` when the viewer is the
assignee or reporter (`canEditTask` / `tasks.services.can_edit`). Permissions are read only from
`my_permissions` (project scope).

#### Task panel (side panel, full page, mobile sheet; `?task=KEY`)

Section order in the main column (design): **Description → Dependencies → Time → Sub-tasks → Attachments →
Comments/Activity.** The custom-field group sits in the properties column after Labels and before "Add property".

| Element | Shown when | Editable when |
|---|---|---|
| Header chip **Blocked** (`role=status`, `title="Blocked by PRJ-48, …"`) | `task.isBlocked` | never (derived) |
| Header chip **running timer** (`role=timer`, pulse + `mm:ss`/`h:mm:ss`) | the viewer's timer runs on this task | never (click does nothing; the Time section has the button) |
| **Custom fields** group, header "Custom fields" + "Manage" link | at least one visible row (see rule) | — |
| "Manage" link → `/[ws]/projects/[key]/settings?tab=fields` | `field.manage` | — |
| A field row | the task has a value **or** the field is required **or** the user revealed it this session through "Add property" | can edit task and task not deleted |
| Empty optional row text "Empty" (`text-fg-3`); empty required row text "Required" (warning tone) | as above | |
| "Clear" in a value editor | value set **and** field not required | |
| "Add property" → "Custom fields" heading + one item per hidden field | can edit task | |
| "Add property" → "Time estimate" (new, see §8 #3) | can edit task and `timeEstimateMinutes` is null | |
| **Dependencies** section, header count = blockedBy + blocks | count > 0 **or** can edit task | |
| Group "Blocked by" / "Blocks", each with count and "None" when empty | always inside the section | |
| "+" on a group → task picker (combobox, "Search key or title", ↑↓ ↵ Esc, max 6 results, "No matching tasks") | can edit task | |
| Row (status glyph, key, title; closed rows dimmed) + "×" remove | always / × when can edit task | |
| **Time** section header: `4h 25m / 6h` + progress bar + "+1h 15m over" | section shown when entries > 0 **or** `time.log` | |
| Start/Stop timer button with live clock; "Log time" button | `time.log` and task not deleted | |
| Log time form (Duration, Date, Note; Cancel, Log ↵; inline error / hint) | opened by "Log time" | |
| Entry rows (avatar, duration, note, `timer` tag, date, × delete) | always | × when (own entry and `time.log`) or `time.delete_any` |
| "No time logged" | no entries | |
| Click on the estimate (`/ 6h`) → inline duration input | can edit task | |

States inside the panel: the task detail query drives the panel skeleton (v1). Custom-field definitions
(`qk.customFields`) and time entries (`qk.timeEntries`) are separate queries: while loading, their rows show
`Skeleton` lines; on error, the section shows a one-line inline error with **Retry** (no full-panel error).
Dependencies arrive inside `TaskDetail` and need no extra state.

Deleted task (v1 "Deleted · restorable for 30 days" banner): every editor, the picker, timer and Log time are
hidden; values, dependencies and entries stay visible read-only.

Viewer frame (design "Viewer"): no editors, no timer, no Log time, no "×", no "Manage"; values and entries are
read-only text.

#### Project settings → Custom fields tab (`/[ws]/projects/[key]/settings?tab=fields`)

New tab after Labels: General · Workflow · Labels · **Custom fields** · Members.

| State | Content |
|---|---|
| Loading | 5 skeleton rows (handle, name bar, type bar) with `aria-busy` |
| Error | "Couldn’t load fields" + `status · request <ref>` (mono) + **Retry** (`ErrorState`) |
| Empty | five type icons, **"No custom fields yet"**, "Text, number, select, date, person", button **"Create a field"** (only with `field.manage`) |
| List | rows: drag handle · icon + name + "Required" tag · type name · "N tasks" · delete (trash icon). Header row "Field · Type · Used in". Hint "Alt ↑ ↓ or drag the handle". Live region announces "Browser moved to position 2 of 5", "… created", "… deleted", "… restored". |
| Read-only (no `field.manage`) | v1 `ReadOnlyNote` (role name, reason "edit custom fields", project admins) above the list; no handle, no delete, no "New field", rows not clickable |
| Managers | "New field" button in the header (only when the list is non-empty; the empty state has its own button); clicking a row opens the dialog in edit mode |

Create/edit dialog (`Modal`): Name (max 40, counter `n/40`, error under the field), Type radiogroup (Text,
Number, Select, Date, Person; arrow keys move; **disabled in edit mode** with `disabledReason` "A field’s type
can’t be changed"), Options (select only: colour swatch with an 8-colour palette, name max 32, Enter adds the
next option, remove "×" when more than one option), Required switch ("Always shown, flagged when empty"),
Cancel / **Create field** (edit mode: **Save**). Esc closes the palette first, then the dialog.

Delete confirm (`alertdialog`): "Delete “Browser”?" + "Used in **14 tasks**. Their values are removed." (or
"Not used in any task."), Cancel (autofocus) / **Delete field** (danger). After confirming, the row disappears
and a toast "Deleted “Browser”" with **Undo** shows for 5 s; the `DELETE` is sent when the toast expires (v1
pending-delete pattern used for attachments and views). Undo cancels the pending request.

#### Timesheet (`/[ws]/timesheet`, new route)

Sidebar: new workspace item **Timesheet** (clock icon) after "My tasks", shown to every workspace member.

| Element | Rule |
|---|---|
| Header | "Timesheet" · project selector (All projects + every project the viewer can see, with key badges) · week navigator `Oct 5 – 11` (prev; next only when not on the current week) · "This week" when not on it · **Export** |
| Export (CSV download, built client-side from the response) | selected project: `report.view` there; All projects: `report.view` in at least one listed project. Hidden otherwise. File name `timesheet-<projectkey or all>-<weekStart>.csv` (lower-case). |
| Grid | rows = people with time in the week (name-sorted); columns Mon–Sun; cell = hours (one decimal, `–` for 0, blank for future days hatched "upcoming"); row total; footer day totals and grand total; heat colour from hours (0 → 8 h+) |
| Cell tooltip (hover/focus) | "Alex · Wed Oct 7 · 6.5h" + breakdown rows (All projects: per project; one project: per task), from `breakdown` |
| Loading | 6 skeleton rows |
| Empty | "No time logged" + week label + **Go to this week** |
| Error | "Couldn’t load timesheet" + reason + **Retry** |

The grid scrolls horizontally inside its card at 390 px; the page itself never scrolls horizontally.

#### Board, list, filters, pinned view

| Surface | Change |
|---|---|
| Board card | "Blocked" badge (danger tone) when `isBlocked`, card `title` "Blocked by PRJ-48 Token refresh race…, …", aria-label suffix ", blocked". Timer chip (pulse + clock, button "Stop timer, 12:34") when the viewer's timer runs on that card; clicking it stops and logs. One field chip: the **first select field by position that has a value** ("Browser: Safari", option colour dot). |
| List view | One optional column per custom field (id `cf.<fieldId>`, label = field name, width 140, min 90), **hidden by default**, toggled in the column menu under a "Custom fields" heading, sortable. A "Blocked" glyph next to the title when `isBlocked`. |
| Filter builder (board + list) | New field **Blocked** (`is` Yes/No) and one field per custom field, listed under a "Custom fields" heading (§4.7). |
| Pinned views | Seed a personal pinned view **"Blocked"** (icon `flag`, filter `blocked is true`) for every PRJ member (mock and `seed_demo`). Users can create the same view themselves through board 30's "Save view". |

---

## 2. Data model (backend)

All models extend `apps.common.models.BaseModel` (UUID `id`, `created_at`, `updated_at`). None of the new models
is soft-deleted: they hang off `Task`, which is. A soft-deleted task keeps its values, dependencies and time
entries; they are hidden while it is deleted and come back on restore; a purge cascades. Every write goes through
a service and writes an `AuditLog` row (§5).

### 2.1 App placement

| Model | App | Why |
|---|---|---|
| `CustomField`, `CustomFieldOption` | `projects` | Project configuration, like `Status` and `Label` |
| `TaskFieldValue`, `TaskDependency` | `tasks` | Per-task data; services already own task invariants |
| `TimeEntry`, `RunningTimer` | **new app `timetracking`** (`apps/timetracking/`, standard layering: models, selectors, services, serializers, views, urls) | Own reads (timesheet) and writes; keeps `tasks` from growing further |

### 2.2 `projects.CustomField`

| Field | Type | Notes |
|---|---|---|
| `project` | FK `projects.Project`, CASCADE, `related_name="custom_fields"` | |
| `name` | `CharField(40)` | trimmed, 1–40 chars |
| `type` | `CharField(8)`, choices `text`, `number`, `select`, `date`, `user` | immutable after create |
| `required` | `BooleanField(default=False)` | display flag + "can't clear" rule; never enforced on task create |
| `position` | `PositiveSmallIntegerField` | 0-based, dense; rewritten by reorder |
| `created_by` | FK user, SET_NULL, null | |

Constraints / indexes: `UniqueConstraint("project", Lower("name"), name="custom_field_name_unique")`;
`Index(fields=["project", "position"], name="custom_field_order")`. Limit **50 fields per project** (service).
Delete is a **hard delete** (values cascade); the UI's Undo is the 5-second delayed send (§1.2).

### 2.3 `projects.CustomFieldOption`

| Field | Type | Notes |
|---|---|---|
| `field` | FK `CustomField`, CASCADE, `related_name="options"` | only for `type="select"` |
| `name` | `CharField(32)` | trimmed, 1–32 |
| `color` | `CharField(24)` | one of the 8 palette tokens below |
| `position` | `PositiveSmallIntegerField` | 0-based |

Palette (design `pal()`; same token format as `Label.color`): `var(--low)` Teal, `var(--accent-t)` Blue,
`var(--info)` Violet, `var(--warn)` Amber, `var(--orange)` Orange, `var(--danger)` Red, `var(--ok)` Green,
`var(--text-3)` Gray.
Constraints: `UniqueConstraint("field", Lower("name"), name="custom_field_option_unique")`;
`Index(fields=["field", "position"])`. Limit **50 options per field**.

### 2.4 `tasks.TaskFieldValue`

| Field | Type | Notes |
|---|---|---|
| `task` | FK `Task`, CASCADE, `related_name="field_values"` | |
| `field` | FK `projects.CustomField`, CASCADE, `related_name="values"` | same project as the task (service) |
| `text` | `CharField(120)`, null | type `text` |
| `number` | `DecimalField(max_digits=12, decimal_places=2)`, null | type `number`, 0 ≤ n ≤ 1 000 000 000 |
| `date` | `DateField`, null | type `date` |
| `option` | FK `projects.CustomFieldOption`, CASCADE, null | type `select`; deleting an option deletes its values |
| `user` | FK user, CASCADE, null | type `user`; must be a project member **when set** |

Constraints: `UniqueConstraint(fields=["task", "field"], name="task_field_value_unique")`; a check that
**exactly one** of `text, number, date, option, user` is non-null (`task_field_value_one`); a check
`number IS NULL OR (number >= 0 AND number <= 1000000000)` (`task_field_value_number_range`).
Indexes: `(field, option)`, `(field, user)`, `(field, date)`, `(field, number)` for filtering.
A cleared value is a deleted row (no row = empty). Values for a removed project member stay (display "Former
member", §6.5).

### 2.5 `tasks.TaskDependency`

One row means **`blocker` blocks `blocked`** ("blocked is blocked by blocker").

| Field | Type | Notes |
|---|---|---|
| `blocker` | FK `Task`, CASCADE, `related_name="blocks_links"` | |
| `blocked` | FK `Task`, CASCADE, `related_name="blocked_by_links"` | |
| `project` | FK `projects.Project`, CASCADE | denormalised (both tasks are in it); used for locking and queries |
| `created_by` | FK user, SET_NULL, null | |

Constraints: `UniqueConstraint(fields=["blocker", "blocked"], name="task_dependency_unique")`;
`CheckConstraint(~Q(blocker=F("blocked")), name="task_dependency_not_self")`. FK indexes are automatic.

Rules (enforced in `tasks.services`, mirrored by the mock):

1. **Same project only.** The other task must be a live task in the same project ("Pick a task from this project").
2. **Not self** ("A task can’t depend on itself").
3. **Not parent/sub-task of each other** ("A task and its sub-task can’t depend on each other").
4. **No duplicates** in either reading: if the exact row exists → 409 `dependency_exists`.
5. **No cycles.** Adding "A blocked by B" (row B→A) is refused when A already reaches B by following
   `blocks` edges (A blocks … blocks B), which includes the direct reverse row A→B. BFS over live rows of the
   project, starting at A. → 409 `dependency_cycle`, `details.path` = the task keys of the loop in blocking order,
   first key repeated at the end, e.g. `["PRJ-42", "PRJ-47", "PRJ-42"]`.
6. **Limit 50 rows per task per direction** → 409 `dependency_limit`.
7. **Concurrency:** the add service takes `Project.objects.select_for_update()` on the project row before the
   cycle check, so two concurrent inserts can't close a loop.
8. Soft-deleted tasks: their rows are ignored everywhere (lists, `isBlocked`, cycle checks) until restored. A
   restore can't create a cycle in practice because rows were never removed; if a cycle check ever finds one it
   only blocks new inserts.

**Open blocker** = a live blocker whose status category is not `done` (Done and Canceled both close it;
matches the design's `status !== 'done' && status !== 'cancel'`). `isBlocked` = the task has at least one open
blocker. It is derived, never stored.

### 2.6 `tasks.Task` (one new column)

| Field | Type | Notes |
|---|---|---|
| `time_estimate_minutes` | `PositiveIntegerField`, null | 1–60 000 (1 000 h); `CheckConstraint(time_estimate_minutes__lte=60000, name="task_time_estimate_range")`. Separate from `estimate` (story points 0–99), see §8 #3. |

### 2.7 `timetracking.TimeEntry`

| Field | Type | Notes |
|---|---|---|
| `task` | FK `tasks.Task`, CASCADE, `related_name="time_entries"` | |
| `project` | FK `projects.Project`, CASCADE | denormalised from the task, for the timesheet |
| `user` | FK user, CASCADE, `related_name="time_entries"` | who did the work (always the actor in this release) |
| `minutes` | `PositiveSmallIntegerField` | 1–1 440; check constraint `time_entry_minutes_range` |
| `date` | `DateField` | the day the work happened |
| `note` | `CharField(140, blank=True, default="")` | |
| `source` | `CharField(8)`, choices `manual`, `timer` | |

Indexes: `(task, date)`, `(project, date)`, `(user, date)`. Hard delete (audited).

### 2.8 `timetracking.RunningTimer`

| Field | Type | Notes |
|---|---|---|
| `user` | `OneToOneField(user, CASCADE, related_name="running_timer")` | **one running timer per user**, across all workspaces |
| `task` | FK `tasks.Task`, CASCADE | |
| `started_at` | `DateTimeField` | server time |

A timer whose task is deleted, or whose project the user can no longer see, is dropped lazily: `GET /me/timer`
deletes it and returns `null`.

### 2.9 Migrations

- `projects` 00xx: CustomField, CustomFieldOption.
- `tasks` 00xx: TaskFieldValue, TaskDependency, `Task.time_estimate_minutes`.
- `timetracking` 0001: TimeEntry, RunningTimer. Add `apps.timetracking` to `INSTALLED_APPS` and its urls to
  the v1 router.
- `access` 0003 (data, idempotent): create the three new `Permission` rows if missing (same values as the
  catalogue), then add them to existing **system** roles by `system_key` per §3.2. Custom roles are not touched.
  Reverse = no-op.

---

## 3. Permissions

### 3.1 New catalogue entries (project scope)

| Code | Group | Label | Description |
|---|---|---|---|
| `field.manage` | Planning | Manage custom fields | Create, edit, reorder and delete custom fields |
| `time.log` | Tasks | Log time | Track time on tasks with the timer or by hand |
| `time.delete_any` | Tasks | Delete anyone’s time | Remove time entries logged by others |

Not new permissions (deliberately):

- **Setting custom-field values, time estimates and dependencies** = editing the task: `task.edit_any`, or
  `task.edit_own` on tasks you report or are assigned (v1 rule). For dependencies the check is on the task the
  request is addressed to (`/tasks/:id/dependencies`); the other task only needs to be visible.
- **Seeing** fields, values, dependencies, entries and the timesheet = `project.view`.
- **Timesheet export** = `report.view` (§1.2).

Catalogue placement (`backend/apps/access/catalogue.py` `PERMISSIONS` list and
`frontend/src/lib/permissions/catalogue.ts` `PERMISSION_CATALOGUE`): `field.manage` right after
`status.manage`; `time.log` and `time.delete_any` right after `task.delete`.

### 3.2 Default roles

| Role (scope) | field.manage | time.log | time.delete_any |
|---|---|---|---|
| Owner (workspace) | — | — | — |
| Admin (workspace) | — | — | — |
| Member (workspace) | — | — | — |
| Project Admin (project) | ✓ (core) | ✓ (core) | ✓ (core) |
| Manager (project) | ✓ | ✓ | ✓ |
| Member (project, `project_member`) | — | ✓ | — |
| Viewer (project) | — | — | — |

Project Admin's `permissions` and `core` stay `list(PROJECT_ORDER)`, so the new codes are core for it. Manager
stays "PROJECT_ORDER minus archive/delete/manage_members", so it picks them up automatically. Add `"time.log"` to
`project_member`'s explicit list (after `task.move`). Viewer unchanged. Mirror all of this in the frontend
`DEFAULT_ROLES`.

### 3.3 `my_permissions` order

`PROJECT_ORDER` (backend) and `PROJECT_PERMISSIONS` (frontend `types.ts`) become, exactly:

```
project.view, project.update, project.archive, project.delete, project.manage_members,
objective.manage, milestone.manage, epic.manage, sprint.manage, status.manage, field.manage,
task.create, task.edit_any, task.edit_own, task.delete, task.assign, task.move,
time.log, time.delete_any,
comment.create, comment.edit_own, comment.delete_any, attachment.upload, attachment.delete_any,
report.view
```

They appear in `Project.my_permissions` and `TaskDetail.project.my_permissions` like every other project code.
Example for Sam (project Member on PRJ):
`["project.view","task.create","task.edit_own","task.assign","task.move","time.log","comment.create","comment.edit_own","attachment.upload","report.view"]`.
`GET /permissions` returns the three new entries. Archived projects drop them (not in `ARCHIVED_ALLOWED`).

---

## 4. Endpoints

All paths are under `/api/v1`. Backend: put `tasks/<uuid:task_id>/…` routes **before** the catch-all
`tasks/<str:task_ref>` in `apps/tasks/urls.py`. Every view declares `required = {METHOD: code}` as in v1.

### 4.0 Summary

| # | Method | Path | Permission | Response |
|---|---|---|---|---|
| F1 | GET | `/projects/:id/custom-fields` | `project.view` | 200 `CustomField[]` |
| F2 | POST | `/projects/:id/custom-fields` | `field.manage` | 201 `CustomField` |
| F3 | PATCH | `/custom-fields/:fieldId` | `field.manage` | 200 `CustomField` |
| F4 | DELETE | `/custom-fields/:fieldId` | `field.manage` | 204 |
| F5 | PUT | `/projects/:id/custom-fields/order` | `field.manage` | 200 `CustomField[]` |
| T1 | PATCH | `/tasks/:id` (existing) | v1 rules | 200 `Task` (now accepts `customFields`, `timeEstimateMinutes`) |
| D1 | GET | `/tasks/:id/dependencies` | `project.view` | 200 `TaskDependencies` |
| D2 | POST | `/tasks/:id/dependencies` | can edit task `:id` | 201 `TaskDependencies` |
| D3 | DELETE | `/tasks/:id/dependencies/:dependencyId` | can edit task `:id` **or** the other task | 204 |
| E1 | GET | `/tasks/:id/time-entries` | `project.view` | 200 `TimeEntry[]` |
| E2 | POST | `/tasks/:id/time-entries` | `time.log` | 201 `TimeEntry` |
| E3 | DELETE | `/time-entries/:entryId` | own + `time.log`, or `time.delete_any` | 204 |
| R1 | GET | `/me/timer` | authenticated | 200 `{ timer: RunningTimer \| null }` |
| R2 | POST | `/tasks/:id/timer` | `time.log` | 201 `{ timer, stopped }` |
| R3 | POST | `/me/timer/stop` | `time.log` on the timer's project | 200 `{ entry }` |
| S1 | GET | `/workspaces/:slug/timesheet` | workspace member; data from projects with `project.view` | 200 `Timesheet` |

Changed responses: every `Task` payload (§4.8), `TaskDetail` (§4.8), saved-view rules and counts (§4.7),
`GET /projects/:id/tasks` gains `filter[blocked]` (§4.7).

### 4.1 Custom fields

#### Shape

```json
{
  "id": "b7c1…",
  "projectId": "5f0e…",
  "name": "Browser",
  "type": "select",
  "required": false,
  "position": 0,
  "options": [
    { "id": "o-chrome", "name": "Chrome", "color": "var(--low)", "position": 0 },
    { "id": "o-safari", "name": "Safari", "color": "var(--accent-t)", "position": 1 }
  ],
  "taskCount": 14,
  "createdAt": "2026-10-01T09:12:00Z"
}
```

`options` is `[]` for non-select types. `taskCount` = live tasks (not soft-deleted) with a value for this field.

#### F1 `GET /projects/:id/custom-fields`

Plain array ordered by `position`. 200. 404/403 per project resolution.

#### F2 `POST /projects/:id/custom-fields`

Request:

```json
{
  "name": "Environment",
  "type": "select",
  "required": false,
  "options": [
    { "name": "Production", "color": "var(--danger)" },
    { "name": "Staging", "color": "var(--warn)" },
    { "name": "Preview", "color": "var(--low)" }
  ]
}
```

New field goes last (`position = count`). `options` is ignored for non-select types. Option order = array order.
Response 201 `CustomField` (`taskCount: 0`).

Validation (422 `validation_failed`, `details.fields`):

| Field path | Message | When |
|---|---|---|
| `name` | `Name is required` | blank after trim |
| `name` | `Up to 40 characters` | > 40 |
| `name` | `A field with this name exists` | case-insensitive duplicate in the project |
| `type` | `Pick text, number, select, date or person` | not one of the five |
| `options` | `Add at least one option` | select with no non-blank option |
| `options` | `Options must be unique` | case-insensitive duplicate (trimmed) |
| `options` | `Up to 50 options` | > 50 |
| `options.N.name` | `Up to 32 characters` | > 32 |
| `options.N.color` | `Pick a colour from the palette` | not one of the 8 tokens |

Blank option names are dropped before validation (the dialog's empty last row). 409 `field_limit` "A project can
have up to 50 custom fields." when the project already has 50.

#### F3 `PATCH /custom-fields/:fieldId`

Request (all keys optional):

```json
{
  "name": "Browser",
  "required": true,
  "options": [
    { "id": "o-chrome", "name": "Chrome", "color": "var(--low)" },
    { "name": "Arc", "color": "var(--info)" }
  ]
}
```

- `options` is the **complete ordered list**: items with an `id` of this field are renamed/recoloured/reordered;
  items without `id` are created; existing options missing from the list are **deleted, and the values that
  pointed at them are deleted** (the tasks become empty for this field). Unknown `id` →
  `options.N.id: "Unknown option"`.
- `type` in the body: allowed only if equal to the current type; otherwise 422 `type: "A field’s type can’t be changed"`.
- Same validation messages as F2. 404 `not_found` "Custom field not found." for unknown/invisible ids.
- Response 200 `CustomField`.

#### F4 `DELETE /custom-fields/:fieldId`

Hard delete; values cascade; remaining fields' positions are compacted. 204. Saved-view rules that reference the
field are left as they are and ignored from then on (§4.7).

#### F5 `PUT /projects/:id/custom-fields/order`

Request `{ "ids": ["f3", "f1", "f2", "f4", "f5"] }` — every field of the project exactly once. 422
`ids: "Send every field once"` otherwise. Response 200 `CustomField[]` in the new order. One audit row.

### 4.2 Custom-field values on tasks (T1, existing `PATCH /tasks/:id`)

New optional body keys (alongside `version`, which stays required):

```json
{
  "customFields": {
    "f-browser": "o-safari",
    "f-found-in": "v2.3.1",
    "f-accounts": 1240,
    "f-qa-signoff": "2026-10-09",
    "f-qa-owner": "u_riley",
    "f-old": null
  },
  "timeEstimateMinutes": 360,
  "version": 7
}
```

- `customFields` is a **merge**: listed keys are set, `null` clears, unlisted keys are untouched. `{}` is a no-op.
- Value types: text → string (trimmed; `""` means clear), number → JSON number, select → option id, date →
  `ISODate`, user → user id.
- Authorisation: the v1 edit rule (`task.edit_any` / `task.edit_own`). A PATCH whose only keys are
  `customFields`/`timeEstimateMinutes` is **not** a "status only" patch, so `task.move` alone is not enough.
- Version: checked first (409 `version_conflict` with `details.current`), then bumped once for the whole PATCH.
- `timeEstimateMinutes`: integer 1–60 000, or `null` to clear; `0` is treated as `null`.

Validation (422, `details.fields`):

| Path | Message |
|---|---|
| `customFields` | `Send an object of field ids` (not an object) |
| `customFields.<id>` | `This field was deleted` (unknown id or another project's field) |
| `customFields.<id>` | `Up to 120 characters` (text) |
| `customFields.<id>` | `Enter a number from 0 to 1,000,000,000` (number; non-number, NaN, out of range; rounded to 2 decimals otherwise) |
| `customFields.<id>` | `Pick one of the options` (select) |
| `customFields.<id>` | `Pick a date` (date) |
| `customFields.<id>` | `Pick someone on this project` (user not a project member) |
| `customFields.<id>` | `This field is required` (`null`/`""` on a required field) |
| `timeEstimateMinutes` | `Estimate is 1 minute to 1000 hours` |

`customFields` and `timeEstimateMinutes` are **not** accepted by `POST /projects/:id/tasks` or by
`tasks/bulk` (bulk keeps its v1 message "This field can’t be bulk-edited").

### 4.3 Dependencies

#### Shapes

```ts
interface DependencyTask {          // the task on the other end
  id: ID; key: string; title: string; statusId: ID;
  status: { name: string; glyph: StatusGlyph; category: StatusCategory };
  assigneeId: ID | null;
}
interface DependencyItem { id: ID; task: DependencyTask; createdAt: ISODateTime; createdById: ID | null }
interface TaskDependencies {
  taskId: ID;
  isBlocked: boolean;
  blockedBy: DependencyItem[];      // rows where this task is `blocked`; ordered by createdAt
  blocks: DependencyItem[];         // rows where this task is `blocker`; ordered by createdAt
}
```

`DependencyItem.id` is the `TaskDependency` id. Soft-deleted tasks never appear.

#### D1 `GET /tasks/:id/dependencies`

200 `TaskDependencies`. Same data is embedded in `TaskDetail.dependencies`.

#### D2 `POST /tasks/:id/dependencies`

```json
{ "relation": "blocked_by", "taskId": "p_prj-t48" }
```

`relation`: `"blocked_by"` (the other task blocks `:id`) or `"blocks"` (`:id` blocks the other task).
Response **201** `TaskDependencies` of `:id` (fresh, including `isBlocked`).

| Status | Code | Message / details |
|---|---|---|
| 422 | `validation_failed` | `relation: "Pick blocked by or blocks"` · `taskId: "Pick a task from this project"` · `taskId: "A task can’t depend on itself"` · `taskId: "A task and its sub-task can’t depend on each other"` |
| 409 | `dependency_exists` | "These tasks are already linked." |
| 409 | `dependency_cycle` | "That would create a loop: PRJ-42 → PRJ-47 → PRJ-42." · `details.path: ["PRJ-42","PRJ-47","PRJ-42"]` |
| 409 | `dependency_limit` | "A task can have up to 50 dependencies each way." |
| 409 | `task_deleted` | either task deleted |
| 403 | `forbidden` | can't edit `:id` (`details.permission: "task.edit_any"`, v1 message "You can only edit tasks you reported or are assigned.") |

#### D3 `DELETE /tasks/:id/dependencies/:dependencyId`

The row must involve `:id` (as blocker or blocked) → else 404 "Dependency not found.". Allowed when the actor
can edit **either** task. 204.

### 4.4 Time entries

#### Shape

```json
{
  "id": "e1…",
  "taskId": "p_prj-t42",
  "projectId": "p_prj",
  "userId": "u_alex",
  "minutes": 90,
  "date": "2026-10-05",
  "note": "Repro + profiling",
  "source": "manual",
  "createdAt": "2026-10-05T16:40:00Z"
}
```

`note` may be `""`; the client renders "Manual entry" / "Timer" in `text-fg-3` in that case.

#### E1 `GET /tasks/:id/time-entries`

Plain array, ordered `date` desc, then `createdAt` desc. 200.

#### E2 `POST /tasks/:id/time-entries`

```json
{ "minutes": 90, "date": "2026-10-07", "note": "Repro + profiling" }
```

The client parses the duration text (§6.6) and sends integer minutes. `note` is trimmed and cut to 140 chars.
Response 201 `TimeEntry` (`source: "manual"`, `userId` = actor).

| Path | Message | Rule |
|---|---|---|
| `minutes` | `Enter a duration` | missing or not an integer |
| `minutes` | `Duration must be over 0` | ≤ 0 |
| `minutes` | `Max 24h per entry` | > 1 440 |
| `date` | `Pick a date` | missing or not `YYYY-MM-DD` |
| `date` | `Can’t log future time` | > server UTC today **+ 1 day** (tolerance for time zones ahead of UTC) |
| `date` | `Date is too far back` | < server UTC today − 365 days |

403 without `time.log`; 409 `task_deleted`.

#### E3 `DELETE /time-entries/:entryId`

Own entry with `time.log`, or anyone's with `time.delete_any`. 403 `forbidden` otherwise
(`details.permission: "time.delete_any"`). 404 if the entry's project is not visible. 204.

### 4.5 Timer

```ts
interface RunningTimer { taskId: ID; taskKey: string; taskTitle: string; projectId: ID; startedAt: ISODateTime }
```

#### R1 `GET /me/timer`

200 `{ "timer": RunningTimer | null }`. Drops (deletes) a timer whose task is soft-deleted or whose project
the user can no longer see, and returns `null`.

#### R2 `POST /tasks/:id/timer` (start)

Body (optional): `{ "date": "2026-10-07" }` — the local date used if another timer has to be stopped.

- No timer running → create one (`startedAt = now`).
- Timer already on **this** task → no change; return it with `stopped: null` (idempotent, status 201 still).
- Timer on **another** task → stop it exactly like R3 (logs an entry on that task, if still allowed; otherwise
  it is discarded) and start the new one, in one transaction.

Response 201:

```json
{
  "timer": { "taskId": "p_prj-t42", "taskKey": "PRJ-42", "taskTitle": "Fix flaky board reflow on column resize", "projectId": "p_prj", "startedAt": "2026-10-07T09:00:00Z" },
  "stopped": { "id": "e9…", "taskId": "p_prj-t44", "projectId": "p_prj", "userId": "u_alex", "minutes": 12, "date": "2026-10-07", "note": "", "source": "timer", "createdAt": "2026-10-07T09:00:00Z" }
}
```

403 without `time.log` on the task's project; 409 `task_deleted`; `date` validated as in E2 (only when used).

#### R3 `POST /me/timer/stop`

Body (optional): `{ "date": "2026-10-07", "note": "" }`. Creates a `TimeEntry` with `source: "timer"`,
`minutes = clamp(round((now − startedAt) / 60 s), 1, 1440)`, `date` = body date (validated as E2) or server UTC
date; deletes the timer. Response 200 `{ "entry": TimeEntry }`.

| Status | Code | Message |
|---|---|---|
| 404 | `not_found` | "No timer is running." |
| 403 | `forbidden` | "You can’t log time on this project any more. The timer was discarded." (`details.permission: "time.log"`; the timer is deleted) |
| 409 | `task_deleted` | "This task was deleted. The timer was discarded." (timer deleted) |

### 4.6 Timesheet

#### S1 `GET /workspaces/:slug/timesheet?filter[week]=2026-10-07&filter[project]=<projectId>`

- `filter[week]`: any date in the wanted week; the server snaps to that week's **Monday**. Default: the current
  UTC week. Invalid → 422 `filter[week]: "Pick a date"`.
- `filter[project]`: optional, one project id. It must be a project where the caller has `project.view`
  (otherwise the v1 project-resolution errors: 404 / 403 `project_membership_required`). Omitted = all projects
  the caller can see in the workspace (archived included, soft-deleted excluded).
- Only entries on live tasks count.

Response 200:

```json
{
  "weekStart": "2026-10-05",
  "days": ["2026-10-05","2026-10-06","2026-10-07","2026-10-08","2026-10-09","2026-10-10","2026-10-11"],
  "projects": [
    { "id": "p_prj", "key": "PRJ", "name": "Platform Rebuild", "hue": 255, "my_permissions": ["project.view", "…", "report.view"] }
  ],
  "rows": [
    {
      "user": { "id": "u_alex", "name": "Alex Kim", "hue": 285, "avatarUrl": null },
      "cells": [
        {
          "date": "2026-10-05",
          "minutes": 390,
          "breakdown": [
            { "projectId": "p_prj", "taskId": null, "key": "PRJ", "name": "Platform Rebuild", "hue": 255, "minutes": 300 },
            { "projectId": "p_inf", "taskId": null, "key": "INF", "name": "Infra", "hue": 75, "minutes": 90 }
          ]
        }
      ],
      "totalMinutes": 1620
    }
  ],
  "dayTotals": [1980, 2100, 1450, 0, 0, 0, 0],
  "totalMinutes": 5530
}
```

- `projects`: every project the caller can see in the workspace (feeds the selector and the export gate),
  name-sorted, each with its project `my_permissions`. Not filtered by `filter[project]`.
- `rows`: users with ≥ 1 minute in the week within scope, sorted by name. `cells` always has 7 items.
- `breakdown`: without `filter[project]` → one slice per project (`taskId: null`, `key`/`name`/`hue` of the
  project); with it → one slice per task (`taskId`, `key` = task key, `name` = task title, `hue` = project hue).
  Sorted by minutes desc, at most 5 slices; `minutes` of the cell is always the full total.
- `dayTotals` has 7 items. All numbers are minutes. Not paginated.

### 4.7 Filters, saved views and the "Blocked" view

Filter rules keep the v1 shape `{ field, op, values }` (rows combined with AND) and URL format
`?f=<field>:<op>:<v1,v2>`. Additions:

| Field id | Ops | Values | Meaning |
|---|---|---|---|
| `blocked` | `is` | `["true"]` or `["false"]` | `isBlocked` equals the value |
| `cf.<fieldId>` · text | `set`, `empty` | none | has / lacks a value |
| `cf.<fieldId>` · number | `gt`, `lt`, `set`, `empty` | one number (`"1240"`, `"12.5"`) for gt/lt | strict comparison |
| `cf.<fieldId>` · select | `is`, `not`, `any`, `empty` | option ids | as label rules |
| `cf.<fieldId>` · user | `is`, `not`, `any`, `empty` | user ids or `"me"` | as assignee rules |
| `cf.<fieldId>` · date | `before`, `after`, `empty` | ISO date or `today`/`tomorrow`/`week`/`sprint` | as due rules |

New `FilterOp` values: `set` ("is not empty"), `gt` ("greater than"), `lt` ("less than"). `not` and `before`/
`after` on a task with no value: `not` matches (like v1 label `not`), `before`/`after`/`gt`/`lt` don't.
Field ids use `.` (allowed by `VALUE_RE`) so the `:`-separated URL format still parses.

Backend:
- `projects.saved_views.clean_rules(raw, project)` gains the `project` argument. `cf.<id>` rules are kept only if
  the field exists in that project and the op is valid for its type; `blocked` rules need `values` `true`/`false`.
  Invalid rows are dropped silently (v1 behaviour).
- `apply_rules` supports both: `blocked` via an `Exists()` subquery on open blockers; `cf.*` via
  `TaskFieldValue` lookups. A rule whose field was deleted after saving is **ignored** (matches everything).
- `SavedView.count` therefore includes the new rules.
- `GET /projects/:id/tasks` gains `filter[blocked]=true|false` (422 `filter[blocked]: "Use true or false"`).
  Custom-field filtering is not added to that endpoint (board and list filter client-side, as in v1).

Frontend: `applyFilters`/`matchRule` gain the same semantics and must agree with the backend on every row in the
table above (shared test vectors, §7).

### 4.8 Task payload changes (backward compatible, additive)

Every `Task` payload — task lists, board, backlog, workspace tasks, my tasks, sprint board, bulk, PATCH/move
responses, `version_conflict.details.current`, search task results — gains:

| Field | Type | Meaning |
|---|---|---|
| `customFields` | `Record<ID, string \| number>` | set values only, keyed by field id; select → option id, user → user id, date → ISO, number → number, text → string |
| `isBlocked` | `boolean` | at least one open blocker |
| `openBlockers` | `{ id: ID; key: string; title: string }[]` | the open blockers, ordered by task number (board tooltip, panel chip title) |
| `timeEstimateMinutes` | `number \| null` | |
| `loggedMinutes` | `number` | sum of the task's time entries (all users) |

`TaskDetail` additionally gains `dependencies: TaskDependencies`.

Example (fragment):

```json
{
  "id": "p_prj-t42", "key": "PRJ-42", "estimate": 3, "version": 8,
  "customFields": { "p_prj-cf-browser": "p_prj-cf-browser-safari", "p_prj-cf-found": "v2.3.1", "p_prj-cf-accounts": 1240, "p_prj-cf-qaowner": "u_riley" },
  "isBlocked": true,
  "openBlockers": [{ "id": "p_prj-t48", "key": "PRJ-48", "title": "Token refresh race on cold start" }],
  "timeEstimateMinutes": 360,
  "loggedMinutes": 255
}
```

Backend implementation notes:
- `tasks.selectors.annotated()` adds `logged_minutes` (`Coalesce(Subquery(Sum))`), `is_blocked` (`Exists`), and
  prefetches `field_values` (with `option_id`, `user_id`) and the open blocker links (`to_attr`). The board and
  list endpoints must keep a **constant query count** regardless of the number of tasks.
- `task_data()` falls back to per-task queries when the annotations are missing (same pattern as `_counter`).
- No field is removed or renamed; v1 clients ignore the new keys. Deploy the backend before a frontend that
  reads them (the frontend types declare them required).

---

## 5. Side effects

### 5.1 Version bumps

| Write | `Task.version` |
|---|---|
| PATCH `customFields` / `timeEstimateMinutes` | +1 (part of the PATCH, checked first) |
| Add / remove dependency | **no bump** on either task (separate resource, like comments; bumping both ends would cause false conflicts on the other task). Clients invalidate both tasks' detail queries and the board/list. |
| Time entry create/delete, timer start/stop | no bump (`loggedMinutes` is a counter, like `commentCount`) |
| Custom-field create/update/delete/reorder (incl. option deletion clearing values) | no bump |

### 5.2 Audit rows (`apps.audit.services.record`)

| Action | Scope (workspace / project / task) | `target` | `changes` / `data` |
|---|---|---|---|
| `task.updated` (existing) | ws, project, task | task title | one `change(<field name>, before, after)` per changed custom field (`kind: "person"` for user fields with user ids; `"value"` otherwise, select values as option **names**, dates ISO, `null` for empty). `change("Time estimate", beforeMinutes, afterMinutes)` |
| `task.dependency_added` | ws, project, task — **one row per task** (2 rows) | that task's title | `data: { "relation": "blocked_by" \| "blocks", "otherKey": "PRJ-48", "otherTitle": "…" }` from that row's task's perspective |
| `task.dependency_removed` | as above, 2 rows | | same `data` |
| `task.time_logged` | ws, project, task | task title | `data: { "minutes": 90, "date": "2026-10-07", "source": "manual" \| "timer" }` |
| `task.time_entry_deleted` | ws, project, task | task title | `data: { "minutes": 90, "date": "…", "owner": "<user name>" }` |
| `project.custom_field_created` | ws, project | field name | `changes: [change("Type", null, "select"), change("Required", null, false)]` |
| `project.custom_field_updated` | ws, project | field name | name / required / options diffs (`change("Options", "Chrome, Safari", "Chrome, Arc")`) |
| `project.custom_field_deleted` | ws, project | field name | `data: { "valuesRemoved": 14 }` |
| `project.custom_fields_reordered` | ws, project | project name | `change("Order", "A, B, C", "B, A, C")` |

Timer start and a stop that is discarded write no audit row; a stop that logs writes `task.time_logged`.
On the frontend, `auditActionKind` maps all of these to "updated" except `*_deleted` → "deleted" and
`custom_field_created` → "created" (extend the switch: verbs ending in `_created`/`_deleted`).

### 5.3 Activity feed

Add to `audit.selectors.ACTIVITY_VERBS` and the frontend `ActivityVerb` union:

| Audit action | Verb | Text (`activity-text.ts`) |
|---|---|---|
| `task.dependency_added` | `dependency_added` | blocked_by: "marked this blocked by PRJ-48" · blocks: "marked this as blocking PRJ-47" |
| `task.dependency_removed` | `dependency_removed` | "removed the dependency on PRJ-48" |

Custom-field value changes already appear as "updated the task" (`task.updated`). Time entries and field
definition changes are audit-only (not in activity feeds).

### 5.4 Notifications

None in this release. No designed inbox row or email exists for dependency, field or time events, and the
v1 `NotificationType` set is unchanged. (Candidate for later: "PRJ-42 is unblocked" to the assignee.)

### 5.5 Other

- Search vectors: unchanged (custom-field text is not indexed).
- Trash: deleting/restoring/purging a task carries its values, dependencies and entries implicitly (§2).
- `seed_demo` (backend) loads the new mock collections through `backend/scripts/frontend-seed/dump-seed.mts`.

---

## 6. Frontend

Lift the ban first: update the "No v2 features" bullet in `frontend/CLAUDE.md` (remove custom fields,
dependencies, time tracking) and add every endpoint and field of §4 to "Requested API additions" in
`frontend/docs/final-report.md` (paper-trail rule). Add the new `/[ws]/timesheet` route to the architecture list.

### 6.1 `src/lib/api/types.ts`

```ts
/* Permissions: PROJECT_PERMISSIONS becomes the exact §3.3 list (adds field.manage, time.log, time.delete_any). */

/* ── Custom fields (board 39) ── */
export type CustomFieldType = "text" | "number" | "select" | "date" | "user";
export const FIELD_COLORS = [
  "var(--low)", "var(--accent-t)", "var(--info)", "var(--warn)",
  "var(--orange)", "var(--danger)", "var(--ok)", "var(--text-3)",
] as const;
export type FieldColor = (typeof FIELD_COLORS)[number];

export interface CustomFieldOption { id: ID; name: string; color: FieldColor; position: number }
export interface CustomField {
  id: ID; projectId: ID; name: string; type: CustomFieldType; required: boolean; position: number;
  options: CustomFieldOption[]; taskCount: number; createdAt: ISODateTime;
}
export interface CustomFieldInput {
  name: string; type: CustomFieldType; required?: boolean;
  options?: { id?: ID; name: string; color: FieldColor }[];
}
export type CustomFieldPatch = Partial<Pick<CustomFieldInput, "name" | "required" | "options">>;
/** select → option id, user → user id, date → ISODate, number → number, text → string. */
export type CustomFieldValue = string | number;

/* ── Dependencies ── */
export type DependencyRelation = "blocked_by" | "blocks";
export interface TaskRef { id: ID; key: string; title: string }
export interface DependencyTask extends TaskRef {
  statusId: ID; status: Pick<Status, "name" | "glyph" | "category">; assigneeId: ID | null;
}
export interface DependencyItem { id: ID; task: DependencyTask; createdAt: ISODateTime; createdById: ID | null }
export interface TaskDependencies { taskId: ID; isBlocked: boolean; blockedBy: DependencyItem[]; blocks: DependencyItem[] }

/* ── Time ── */
export interface TimeEntry {
  id: ID; taskId: ID; projectId: ID; userId: ID; minutes: number; date: ISODate; note: string;
  source: "manual" | "timer"; createdAt: ISODateTime;
}
export interface RunningTimer { taskId: ID; taskKey: string; taskTitle: string; projectId: ID; startedAt: ISODateTime }
export interface TimesheetSlice { projectId: ID; taskId: ID | null; key: string; name: string; hue: number; minutes: number }
export interface TimesheetCell { date: ISODate; minutes: number; breakdown: TimesheetSlice[] }
export interface TimesheetRow { user: Pick<User, "id" | "name" | "hue" | "avatarUrl">; cells: TimesheetCell[]; totalMinutes: number }
export interface Timesheet {
  weekStart: ISODate; days: ISODate[];
  projects: Pick<Project, "id" | "key" | "name" | "hue" | "my_permissions">[];
  rows: TimesheetRow[]; dayTotals: number[]; totalMinutes: number;
}
```

Changes to existing types:

```ts
interface Task {
  /* …v1 fields… */
  customFields: Record<ID, CustomFieldValue>;
  isBlocked: boolean;
  openBlockers: TaskRef[];
  timeEstimateMinutes: number | null;
  loggedMinutes: number;
}
interface TaskDetail extends Task { /* …v1… */ dependencies: TaskDependencies }

type TaskPatch = /* v1 */ & {
  /** Merge: listed keys set, null clears. */
  customFields?: Record<ID, CustomFieldValue | null>;
  timeEstimateMinutes?: number | null;
};

type ActivityVerb = /* v1 */ | "dependency_added" | "dependency_removed";

type BaseFilterField = "status" | "priority" | "assignee" | "label" | "sprint" | "due" | "epic";
export type FilterField = BaseFilterField | "blocked" | `cf.${string}`;
export type FilterOp = "is" | "not" | "any" | "empty" | "before" | "after" | "set" | "gt" | "lt";
```

### 6.2 `src/lib/api/endpoints.ts`

```ts
export const customFields = {
  list: (projectId: string) => http.get<CustomField[]>(`/projects/${enc(projectId)}/custom-fields`),
  create: (projectId: string, body: CustomFieldInput) => http.post<CustomField>(`/projects/${enc(projectId)}/custom-fields`, body),
  update: (id: string, body: CustomFieldPatch) => http.patch<CustomField>(`/custom-fields/${enc(id)}`, body),
  remove: (id: string) => http.del(`/custom-fields/${enc(id)}`),
  reorder: (projectId: string, ids: string[]) => http.put<CustomField[]>(`/projects/${enc(projectId)}/custom-fields/order`, { ids }),
};

export const dependencies = {
  list: (taskId: string) => http.get<TaskDependencies>(`/tasks/${enc(taskId)}/dependencies`),
  add: (taskId: string, relation: DependencyRelation, otherTaskId: string) =>
    http.post<TaskDependencies>(`/tasks/${enc(taskId)}/dependencies`, { relation, taskId: otherTaskId }),
  remove: (taskId: string, dependencyId: string) => http.del(`/tasks/${enc(taskId)}/dependencies/${enc(dependencyId)}`),
};

export const time = {
  entries: (taskId: string) => http.get<TimeEntry[]>(`/tasks/${enc(taskId)}/time-entries`),
  log: (taskId: string, body: { minutes: number; date: string; note?: string }) =>
    http.post<TimeEntry>(`/tasks/${enc(taskId)}/time-entries`, body),
  remove: (entryId: string) => http.del(`/time-entries/${enc(entryId)}`),
  timer: () => http.get<{ timer: RunningTimer | null }>("/me/timer"),
  startTimer: (taskId: string, date: string) => http.post<{ timer: RunningTimer; stopped: TimeEntry | null }>(`/tasks/${enc(taskId)}/timer`, { date }),
  stopTimer: (date: string, note?: string) => http.post<{ entry: TimeEntry }>("/me/timer/stop", { date, note }),
  timesheet: (slug: string, week: string, projectId?: string) =>
    http.get<Timesheet>(`/workspaces/${enc(slug)}/timesheet`, { filter: { week, project: projectId } }),
};
// api = { …v1, customFields, dependencies, time }
```

`tasks.update` is unchanged (the new keys ride in `TaskPatch`).

### 6.3 `src/lib/api/query-keys.ts`

```ts
customFields: (projectId: string) => ["p", projectId, "custom-fields"] as const,
dependencies: (taskId: string) => ["t", taskId, "dependencies"] as const,   // only if D1 is used standalone
timeEntries: (taskId: string) => ["t", taskId, "time"] as const,
myTimer: () => ["me", "timer"] as const,
timesheet: (slug: string, week: string, projectId?: string) => ["workspace", slug, "timesheet", week, projectId ?? "all"] as const,
```

Invalidation: field create/update/delete/reorder → `qk.customFields`, `qk.scope(projectId)` (task payloads
change). Value PATCH → v1 `useUpdateTask` path (optimistic on `qk.task`, board, list). Dependency add/remove →
`qk.task` for **both** task keys, `qk.board`, `qk.taskList`, `qk.views(slug)` (counts). Log/delete entry and
timer stop/start → `qk.timeEntries`, `qk.task` (`loggedMinutes`), `qk.myTimer`, `qk.timesheet` prefix.

### 6.4 Permissions (`src/lib/permissions/catalogue.ts`)

Add the three `prj(...)` entries at the §3.1 positions and update `DEFAULT_ROLES` per §3.2. Gating:
`can("field.manage")`, `can("time.log")`, `can("time.delete_any")`, `can("report.view")`, `canEditTask(task)`.
Nothing is inferred from role names. Hidden when not allowed; a visible-but-disabled control carries a
`disabledReason` (only the dialog's locked Type control in edit mode).

### 6.5 Routes and components

| Path | What |
|---|---|
| `src/app/[workspace]/timesheet/page.tsx` | thin page → `features/time/timesheet-screen.tsx` |
| `features/fields/custom-fields-settings.tsx` | settings tab panel (list, drag + Alt↑↓ reorder, read-only note, states) |
| `features/fields/custom-field-dialog.tsx` | create/edit dialog (§1.2) |
| `features/fields/delete-field-dialog.tsx` | confirm + 5 s pending delete with Undo |
| `features/fields/task-custom-fields.tsx` | panel group; row visibility rule; per-type editors: inline text (max 120) / number input (Enter commits, Esc cancels, blur commits), select + person listbox with Clear, date popover calendar (Mon-first, Today, Clear) |
| `features/fields/field-lib.ts` | `displayValue`, `validateValue` (same messages as §4.2), `cardChip(task, fields)`, `cfSortValue`, `visibleRows` |
| `features/dependencies/task-dependencies.tsx` | section with two groups and remove buttons |
| `features/dependencies/dependency-picker.tsx` | combobox over `api.tasks.list(projectId, { q, limit: 20 })`, excluding self, parent/sub-tasks and existing links; shows 6; ↑↓ ↵ Esc |
| `features/dependencies/blocked-badge.tsx` | panel chip + card badge (title text from `openBlockers`) |
| `features/time/task-time.tsx` | Time section (header totals/bar/over, timer button, Log time form, entries) |
| `features/time/use-timer.ts` | `qk.myTimer` query (refetch on focus), 1 s tick only while a timer runs **and** the tab is visible, start/stop mutations with toasts ("Logged 12m on PRJ-44" when R2 returns `stopped`) |
| `features/time/duration.ts` | `parseDuration`, `formatMinutes`, `formatClock`, `formatHours` |
| `features/time/timesheet-screen.tsx`, `timesheet-lib.ts` | grid, tooltip, heat scale, CSV builder, week maths |

Edits to existing files: `task-detail.tsx` (section order), `task-properties.tsx` (`TaskChips`: Blocked +
timer chips; custom-field group after labels; `AddProperty`: "Custom fields" heading + "Time estimate"),
`board/task-card.tsx` (badge, timer chip, field chip), `list/list-model.ts` + `list-screen.tsx` (cf columns,
Blocked glyph), `filters/filter-model.ts` + `filter-bar.tsx` (new fields/ops; field list built from
`qk.customFields`; rules for deleted fields render "Removed field" and are ignored), `settings/project-settings.tsx`
(tab `fields`), `components/shell/sidebar.tsx` (Timesheet item), `lib/audit.ts` (§5.2),
`tasks/activity-text.ts` (§5.3).

Display rules: user values resolve through project members; a user who left shows "Former member" in
`text-fg-3`. A select value whose option is missing shows "Removed option". Numbers use
`toLocaleString("en-US")`. Dates "Oct 9" (+ " · today"). Durations "4h 25m", "45m", "6h".

Appearance follows board 39 (classes `tx-*`, `cf-*`, `ts-*` are the reference), using token classes only,
transform/opacity animation only, the timer pulse static under reduced motion, and 390 px layouts (panel as
sheet, settings list, timesheet scroll inside its card).

### 6.6 Duration parsing (client, from the design's `parseDur`)

| Input | Minutes |
|---|---|
| `1:30` (`h:mm`, minutes 00–59) | 90 |
| `1.5` / `2` (bare number ≤ 12) | 90 / 120 (hours) |
| `45` (bare number > 12) | 45 (minutes) |
| `1h 30m`, `1h`, `30m`, `1.5h`, `2 hours 5 mins` | 90, 60, 30, 90, 125 |
| empty | error "Enter a duration" |
| anything else | error "Use a format like 1h 30m" |

Then: ≤ 0 → "Duration must be over 0"; > 1 440 → "Max 24h per entry". Date: empty → "Pick a date"; after local
today → "Can’t log future time"; before local today − 365 → "Date is too far back". Errors show only after the
first submit attempt; a valid duration shows the hint "= 1h 30m · Oct 7". The same parser edits the time estimate
(max 60 000 → "Estimate is 1 minute to 1000 hours").

### 6.7 Mock backend

New file `src/lib/mock/handlers/extensions.ts` exporting `registerExtensions()` (called from
`mock/transport.ts`), implementing every endpoint of §4 with the same status codes, error codes and messages,
permission checks (`requireProject(ctx, id, "field.manage")` etc.) and `version` handling. Existing handlers
change: `PATCH /tasks/:id` (customFields, timeEstimateMinutes), `GET /projects/:id/tasks` (`filter[blocked]`),
`toTask`/`toDetail` in `derive.ts` (new derived fields), saved-view `countFor` (must match on the derived task,
not the raw `TaskRec`), task activity verbs, audit rows.

DB shape (no `SCHEMA` bump; new collections are optional and created lazily, as v1 did for views and trash):

```ts
interface MockDB {
  /* …v1… */
  customFields?: (Omit<CustomField, "taskCount">)[];
  dependencies?: { id: string; projectId: string; blockerId: string; blockedId: string; createdById: string | null; createdAt: string }[];
  timeEntries?: TimeEntry[];
  timers?: { userId: string; taskId: string; startedAt: string }[];
  /** Board 39 upgrade marker for databases cached before v2. */
  ext39?: boolean;
}
// TaskRec gains optional `customFields?: Record<string, CustomFieldValue>` and `timeEstimateMinutes?: number | null`.
```

`ensureExt39(db)` runs on first use of any new route **and** from `createSeed()`:
1. Adds the new permissions to cached **system** roles by `key` (§3.2). Custom roles untouched.
2. Seeds the PRJ data below if `ext39` is unset; sets `ext39 = true`.
3. Adds the "Blocked" pinned view for each PRJ member who doesn't have a view named "Blocked" (after their
   existing pins).

The mock cycle check uses the same BFS as the backend; the cycle error path format must match.

### 6.8 Seed data (PRJ, `p_prj`; mock and `seed_demo`)

Dates use the seed's `D()` (relative to 2026-10-07). Ids are illustrative but stable.

Custom fields (positions 0–4):

| Id | Name | Type | Required | Options |
|---|---|---|---|---|
| `p_prj-cf-browser` | Browser | select | no | Chrome `var(--low)`, Safari `var(--accent-t)`, Firefox `var(--orange)`, Edge `var(--info)` (ids `p_prj-cf-browser-chrome` …) |
| `p_prj-cf-found` | Found in | text | **yes** | |
| `p_prj-cf-accounts` | Accounts affected | number | no | |
| `p_prj-cf-qasignoff` | QA sign-off | date | no | |
| `p_prj-cf-qaowner` | QA owner | user | no | |

Values:

| Task | Browser | Found in | Accounts affected | QA sign-off | QA owner |
|---|---|---|---|---|---|
| PRJ-42 | Safari | v2.3.1 | 1240 | — | Riley Chen |
| PRJ-48 | Chrome | v2.3.0 | 310 | — | Sam Patel |
| PRJ-53 | Firefox | v2.2.4 | 18 | 2026-09-28 | Morgan Diaz |
| PRJ-51 | Safari | v2.3.1 | — | — | — |
| PRJ-33 | — | v2.3.0 | — | — | Jordan Lee |

Dependencies: PRJ-48 blocks PRJ-42 (open → PRJ-42 blocked); PRJ-40 blocks PRJ-42 (done, closed); PRJ-42 blocks
PRJ-47 and PRJ-68; PRJ-57 blocks PRJ-58. Blocked tasks: PRJ-42, PRJ-47, PRJ-68, PRJ-58.

Time: `PRJ-42.timeEstimateMinutes = 360`. Entries on PRJ-42: Alex 90 min on D(2026-10-05) "Repro + profiling"
(manual); Jordan 45 min on D(2026-10-06) "Safari check" (manual); Alex 120 min on D(2026-10-07) "ResizeObserver
fix" (timer) → `loggedMinutes` 255 ("4h 15m / 6h"). Timesheet fill: a deterministic generator (seeded from user
index, day and project, no `Math.random`) adds weekday entries of 1–4 h in 30-minute steps for the current and
previous week up to today, for members of PRJ, MOB and INF, on their assigned open tasks. No running timer is
seeded. Seeding bypasses permissions; note that Riley Chen holds the custom "Release captain" role on PRJ, which
the upgrade does not touch, so Riley can't log new time there unless an admin grants `time.log` to that role
(useful for testing the custom-role path).

---

## 7. Test plan

### 7.1 Backend (pytest, PostgreSQL; gates unchanged: ruff, mypy, coverage ≥ 85 %, `apps/access` ≥ 95 %)

- **Models/migrations:** constraint tests (unique field name case-insensitive, option uniqueness, exactly-one
  value column, number range, dependency unique + not-self, entry minutes range, one timer per user, estimate
  range). `makemigrations --check`. The `access` data migration adds the codes to existing system roles, is
  idempotent, and leaves custom roles alone.
- **Catalogue:** `GET /permissions` includes the 3 codes in order; `my_permissions` order matches §3.3; the 7
  default roles hold exactly the §3.2 grants; archived projects drop them.
- **Custom fields:** CRUD happy paths; every 422 message of F2/F3; 409 `field_limit`; type change refused;
  option removal clears values and adjusts `taskCount`; delete cascades values and compacts positions; reorder
  requires the full id set; Member/Viewer get 403; IDOR (field id from another project/workspace → 404).
- **Values via PATCH:** each type set/clear; merge semantics; required can't be cleared; unknown field; user not
  a member; `version` checked and bumped once; edit_own vs edit_any; `task.move`-only users refused; bulk refuses
  `customFields`; audit `changes` content.
- **Dependencies:** add both relations; 201 payload; self/parent/sub-task/other-project 422; duplicate 409;
  2-cycle and 3-cycle 409 with exact `details.path`; limit 409; deleted tasks ignored in lists, `isBlocked` and
  cycle checks; restore brings them back; remove allowed from either side's editor, refused otherwise; two audit
  rows and two activity entries; no version bump. Concurrency: two transactions adding A→B and B→A — one fails
  (use the project row lock; test with two DB connections or by asserting the lock is taken).
- **`isBlocked`/`openBlockers`:** open vs Done vs Canceled blockers; board, list, my-tasks payloads; constant
  query count for the board with 5 vs 50 tasks (`django_assert_num_queries`).
- **Time entries:** create with every validation message (date tolerance +1 day, −365 days, 1440 cap); `note`
  truncation; delete own / any / forbidden; `loggedMinutes` sums; Viewer 403; deleted task 409; audit rows.
- **Timer:** start, idempotent restart, switch (stops and logs the previous one), stop rounding (30 s → 1, cap at
  1440), stop with no timer 404, stop after losing `time.log` (403, discarded), stop on deleted task (409,
  discarded), `GET /me/timer` drops stale timers. Use `freezegun`.
- **Timesheet:** Monday snapping (Sunday input, week across a month boundary), project filter and its 403/404,
  breakdown by project vs by task (top 5, totals intact), rows only for users with time, `dayTotals`, excludes
  deleted tasks and invisible projects, `projects[].my_permissions`.
- **Saved views:** `clean_rules` keeps/drops cf and blocked rules per type; `apply_rules` for every op in §4.7
  (shared vectors with the frontend); deleted-field rules ignored; counts.
- **OpenAPI:** regenerate `docs/openapi.yaml`; drift check passes.

### 7.2 Frontend (`npm run check`; Vitest with `--maxWorkers=2` on this machine)

- **Unit:** `duration.ts` (every row of §6.6, error order), `formatMinutes`/`formatClock`; `field-lib`
  (display per type, removed option, former member, validation messages, `cardChip` picks the first select by
  position with a value); `filter-model` (new fields/ops, URL round trip with `cf.<id>`, shared vectors with the
  backend); list sort for cf columns; `timesheet-lib` (week maths, CSV text, heat steps, export gate);
  `auditActionKind` for the new actions; `activityText` for the new verbs.
- **Permissions:** `can.test.tsx` covers the 3 keys for all 7 roles; the e2e role matrix asserts: Viewer sees no
  timer/Log time/editors/Manage; Member sees timer and Log time but no "New field"; Manager and Project Admin see
  everything; delete × only on own entries for Member.
- **Mock handlers** (`mock.test.ts` style): every endpoint's happy path and each error code/message in §4,
  version conflict on PATCH, cycle 409 path, `ensureExt39` upgrades a v1-cached DB (roles + seed + Blocked view)
  exactly once.
- **Component/e2e (Playwright, port 3100):** open PRJ-42 → custom-field rows render; set Browser, clear a
  non-required value, required "Found in" offers no Clear; add a "Blocked by" via the picker (keyboard only),
  remove it, see the board badge update; try a cycle → toast with the loop; Log time "1h 30m" → entry + total;
  Start/Stop timer → entry tagged `timer`; settings: create a select field with 3 options, reorder with Alt+↓,
  delete with Undo (no request sent) and without (request sent after 5 s); Timesheet loads, week back/forward,
  project filter, Export downloads; "Blocked" pinned view shows the 4 seeded tasks.
- **Visual sweep:** panel, settings tab, dialog, board card, timesheet (+ loading/empty/error) at 1440 and 390 in
  navy, black and light, as `u_taylor` (Viewer on PRJ) and `u_alex`; no console errors, no horizontal page scroll.
- **Live mode:** with the backend seeded (`seed_demo`), every surface above loads with no failed API call.

---

## 8. Conflicts (design vs conventions) and resolutions

| # | Design | Conventions | Resolution |
|---|---|---|---|
| 1 | Three design roles (admin / member / viewer) gate everything (`role === 'admin'`, `!viewer`) | Permissions only from `my_permissions`; 7 default roles; never role names | Mapped to keys: field management → `field.manage`; timer/log → `time.log`; value/dependency edits → v1 task-edit rule; export → `report.view`. Grants in §3.2. |
| 2 | Settings note "Only admins can edit fields" | v1 `ReadOnlyNote` (role name, reason, project admins) | Use `ReadOnlyNote`; no "admins" copy. |
| 3 | Shows both "Estimate 3 pts" and a time estimate (`timeEst`, "4h 25m / 6h") but no control to set the time estimate | `Task.estimate` is story points (0–99) and feeds velocity/burndown | New separate `timeEstimateMinutes`. Set via "Add property → Time estimate" and by clicking the `/ 6h` total (duration input). |
| 4 | Board card timer pauses/resumes ("Resume timer", accumulated time); panel timer Start/Stop logs an entry | One behaviour | Start/Stop only. The card chip shows only while running; clicking it stops and logs. One server-side timer per user; starting another switches (logs the old one). |
| 5 | Log date floor fixed at 2026-01-01; `TODAY` hard-coded | Rolling dates; server "today" is UTC (v1 known gap) | Floor = today − 365 days; server allows up to UTC today + 1 day. Client validates with local dates. |
| 6 | Field delete applies instantly with an Undo toast that re-inserts the definition | v1 pending-delete pattern (5 s, then send) | Client delays the `DELETE` 5 s; Undo cancels. Backend hard-deletes; no restore endpoint. |
| 7 | Settings nav: General, Members, Statuses, Custom fields, Import | v1 tabs General / Workflow / Labels / Members; Import is a different v2 board | Add a "Custom fields" tab (`?tab=fields`); keep v1 tabs; no Import. |
| 8 | Type label "Person", internal key `user` | — | Wire value `"user"`, UI label "Person". |
| 9 | Number values clamped client-side to 0…1e9, 2 decimals | Server validates | Client clamps/rounds before sending; server rejects out-of-range with 422. |
| 10 | Text value cut to 120 silently; empty input on a required field silently restores | Server validation | Same on the client; server returns 422 if it ever receives them. |
| 11 | "Removed option" display for dangling select values | FK integrity | Option deletion deletes its values; "Removed option" kept only as a defensive fallback. |
| 12 | Dependency picker searches a fixed in-memory pool across mixed tasks | Real data, permissions | Picker uses `GET /projects/:id/tasks?q=`; dependencies are same-project only (§9). |
| 13 | Board card shows a field chip ("Browser: Safari") without saying which field | Deterministic rule needed | First select field by position that has a value. |
| 14 | Panel's custom-field "Manage" link `#custom-fields` | Real routes | `/[ws]/projects/[key]/settings?tab=fields`. |
| 15 | Entries removable only by their author | v1 `*_any` pattern (comments, attachments) | Own with `time.log`; anyone's with `time.delete_any` (Manager, Project Admin). |
| 16 | Timesheet Export gated on `role !== 'viewer'`; CSV built in the browser | Permission keys | `report.view` (§1.2); CSV still built client-side from S1. |
| 17 | Timesheet data and hover breakdown are generated per project or per task | Real aggregation | S1 `breakdown`: per project for All projects, per task for one project; top 5 slices. |
| 18 | Activity tab in the design shows no dependency events | Activity feed is the audit log | New verbs `dependency_added` / `dependency_removed`; field values show as "updated the task". |
| 19 | Design header lists "5 field types" only; no edit dialog for an existing field, yet options can disappear | Labels and statuses are editable in v1 | Rows open the same dialog in edit mode (name, required, options); type is locked. |
| 20 | Panel menu "Duplicate" and the description/sub-task/attachment frames | v1 already built them | Out of scope; v1 behaviour unchanged. |
| 21 | `frontend/CLAUDE.md` bans these v2 features; "Blocked" pinned view dropped in v1 | User lifted the ban | Frontend updates the CLAUDE.md bullet and final report; the "Blocked" view returns as a seeded saved view. |

---

## 9. Open questions

None block implementation; each has a default above that both sides build to. Confirm or change before release:

1. **Cross-project dependencies.** Default: same project only. Allowing other projects in the workspace needs a
   rule for tasks the viewer can't see (redacted rows) and cross-project cycle checks; the model already supports
   it (FKs to `Task`, `project` would become the blocked task's project).
2. **Who sees others' time.** Default: anyone with `project.view` sees every entry on the task and in the
   timesheet. If time should be private to managers, add a `time.view_all` key.
3. **Unblocked notification.** Default: none. If wanted, it needs a `NotificationType`, an inbox row design and a
   preference row.
4. **Editing a time entry.** Default: delete and re-log (the design has no edit control).
5. **Time estimate entry point.** Default: "Add property → Time estimate" and clicking the total. Design has no
   control for it.

---

## 10. Delivery checklist

Backend: models + migrations (incl. `access` data migration) · catalogue + default roles · services/selectors/
views/urls for F1–F5, T1, D1–D3, E1–E3, R1–R3, S1 · Task payload fields with constant query counts · saved-view
rules · audit + activity verbs · `seed_demo` data · tests (§7.1) · `docs/openapi.yaml` regenerated.

Frontend: CLAUDE.md ban lifted + final-report paper trail · types, endpoints, query keys · permissions catalogue
and roles · mock handlers + `ensureExt39` + seed · panel sections, chips, settings tab, dialogs, board card,
list columns, filters, Timesheet route + sidebar entry · tests (§7.2) · visual sweep.
