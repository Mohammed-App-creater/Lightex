# v2 · Board 40: Import wizard (API contract)

Status: **contract, not implemented.** The backend (Django + DRF + Celery, `backend/`) and the frontend (Next.js,
`frontend/`) are built from this document in parallel. Where this document is silent, the v1 conventions in
`docs/backend-plan.md`, `frontend/docs/api-contract.md` and `frontend/src/lib/api/*.ts` apply unchanged, and so do the
board 39 (`docs/v2/39-fields-dependencies-time.md`) and board 32 (`docs/v2/32-timeline-calendar.md`) contracts that
this one maps onto.

Design source: `frontend/design/clean/40-Import-wizard.html` (frames: Step 1 Source, Step 2 Upload CSV, Step 3 Map
fields/statuses/people, Step 4 Summary, Import running, Results with errors, Step 2 Connect Jira, Mobile, Upload
rejected, Connect failed, Connecting, Viewer). Entry points also appear on board 06 (empty board "Import CSV"),
board 12 (setup checklist "Type them or import a CSV") and board 39 (project settings nav "Import").
Precedence is unchanged: **docs and existing conventions win for behaviour, the design wins for appearance.** Every
conflict and its resolution is in §9.

Contents: 0 Wire conventions · 1 Scope · 2 Data model · 3 Permissions · 4 Endpoints · 5 Execution · 6 Frontend ·
7 Security · 8 Test plan · 9 Conflicts · 10 Open questions · 11 Delivery checklist.

**Summary of the change.** One new backend app (`apps/imports`) with two models (`ImportJob`, `ImportRow`), nine
endpoints, one Celery task with batched commits, one new project permission (`project.import`), one new notification
type (`import`), two new audit actions and one activity verb, and one additive project field (`nextTaskNumber`).
The file goes up through the **existing signed-upload pattern** and is parsed **on the server**; progress is
**polled**. CSV is the only real source; Jira, Linear and Asana **CSV exports** are recognised as presets of the CSV
path; Trello and every API connector are "Coming soon".

---

## 0. Wire conventions (unchanged, restated so nobody guesses)

- Base `/api/v1`. JSON. camelCase fields; the only snake_case key is `my_permissions`.
- Timestamps ISO-8601 UTC (`ISODateTime`); calendar dates `YYYY-MM-DD` (`ISODate`).
- Errors: `{ "code": string, "message": string, "details": object }`. Validation is **422** `validation_failed`
  with `details.fields: { "<field path>": "<message>" }`; nested paths are dotted (`columns.3.field`,
  `statuses.blocked`).
- Paginated lists: `{ "data": T[], "nextCursor": string | null }`. Bounded lists are plain arrays.
- Filters: `filter[key]=value`. Create → **201**; async start → **202**; update → **200**; delete → **204**.
- Permission failure → 403 `forbidden` with `details.permission`. Not a workspace member → 404. Workspace member, not
  on the project → 403 `project_membership_required` (v1, unchanged).
- Archived projects are read-only: `project.import` is **not** added to `ARCHIVED_ALLOWED`, so every import write
  returns 403 there.
- IDs are UUIDs on the backend and opaque strings in the mock (`imp_7f3k`). Clients never parse ids.

---

## 1. Scope

### 1.1 What board 40 shows

A four-step modal wizard that turns a file into tasks of one project:

| Step (stepper label) | Content |
|---|---|
| 1 **Source** | Source tiles (radiogroup, arrow keys) · "Import into" project picker with each project's next key |
| 2 **Upload** (CSV) / **Connect** (API sources) | Drop zone (`.csv · max 10 MB`) → file card (name, `48 rows · 8 columns · 4 KB`, Replace, Remove) + "Detected columns" chips with a sample value. Errors inline. "Use sample file". |
| 3 **Map** | "Fields" table (source column + sample → Lightex field select, `auto` tag, duplicate highlight) · "Statuses" value map · "People" value map · "Preview" (first 5 rows, bad rows tinted, title tooltip "Will skip: …") |
| 4 **Import** | Summary (4 stat tiles: Tasks, Will skip, Statuses, People · route "file → PRJ Platform Rebuild" with key range · skip summary `2 × missing title · 1 × invalid due date`) → Running (progress bar, `pos / total rows`, %, streaming log `ok PRJ-61 Fix login…` / `skip row 8 Missing title`) → Complete (spark, key range, Imported / Skipped tiles, Error report table + **Download report**, **Import more**, **Open project**) |

Footer: a reason line (warning tone, shakes when Next is pressed while blocked), Back, Next / Start import.

### 1.2 Sources in this release

| Source | This release | Why |
|---|---|---|
| **CSV** (any spreadsheet export) | **Real.** Required. | The common denominator; every tool below can produce it. |
| **Jira — CSV export** ("Filters → Export → Export CSV (all fields)") | **Real**, as the Jira tile. It is the CSV path with the `jira` preset (§4.7): header synonyms (`Summary`, `Issue key`, `Issue id`, `Issue Type`, `Custom field (Story Points)`, `Original Estimate` in seconds, `Parent`, `Inward issue link (Blocks)`, repeated `Labels`/`Sprint` columns), Jira's date format (`09/Oct/26 10:00 AM`) and Jira priority names. | A preset is only synonyms, units and a date format on top of the same parser, so it costs little and brings the issue hierarchy, estimates and links across. |
| **Linear — CSV export**, **Asana — CSV export** | **Real, auto-detected** inside the CSV tile (no new tiles). The server recognises the header signature (§4.7) and applies the `linear` / `asana` preset; the Upload step shows "Looks like a Linear export". | Same argument as Jira; neither is in the design, so they get no tile of their own. |
| **Trello — JSON export** | **"Coming soon"** tile (disabled, `disabledReason` "Trello import is coming soon. Export your board as CSV with a Power-Up and use CSV."). | Trello's free export is JSON only: a nested document (cards, lists, members, checklists **plus the full action history**) that often exceeds 10 MB, and its members carry usernames, not emails, so people can't be matched. It needs its own parser and limits. It can be added later as a converter that produces the same row model (§5.2), without changing the rest of the pipeline. |
| **Jira / Trello / Linear / Asana APIs** (OAuth, site URL, "Connect") | **"Coming soon".** The design's Connect frames (site URL, Connecting skeleton, "Couldn’t reach Jira · 401", board/project picker) are not built. | They need per-provider OAuth apps (Atlassian 3LO, Trello key/token), encrypted token storage, pagination under rate limits and long syncs; there is no integration infrastructure yet (board 37 is v2 as well). File exports carry the same data with no credentials. |

The wire value `source` is what the user picked (`"csv"` or `"jira"`); `preset` is what the server detected
(`"generic" | "jira" | "linear" | "asana"`). Picking the Jira tile and uploading a file that doesn't look like a Jira
export is allowed: `preset` becomes `generic` and the Upload step shows the note "This doesn’t look like a Jira export.
Columns are matched by name." (non-blocking).

### 1.3 Entry points

Every entry point is **rendered only when** the viewer holds `project.import` **and** `task.create` on that project
(§3) and the project is not archived. All of them open the wizard with `?import=new` (`pushUrl`), preselecting the
project.

| # | Where | Control |
|---|---|---|
| E1 | Project overview → setup checklist (board 12), item "Create your first tasks" | desc becomes "Type them or import a CSV"; secondary action **Import CSV** next to "New task" |
| E2 | Board and list empty state (board 06: "Create the first task for this project, or import a CSV.") | ghost button **Import CSV** next to "New task" |
| E3 | Project settings → new tab **Import** (`/[ws]/projects/[key]/settings?tab=import`, last tab, board 39's settings nav) | import history (§6.5) + **New import** button |
| E4 | Command palette, project context | action **Import tasks…** (`>` prefix group "Actions") |
| E5 | Inbox notification "Import finished" (§5.8) | opens `?import=<jobId>` on the project board (result step) |

The new-project flow (frontend final report §3 item 5) is covered by E1: a fresh project lands on its overview, whose
checklist offers "Import CSV". The wizard does not create projects (§10 #9).

### 1.4 Wizard steps and states

The wizard is a `Modal` (large, 760 px wide, 640 px tall on desktop; full-height sheet at ≤ 760 px). URL state:
`?import=new` before a job exists, then `?import=<jobId>` (`replaceUrl`), so a reload or a notification reopens the
same job. The client step is derived from the job status (§2.3): `draft`/no job → 1–2, `ready` → 3–4 (summary),
`queued`/`running` → 4 running, `completed`/`canceled`/`failed` → 4 result.

#### Step 1 · Source

| Element | Rule |
|---|---|
| Tiles (design order) | **Trello** (disabled, "Coming soon" badge, meta "Boards · lists · cards") · **Jira** (meta "Issues · CSV export") · **CSV** (meta "Any spreadsheet export"). Roving tabindex, arrow keys move and select (design), disabled tile is skipped. |
| Import into | Picker of projects where `my_permissions` has `project.import` and `task.create` (status active). Each option: key badge, name, meta = next key (`PRJ-61` from `Project.key` + `Project.nextTaskNumber`). Esc closes the menu first (design `onKey`). |
| Footer reason | "Pick a source" until a tile is chosen |
| Changing the project after a file was uploaded | the client discards the draft job (`cancel`) and silently re-uploads the same `File` for the new project (the File object stays in memory); mapping restarts from the new suggestions |

#### Step 2 · Upload

| State | Content |
|---|---|
| Empty | Drop zone "Drop a CSV or browse" / "Drop to upload" while dragging, meta `.csv · max 10 MB`. Jira tile: one helper line above it, "In Jira: Filters → Export → Export CSV (all fields)". Live mode: **Download template** link (§6.8); mock mode: **Use sample file** (design). |
| Client pre-checks (instant, design copy) | not `.csv` → **Only .csv files** · `name · .xlsx · export as CSV first`; > 10 MB → **File is too large** · `name · 12.4 MB · max 10 MB`; 0 bytes → **File is empty** · `name` |
| Uploading | note with spinner "Uploading tasks.csv · 42%" (`role=status`), drop zone disabled |
| Analyzing | note with spinner "Reading tasks.csv" (design) |
| Analysis error (422, §4.3) | alert with the design title + meta (table in §4.3); the drop zone stays, red border |
| Upload/network error | alert **Couldn’t read file** · `name · Upload interrupted. Try again.` |
| File ready | file card: CSV badge, name, meta `48 rows · 8 columns · 4 KB` (+ ` · ; separated` / ` · tab separated`, + ` · Windows-1252` when not UTF-8, design order), **Replace** (new job), **×** Remove (cancels the job). Preset note when detected ("Looks like a Jira export"). "Detected columns" + count + chips (name, first non-empty sample ≤ 40 chars). |
| Footer reason | "Upload a CSV file" · "Reading file" · "Fix the file to continue" (design) |

#### Step 3 · Map (wide: two columns ≥ 1280 px design frame, stacked below 760 px)

| Section | Rule |
|---|---|
| **Fields** `mapped/total` | One row per column: name + sample, arrow, select. Options in §4.5 (core fields from the design first, then "More fields", then a "Custom fields" group with this project's fields, then "Don’t import"). `auto` tag when the server suggested it and the user hasn't touched it. A field mapped twice tints both rows (`dup`) except the multi-column fields (§4.5). Time estimate rows get a unit select (minutes/hours/seconds) when the column has bare numbers. |
| **Statuses** `mapped/total` | Shown when a column maps to Status. One row per distinct value (value + count) → the project's statuses (glyph + colour) or "Choose…". Unmapped rows get the warning ring (`need`). |
| **Types** `n` (new, same look as Statuses) | Shown when a column maps to Type. Values → Feature, Bug, Chore, Spike, and **Epic** (only with `epic.manage`). |
| **People** `n` | Shown when a column maps to Assignee or to a Person custom field. One row per distinct value → avatar + project member, or "Leave unassigned" (dashed avatar). Without `task.assign` the options are only "You" and "Leave unassigned". |
| **Preview** "first 5 rows" | Rows 1–5 of the file (`GET …/rows?limit=5`), cells rendered like the design (status glyph, avatar, priority bars, `3 pts`, `Oct 14`, label pills, `Missing title` / `Unmapped` in danger italics, `—` muted). Rows that will be skipped are tinted with the reason in `title`. |
| Footer reason | the first blocker from the server (§4.6): "Map a column to Title" → "Two columns map to Status" → "Map 2 more statuses" → "Too many statuses (52 · max 50)". Next is `aria-disabled` and shakes the reason (design). |

Every change is saved with `PUT /imports/:id/mapping` (debounced 300 ms, one request in flight, latest wins, §6.4);
the field select updates instantly, the value tables, counts and preview update from the response.

#### Step 4 · Import

| State | Content |
|---|---|
| Summary | Tiles **Tasks** (`counts.tasks`, plus "+ 2 epics" meta when epic rows exist) · **Will skip** (warning tone when > 0) · **Statuses** · **People** (values mapped to someone). Route row: source glyph + file name → project badge + name, key range `PRJ-61 → PRJ-104` (estimate). Skip summary line (`2 × missing title · 1 × invalid due date`). New line when anything will be created: "Creates 2 labels, 1 epic" (from `validation.creates`). |
| Running | "Importing" + `processed / total rows` + %, progress bar (`role=progressbar`), log (`role=log`, `aria-live=polite`) of the last 7 `progress.recent` lines. Stepper dot 4 spins. Footer: muted "Runs in the background" + **Stop import** (ghost). Header × stays and reads "Close · the import keeps running" (§9 #12). |
| Stopping | after Stop: note "Stopping after the current batch…", Stop disabled |
| Complete | spark + "Import complete" + `PRJ-61 → PRJ-104 · Platform Rebuild`; tiles Imported (ok) / Skipped (danger when > 0); "Error report" table (Row, Reason, Value; first 50 issues, then "and 12 more in the report") + **Download report**. Buttons **Import more** (back to step 1, same project) and **Open project** (board). |
| Stopped (`canceled` after start) | same layout, title "Import stopped", tiles as far as it got |
| Failed | title "Import failed", `error.message`, tiles as far as it got, **Retry** (resumes, §5.6) + **Close** |

#### Lock state (direct URL without permission)

Entry points are hidden (v1 rule), so the lock panel only shows for a hand-typed or stale `?import=` URL. It keeps
the design's lock layout but its text is v1's `ReadOnlyNote`: "Your role (Viewer) can’t import tasks into Platform
Rebuild" + the project admins list. No "member access" wording and no "Ask an admin" link (§9 #5).

### 1.5 Limits

| Limit | Value | Where enforced |
|---|---|---|
| File size | 10 MB (`MAX_UPLOAD_BYTES`, same as attachments) | client pre-check, I1 (declared size), I2 (real size from storage) |
| Extension | `.csv` | client, I1 |
| Data rows (excluding the header) | **5,000** (mock: 1,000, §6.7) | I2 → "Too many rows" |
| Columns | 40 (design) | I2 → "Too many columns" |
| Header name | first 60 characters, blank → `Column 4`, duplicates → `Labels (2)` (design) | I2 |
| Cell | 64 KB parse limit | I2 → "A cell is too long" |
| Distinct values: statuses / types / people | 50 / 20 / 200 | mapping blocker |
| New labels / new epics per import | 100 / 50 | mapping blocker |
| Labels per task | 20 (extra dropped with a warning) | runner |
| Concurrent imports | 1 queued-or-running job per project | I6 → 409 |
| Job creation | 20 per hour per user (`THROTTLE_IMPORTS`) | I1 |
| Retention | files + rows 30 days after the job finishes; untouched drafts 24 h | `purge_imports` |

### 1.6 Who can import

`project.import` (new, §3) **and** `task.create`, on the target project. Inside an import the user can only do what
they could do by hand, using the existing keys: assign others → `task.assign`; create epics (from Epic-type rows or
unknown epic names) → `epic.manage`; create select options in custom fields → `field.manage`; create labels →
`task.create` (v1 label rule). Default grants: Project Admin, Manager, Member; not Viewer (§3.2).

---

## 2. Data model (backend)

New app **`apps/imports`** (standard layering: `models`, `selectors`, `services`, `serializers`, `views`, `urls`,
plus `parsing.py`, `presets.py`, `mapping.py`, `planner.py`, `runner.py`, `report.py`, `tasks.py`,
`management/commands/{purge_imports,resume_imports}.py`). Both models extend `apps.common.models.BaseModel`. Neither
is soft-deleted; jobs are hard-deleted by retention.

### 2.1 `imports.ImportJob`

| Field | Type | Notes |
|---|---|---|
| `workspace` | FK `workspaces.Workspace`, CASCADE | denormalised from the project |
| `project` | FK `projects.Project`, CASCADE, `related_name="imports"` | target |
| `created_by` | FK user, SET_NULL, null | the importer; reporter of every imported task |
| `source` | `CharField(8)`, choices `csv`, `jira` | the tile |
| `preset` | `CharField(8)`, choices `generic`, `jira`, `linear`, `asana` | set by analysis |
| `status` | `CharField(10)`, choices `draft`, `ready`, `queued`, `running`, `completed`, `failed`, `canceled`, default `draft` | §2.3 |
| `cancel_requested` | `BooleanField(default=False)` | |
| `file_name` | `CharField(120)` | `clean_file_name()` (collaboration), display only |
| `file_size` | `PositiveIntegerField` | declared at I1, replaced by the real size at I2 |
| `source_key` | `CharField(300, unique)` | `ws/<ws>/p/<project>/imports/<job>/source.csv`, server-generated |
| `parsed_key` | `CharField(300, blank)` | `…/parsed.json.gz` (§5.2), written by I2 |
| `report_key` | `CharField(300, blank)` | `…/report.csv`, written when the job finishes with issues |
| `encoding` | `CharField(16, blank)` | `utf-8`, `utf-16`, `windows-1252` |
| `delimiter` | `CharField(1, blank)` | `,` `;` `\t` `|` |
| `row_count`, `column_count` | `PositiveIntegerField(default=0)` | data rows, columns |
| `analysis` | `JSONField(null)` | §4.3 `analysis` (columns, samples, types, distinct values) |
| `mapping` | `JSONField(null)` | §4.5, normalised |
| `mapping_revision` | `PositiveIntegerField(default=0)` | last accepted revision |
| `validation` | `JSONField(null)` | last computed §4.6 summary (cached for GET) |
| `phase` | `CharField(10, blank)` | `preparing`, `rows`, `links`, `finishing` |
| `number_base` | `PositiveIntegerField(null)` | first reserved task number (§5.4) |
| `planned_tasks` | `PositiveIntegerField(default=0)` | numbers reserved |
| `cursor` | `PositiveIntegerField(default=0)` | next data-row index (0-based) of the rows phase |
| `setup` | `JSONField(default=dict)` | ids of objects created in the preparing phase: `{ "labels": {name: id}, "epics": {ref: id}, "options": {fieldId: {name: id}} }` |
| `imported`, `epics_created`, `skipped`, `warnings`, `labels_created`, `options_created` | `PositiveIntegerField(default=0)` | counters, updated in each batch transaction |
| `first_key`, `last_key` | `CharField(24, blank)` | |
| `recent` | `JSONField(default=list)` | last 10 log lines (§4.2 `progress.recent`) |
| `error_code`, `error_message` | `CharField(40, blank)`, `CharField(300, blank)` | failed jobs |
| `lease_token` | `UUIDField(null)` | runner lease (§5.1) |
| `heartbeat_at` | `DateTimeField(null)` | refreshed by every batch |
| `request_id` | `CharField(64, blank)` | `X-Request-ID` of the start request; copied to audit rows |
| `started_at`, `finished_at` | `DateTimeField(null)` | |
| `expires_at` | `DateTimeField` | `created_at + 24 h` until started; `finished_at + 30 days` once terminal |

Constraints / indexes:
- `UniqueConstraint(fields=["project"], condition=Q(status__in=["queued", "running"]), name="import_one_active_per_project")`
- `Index(fields=["project", "-created_at"], name="import_project_recent")`
- `Index(fields=["status", "heartbeat_at"], name="import_recovery")`
- `Index(fields=["expires_at"], name="import_expiry")`
- `CheckConstraint(condition=Q(row_count__lte=5000), name="import_row_cap")`

Large JSON columns (`analysis`, `mapping`, `validation`) are deferred in list queries.

### 2.2 `imports.ImportRow`

One row per **processed** data row of a started job (imported, epic, skipped or warned). It makes batches
idempotent, resolves parent and dependency references across batches and restarts, and feeds the error report and
`GET …/rows` after the run.

| Field | Type | Notes |
|---|---|---|
| `job` | FK `ImportJob`, CASCADE, `related_name="rows"` | |
| `row` | `PositiveIntegerField` | spreadsheet row number: header = 1, first data row = 2 (design `i + 2`) |
| `outcome` | `CharField(8)`, choices `task`, `epic`, `skipped` | |
| `task` | FK `tasks.Task`, SET_NULL, null | created task |
| `epic` | FK `planning.Epic`, SET_NULL, null | created or linked epic (epic rows) |
| `refs` | `JSONField(default=list)` | this row's identities (values of the ID columns, §4.5), lower-cased |
| `issues` | `JSONField(default=list)` | `[{severity, field, reason, value}]` (§4.6) |

Constraints: `UniqueConstraint(fields=["job", "row"], name="import_row_unique")`;
`Index(fields=["job", "outcome"])`. A GIN index on `refs` is not needed (lookups happen in memory per job).

### 2.3 Status machine

```
            analyze ok                 start                lease                  all rows + links
  draft ───────────────▶ ready ─────────────────▶ queued ──────────▶ running ───────────────────────▶ completed
    │  ▲                  │  ▲ PUT mapping         │                   │  │
    │  └ analyze 422      │  └────────┘            │ cancel            │  │ cancel_requested → after the batch
    │    (stays draft)    │ cancel                 ▼                   │  ▼
    └──── cancel ─────────┴──────────────────▶ canceled ◀──────────────┘ canceled
                                                                       │ error after retries, project archived,
                                     start (retry, resumes at cursor)  ▼ permission lost
                                  queued ◀────────────────────────── failed
```

- Terminal: `completed`, `canceled`, `failed` (`failed` can be retried until it expires).
- `draft` → `ready` only through I2; a failed analysis leaves `draft` (the client discards it on Replace).
- `PUT mapping` only in `ready`. `start` only in `ready` or `failed`. `cancel` in every non-terminal state.
- Writes on a job in the wrong state → 409 `import_state` "This import has already started." /
  "This import has finished." with `details.status`.
- Tasks created before a cancel or a failure **stay** (each batch commits). There is no undo (§9 #13, §10 #3).

### 2.4 Storage objects

All through the existing `apps.collaboration.storage.get_storage()` (R2 / Local / Fake); keys are server-generated
and never contain the user's file name.

| Key | Written by | Content |
|---|---|---|
| `ws/<ws>/p/<project>/imports/<job>/source.csv` | the browser (signed PUT) | the raw file |
| `…/parsed.json.gz` | I2 | `{"v":1,"header":[…],"rows":[[…],…]}`, cells as decoded strings (§5.2) |
| `…/report.csv` | finishing phase | the error report (§5.7) |

### 2.5 Retention

`manage.py purge_imports` (daily, next to `purge_trash`; Render cron / compose docs updated):
1. Jobs in `draft`/`ready` whose `expires_at` (created + 24 h) passed → status `canceled`, then deleted with step 2.
2. Jobs whose `expires_at` passed and that are not `queued`/`running` → delete the three storage objects, then the job
   row (cascades `ImportRow`). Imported tasks, labels and epics are untouched.
3. Purging a project from Trash deletes its import files first (`imports.services.delete_project_files(project)`
   called by the project purge), because the FK cascade alone would orphan them in storage.

`GET` on an expired (deleted) job → 404. The settings history only lists jobs that still exist.

### 2.6 Migrations

- `imports` 0001: `ImportJob`, `ImportRow`. Add `apps.imports` to `INSTALLED_APPS`, its urls to `config/api_urls.py`.
- `access` **0004** (data, idempotent; board 39 owns 0003): create the `project.import` `Permission` row if missing,
  add it to existing **system** roles by `system_key` per §3.2. Custom roles untouched. Reverse = no-op.
- No change to `tasks`, `projects` or `planning` tables. `Project.nextTaskNumber` is computed (`task_seq + 1`).

---

## 3. Permissions

### 3.1 New catalogue entry (project scope)

| Code | Group | Label | Description |
|---|---|---|---|
| `project.import` | Tasks | Import tasks | Bring in tasks from a CSV or another tool’s export |

Placement: in `backend/apps/access/catalogue.py` `PERMISSIONS`, right after `time.delete_any` (the last Tasks
entry); in `PROJECT_ORDER`, right after `task.move` (before `time.log`). Mirror both in
`frontend/src/lib/permissions/catalogue.ts` and `PROJECT_PERMISSIONS` (`types.ts`).

Why a new key rather than reusing `task.create`: one request creates up to 5,000 tasks plus labels and epics. Admins
must be able to let someone create tasks by hand without letting them bulk-load, and a custom role can withhold it.
Why project scope: the target is always one project; workspace and project scopes never override each other, so a
workspace Owner who isn't on the project can't import into it (v1 rule).

Effective rule (backend `imports.services.can_import`, frontend `canImport(perms)`): `project.import` **and**
`task.create`. A denial reports the first missing code in `details.permission`.

### 3.2 Default roles

| Role (scope) | project.import |
|---|---|
| Owner, Admin, Member (workspace) | — (workspace scope) |
| Project Admin | ✓ (core: stays `list(PROJECT_ORDER)`) |
| Manager | ✓ (stays "PROJECT_ORDER minus archive/delete/manage_members") |
| Member (`project_member`) | ✓ (add `"project.import"` after `task.move` in its explicit list) |
| Viewer | — |

Member gets it because the design gates import only away from viewers ("Import needs member access"); see §10 #2.

### 3.3 `my_permissions` order

`PROJECT_ORDER` / `PROJECT_PERMISSIONS` become, exactly:

```
project.view, project.update, project.archive, project.delete, project.manage_members,
objective.manage, milestone.manage, epic.manage, sprint.manage, status.manage, field.manage,
task.create, task.edit_any, task.edit_own, task.delete, task.assign, task.move, project.import,
time.log, time.delete_any,
comment.create, comment.edit_own, comment.delete_any, attachment.upload, attachment.delete_any,
report.view
```

Example for Sam (project Member on PRJ):
`["project.view","task.create","task.edit_own","task.assign","task.move","project.import","time.log","comment.create","comment.edit_own","attachment.upload","report.view"]`.

### 3.4 Job-level rules

| Action | Rule |
|---|---|
| Create (I1), list (I9) | `can_import` on the project |
| Read a job, its rows, its report (I3, I5, I8) | `project.import` on the job's project (anyone who may import may see the project's import history) |
| Analyze, save mapping, start / retry (I2, I4, I6) | the job's creator, and `can_import` still holds → else 403 "Only the person who started this import can change it." (`details.permission` absent) |
| Cancel (I7) | the creator, or a holder of `project.update` on the project |
| The runner | re-checks `can_import` for the creator at the start of every batch; lost → job `failed`, code `permission_lost` (§5.6) |

A job id from another workspace or a project the caller isn't on resolves like v1 (404 / 403
`project_membership_required`).

---

## 4. Endpoints

All paths under `/api/v1`. Every view declares `required = {METHOD: code}` as in v1 (`project.import`), plus the
service-level checks of §3.4.

### 4.0 Summary

| # | Method | Path | Permission | Response |
|---|---|---|---|---|
| I1 | POST | `/projects/:id/imports` | `can_import` | 201 `{ job: ImportJob, upload: UploadTicket }` |
| — | PUT | `upload.url` (storage, not the API) | signed URL | 200 |
| I2 | POST | `/imports/:id/analyze` | creator | 200 `ImportJob` (`ready`) |
| I3 | GET | `/imports/:id` | `project.import` | 200 `ImportJob` |
| I4 | PUT | `/imports/:id/mapping` | creator | 200 `ImportJob` |
| I5 | GET | `/imports/:id/rows` | `project.import` | 200 `Paginated<ImportRowPreview>` |
| I6 | POST | `/imports/:id/start` | creator | 202 `ImportJob` (`queued`) |
| I7 | POST | `/imports/:id/cancel` | creator or `project.update` | 200 `ImportJob` |
| I8 | GET | `/imports/:id/error-report` | `project.import` | 200 `{ url, fileName, expiresAt }` |
| I9 | GET | `/projects/:id/imports` | `can_import` | 200 `ImportJobSummary[]` (max 20, newest first) |

Changed responses (additive): every `Project` payload gains `nextTaskNumber: number` (`task_seq + 1`; the picker's
"next key"). `NotificationType` gains `"import"` (§5.8). `AuditEntry.source` gains `"import"`. `ActivityVerb` gains
`"imported"` (§5.9). `GET /permissions` returns `project.import`.

**Upload choice: the existing signed-upload pattern, not multipart.** Reasons: (1) the worker reads the file from
storage, and on Render the web and worker may be different machines, so a multipart body written to the web
container's disk would be invisible to it; (2) it reuses `StorageBackend` (R2 / Local / Fake), `UploadThrottle`,
the R2 CORS rule and the client's XHR upload with progress (`putToSignedUrl` in `src/lib/api/uploads.ts`); (3) 10 MB
bodies never pass through gunicorn's sync workers; (4) `HttpTransport` is JSON-only, so multipart would need a
second transport path. Unlike attachments, there is no separate confirm call: I2 verifies the object.

**Progress: polling, not SSE.** The runner commits progress once per batch (~1 s), so a 1 s poll shows everything
there is. SSE would pin a sync gunicorn worker per open wizard (3 workers per container on the free plan) and needs
an ASGI deployment that doesn't exist yet. When presence brings a shared SSE endpoint, `useImportJob` can switch to
it behind the same hook; the job shape stays the same.

### 4.1 Shapes

```ts
type ImportStatus = "draft" | "ready" | "queued" | "running" | "completed" | "failed" | "canceled";
type ImportField =
  | "title" | "description" | "status" | "assignee" | "priority" | "estimate" | "dueDate" | "labels"   // design
  | "type" | "timeEstimate" | "startDate" | "epic" | "sprint" | "parent" | "sourceId" | "blockedBy" | "blocks"
  | "customField" | "skip";
```

`ImportJob` (full; I3 and every write returns it):

```json
{
  "id": "4b1e0c7a-…",
  "projectId": "5f0e…",
  "source": "csv",
  "preset": "generic",
  "status": "ready",
  "cancelRequested": false,
  "file": {
    "name": "tasks-export.csv", "size": 4210, "encoding": "utf-8", "delimiter": ",",
    "rowCount": 48, "columnCount": 8
  },
  "analysis": { "columns": [ "… §4.3 …" ] },
  "mapping": { "… §4.5 …" },
  "validation": { "… §4.6 …" },
  "progress": null,
  "result": null,
  "error": null,
  "createdById": "u_alex-uuid",
  "createdAt": "2026-10-09T09:12:03Z",
  "startedAt": null,
  "finishedAt": null,
  "expiresAt": "2026-10-10T09:12:03Z"
}
```

`analysis`, `mapping`, `validation` are `null` in `draft`. `progress` is non-null from `queued` on; `result` is
non-null in terminal states after a start; `error` only in `failed`.

`ImportJobSummary` (I9): `{ id, projectId, source, status, fileName, imported, skipped, firstKey, lastKey,
hasErrorReport, createdById, createdAt, startedAt, finishedAt, expiresAt, error }`. Drafts are not listed.

### 4.2 I1 `POST /projects/:id/imports` (create + upload ticket)

Request:

```json
{ "source": "csv", "fileName": "tasks-export.csv", "size": 4210 }
```

Response **201**:

```json
{
  "job": { "id": "4b1e…", "projectId": "5f0e…", "source": "csv", "preset": "generic", "status": "draft",
           "cancelRequested": false,
           "file": { "name": "tasks-export.csv", "size": 4210, "encoding": "", "delimiter": "", "rowCount": 0, "columnCount": 0 },
           "analysis": null, "mapping": null, "validation": null, "progress": null, "result": null, "error": null,
           "createdById": "…", "createdAt": "2026-10-09T09:12:03Z", "startedAt": null, "finishedAt": null,
           "expiresAt": "2026-10-10T09:12:03Z" },
  "upload": {
    "uploadId": "4b1e…",
    "url": "https://<account>.r2.cloudflarestorage.com/<bucket>/ws/…/imports/4b1e…/source.csv?X-Amz-…",
    "method": "PUT",
    "headers": { "Content-Type": "text/csv" },
    "expiresAt": "2026-10-09T09:22:03Z"
  }
}
```

The ticket's `Content-Type` is always `text/csv` (Windows reports `.csv` as `application/vnd.ms-excel`; the
browser's type is ignored). `uploadId` equals the job id. TTL `UPLOAD_URL_TTL_SECONDS` (600 s).

Validation (422, `details.fields`):

| Path | Message |
|---|---|
| `source` | `Pick CSV or Jira` (anything else); `trello` → `Trello import is coming soon` |
| `file` | `Only .csv files` (extension) |
| `file` | `File is too large` (`size` > 10 MB; `details.file = { "reason": "too_large", "size": 13002342 }`) |
| `file` | `File is empty` (`size` ≤ 0 or not an integer) |

403 per §3; 429 throttled (`THROTTLE_IMPORTS`, 20/hour).

### 4.3 I2 `POST /imports/:id/analyze`

No body. Reads the object, detects encoding and delimiter, parses, stores `parsed.json.gz`, computes the analysis,
detects the preset, builds the **suggested mapping** and its validation, sets `status = "ready"`. Synchronous
(bounded by the limits of §1.5; ~1 s for 10 MB). Calling it on a `ready` job returns the job unchanged (idempotent).

Response **200** (sample file of §6.8, abridged to 4 of 8 columns):

```json
{
  "id": "4b1e…", "status": "ready", "preset": "generic",
  "file": { "name": "tasks-export.csv", "size": 4210, "encoding": "utf-8", "delimiter": ",", "rowCount": 48, "columnCount": 8 },
  "analysis": {
    "columns": [
      { "index": 0, "name": "Title", "samples": ["Fix login redirect loop", "Add SSO for admin console", "Board loads slowly with 500 cards"],
        "inferredType": "text", "emptyCount": 2, "distinctCount": 46, "dateOrder": null },
      { "index": 2, "name": "Status", "samples": ["todo", "in progress", "done"],
        "inferredType": "text", "emptyCount": 0, "distinctCount": 5, "dateOrder": null },
      { "index": 6, "name": "Due", "samples": ["2026-10-08", "2026-10-09", "2026-10-10"],
        "inferredType": "date", "emptyCount": 12, "distinctCount": 16, "dateOrder": "ymd" },
      { "index": 7, "name": "Tags", "samples": ["frontend", "backend", "frontend;perf"],
        "inferredType": "list", "emptyCount": 10, "distinctCount": 4, "dateOrder": null }
    ]
  },
  "mapping": {
    "revision": 0,
    "columns": [
      { "field": "title" }, { "field": "description" }, { "field": "status" }, { "field": "assignee" },
      { "field": "priority" }, { "field": "estimate" }, { "field": "dueDate" }, { "field": "labels" }
    ],
    "statuses": {}, "types": {}, "people": {}
  },
  "validation": { "… §4.6 example …" }
}
```

`samples`: up to 3 distinct non-empty values, each ≤ 40 characters (design chips show the first). `inferredType`:
`empty` · `number` · `date` · `duration` · `person` (≥ 80 % emails or member names) · `list` (≥ 30 % of non-empty
cells contain `;` or `, ` separated short tokens) · `text`. `dateOrder`: `ymd` · `mdy` · `dmy` · `jira` · `text`
(month names) for date columns, decided per column (§4.7). Inference only drives suggestions; it never rejects.

Analysis errors: 422 `validation_failed`, `details.fields.file` = the **title**, `details.file` = machine detail the
client turns into the design's meta line. Job stays `draft`.

| `details.file.reason` | Title (`fields.file`) | Meta built by the client |
|---|---|---|
| `upload_missing` | `Couldn’t read file` | `name · The upload didn’t finish. Try again.` |
| `too_large` | `File is too large` | `name · 12.4 MB · max 10 MB` |
| `empty` | `File is empty` | `name` |
| `excel` (ZIP/OLE signature) | `Only .csv files` | `name · Excel workbook · export as CSV first` |
| `binary` (NUL bytes after decoding) | `Not a text file` | `name` |
| `unclosed_quote` (`line`) | `Unclosed quote` | `name · near line 12` |
| `cell_too_long` (`line`) | `A cell is too long` | `name · line 40 · max 64 KB per cell` |
| `no_rows` | `No rows found` | `name` |
| `header_only` | `Header only, no rows` | `name` |
| `too_many_columns` (`columns`) | `Too many columns` | `45 columns · max 40` |
| `too_many_rows` (`rows`) | `Too many rows` | `6,210 rows · max 5,000` |

### 4.4 I3 `GET /imports/:id` (poll)

Returns the job. The client polls it every **1 s** while `status ∈ {queued, running}` and the tab is visible, and
on window focus otherwise (§6.4). Side effect, for recovery only: if the job is `queued`/`running` and its
`heartbeat_at` is older than `IMPORT_LEASE_SECONDS` (120 s) (or it has been `queued` for 30 s with no heartbeat), the
view re-dispatches the runner (§5.1). The lease makes this idempotent; the job's data is not changed by the GET.

Running example:

```json
{
  "id": "4b1e…", "status": "running", "cancelRequested": false,
  "progress": {
    "phase": "rows",
    "total": 48, "processed": 24, "imported": 22, "epics": 0, "skipped": 2, "warnings": 0,
    "recent": [
      { "row": 19, "outcome": "task", "key": "PRJ-77", "title": "Remove legacy v1 endpoints", "reason": null },
      { "row": 20, "outcome": "skipped", "key": null, "title": "Upgrade to Node 22", "reason": "Invalid due date" },
      { "row": 21, "outcome": "task", "key": "PRJ-78", "title": "Attachment virus scan", "reason": null }
    ]
  },
  "result": null, "error": null,
  "startedAt": "2026-10-09T09:15:40Z", "finishedAt": null, "expiresAt": null
}
```

Completed example (`result`):

```json
{
  "id": "4b1e…", "status": "completed",
  "progress": { "phase": "finishing", "total": 48, "processed": 48, "imported": 44, "epics": 0, "skipped": 4, "warnings": 0, "recent": [] },
  "result": {
    "imported": 44, "epics": 0, "skipped": 4, "warnings": 0,
    "firstKey": "PRJ-61", "lastKey": "PRJ-104",
    "created": { "labels": 1, "epics": 0, "options": 0 },
    "hasErrorReport": true,
    "issueCount": 4,
    "issues": [
      { "row": 8,  "severity": "skip", "field": "title",    "reason": "Missing title",            "value": "" },
      { "row": 20, "severity": "skip", "field": "dueDate",  "reason": "Invalid due date",         "value": "next week" },
      { "row": 27, "severity": "skip", "field": "estimate", "reason": "Estimate is not a number", "value": "XL" },
      { "row": 42, "severity": "skip", "field": "title",    "reason": "Missing title",            "value": "" }
    ]
  },
  "error": null,
  "finishedAt": "2026-10-09T09:15:43Z", "expiresAt": "2026-11-08T09:15:43Z"
}
```

`result.issues` holds the first 50 issues (skips first, then warnings, each by row); `issueCount` is the total.

Failed example: `"status": "failed"`, `"error": { "code": "permission_lost", "message": "You no longer have permission to import into PRJ. 120 tasks were imported before it stopped." }`.

### 4.5 I4 `PUT /imports/:id/mapping`

The **whole** mapping (not a merge). Request:

```json
{
  "revision": 3,
  "columns": [
    { "field": "title" },
    { "field": "description" },
    { "field": "status" },
    { "field": "assignee" },
    { "field": "priority" },
    { "field": "estimate" },
    { "field": "dueDate" },
    { "field": "labels" }
  ],
  "statuses": { "blocked": "st_todo-uuid" },
  "types": {},
  "people": { "chris ortiz": null }
}
```

- `columns`: exactly `column_count` items, by column index. Items: `{ "field": ImportField }`, plus
  `"customFieldId"` when `field = "customField"`, plus optional `"unit": "minutes" | "hours" | "seconds"` when
  `field = "timeEstimate"` (bare numbers; default `hours`, `jira` preset `seconds` for `Original Estimate` /
  `Remaining Estimate`).
- `statuses`, `types`, `people`: value maps keyed by the value **key** (`ImportValue.key`: trimmed, lower-cased,
  inner whitespace collapsed). A present key is the user's explicit choice (`null` = "Choose…" for statuses/types,
  "Leave unassigned" for people). An absent key gets the server's suggestion (`auto: true`). Keys that no longer occur
  (another column was mapped) are dropped from the stored mapping.
- `revision`: the client increments it per PUT. A revision ≤ the stored one → 409 `mapping_conflict` with
  `details.current` = the job (two tabs); the client adopts it.

**Field targets** (select labels in design order; `auto` = suggested from the header, §4.7):

| `field` | Label | Multi-column | Notes |
|---|---|---|---|
| `title` | Title * | no | required |
| `description` | Description | no | |
| `status` | Status | no | value map `statuses` |
| `assignee` | Assignee | no | value map `people`; first value when a cell lists several (`,` `;`) |
| `priority` | Priority | no | fixed synonyms (§4.7) |
| `estimate` | Estimate | no | story points |
| `dueDate` | Due date | no | |
| `labels` | Labels | **yes** (Jira repeats `Labels`) | split on `;` and `,` |
| `type` | Type | no | value map `types` |
| `timeEstimate` | Time estimate | no | board 39 `timeEstimateMinutes` |
| `startDate` | Start date | no | board 32 `startDate`; on epic rows → `Epic.startDate` |
| `epic` | Epic | no | epic name, or a reference to an epic row's ID |
| `sprint` | Sprint | no | sprint name; repeated Jira `Sprint` columns → map one |
| `parent` | Parent | no | reference: an ID in this file, or an existing task key in the project (`PRJ-12`) |
| `sourceId` | ID (for links) | **yes** (`Issue key` + `Issue id`) | identities used by Parent / Blocked by / Blocks; not stored on tasks |
| `blockedBy` | Blocked by | **yes** | references, split on `,` `;` whitespace → board 39 dependencies |
| `blocks` | Blocks | **yes** | same, other direction |
| `customField` + `customFieldId` | the field's name (group "Custom fields") | no per field id | board 39 value rules |
| `skip` | Don’t import | yes | |

The "More fields" group (Type … Blocks) and "Custom fields" group follow the design's eight. A custom field whose id
doesn't belong to the project → 422 `columns.4.customFieldId: "This field was deleted"`.

Response **200**: the job, with `mapping` normalised (all auto choices written in, `revision` stored) and a fresh
`validation`. Other 422 messages: `columns: "Send one entry per column"`, `columns.N.field: "Pick a field"`,
`statuses.<key>: "Pick a status from this project"`, `types.<key>: "Pick feature, bug, chore, spike or epic"`,
`types.<key>: "You can’t create epics in this project"` (epic without `epic.manage`),
`people.<key>: "Pick someone on this project"`, `people.<key>: "You can only assign tasks to yourself"` (another
member without `task.assign`). 409 `import_state` outside `ready`.

### 4.6 Validation (`ImportJob.validation`, recomputed by I2 and I4)

```json
{
  "ready": false,
  "blockers": [
    { "code": "status_unmapped", "message": "Map 1 more status", "field": "status" }
  ],
  "values": {
    "statuses": [
      { "key": "todo",        "value": "todo",        "count": 14, "target": "st_todo-uuid",     "auto": true },
      { "key": "in progress", "value": "in progress", "count": 14, "target": "st_progress-uuid", "auto": true },
      { "key": "done",        "value": "done",        "count": 7,  "target": "st_done-uuid",     "auto": true },
      { "key": "review",      "value": "review",      "count": 7,  "target": "st_review-uuid",   "auto": true },
      { "key": "blocked",     "value": "blocked",     "count": 6,  "target": null,               "auto": false }
    ],
    "types": [],
    "people": [
      { "key": "alex kim",    "value": "Alex Kim",    "count": 10, "target": "u_alex-uuid",  "auto": true, "matchedBy": "name" },
      { "key": "riley chen",  "value": "Riley Chen",  "count": 10, "target": "u_riley-uuid", "auto": true, "matchedBy": "name" },
      { "key": "sam patel",   "value": "Sam Patel",   "count": 10, "target": "u_sam-uuid",   "auto": true, "matchedBy": "name" },
      { "key": "chris ortiz", "value": "Chris Ortiz", "count": 9,  "target": null,           "auto": false, "matchedBy": null }
    ]
  },
  "counts": { "rows": 48, "tasks": 44, "epics": 0, "skipped": 4, "warnings": 0, "statuses": 5, "people": 3 },
  "skipReasons": [
    { "reason": "Missing title", "count": 2 },
    { "reason": "Invalid due date", "count": 1 },
    { "reason": "Estimate is not a number", "count": 1 }
  ],
  "creates": { "labels": ["api"], "epics": [], "options": [] },
  "keyRange": { "first": "PRJ-61", "last": "PRJ-104" }
}
```

- `values.*.value` is the first-seen spelling; `count` counts rows; lists are ordered by first appearance (design).
  `people` merges values from the Assignee column and every Person custom-field column.
- `counts.people` = people values mapped to someone (design "People" tile). `counts.tasks` excludes skipped rows and
  epic rows. `keyRange` is an estimate from the current `task_seq` (`null` when `tasks = 0`).
- `creates.labels` = label names not in the project (lower-cased, cut to 24 like v1). `creates.epics` = epic rows plus
  unknown epic names (only listed when the importer has `epic.manage`; otherwise those become warnings).
  `creates.options` = `[{ "customFieldId": "…", "names": ["Arc"] }]` (only with `field.manage`).

**Blockers** (in this order; the footer shows the first one; `start` refuses while any exists):

| `code` | Message (design copy first) |
|---|---|
| `title_unmapped` | `Map a column to Title` |
| `duplicate_field` | `Two columns map to Status` (the first single-column field mapped twice, by label) |
| `status_unmapped` | `Map 1 more status` / `Map 3 more statuses` |
| `type_unmapped` | `Map 1 more type` / `Map 2 more types` |
| `too_many_values` | `Too many statuses (52 · max 50)` · `Too many types (… · max 20)` · `Too many people (… · max 200)` |
| `too_many_creates` | `Too many new labels (130 · max 100)` · `Too many new epics (… · max 50)` |
| `nothing_to_import` | `No rows can be imported` (`counts.tasks + counts.epics = 0`) |

**Row issues.** Principle: **a value that can't be read skips the row** (nothing is imported half-read; the user fixes
the file and re-imports the report's rows), **a reference that can't be resolved imports the row without it** and adds
a warning.

| Severity | `field` | `reason` (exact copy) | When |
|---|---|---|---|
| skip | `title` | `Missing title` | empty after trimming (design) |
| skip | `title` | `Title over 200 characters` (`value` = first 40 chars + `…`) | design |
| skip | `title` | `Epic name over 80 characters` | epic rows |
| skip | `dueDate` | `Invalid due date` | design |
| skip | `startDate` | `Invalid start date` | |
| skip | `startDate` | `Start date after due date` | board 32 order rule |
| skip | `estimate` | `Estimate is not a number` | design |
| skip | `estimate` | `Estimate over 99 points` | v1 range |
| skip | `timeEstimate` | `Time estimate is not a duration` / `Time estimate over 1000 hours` | board 39 range |
| skip | `description` | `Description over 20,000 characters` | rich-text limit |
| skip | `customField` | `<Field>: up to 120 characters` · `<Field>: enter a number from 0 to 1,000,000,000` · `<Field>: invalid date` | board 39 value rules |
| warning | `sprint` | `No sprint named “Sprint 99” · added to the backlog` | |
| warning | `epic` | `No epic named “Growth” · left without an epic` | unknown name, no `epic.manage` |
| warning | `parent` | `Parent “WEB-77” not found · imported as a top-level task` | |
| warning | `parent` | `Parent is a sub-task · imported as a top-level task` | v1 one-level rule |
| warning | `blockedBy`/`blocks` | `“WEB-9” not found · dependency skipped` · `Would create a loop · dependency skipped` · `Dependency limit reached` | board 39 rules |
| warning | `customField` | `<Field>: no option “Arc” · left empty` | no `field.manage` or 50 options |
| warning | `labels` | `More than 20 labels · extra labels dropped` | |
| warning | `startDate` | `Epic dates need both start and target · dates left empty` | board 32 epic rule |
| warning | `status` | `Status “QA” was deleted · used Todo` | status deleted between start and run (§5.6) |

People that map to "Leave unassigned" are **not** warnings (it was the user's choice).

### 4.7 Matching and conversion rules (server; the mock mirrors them with shared vectors, §8)

**Header → field** (normalise: lower-case, strip a Jira `custom field (…)` wrapper, `’'` removed, non-alphanumerics →
space, trim). First column wins for single-column fields (design `used`); multi-column fields take every match.

| Field | Synonyms |
|---|---|
| title | title, summary, name, card name, task, task name, subject, issue |
| description | description, desc, details, body, notes |
| status | status, list, state, column, stage, section, section column |
| assignee | assignee, assignee email, members, member, owner, assigned to, assigned |
| priority | priority, prio, severity |
| estimate | estimate, story points, story point estimate, points, sp, estimation, effort |
| timeEstimate | original estimate, time estimate, estimated time, time estimate h |
| startDate | start, start date, starts |
| dueDate | due, due date, deadline, due on, target date |
| labels | labels, tags, label, tag |
| type | type, issue type, task type, kind |
| epic | epic, epic link, epic name |
| sprint | sprint, cycle, cycle name, iteration |
| parent | parent, parent id, parent issue, parent task, parent key |
| sourceId | id, key, issue key, issue id, task id, card id |
| blockedBy | blocked by, depends on, inward issue link blocks |
| blocks | blocks, outward issue link blocks |
| customField | the header equals a project custom field's name (same normalisation) |

When an Asana export has both `Assignee` and `Assignee Email`, the email column wins and the name column is `skip`.

**Presets** (detected from headers; the first that matches wins):

| Preset | Signature | Extras |
|---|---|---|
| `jira` | `Issue key` and `Summary` and `Issue Type` | dates `dd/Mon/yy h:mm AM`; `Original Estimate` unit `seconds`; priorities Highest/High/Medium/Low/Lowest |
| `linear` | `ID` and `Title` and (`Cycle Name` or `Team`) | `Parent issue` → parent; `Cycle Name` → sprint |
| `asana` | `Task ID` and `Name` and `Section/Column` | `Section/Column` → status; `Parent task` → parent; `Notes` → description |
| `generic` | otherwise | |

**Statuses** (value → project status): (1) exact name match ignoring case and spaces (`to do` = `Todo`); (2) synonym →
glyph (design `autoStatus`: backlog, icebox → backlog; todo, open, new, to do → todo; doing, in progress, started, wip
→ progress; review, in review, qa → review; done, closed, complete, completed, resolved → done; won’t do, wont do,
canceled, cancelled → canceled) → the first project status with that glyph by position; (3) otherwise unmapped. An
empty cell uses the project's default status (v1 `_default_status`) and needs no mapping.

**Types**: story, task, feature, new feature, improvement, sub-task, subtask → `feature`; bug, defect, incident →
`bug`; chore, maintenance, tech debt → `chore`; spike, research, investigation → `spike`; epic → `epic` (only offered
with `epic.manage`; otherwise unmapped). Other values are unmapped (`types` map). Empty → `feature`.

**People** (value → project member): split the cell on `,` `;` and take the first value (design); (1) an email equal
to a member's email (case-insensitive) → `matchedBy: "email"`; (2) the normalised full name equal to a member's name →
`"name"`; (3) design's fuzzy rule after replacing `.` `_` with spaces: same first name **and** the second token's
initial equals the member's last-name initial (`Sam P.`, `jordan.lee`), **only if exactly one member matches** →
`"initial"`; (4) otherwise `null` (Leave unassigned). Only project members are candidates. Nobody is invited (§10 #7).
The importer without `task.assign` gets every suggestion except themself set to `null`.

**Priority** (no value map; unknown → 0 "No priority", no issue, design `—`): urgent, highest, critical, blocker, p0
→ 4; high, p1 → 3; medium, normal, p2 → 2; low, lowest, minor, trivial, p3, p4 → 1; none, no priority, empty → 0.

**Dates** (cell trimmed; a time part is ignored; no timezone conversion):

| Pattern | Example |
|---|---|
| ISO date / datetime | `2026-10-14`, `2026-10-14T18:00:00Z`, `2026/10/14` |
| Numeric with slashes or dots, order per column (`mdy` unless some value's first part is > 12 → `dmy`; dots → `dmy`) | `10/14/2026`, `14/10/2026`, `14.10.2026`, 2-digit years → 20yy |
| Jira | `14/Oct/26 6:00 PM` |
| English month names | `Oct 14, 2026`, `14 Oct 2026`, `October 14, 2026` |

Anything else (`next week`, `ASAP`, Excel serials) is invalid. Impossible dates (`2026-02-30`) are invalid.

**Numbers** (estimate, number custom fields): `1240`, `1,240`, `1 240`, `12.5`; with `;` as the file delimiter, `12,5`
is 12.5. Estimates round half up to an integer (v1 `_estimate`).

**Durations** (time estimate): board 39 §6.6 grammar (`1h 30m`, `90m`, `1.5h`, `1:30`, `2 hours 5 mins`); a bare
number uses the column's `unit`. Result 1–60,000 minutes; `0` or empty → no estimate.

**Text**: C0 control characters except tab and newline are removed from every value. Description: plain text → Tiptap
doc (blank line = new paragraph, single newline = `hardBreak`), then `sanitize_doc()`. No Markdown, HTML or Jira wiki
markup is interpreted. Labels: v1 rules (trimmed, lower-cased, cut to 24 chars), up to 20 per task, de-duplicated.

**References** (parent, blockedBy, blocks, epic-as-reference): a value is matched, case-insensitively, against (1) the
`sourceId` identities of the rows in this file, then (2) for parent/blockedBy/blocks only, an existing task key in the
target project (`PRJ-12`). For `epic`, a value that matches an **epic row** links to that epic; otherwise it's an
epic **name** matched against the project's epics (case-insensitive), else created (with `epic.manage`) or a warning.
A parent that is an epic row → the task's `epic` (Jira classic: sub-items of an epic); a parent that is a task row →
sub-task. Sub-tasks inherit their parent's sprint, and its epic when they have none (v1 rules).

### 4.8 I5 `GET /imports/:id/rows`

Query: `filter[outcome]=all|task|epic|skipped|warning` (default `all`), `limit` (1–100, default 20), `cursor`.

- Before start (`ready`): a **dry run** of the current mapping over the parsed rows (no writes). `key` is the
  predicted key.
- After start: read from `ImportRow` (actual outcomes and keys) for processed rows.

Response:

```json
{
  "data": [
    { "row": 2, "outcome": "task", "key": "PRJ-61", "issues": [],
      "values": { "title": "Fix login redirect loop", "type": "feature", "statusId": "st_todo-uuid", "assigneeId": "u_alex-uuid",
                  "priority": 3, "estimate": 3, "timeEstimateMinutes": null, "startDate": null, "dueDate": "2026-10-08",
                  "labels": ["frontend"], "epic": null, "sprintId": null, "parent": null, "customFields": {} } },
    { "row": 8, "outcome": "skipped", "key": null,
      "issues": [{ "severity": "skip", "field": "title", "reason": "Missing title", "value": "" }],
      "values": { "title": "", "type": "feature", "statusId": null, "assigneeId": "u_riley-uuid", "priority": 3, "estimate": 3,
                  "timeEstimateMinutes": null, "startDate": null, "dueDate": "2026-10-14", "labels": ["backend"],
                  "epic": null, "sprintId": null, "parent": null, "customFields": {} } }
  ],
  "nextCursor": "eyJyb3ciOjZ9"
}
```

`values.statusId` is `null` when the row's status value is unmapped (the preview shows "Unmapped"). `epic` is
`{ "name": "Checkout redesign", "new": true } | { "id": "…", "name": "…" } | null`; `parent` is
`{ "ref": "WEB-2", "row": 3 } | { "ref": "PRJ-12", "taskId": "…" } | null`.

### 4.9 I6 `POST /imports/:id/start`

No body. In `ready` (or `failed`, as a retry): re-validates (blockers → 422 `validation_failed`,
`details.fields.mapping` = the first blocker's message, `details.blockers` = the list), re-checks permissions,
sets `queued`, `request_id`, `progress`, `expires_at = null` until finished, and dispatches the runner on commit
(§5.1). Returns **202** with the job. Calling it again on a `queued`/`running` job returns 202 with the job
(idempotent, no second runner).

409 `import_in_progress` "Another import is running in this project. Try again when it finishes." with
`details.jobId` (partial unique constraint). 409 `import_state` on `completed`/`canceled`.

### 4.10 I7 `POST /imports/:id/cancel`

| From | Effect | Response |
|---|---|---|
| `draft`, `ready` | `canceled`; storage objects deleted now; row purged by retention | 200 job |
| `queued` | `canceled` (the runner exits on its lease check) | 200 job |
| `running` | `cancel_requested = true`; the runner stops after the current batch, then finishes as `canceled` with a report of what was processed | 200 job (still `running`, `cancelRequested: true`) |
| `failed` | `canceled` (gives up the retry) | 200 job |
| `completed`, `canceled` | — | 409 `import_state` |

### 4.11 I8 `GET /imports/:id/error-report`

```json
{ "url": "https://…/report.csv?X-Amz-…", "fileName": "import-errors-prj-2026-10-09.csv", "expiresAt": "2026-10-09T09:16:43Z" }
```

A 60-second presigned GET (`content_type="text/csv; charset=utf-8"`, `inline=False`, so `Content-Disposition:
attachment`). File name `import-errors-<project key lower-case>-<finish date UTC>.csv`. 404 `not_found` "This import
has no error report." when the job isn't terminal or had no issues. The client opens the URL in a hidden link (no
token is ever put in a URL; the signature is the storage's).

### 4.12 I9 `GET /projects/:id/imports`

Plain array of `ImportJobSummary`, newest first, max 20, excluding `draft`. Example:

```json
[
  { "id": "4b1e…", "projectId": "5f0e…", "source": "csv", "status": "completed", "fileName": "tasks-export.csv",
    "imported": 44, "skipped": 4, "firstKey": "PRJ-61", "lastKey": "PRJ-104", "hasErrorReport": true,
    "createdById": "u_alex-uuid", "createdAt": "2026-10-09T09:12:03Z", "startedAt": "2026-10-09T09:15:40Z",
    "finishedAt": "2026-10-09T09:15:43Z", "expiresAt": "2026-11-08T09:15:43Z", "error": null }
]
```

---

## 5. Execution

### 5.1 Dispatch, lease, recovery

- `imports.services.dispatch(job_id)` runs in `transaction.on_commit` after I6 (and after a recovery):
  - with a broker (`CELERY_TASK_ALWAYS_EAGER` false): `apps.imports.tasks.run_import.delay(job_id)`;
  - without one (Render free plan, compose without the worker profile): a **daemon thread** in the web process
    (`threading.Thread(target=run_import_safely, daemon=True)`), which closes its DB connection when done. Running it
    eagerly inside the request would block the start request for the whole import and hit gunicorn's 30 s timeout.
  - tests: `IMPORT_RUNNER = "inline"` runs it synchronously.
- `run_import` (Celery: `acks_late=True`, `autoretry_for=(OperationalError, InterfaceError)`, `max_retries=3`,
  exponential backoff) first takes the **lease**:
  `UPDATE importjob SET lease_token=:new, heartbeat_at=now(), status='running', started_at=COALESCE(started_at, now())
  WHERE id=:id AND status IN ('queued','running')
  AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '120 s')`. Zero rows → another runner owns the job, or
  it is finished or canceled → exit. Duplicate deliveries and re-dispatches are therefore harmless. A job that is
  `running` with `cancel_requested` goes straight to the cancel path of §5.6.
- Every batch transaction re-reads the job `FOR UPDATE` and aborts if `lease_token` changed (lost lease).
- Recovery: the I3 poll (§4.4) and `manage.py resume_imports` (optional cron, every minute) re-dispatch jobs whose
  heartbeat is stale. Work resumes at `phase` / `cursor`.

### 5.2 Phases

| Phase | Work | Transaction |
|---|---|---|
| (I2, before start) parse | decode (§7.2), sniff (§7.3), parse with Python `csv` (`strict=True`, `field_size_limit(65536)`), pad/cut each row to the header width, write `parsed.json.gz` | — |
| `preparing` | load parsed rows, mapping and lookups (statuses, members, labels, epics, sprints, custom fields + options); **plan** every row in memory (§4.6, §4.7): outcome, converted values, references resolved to row numbers or existing ids; then create missing **labels**, **epics** (epic rows and new epic names) and **select options**, get-or-create by case-insensitive name, ids saved in `job.setup`; reserve task numbers | one transaction; the project row is locked only for the reservation |
| `rows` | batches of `IMPORT_BATCH_SIZE` (200) rows from `cursor` (§5.3) | one transaction per batch |
| `links` | set `parent_id` of sub-tasks and create dependencies (§5.5) | batches of 500, one transaction each, idempotent |
| `finishing` | build and upload the report, set counters/keys, `completed` (or `canceled`), audit summary, domain event | one transaction (report uploaded first) |

Planning is deterministic for a given file + mapping + project state, so a restart re-plans and continues at
`cursor`.

### 5.3 A rows batch

Inside `transaction.atomic()`:

1. `SELECT … FOR UPDATE` the job; check the lease, `cancel_requested` (→ jump to finishing as `canceled`), the
   project (archived or deleted → `failed`, `project_unavailable`) and `can_import(creator)` (→ `failed`,
   `permission_lost`).
2. For the batch's planned rows: build `Task` objects with
   - `number = number_base + job.imported + i` (i = position among this batch's task rows), `key = f"{project.key}-{number}"`;
   - `reporter = creator`, `created_at = now`, `version = 1`;
   - `status` from the map (a status deleted since start → default status + warning), `apply_status()` so done
     statuses set `completed_at` (v1);
   - `sprint` = the mapped sprint or **`None` (backlog)**, unlike v1 `create_task`, which joins the active sprint;
     sub-tasks get the parent row's sprint;
   - `position`: per status, the first key after `last_position(project, status)` (read once per status per batch),
     then successive fractional keys, so file order is kept within each column;
   - `assignee` (a member removed since start → unassigned + warning), priority, type, estimate,
     `time_estimate_minutes`, `start_date`, `due_date`, `epic`, description.
3. `bulk_create` tasks; then `TaskStatusHistory` (v1 `initial_history` rows), `TaskLabel`, `TaskFieldValue`
   (board 39), `SprintScopeChange` for tasks placed in an **active** sprint (v1 `_track_scope`), each with one
   `bulk_create`.
4. Search vectors: one `UPDATE` per task with v1's `refresh_search_vector` expression (200 per batch).
5. `ImportRow` rows for every processed row of the batch (`bulk_create`; the unique `(job, row)` constraint guards the
   lease).
6. Audit rows for the batch with one `bulk_create` (§5.9).
7. Update counters, `cursor`, `recent` (last 10 lines), `heartbeat_at`; save the job.

Commit. Epic rows were created in `preparing`; in the rows phase they only get their `ImportRow` (`outcome = "epic"`).

**No per-task domain events.** Import does not emit `task_assigned` or mention events for each task (descriptions are
plain text, so there are no mentions anyway); the only event is `import_finished` (§5.8, §10 #4).

### 5.4 Idempotency and numbering

- Numbers: `preparing` locks the project row once and does `number_base = task_seq + 1; task_seq += planned_tasks`.
  Keys of one import are contiguous; tasks created by hand meanwhile get numbers after the block. Rows that turn out
  skipped at run time (only status/member changes can cause warnings, never new skips) leave unused numbers at the end
  of the block (a gap; keys stay unique).
- A batch and its `cursor` commit together, so a retry never re-inserts a row. The lease prevents two runners.
  `preparing` uses get-or-create and records ids in `job.setup` with a `setup.done` flag. `links` uses
  `bulk_create(ignore_conflicts=True)` on the board 39 unique constraint and sets parents with idempotent `UPDATE`s.
  `finishing` only runs `WHERE status = 'running'`.

### 5.5 Links phase (parents, dependencies)

- **Parents**: for each `ImportRow` whose plan has a parent task, `UPDATE task SET parent_id = :p` (and the inherited
  sprint/epic were already set at insert). Parents that are sub-tasks themselves were already turned into warnings in
  planning.
- **Dependencies** (board 39 `TaskDependency`): resolve both ends (imported task ids from `ImportRow`, or existing
  tasks by key), same project only, not self, not parent/sub-task of each other, max 50 per task per direction, and the
  **cycle check** on an in-memory graph seeded with the project's live dependency rows (same BFS as board 39); a
  rejected edge is a warning on the row that declared it. The phase takes the project row lock (board 39 rule 7) per
  batch. Dependencies don't bump `version` (board 39 §5.1).

### 5.6 Cancel, failure, retry

| Event | Result |
|---|---|
| Cancel while running | after the current batch: `links` runs for the rows already imported (so sub-tasks and dependencies among them are kept), then `finishing` with status `canceled`; report covers processed rows |
| DB error | Celery retries (3×, backoff); the thread runner retries the batch twice, 2 s apart; then `failed`, `import_failed` "Something went wrong after 120 tasks. They were kept. Retry to import the rest." |
| Project archived or deleted | `failed`, `project_unavailable` "The project was archived during the import. 120 tasks were imported." |
| Creator lost `project.import`/`task.create` | `failed`, `permission_lost` (§4.4 example) |
| Storage object missing at run time | `failed`, `file_missing` "The uploaded file is gone. Start a new import." (not retryable) |
| Retry (`start` on `failed`) | `queued`, resumes at `phase`/`cursor` with the same mapping; numbers continue from `number_base + imported` |

### 5.7 Error report (`report.csv`)

UTF-8 **with BOM**, CRLF, every field quoted, formula-safe (§7.1). Columns: `Row`, `Outcome` (`Skipped` / `Imported
with changes`), `Reason`, `Value`, then **every original column** with the file's header names, so a user can fix the
skipped rows and import the report itself (Lightex ignores the first four columns by mapping them to Don’t import —
they are suggested as `skip`). One line per issue (a row with two warnings has two lines). Skips first, then warnings,
each by row.

### 5.8 Notification

At the end of `finishing` (completed, canceled after start, or failed) the service emits
`emit("import_finished", workspace=…, project=…, actor=None, payload={"jobId": …})`. Handler `on_import_finished`
delivers **one in-app notification to the job's creator** (bypassing `_recipients`, which drops the actor; still
requires an active project member):

| Field | Value |
|---|---|
| `type` | `"import"` (new; added to `Notification.TYPES` and the frontend `NotificationType`) |
| `actorId` | `null` (system row, like "Due tomorrow") |
| `taskId` | `null` |
| `payload` | `{ "importId": "4b1e…", "projectKey": "PRJ", "imported": 44, "skipped": 4, "importStatus": "completed" \| "canceled" \| "failed" }` |

No preference row (always on, like `access`) and no email (no designed template). Inbox text: "Import finished ·
44 tasks added to PRJ · 4 skipped" / "Import stopped · 120 tasks added to PRJ" / "Import failed · 120 tasks added to
PRJ". The row links to `/[ws]/projects/PRJ/board?import=<importId>`.

### 5.9 Audit and activity

| Action | Rows | `target` | `changes` / `data` | `source` |
|---|---|---|---|---|
| `project.import_started` | 1 (ws, project) | file name | `data: { importId, fileName, source, preset, rows }` | `import` |
| `task.imported` | 1 per task (ws, project, task) | task title | `changes: [change("Title", null, title, "text"), change("Status", null, glyph, "status")]`, `data: { importId, row, fileName }` | `import` |
| `label.created`, `epic.created`, `project.custom_field_updated` (options) | v1/board 39 shapes, one per created object | | | `import` |
| `project.import_completed` | 1 (ws, project) | file name | `data: { importId, fileName, source, status, imported, epics, skipped, warnings, firstKey, lastKey }` | `import` |

All rows of a job carry the start request's `request_id` and the creator as actor. Batch rows go through a new
`audit.services.record_many(rows)` (same scrubbing as `record`, one `bulk_create`).

Activity (`audit.selectors.ACTIVITY_VERBS` + frontend `ActivityVerb`): `task.imported` → `imported` and
`project.import_completed` → `imported`. **`activity()` (project and workspace feeds) excludes `task.imported`**, so a
5,000-row import shows as one entry; `task_activity()` keeps it, so each task's own feed starts with it.

| Feed | Text (`activity-text.ts`) |
|---|---|
| project/workspace (`project.import_completed`) | "imported 44 tasks from tasks-export.csv" (`data.imported`, `data.fileName`; "imported 1 task") |
| task (`task.imported`) | "imported this task from tasks-export.csv" |

`auditActionKind`: `task.imported` → "created"; `project.import_*` → "updated". `AuditEntry.source` gains `"import"`.

### 5.10 What imported data looks like

- Tasks: normal tasks (version 1, reporter = importer, created now), indistinguishable from hand-made ones apart from
  their audit trail. No source id is stored on the task (the v1 `ExternalLink` reserve is for GitHub/GitLab).
- Done-category tasks get `completed_at = now`, so throughput/velocity count them today (§10 #5).
- Search, board, list, backlog, saved-view counts and reports see them on the next fetch.

---

## 6. Frontend

Lift the ban first: remove "import" from the "No v2 features" bullet in `frontend/CLAUDE.md`; add every endpoint and
field of §4 to "Requested API additions" in `frontend/docs/final-report.md` and replace §3 item 5 / §7 row 40 (paper
trail rule). No new npm dependency (the parser lives in the mock; the live client never parses CSV).

### 6.1 `src/lib/api/types.ts`

```ts
/* PROJECT_PERMISSIONS becomes the exact §3.3 list (adds "project.import" after "task.move"). */
/* Project gains: nextTaskNumber: number. */
/* NotificationType gains "import"; Notification.payload gains importId?, imported?, skipped?, importStatus?. */
/* ActivityVerb gains "imported". AuditEntry.source becomes "web" | "api" | "import". */

/* ── Import (board 40) ── */
export type ImportSource = "csv" | "jira";
export type ImportPreset = "generic" | "jira" | "linear" | "asana";
export type ImportStatus = "draft" | "ready" | "queued" | "running" | "completed" | "failed" | "canceled";
export type ImportField =
  | "title" | "description" | "status" | "assignee" | "priority" | "estimate" | "dueDate" | "labels"
  | "type" | "timeEstimate" | "startDate" | "epic" | "sprint" | "parent" | "sourceId" | "blockedBy" | "blocks"
  | "customField" | "skip";
export type ImportTaskType = TaskType | "epic";
export type ImportColumnType = "empty" | "text" | "number" | "date" | "duration" | "list" | "person";

export interface ImportFileInfo {
  name: string; size: number; encoding: "" | "utf-8" | "utf-16" | "windows-1252";
  delimiter: "" | "," | ";" | "\t" | "|"; rowCount: number; columnCount: number;
}
export interface ImportColumn {
  index: number; name: string; samples: string[]; inferredType: ImportColumnType;
  emptyCount: number; distinctCount: number; dateOrder: "ymd" | "mdy" | "dmy" | "jira" | "text" | null;
}
export interface ImportColumnMapping { field: ImportField; customFieldId?: ID; unit?: "minutes" | "hours" | "seconds" }
export interface ImportMapping {
  revision: number;
  columns: ImportColumnMapping[];
  statuses: Record<string, ID | null>;
  types: Record<string, ImportTaskType | null>;
  people: Record<string, ID | null>;
}
export interface ImportValue {
  key: string; value: string; count: number; target: string | null; auto: boolean;
  matchedBy?: "email" | "name" | "initial" | null;
}
export type ImportBlockerCode =
  | "title_unmapped" | "duplicate_field" | "status_unmapped" | "type_unmapped"
  | "too_many_values" | "too_many_creates" | "nothing_to_import";
export interface ImportValidation {
  ready: boolean;
  blockers: { code: ImportBlockerCode; message: string; field?: ImportField }[];
  values: { statuses: ImportValue[]; types: ImportValue[]; people: ImportValue[] };
  counts: { rows: number; tasks: number; epics: number; skipped: number; warnings: number; statuses: number; people: number };
  skipReasons: { reason: string; count: number }[];
  creates: { labels: string[]; epics: string[]; options: { customFieldId: ID; names: string[] }[] };
  keyRange: { first: string; last: string } | null;
}
export interface ImportIssue { severity: "skip" | "warning"; field: ImportField | null; reason: string; value: string }
export type ImportOutcome = "task" | "epic" | "skipped";
export interface ImportRowPreview {
  row: number; outcome: ImportOutcome; key: string | null; issues: ImportIssue[];
  values: {
    title: string; type: ImportTaskType; statusId: ID | null; assigneeId: ID | null; priority: Priority;
    estimate: number | null; timeEstimateMinutes: number | null; startDate: ISODate | null; dueDate: ISODate | null;
    labels: string[]; epic: { id?: ID; name: string; new?: boolean } | null; sprintId: ID | null;
    parent: { ref: string; row?: number; taskId?: ID } | null; customFields: Record<ID, CustomFieldValue>;
  };
}
export interface ImportLogLine { row: number; outcome: ImportOutcome; key: string | null; title: string; reason: string | null }
export interface ImportProgress {
  phase: "preparing" | "rows" | "links" | "finishing";
  total: number; processed: number; imported: number; epics: number; skipped: number; warnings: number;
  recent: ImportLogLine[];
}
export interface ImportResult {
  imported: number; epics: number; skipped: number; warnings: number;
  firstKey: string | null; lastKey: string | null;
  created: { labels: number; epics: number; options: number };
  hasErrorReport: boolean; issueCount: number; issues: (ImportIssue & { row: number })[];
}
export interface ImportJob {
  id: ID; projectId: ID; source: ImportSource; preset: ImportPreset; status: ImportStatus; cancelRequested: boolean;
  file: ImportFileInfo; analysis: { columns: ImportColumn[] } | null; mapping: ImportMapping | null;
  validation: ImportValidation | null; progress: ImportProgress | null; result: ImportResult | null;
  error: { code: string; message: string } | null;
  createdById: ID | null; createdAt: ISODateTime; startedAt: ISODateTime | null; finishedAt: ISODateTime | null;
  expiresAt: ISODateTime | null;
}
export interface ImportJobSummary {
  id: ID; projectId: ID; source: ImportSource; status: ImportStatus; fileName: string;
  imported: number; skipped: number; firstKey: string | null; lastKey: string | null; hasErrorReport: boolean;
  createdById: ID | null; createdAt: ISODateTime; startedAt: ISODateTime | null; finishedAt: ISODateTime | null;
  expiresAt: ISODateTime | null; error: { code: string; message: string } | null;
}
```

### 6.2 `src/lib/api/endpoints.ts`

```ts
export const imports = {
  list: (projectId: string) => http.get<ImportJobSummary[]>(`/projects/${enc(projectId)}/imports`),
  create: (projectId: string, body: { source: ImportSource; fileName: string; size: number }) =>
    http.post<{ job: ImportJob; upload: UploadTicket }>(`/projects/${enc(projectId)}/imports`, body),
  get: (id: string) => http.get<ImportJob>(`/imports/${enc(id)}`),
  analyze: (id: string) => http.post<ImportJob>(`/imports/${enc(id)}/analyze`),
  saveMapping: (id: string, mapping: ImportMapping) => http.put<ImportJob>(`/imports/${enc(id)}/mapping`, mapping),
  rows: (id: string, query?: ListQuery) => http.get<Paginated<ImportRowPreview>>(`/imports/${enc(id)}/rows`, query),
  start: (id: string) => http.post<ImportJob>(`/imports/${enc(id)}/start`),
  cancel: (id: string) => http.post<ImportJob>(`/imports/${enc(id)}/cancel`),
  errorReport: (id: string) => http.get<{ url: string; fileName: string; expiresAt: ISODateTime }>(`/imports/${enc(id)}/error-report`),
};
// api = { …, imports }
```

`src/lib/api/uploads.ts` gains `uploadImportFile(projectId, source, file, onProgress, signal)`: create → reuse the
private `putToSignedUrl` (unchanged, including the `mock-upload://` branch) → `analyze`. It returns the analysed job
or throws `ApiError` (422 details as §4.3). Client pre-checks (`import-lib.ts` `precheckImportFile`) run before the
create call and produce the same titles/meta.

### 6.3 `src/lib/api/query-keys.ts`

```ts
imports: (projectId: string) => ["p", projectId, "imports"] as const,
importJob: (id: string) => ["import", id] as const,
importRows: (id: string, outcome: string, revision: number) => ["import", id, "rows", outcome, revision] as const,
```

Invalidation: on a job reaching a terminal state → `qk.scope(projectId)` (board, list, backlog, labels, epics,
statuses counts, custom fields, activity), `qk.project(slug, key)` and `qk.projects(slug)` (counts, `nextTaskNumber`),
`qk.views(slug)` (counts), `qk.imports(projectId)`, `qk.unread()`. On cancel/start → `qk.imports(projectId)`.

### 6.4 Queries and mutations (`features/import/queries.ts`)

- `useImportJob(id)`: `refetchInterval` = 1000 ms while `status ∈ {queued, running}` and `document.visibilityState ===
  "visible"`, else `false`; `refetchOnWindowFocus: true`. When it sees a terminal status it runs the invalidation of
  §6.3 once and shows a toast if the wizard is closed ("Import finished · 44 tasks added to PRJ", action "View").
- `useSaveMapping(id)`: keeps the latest local mapping, sends at most one PUT at a time (300 ms debounce, the newest
  pending replaces older ones), `revision = lastSent + 1`; writes the response into `qk.importJob`; on 409
  `mapping_conflict` adopts `details.current`. The select shows the local value at once; tables, counts, footer reason
  and preview follow the server.
- Preview: `api.imports.rows(id, { limit: 5 })` keyed by `qk.importRows(id, "all", revision)`.
- `useStartImport`, `useCancelImport`: plain mutations (no optimistic state: the server owns the job).
- Download report: `api.imports.errorReport(id)` then a hidden `<a download>` click.

### 6.5 Routes and components

No new route. The wizard is a modal hosted by the project shell, opened with `?import=new|<jobId>` via
`pushUrl`/`replaceUrl` (never `router.push`), code-split through `lazyWithPreload` and warmed when an entry point
renders.

| Path | What |
|---|---|
| `features/import/import-wizard-host.tsx` | reads `?import=`, loads the job, mounts the wizard; lock panel (§1.4) when `canImport` is false |
| `features/import/import-wizard.tsx` | `Modal` shell: head (icon, "Import", "into" project badge, ×), stepper (4 steps, done/current/running dots, back-navigation only in setup), body, footer (reason line with shake, Back, Next / Start import / Stop import / Import more + Open project / Retry) |
| `features/import/step-source.tsx` | tiles radiogroup (Trello disabled with `disabledReason`), project picker |
| `features/import/step-upload.tsx` | drop zone, upload progress, analyzing note, alerts, file card, preset note, detected columns |
| `features/import/step-map.tsx` | Fields table (+ unit select), Statuses / Types / People value tables, Preview table |
| `features/import/step-run.tsx` | summary, running (progress + log), result (complete / stopped / failed) and `error-report-table.tsx` |
| `features/import/import-lib.ts` | `precheckImportFile`, `stepOf(job)`, `footerReason(job, step)`, `fieldOptions(customFields, perms)`, `fileMeta(file)`, `analysisErrorMeta(details)`, `formatKeyRange`, `skipSummary`, `canImport(perms)` |
| `features/import/import-history.tsx` | settings tab: list of `ImportJobSummary` (status pill, file, `PRJ-61 → PRJ-104`, imported/skipped, who, when, Download report, Open), **New import**; empty "No imports yet"; loading skeleton; error + Retry |

Edits: `settings/project-settings.tsx` (tab `import`, last, shown only with `canImport`), `projects/overview.tsx`
(checklist desc + "Import CSV"), board/list empty states ("Import CSV"), `palette` (action "Import tasks…"),
`projects/project-shell.tsx` (host), `notifications` inbox row for `type: "import"`, `lib/audit.ts`,
`tasks/activity-text.ts`, `permissions/catalogue.ts` (+ `DEFAULT_ROLES`).

Appearance follows board 40 (`iw-*` classes are the reference) with token classes only. Motion: only transform and
opacity (§9 #29): the stepper fill and progress bar use `transform: scaleX()`, the running shimmer is a translated
overlay, the log line slide-in and tile lift are transforms; all static under reduced motion. 390 px: the modal is a
full-height sheet, tiles stack, mapping rows stack (select under the column name), stat tiles 2 × 2, 40 px controls
(design "Mobile" frame). The page never scrolls horizontally; the preview table scrolls inside its card.

Accessibility: tiles are a `radiogroup` with roving focus; Next carries `aria-disabled` + `aria-describedby` to the
reason line; the reason line is `role=status`; alerts `role=alert`; the progress bar has `aria-valuenow`; the log is
`role=log aria-live=polite` and announces at most one line per second.

### 6.6 Gating

`canImport(perms) = can("project.import", perms) && can("task.create", perms)` decides every entry point, the picker's
project list and the settings tab. Inside the wizard: Type option "Epic" needs `epic.manage`; people options beyond
"You" need `task.assign`; "Creates n options" lines appear only with `field.manage`. Stop import is shown to the
creator and to `project.update` holders. Nothing is inferred from role names.

### 6.7 Mock backend

New `src/lib/mock/handlers/imports.ts` exporting `registerImports()` (called from `mock/transport.ts`), implementing
I1–I9 with the same status codes, error codes, messages and permission checks. The import logic lives in
`src/lib/mock/import/` (`decode.ts`, `csv.ts`, `presets.ts`, `match.ts`, `convert.ts`, `plan.ts`, `report.ts`), inside
the lazily loaded mock chunk, so live builds never ship a CSV parser.

- **Upload**: I1 registers an entry in the existing `mockUploads` map (export a `registerMockUpload(id)` helper from
  `handlers/tasks.ts`) and returns `url: "mock-upload://<id>"`; `mockUpload()` stores the Blob unchanged.
- **Analyze**: reads the Blob (`arrayBuffer`), decodes (BOM sniff → `TextDecoder("utf-8", { fatal: true })` →
  `TextDecoder("utf-16le")` for a UTF-16 BOM → fallback `TextDecoder("windows-1252")`), sniffs and parses exactly as
  §7.2–7.3. Parsed rows live in an in-memory `Map<jobId, ParsedFile>`, **not** in localStorage.
- **DB**: `MockDB.imports?: ImportJobRec[]` and `MockDB.importRows?: ImportRowRec[]` (optional, created lazily; no
  `SCHEMA` bump). Job records hold no file content.
- **Runner**: `setTimeout` ticks of 150 ms processing 4 rows per tick (a 48-row sample runs ~2 s, matching the
  design's streaming log), each tick doing what one backend batch does (create tasks through the same internal helpers
  as `POST /projects/:id/tasks`, minus per-task notifications) and persisting through the normal DB save path. Cancel
  is honoured at the next tick. Mock controls (latency, error rate, offline) apply to requests, not ticks.
- **Limits**: the mock caps imports at **1,000 rows** (`too_many_rows`, meta `1,240 rows · max 1,000 in the mock
  API`) to protect the localStorage quota.
- **Reload**: a job whose parsed rows are missing from memory (page reloaded) becomes `failed` with
  `file_missing` "The mock API lost the file when the page reloaded. Start a new import." when it's `ready`, `queued`
  or `running`.
- **Error report**: built in memory; I8 returns `url: URL.createObjectURL(new Blob(["﻿" + csv], { type:
  "text/csv" }))` (revoked after 60 s).
- **Notification / audit / activity**: written like the backend (§5.8–5.9).
- **Permissions**: `ensureExt40(db)` (run on first import route and from `createSeed()`) adds `project.import` to the
  cached **system** roles by key (§3.2), custom roles untouched; marker `ext40?: boolean`.

### 6.8 Fixtures

**Sample file** (`src/lib/mock/import/fixtures/sample.ts`, the design's `sampleText()` verbatim: 48 data rows, CRLF,
cells quoted when they contain `"` `,` `;` or a newline). Header and the first 10 rows:

```csv
Title,Description,Status,Assignee,Priority,Estimate,Due,Tags
Fix login redirect loop,Repro in Safari 17,todo,Alex Kim,High,3,2026-10-08,frontend
Add SSO for admin console,See incident 112,in progress,Riley Chen,Medium,2,2026-10-09,backend
Board loads slowly with 500 cards,,todo,Sam Patel,Low,5,2026-10-10,"frontend;perf"
Rate-limit password reset,"Spec in ""Billing v2"" doc",done,Chris Ortiz,Urgent,1,,
Dark mode for settings,,review,,Medium,8,2026-10-12,api
Export sprint report as PDF,Repro in Safari 17,in progress,Alex Kim,,,2026-10-13,frontend
,See incident 112,blocked,Riley Chen,High,3,2026-10-14,backend
Webhook retries with backoff,,todo,Sam Patel,Medium,2,,"frontend;perf"
Keyboard shortcut cheatsheet,"Spec in ""Billing v2"" doc",in progress,Chris Ortiz,Low,5,2026-10-16,
Archive closed sprints,,todo,,Urgent,1,2026-10-17,api
```

Expected against PRJ (mock and `seed_demo`): all 8 columns auto-mapped; statuses `todo`→Todo, `in progress`→In
progress, `done`→Done, `review`→In review (synonym), `blocked` → unmapped (blocker "Map 1 more status", the design's
S3 frame); people Alex Kim, Riley Chen, Sam Patel by name, Chris Ortiz → Leave unassigned (`counts.people = 3`);
skips: rows 8 and 42 "Missing title", row 20 "Invalid due date" (`next week`), row 27 "Estimate is not a number"
(`XL`) → 44 tasks, 4 skipped; creates label `api` (PRJ's seed labels are frontend, backend, bug, perf, infra, design).

**Jira fixture** (`backend/apps/imports/tests/data/jira-export.csv`, copied by the frontend tests):

```csv
Issue key,Issue id,Summary,Issue Type,Status,Priority,Assignee,Custom field (Story Points),Original Estimate,Parent,Labels,Labels,Custom field (Start date),Due date,Inward issue link (Blocks),Sprint
WEB-1,10001,Checkout redesign,Epic,In Progress,High,Alex Kim,,,,,,01/Oct/26 9:00 AM,30/Oct/26 6:00 PM,,
WEB-2,10002,Cart drawer,Story,To Do,Medium,Jordan Lee,3,28800,10001,frontend,ux,05/Oct/26 9:00 AM,14/Oct/26 6:00 PM,,Sprint 14
WEB-3,10003,Cart drawer animation,Sub-task,To Do,Low,jordan.lee,1,7200,10002,frontend,,,,,Sprint 14
WEB-4,10004,Price rounding bug,Bug,Done,Highest,Sam P.,2,,10001,backend,,,09/Oct/26 6:00 PM,,
WEB-5,10005,Payment retry,Story,In Review,Medium,Dana Wu,5,14400,10001,backend,api,,,WEB-4,Sprint 99
WEB-6,10006,,Task,To Do,Low,,,,,,,,,,
```

Expected: preset `jira`; `Issue key` + `Issue id` → ID; both `Labels` → Labels; WEB-1 → epic "Checkout redesign"
(2026-10-01 → 2026-10-30); WEB-2 → task in that epic, 3 pts, 480 min, start 2026-10-05, due 2026-10-14, Sprint 14,
labels frontend + ux; WEB-3 → sub-task of WEB-2, Jordan Lee (`initial`), Sprint 14 inherited; WEB-4 → Done, priority
4, Sam Patel (`initial`), epic WEB-1; WEB-5 → In review, unassigned (Dana Wu), blocked by WEB-4, warning "No sprint
named “Sprint 99” · added to the backlog"; WEB-6 → skipped "Missing title". Test variants generated from it: UTF-8 BOM,
`;`-delimited, tab-delimited UTF-16LE (Excel "Unicode text"), Windows-1252 with `Café`, CRLF vs LF, a quoted cell with
an embedded newline.

**Template** (live "Download template"): a static `public/import-template.csv` with the design's 8 headers plus
`Type, Start date, Time estimate, Epic, Sprint, Parent, ID` and two example rows.

---

## 7. Security

### 7.1 CSV formula injection

The error report reproduces user data that spreadsheet apps would evaluate. `csv_safe(value)` (backend
`apps/common/csvsafe.py`; mock `src/lib/mock/import/report.ts`, shared vectors):
- prefix `'` when the value starts with `=`, `+`, `-`, `@`, tab, CR, LF, or their full-width forms `＝ ＋ － ＠`, also
  after leading spaces (`"  =1+1"`);
- then quote every field and double inner quotes; never emit an unquoted field;
- applied to every cell, header names included.
Imported values themselves are stored verbatim (they are data; the UI renders text through React, never as HTML).
Recommendation outside this board: board 39's timesheet export and the reports CSV export should adopt the same helper.

### 7.2 Encoding detection (identical on both sides)

1. `EF BB BF` → UTF-8, BOM dropped. `FF FE` / `FE FF` → UTF-16 LE/BE (Excel "Unicode text"), BOM dropped.
2. Otherwise strict UTF-8 decode; success → `utf-8`.
3. Otherwise `windows-1252` (a superset of printable Latin-1; undefined bytes map to U+FFFD) → `encoding:
   "windows-1252"`, shown in the file meta so a wrong guess is visible.
4. After decoding, any NUL character → `binary` ("Not a text file"). A raw prefix of `PK\x03\x04` (xlsx) or
   `D0 CF 11 E0` (xls) is checked before decoding → `excel`.
No `chardet`-style dependency.

### 7.3 Delimiter sniffing

Candidates `,` `;` tab `|`. For each, parse the first 20 records (quote-aware) and score: records with the same field
count as the first record, provided that count is > 1. Highest score wins; ties go to the candidate with more fields in
the first record, then the order `,` `;` tab `|`. A file where no candidate gives > 1 field is read as one column
(`,`). The design's header-only count is the fallback for tiny files (< 2 records).

### 7.4 Memory and CPU limits

- Size is checked three times: declared at I1, the storage HEAD at I2 (`> 10 MB` → `too_large`, before reading), and a
  bounded read (`size + 1` bytes max).
- Parsing streams over the decoded text with `csv.reader`, `field_size_limit(65536)` (→ `cell_too_long`), and stops at
  row 5,001 (→ `too_many_rows`) and column 41 (→ `too_many_columns`). Worst case in memory: ~10 MB raw + ~40 MB of
  Python strings for a few seconds; the worker never holds more than one job.
- `parsed.json.gz` is our own output (no decompression of user input, so no zip-bomb surface).
- I2 is synchronous but bounded by the limits; I4/I5 reuse the parsed file (one process-local LRU entry per job) and
  run in O(rows × columns).
- One active job per project, 20 creations per hour per user, `UploadThrottle` on the ticket.

### 7.5 Other

- Authorisation on every job endpoint resolves job → project → `can()` (IDOR tests, §8.1). Storage keys are
  server-generated; the user's file name is cleaned and never used in a key or a path.
- The error report is served with a 60 s presigned URL, `Content-Disposition: attachment`, `text/csv`; the local
  backend sets `nosniff` (R2 needs the v1 Transform Rule).
- Files hold customer data: private bucket, deleted after 30 days (§2.5), never logged. Audit `data` holds only names,
  counts and ids.
- Descriptions become Tiptap text nodes only, then `sanitize_doc()`; links in text are not auto-linked.
- C0 control characters (except tab and newline) are stripped from every value (§4.7).

---

## 8. Test plan

### 8.1 Backend (pytest, PostgreSQL; gates unchanged: ruff, mypy, coverage ≥ 85 %, `apps/access` ≥ 95 %)

- **Shared vectors** `backend/apps/imports/tests/data/import_vectors.json` (the frontend copies it, like board 32's
  span vectors): decoding (BOM, UTF-16, cp1252), delimiter sniffing, quoted newlines/quotes, unclosed quote line
  numbers, header normalisation and synonyms, preset detection, status/type/people/priority matching, date formats
  and `dateOrder`, numbers, durations + units, `csv_safe`.
- **Models/migrations:** one-active-per-project constraint, row cap check, `ImportRow` uniqueness;
  `makemigrations --check`; the `access` 0004 data migration adds `project.import` to system roles, is idempotent,
  leaves custom roles.
- **Catalogue:** `GET /permissions` has the code; `my_permissions` order is §3.3; the 7 roles hold exactly §3.2;
  archived projects drop it.
- **I1:** happy path returns a ticket for every storage backend; each 422 message; Viewer 403; non-member 403
  `project_membership_required`; other workspace 404; throttle 429.
- **I2:** every `details.file.reason` row of §4.3 with a crafted file; encoding and delimiter reported; analysis
  columns/samples/types; preset detection for the Jira, Linear and Asana fixtures; idempotent on `ready`; only the
  creator.
- **I4:** auto suggestions (sample + Jira fixture match §6.8 exactly); explicit `null`s; dropped stale keys; every
  blocker in order; every 422; `task.assign`-less importer; epic type without `epic.manage`; revision conflict 409;
  409 outside `ready`.
- **I5:** dry-run outcomes and predicted keys; after-run outcomes from `ImportRow`; filters and cursor.
- **I6 / runner** (`IMPORT_RUNNER="inline"`): the sample imports 44 tasks with contiguous keys, correct statuses,
  assignees, labels, positions in file order per column, backlog (not the active sprint),
  status history, search vectors (a `q=` search finds an imported title), audit rows (`task.imported` × 44 +
  start/complete, `source="import"`, request id), one activity entry in the project feed, `task.imported` in the task
  feed, label `api` created once; the Jira fixture creates the epic with dates, epic links, the sub-task with the
  inherited sprint, labels `ux` and `api`, the
  dependency, and the warnings of §6.8; custom fields of every type including created options; constant query count
  per batch (`django_assert_num_queries` with 50 vs 200 rows in one batch).
- **Idempotency/recovery:** kill after a committed batch (raise in batch 2), re-dispatch → no duplicates, numbers
  continue; two concurrent `run_import` calls → one runs (lease); stale heartbeat → GET re-dispatches; `resume_imports`.
- **Cancel/failure:** cancel in each state (§4.10); cancel mid-run keeps imported tasks and links; project archived
  mid-run → `project_unavailable`; creator demoted → `permission_lost`; storage object deleted → `file_missing`;
  retry resumes; one active import per project 409.
- **Report:** columns, BOM, CRLF, quoting, formula-safe cells (vectors), original columns reproduced; I8 404 without
  issues; presigned URL headers.
- **Notification:** one `import` notification to the creator (completed, canceled, failed), none to assignees, no
  email, no `task_assigned` notifications from imported tasks.
- **Retention:** `purge_imports` deletes expired jobs and storage objects, keeps tasks; drafts after 24 h; project purge
  removes files.
- **IDOR:** every job endpoint with a job from another project/workspace.
- **OpenAPI:** regenerate `docs/openapi.yaml`; drift check passes.

### 8.2 Frontend (`npm run check`; Vitest with `--maxWorkers=2` on this machine)

- **Unit:** the mock import modules against the shared vectors (same expectations as pytest); `import-lib.ts`
  (`precheckImportFile` titles/meta, `stepOf` for every status, `footerReason` order and copy, `fileMeta` incl.
  delimiter/encoding suffixes, `analysisErrorMeta`, `skipSummary`, `formatKeyRange`, `fieldOptions` gating);
  `activityText` for `imported`; `auditActionKind`; inbox row text for `import`.
- **Permissions:** `can.test.tsx` covers `project.import` for all 7 roles; `canImport` needs both keys.
- **Mock handlers** (`mock.test.ts` style): I1–I9 happy paths and each error; sample run produces 44 tasks and the
  report; Jira fixture outcomes; 1,000-row cap; reload → `file_missing`; `ensureExt40` upgrades a cached DB once.
- **e2e (Playwright, port 3100):** as `u_alex` from the overview checklist: Import CSV → CSV tile → upload the sample
  (setInputFiles) → map `blocked` → Todo → summary shows 44 / 4 / 5 / 3 → Start → progress → complete → Download
  report (file content check) → Open project shows PRJ-… tasks; Stop import mid-run shows "Import stopped"; upload a
  `.xlsx` and a 12 MB file → design errors; keyboard-only pass through the tiles and selects; as `u_taylor` (Viewer)
  no entry point exists and `?import=new` shows the lock panel; as `u_sam` (project Member: has `task.assign`, lacks
  `epic.manage`) the people options list every member and the Type option "Epic" is absent; a custom role without
  `task.assign` (mock unit test) limits people to "You" and "Leave unassigned".
- **Visual sweep:** every step and state (upload error, analyzing, mapping with dup and unmapped, summary, running,
  complete, stopped, failed, lock, settings history empty/loading/error) at 1440 and 390, navy/black/light; no console
  errors; no horizontal page scroll; reduced motion.
- **Live mode:** against `seed_demo` with `STORAGE_BACKEND=local`: the sample and the Jira fixture import end to end
  with the thread runner (no Redis) and with the compose worker profile.

---

## 9. Conflicts (design vs conventions) and resolutions

| # | Design | Conventions / reality | Resolution |
|---|---|---|---|
| 1 | Header "client-side CSV parse"; the browser reads the first 1 MB / 50 rows | The worker needs the whole file; validation must be authoritative and identical for 5,000 rows | Server parses (I2); the client only pre-checks extension, size and emptiness. The footer note "Preview covers the first 50 rows" is dropped: counts are exact. |
| 2 | Trello and Jira tiles lead to "Connect" (site URL, OAuth, 401 retry, board picker) | No OAuth/integration infrastructure; v2 integrations not built | API imports are "Coming soon". Jira tile = Jira **CSV export** (preset). Trello tile disabled "Coming soon" (JSON export, §1.2). Connect/Connecting/Connect failed frames not built. |
| 3 | Only Trello, Jira, CSV | Brief also names Linear and Asana | Linear/Asana CSV exports are auto-detected presets inside the CSV tile; no new tiles. |
| 4 | Roles admin/member/viewer gate the wizard | Permissions only from `my_permissions`, no role names | `project.import` + `task.create`; sub-capabilities via `task.assign`, `epic.manage`, `field.manage` (§1.6). |
| 5 | Viewer frame: lock "Import needs member access · Ask an admin" | Hidden when not allowed; v1 `ReadOnlyNote` copy | Entry points hidden; the lock panel only on a direct URL, using `ReadOnlyNote` text; no "Ask an admin" link (no "request a different role" endpoint in v1). |
| 6 | Eight target fields | Boards 32/39 add start date, time estimate, custom fields, dependencies; epics/sprints/sub-tasks exist in v1 | Extended list (§4.5) in "More fields" and "Custom fields" groups after the design's eight. |
| 7 | Any field mapped twice blocks ("Two columns map to …") | Jira repeats `Labels`, and `Issue key` + `Issue id` are both identities | Labels, ID, Blocked by, Blocks accept several columns; every other field keeps the design rule. |
| 8 | Status and people tables show the first 12 distinct values | Rows with value 13+ would be silently unmapped | All values up to caps 50/20/200; beyond a cap → blocker. |
| 9 | People options are a fixed people list | Assignees must be project members | Options = project members + "Leave unassigned"; match by email, name, initial; no invites. |
| 10 | Status options are six fixed glyph statuses | Projects have their own workflows | Options = the project's statuses with their glyph and colour. |
| 11 | Dates via a regex then `Date.parse` fallback | `Date.parse` isn't portable to Python; ambiguous D/M | Explicit formats with per-column order (§4.7); unknown → "Invalid due date". |
| 12 | No cancel; the close button is hidden while running | Imports can run for minutes; the footer says "Runs in the background" | × stays ("Close · the import keeps running"); **Stop import** button while running; completion notification + toast. |
| 13 | No undo | — | Not built (as designed). Partial imports after Stop/failure stay; `ImportRow` keeps the task ids so a revert can be added later (§10 #3). |
| 14 | "Use sample file" loads fake data | In live mode that would write fake tasks into a real project | Mock mode only; live mode shows "Download template". |
| 15 | Log streams one line per row every 120 ms | The server commits per batch | Log renders `progress.recent` (last 10 per poll), animating new lines in. |
| 16 | Report built in the browser as a `data:` URL, columns Row/Reason/Value | Server owns the data; formula injection | Server-generated report (§5.7) with Outcome and the original columns, formula-safe; table shows the first 50 issues. |
| 17 | Report file name date hard-coded (`2026-10-07`) | Real dates | Finish date (UTC). |
| 18 | Skip rules: missing title, title > 200, invalid due date, non-numeric estimate | v1 `_title` truncates silently | Import skips as designed; the same "unreadable value skips" principle extends to the new fields; unresolvable references are warnings (§4.6). |
| 19 | Picker shows each project's next key (`PRJ-61`) | `Project` doesn't expose `task_seq` | Additive `Project.nextTaskNumber`. |
| 20 | Project picker on step 1 can change after the file is chosen | Mapping depends on the project | Changing project discards the draft and re-uploads the same file silently. |
| 21 | Board 39 settings nav lists "Import" | v1 tabs + board 39 "Custom fields" | New last tab **Import** (`?tab=import`) with history, shown only with `canImport`. |
| 22 | Board 06 empty state and board 12 checklist offer "Import CSV" | v1 omitted them (v2 ban) | Both enabled (E1, E2). |
| 23 | Only a happy "Import complete" result | Jobs can be stopped or fail | "Import stopped" and "Import failed" (+ Retry) reuse the result layout. |
| 24 | No inbox row for imports | Users may leave during a long import | New in-app `import` notification, no email, no preference row. |
| 25 | Types aren't mapped | v1 tasks have a type; Jira's `Issue Type` drives epics and sub-tasks | "Types" value table, same look as Statuses, only when a Type column is mapped. |
| 26 | "Estimate" field only | Story points vs time (board 39 §8 #3) | "Estimate" = points (design); "Time estimate" separate with a unit select. |
| 27 | Imported tasks: no sprint rule | v1 create joins the active sprint | Imports go to the backlog unless a Sprint column maps them. |
| 28 | Per-task "assigned" notifications implied by v1 create | Hundreds of notifications | Suppressed during import (§10 #4). |
| 29 | Stepper fill and progress bar animate `width`; shimmer animates `background-position`; dots transition colours | Animate only transform and opacity | `scaleX` transforms, translated shimmer overlay, instant colour changes; static under reduced motion. |
| 30 | `frontend/CLAUDE.md` bans import (v2) | The user lifted the ban | Frontend removes it from the bullet and records the paper trail. |

---

## 10. Open questions

None blocks implementation; each has a default above that both sides build to. Confirm or change before release:

1. **Row cap.** Default 5,000 rows per file (mock 1,000). 10,000 would still fit the 10 MB limit and the batch design;
   the cost is longer runs on the thread runner.
2. **Members importing.** Default: project Member gets `project.import` (design gates only viewers). Alternative:
   Manager and Project Admin only.
3. **Undo import.** Not in the design, not built. `ImportRow.task` makes a `POST /imports/:id/revert` (soft-delete the
   job's tasks to Trash, restorable 30 days) cheap to add.
4. **Assignment notifications.** Default: none per task. Option: one summary row per assignee ("Alex imported 12 tasks
   assigned to you"), which needs a notification type and an inbox design.
5. **Report skew.** Imported done tasks count as completed on import day in throughput, velocity and cycle time.
   Options: map a "Completed date" column into `completed_at` and history, or exclude `task.imported` history rows from
   reports.
6. **Trello JSON and API connectors.** Which comes first; both are "Coming soon" now.
7. **Unmatched people.** Default: unassigned. Options: invite them by email (needs `workspace.manage_members` and an
   accept step before they can be assigned), or keep the name in a text custom field.
8. **Auto-created objects.** Default: labels, epics and select options are created automatically and announced in the
   summary ("Creates 2 labels, 1 epic"). Option: checkboxes to opt out.
9. **New project from a file.** Default: import only into existing projects. Option: "Create a project from this file"
   in step 1.
10. **Excel files.** Default: CSV only ("Only .csv files · export as CSV first"). `.xlsx` would need `openpyxl` (new
    dependency) and a sheet picker.

---

## 11. Delivery checklist

Backend: `apps/imports` (models, migrations, parsing/presets/mapping/planner/runner/report, services, selectors,
serializers, views, urls, Celery task, thread runner, `purge_imports`, `resume_imports`) · `access` 0004 + catalogue +
default roles · `Project.nextTaskNumber` · notification type `import` + handler · audit `record_many`, actions,
activity verb and feed exclusion · settings (`IMPORT_*`, `THROTTLE_IMPORTS`) · project purge hook · Render/compose
docs (cron for `purge_imports`) · shared vectors + fixtures · tests (§8.1) · `docs/openapi.yaml` regenerated.

Frontend: CLAUDE.md ban lifted + final-report paper trail · types, endpoints, query keys, `uploadImportFile` ·
permissions catalogue and roles · mock (`handlers/imports.ts`, `mock/import/*`, `ensureExt40`, fixtures) · wizard
host + four steps + result states + lock panel · entry points (checklist, empty states, settings tab, palette) ·
inbox row, activity text, audit kind · tests (§8.2) · visual sweep.
