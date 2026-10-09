# v2 · Board 33: Dashboards & presence (API contract)

Status: **contract, not implemented.** The backend (Django + DRF, `backend/`) and the frontend (Next.js,
`frontend/`) are built from this document in parallel. Where this document is silent, the v1 conventions in
`docs/backend-plan.md`, `frontend/docs/api-contract.md` and `frontend/src/lib/api/*.ts` apply unchanged, and so do the
board 39 (`docs/v2/39-fields-dependencies-time.md`), board 32 (`docs/v2/32-timeline-calendar.md`) and board 40
(`docs/v2/40-import-wizard.md`) contracts.

Design source: `frontend/design/clean/33-Dashboards-amp-presence.html` (frames: Dashboard, Edit layout, Mobile, Add
widget, Presence on task, Live cursors in comments, Loading, Empty, Error; `data-props` theme navy/dark/light and role
admin/member/viewer). Precedence is unchanged: **docs and existing conventions win for behaviour, the design wins for
appearance.** Every conflict and its resolution is in §9.

**The user's decision: realtime uses Server-Sent Events (SSE), not WebSockets.** The v1 rule "no WebSockets" stands;
one shared SSE stream is the agreed exception. Presence uses it first; the board, inbox and import progress reuse it.
When the stream is unavailable, the client falls back to v1's 30-second polling.

Contents: 0 Wire conventions · 1 Scope · 2 Realtime architecture · 3 Data model · 4 Permissions · 5 Endpoints ·
6 Side effects · 7 Frontend · 8 Test plan · 9 Conflicts · 10 Open questions · 11 Delivery checklist.

**Summary of the change.**

- Two new backend apps:
  - `apps/dashboards`: models `Dashboard` and `DashboardWidget`.
  - `apps/realtime`: models `RealtimeEvent` and `PresenceSession`, the stream view, an in-process hub, and a
    Postgres LISTEN/NOTIFY broker (Redis optional).
- Six dashboard endpoints, one new report (`workload`), one additive report field (`ProgressRow.quarter`), three
  presence endpoints and one stream endpoint.
- Two new project permissions (`dashboard.create`, `dashboard.manage`).
- **Deployment change:** gunicorn moves from `sync` to `gthread` workers, and one direct (unpooled) database URL is
  needed for LISTEN.
- **No new Python or npm dependency.**

---

## 0. Wire conventions (unchanged, restated so nobody guesses)

- Base `/api/v1`. JSON. camelCase fields; the only snake_case key is `my_permissions`.
- Timestamps ISO-8601 UTC (`ISODateTime`); calendar dates `YYYY-MM-DD` (`ISODate`).
- Errors: `{ "code": string, "message": string, "details": object }`. Validation is **422** `validation_failed`
  with `details.fields: { "<field path>": "<message>" }`; nested paths are dotted (`widgets.2.config.range`).
- Paginated lists: `{ "data": T[], "nextCursor": string | null }`. Every list in this document is a bounded **plain
  array**.
- Filters: `filter[key]=value`. Create → **201**; update → **200**; delete → **204**.
- Permission failure → 403 `forbidden` with `details.permission`. Not a workspace member → 404. Workspace member, not
  on the project → 403 `project_membership_required` (v1, unchanged).
- Optimistic concurrency: writes to a dashboard carry `version`; a mismatch → 409 `version_conflict` with
  `details.current` (the current `Dashboard`), as for tasks.
- Archived projects are read-only: the new permissions are **not** added to `ARCHIVED_ALLOWED`. Dashboards there can be
  viewed, not changed. Presence still works (it is not a write to project data).
- IDs are UUIDs on the backend and opaque strings in the mock (`db_prj_health`). Clients never parse ids.
- The one non-JSON response in this document is the stream (§2, §5.5): `text/event-stream`. Errors **before** the
  stream starts are still JSON in the shape above.

---

## 1. Scope

### 1.1 What board 33 shows

| Feature | Surfaces |
|---|---|
| **Dashboards** | Project tab **Dashboards** → a 12-column widget grid with a dashboard picker in the breadcrumb ("Dashboards / Sprint 14 health ▾"), a presence stack ("Viewing now"), **Edit layout** (drag ⠿ to reorder, corner to resize, × to remove, **Add widget** gallery, Cancel / **Save layout**), mobile stacking, and the loading, empty and error states |
| **Widgets** (6 types, §1.3) | Burndown · My tasks · Objective progress · Workload by person · Velocity · Recent activity |
| **Presence** | Who is viewing a dashboard or the board; who has a task open (avatars on board cards and in the task panel header); "X is editing" pill; per-field name flags; "X is typing" in comments; a flag on the description while someone edits it |
| **Live updates** | Widgets and open tasks refresh when someone else changes data. The changed rows flash, and a toast says "Updated just now by Riley · Burndown" |

Out of scope (each has a resolution in §9): character-level co-editing of the description (the design's live caret
with streamed text), remote mouse cursors and remote text selection in comments, workspace-level dashboards,
duplicating dashboards, scheduled or emailed dashboards, and more than one widget of a type per dashboard.

### 1.2 Where dashboards live

- **Project-scoped.** Every widget in the design reads one project's data: the PRJ sprint, PRJ objectives, PRJ keys
  and "Dashboard · Platform Rebuild" in the mobile header. The design's sidebar keeps the project active while a
  dashboard is shown. Workspace dashboards are open question §10 #2.
- **Shared or personal** (`visibility`):
  - `shared`: visible to every project member with `project.view`.
  - `personal`: visible only to its owner.
  - The owner can switch between the two (§1.6).
- **Routes:**
  - `/[ws]/projects/[key]/dashboards` opens the last dashboard you opened in this project (remembered per project
    in `localStorage`). Otherwise it opens the first shared dashboard, then your first personal one. If none exists,
    it shows the "No dashboards yet" state (§1.7).
  - `/[ws]/projects/[key]/dashboards/[dashboardId]` opens one dashboard.
- **Limits** (service): 20 shared dashboards per project; 10 personal dashboards per user per project; name 1–60
  characters, trimmed; one widget per type, so at most 6 widgets.

### 1.3 Widget catalogue (exactly the design's six)

The values come from the design's `CAT` (default size), `minH` (minimum height) and `STACK` (stacked height on mobile)
fixtures. Width is always 3–12 columns. Height is always `minH`–4 rows.

| `type` | Name | Default w × h | minH | Stack height (px) | Header meta | Data source | Needs |
|---|---|---|---|---|---|---|---|
| `burndown` | Burndown | 6 × 2 | 2 | 236 | sprint name ("Sprint 14") | existing `GET /projects/:id/reports/burndown?filter[sprint]=` | `report.view` |
| `my_tasks` | My tasks | 3 × 2 | 1 | 200 | "N open" | existing `GET /projects/:id/tasks?filter[assignee]=me&sort=dueDate&limit=50` | `project.view` |
| `objectives` | Objective progress | 3 × 2 | 1 | 206 | quarter ("Q4") or "All quarters" | existing `GET /projects/:id/reports/progress` (objective rows), plus additive `quarter` (§5.4) | `report.view` |
| `workload` | Workload by person | 6 × 2 | 2 | 268 | "pts · Sprint 14" / "h · Sprint 14" | **new** `GET /projects/:id/reports/workload` (§5.4) | `report.view` |
| `velocity` | Velocity | 3 × 2 | 2 | 214 | "avg 35" (mean of completed) | existing `GET /projects/:id/reports/velocity?filter[range]=` | `report.view` |
| `activity` | Recent activity | 3 × 2 | 1 | 236 | "live" while the stream is live, otherwise none | existing `GET /projects/:id/activity?limit=10` | `project.view` |

What each widget renders, in the design's anatomy and the Reports chart palette (`--c1` series 1, `--c2` series 2,
`--cref` reference). It reuses the Reports Recharts primitives (§7.6).

- **Burndown.**
  - Legend: Remaining (line), Ideal (dashed).
  - Remaining line with a light area under it; dashed ideal; a vertical "Today" rule; an end dot with the current
    value.
  - X labels: sprint start, "Today", sprint end (`Oct 1 · Today · Oct 14`).
  - Hover/focus per day shows the tooltip "Oct 7 · today", rows "28 remaining" and "31 ideal".
  - `aria-label`: "Sprint 14 burndown: 28 of 42 points remaining on Oct 7, ideal 31".
  - No sprint: inline empty "No active sprint".
- **My tasks.**
  - Rows: status glyph button, key, title, due date ("Oct 9"; warning tone when due within 2 days and open).
  - Order: open tasks by due date (no date last), then tasks done in the last 7 days (dimmed), when
    `config.showDone`.
  - Rows shown: as many as fit (h1: 3, h2: 7, h3: 11, h4: 15).
  - Glyph button `aria-pressed`, label "Complete PRJ-42" / "Reopen PRJ-40":
    - Complete moves the task to the project's first **done**-category status that is not canceled.
    - Reopen moves it to the first **todo**-category status.
    - Both use v1 `PATCH /tasks/:id { statusId, version }` (the status-only rule: `task.move` or can-edit-task).
  - Without that permission, the glyph is plain, not a button.
  - Clicking a row opens `?task=KEY`.
  - Empty: "Nothing assigned to you".
- **Objective progress.**
  - Legend: Progress, Expected today (tick).
  - Row: name, bar with the expected tick, `62%` (danger tone when more than 10 points behind expected).
  - Tooltip: "62% progress · 70% expected".
  - Shows objective rows only, filtered by `config.quarter`.
  - Empty: "No objectives".
- **Workload by person.**
  - Legend: In progress, To do, Capacity (tick).
  - Row: avatar, first name, stacked bar (in progress `--c1`, to do `--c2`), capacity tick, `11/10` (danger tone
    when over capacity).
  - Tooltip: "Alex Kim · pts", "5 in progress", "6 to do", "10 capacity".
  - The scale is the response's `scale`.
  - No sprint: "No active sprint". No rows: "No assigned work in this sprint".
- **Velocity.**
  - Legend: Committed (`--c2`), Completed (`--c1`); grouped bars per sprint, labels `S9…S13`.
  - Tooltip: "Sprint 12 · 92%", "33 completed", "36 committed".
  - When `insufficient` is true, the v1 `NotEnoughData` state shows ("Velocity needs 3 completed sprints").
- **Recent activity.**
  - Rows: avatar, **First name** + verb + key + tail, relative time (`now` in the live tone).
  - Verbs and text come from v1 `activity-text.ts`.
  - The newest row flashes once when it arrives live.
  - Empty: "No activity yet".

Each widget has its own query, so each has its own states:

- loading: skeleton lines inside the card;
- error: one line "Couldn’t load" with **Retry** inside the card;
- empty: the per-widget copy above.

A failing widget never fails the dashboard.

### 1.4 Layout grid and editing

**Model.** A dashboard's layout is an **ordered list** of widgets, each with `w` (3–12) and `h` (`minH`–4). Positions
are **not stored**; they are computed with the design's first-fit packing (`pack()`):

- For each widget in order, find the first row, then the first column, where a `w × h` box fits without overlap.
- The grid has 12 columns.

Both sides implement packing identically, with shared vectors (§8.3). The backend only needs it to validate nothing;
it is a client concern, but the vectors make the mock and screenshots stable.

**Geometry** (appearance; the design frames use 116–170 px rows):

- Row unit `U` = 152 px when the grid is at least 1024 px wide, 128 px below that.
- Gutters are 12 px (6 px padding around each card). Card height = `h × U`.

**View mode.**

- Charts are interactive (hover and focus tooltips).
- The header shows, in order:
  - the crumb "Dashboards / <name> ▾" (the picker, §1.6);
  - spacer;
  - the "Viewing now" presence stack (§1.5);
  - a separator;
  - **Edit layout**, only when you can edit this dashboard (§4.3) and the viewport is wider than 760 px.

**Edit mode** (entered with Edit layout; a snapshot of the layout is kept for Cancel):

| Element | Behaviour |
|---|---|
| Header | pill "Editing layout" · **Add widget** · separator · Cancel · **Save layout** (primary) |
| Grid | 12 dashed column guides and row lines (`db-guides`); widget bodies dimmed, no pointer events |
| Grip ⠿ (left of the title, `aria-roledescription="drag handle"`, label "Move Burndown. Arrow keys reorder") | Pointer drag: the card follows the pointer (lifted: scale 1.015, rotate −0.4°, modal shadow). When the pointer enters another widget's packed rect, the dragged widget moves to that index and the layout repacks with a dashed accent placeholder at its slot. Releasing drops it. Keyboard: ←/↑ move one earlier, →/↓ one later; focus stays on the grip. |
| × (top right, "Remove Burndown") | Removes the widget from the draft (no confirm; Cancel restores it) |
| Resize handle (bottom right, label "Resize Burndown, 6 × 2. Arrow keys resize") | Pointer: snaps to whole columns and rows, clamped to 3–12 and `minH`–4; a size badge "6 × 2" shows while resizing. Keyboard: ←/→ change `w` by 1, ↑/↓ change `h` by 1; the badge shows for 900 ms. |
| Widget settings (gear, §1.3 config; only for types with options) | Popover with that type's options (§3.3); changes apply to the draft at once |
| Add widget → gallery (`dialog`, "Add widget", count "4 of 6 added", Esc closes, first free tile focused) | One tile per type with a mini preview, name and default size ("6 × 2"). Types already present show "✓ Added" and are `aria-disabled`. Types you can't read (`report.view` missing) are not rendered. Choosing a tile appends the widget at its default size with its default config, closes the gallery, keeps edit mode, and the new card pops in. |
| Cancel | Restores the snapshot; live region "Layout changes discarded" |
| Save layout | If nothing changed, it leaves edit mode with no request. Otherwise it sends one `PUT /dashboards/:id/layout` with the whole list and `version` (§5.2). Success: toast "✓ Layout saved · 6 widgets", live region "Layout saved". 409: toast "Someone else changed this dashboard" with **Reload**; the draft stays until you reload or cancel. 422: toast with the first message; stay in edit mode. |

Live-region messages (`aria-live=polite`), exactly:

- "Burndown moved to position 2 of 6"
- "Burndown resized to 6 by 2"
- "Burndown added"
- "Burndown removed"
- "Layout saved"
- "Layout changes discarded"

Leaving the route in edit mode discards the draft (no guard).

**Mobile (≤ 760 px).**

- Widgets stack in layout order at full width, with the stack heights of §1.3. The layout itself is not changed.
- No edit mode.
- The empty state's **Add widget** still works: it opens the gallery as a sheet and saves at once (one `PUT`) because
  there is no edit mode to save from.
- The app shell top bar stays. The presence stack (small avatars) goes into `TopBarActions`.

### 1.5 Presence surfaces

A **presence location** is one of:

- `board` (a project's board; id = project id);
- `dashboard` (id = dashboard id);
- `task` (id = task id; the side panel, sheet or full page).

Each browser tab reports one location, plus an optional editing field and a typing flag (§2.8).

| Surface | What shows | Rules |
|---|---|---|
| Dashboard header "Viewing now" (`role=group`) | Avatars (26 px, overlapping by −6 px) of **other** people viewing this dashboard, each with the pulsing live ring in their hue and a green dot. You are last, without a ring ("Alex Kim, you"). | Shown only when at least one other person is present. At most 4 avatars + "+N" chip. Each avatar's `title`/`aria-label` is "Jordan Lee, viewing" or "Jordan Lee, editing the layout". |
| Dashboard "is editing the layout" | When someone else has this dashboard in edit mode, a `pr-edit` pill "Jordan is editing the layout" sits left of the stack | Information only; saves are protected by `version` |
| Board header | Same stack, for people on this project's board | Board view only |
| Board card | Small avatars (20 px, live ring) of the people with **that task** open, pinned to the card's top-right edge. The card border takes the first person's hue with a soft ring. `aria-label` on the group: "Jordan and Riley are here". | People with the task open from any surface |
| Task panel header | Stack of everyone with the task open (others live-ringed, you last). If someone else is editing, a `pr-edit` pill "Jordan is editing" with a pencil icon. | If several are editing, the earliest one shows: "Jordan and 1 other are editing". |
| Field flag | When another person's `field` is a property row (`status`, `assignee`, `dueDate`, `priority`, `estimate`, `labels`, `sprint`, `epic`, `title`, `cf.<id>`, …), that row's value gets an inset ring in their hue and a small name flag ("Riley") above it | One flag per field (earliest person) |
| Description | While another person edits the description: a border in their hue and a name flag "Jordan" at the top-left of the box. `aria-label` "Description, Jordan is editing". **No streamed characters** (§9 #8). | |
| Comments typing row | Under the thread: avatar + animated dots + "Sam is typing" / "Sam and Riley are typing" / "3 people are typing" (`aria-live=polite`); fades out 200 ms after the last typist stops | Typing comes from the comment composer only; you never see yourself |
| "Updated just now by …" toast | Avatar (live ring) + "Updated just now by Riley" + mono key (widget name on dashboards, e.g. "Burndown"; "PRJ-42 · Due" in the task panel) | Only for events from someone else that change a widget on screen or the open task; at most one every 4 s; the changed rows flash once (`hl`, 1.6 s; none under reduced motion) |

Presence avatars use the design's `oklch(var(--lv-l) var(--lv-c) <hue>)` ring tokens. Under reduced motion the pulse,
dots and flash are static.

When realtime is in **polling** mode (§2.10):

- Avatars and editing pills still update, about every 20 s (from the heartbeat response).
- Typing rows and live flashes are hidden.
- The activity widget drops the "live" meta.

### 1.6 Dashboard picker and management

The crumb button opens a `Menu`:

| Item | Shown when |
|---|---|
| Section "Shared": every shared dashboard (name; ✓ on the current one) | always |
| Section "Personal": your personal dashboards | you have any |
| **New dashboard…** → dialog: Name (max 60), Visibility radio (Shared with project / Only me), Start from (Blank / Sprint health) | `dashboard.create` |
| separator · **Rename…** | you can edit this dashboard (§4.3) |
| **Share with project** / **Make personal** | you are the owner and hold `dashboard.create` |
| **Delete…** → `alertdialog` "Delete “Sprint 14 health”?" + "It disappears for everyone on this project." (shared) or "Only you can see it." (personal). Cancel (autofocus) / **Delete dashboard** (danger). Then a toast with **Undo** for 5 s; the `DELETE` is sent when the toast expires (v1 pending-delete). | you can edit this dashboard |

"Sprint health" creates the design's default layout: Burndown 6×2, My tasks 3×2, Objective progress 3×2, Workload
6×2, Velocity 3×2, Recent activity 3×2, each with its default config. Widgets the creator can't read are skipped.

### 1.7 States

| State | Content |
|---|---|
| Loading (the dashboard query) | Skeleton cards: desktop 2 columns (150, 150, 110 px wide span 2); stacked on mobile (120, 90). `aria-busy` "Loading dashboard". |
| Error | v1 `ErrorState`: "Couldn’t load dashboard", meta `<status> · request <ref>` (mono), **Retry** |
| Not found / no access | 404 → v1 not-found screen. Someone else's personal dashboard is 404 too. 403 `project_membership_required` → the v1 request-access screen. |
| No dashboards yet (project has none you can see) | Grid icon, **"No dashboards yet"**. With `dashboard.create`: **New dashboard**. Without it: mono "Ask a project admin to create one". |
| Empty (no widgets) | Grid icon, **"No widgets yet"**. If you can edit it: **Add widget** (opens the gallery and enters edit mode). Otherwise: mono "Ask an editor to add widgets". |
| Nothing you can see (widgets exist, none readable by you) | Grid icon, **"Nothing to show"**, mono "These widgets need report access" |
| Ready | The grid |
| Archived project | Ready; picker shows only the list; no Edit layout, no New, Rename, Share or Delete |

### 1.8 Who can do what (summary; keys in §4)

| Action | Rule |
|---|---|
| See the Dashboards tab, list and open shared dashboards | `project.view` |
| See a widget | the widget type's "Needs" column (§1.3); otherwise it is not rendered and packing skips it |
| Create a dashboard (shared or personal) | `dashboard.create` |
| Edit (layout, rename, delete) a dashboard | owner with `dashboard.create`, **or** shared + `dashboard.manage` |
| Change visibility | owner with `dashboard.create` |
| Complete/reopen in My tasks | v1 status-only rule for that task |
| Be visible in presence / see presence | `project.view` on the location's project (everyone on the project sees everyone there) |

---

## 2. Realtime architecture

### 2.1 Decision summary

| Topic | Decision |
|---|---|
| Transport | One SSE stream **per browser per workspace**: `GET /api/v1/workspaces/:slug/stream`. Tabs share it through a leader tab (§7.7). |
| Client API | **`fetch()` with a streaming body**, not `EventSource`, with a ~60-line SSE parser (§7.7). |
| Authentication | The normal `Authorization: Bearer <access token>` header. **No ticket, no token in the URL.** The stream ends itself when the token expires; the client refreshes and reconnects. |
| Events | Invalidation hints with ids and versions, never full records; versioned envelope `v: 1` (§2.4) |
| Replay | `Last-Event-ID` header; durable events kept 15 min in Postgres (`RealtimeEvent`); a gap or older id gives `reset` |
| Fan-out across processes | **Postgres `LISTEN/NOTIFY`** on a dedicated **direct (unpooled)** connection per web process, opened only while the process has streams. Redis pub/sub when `REALTIME_BROKER=redis`. |
| Presence | Rows in Postgres (`PresenceSession`) with a 45 s TTL refreshed by a 20 s heartbeat `PUT`; changes broadcast as volatile events |
| Web server | gunicorn **`gthread`** workers (threads per process). Streams are capped per process below the thread count, so API requests always have threads. |
| Fallback | Any failure → "polling" mode: v1's 30 s polling for board, inbox and saved-view counts, plus dashboard widgets; presence through the heartbeat response; the stream retried with backoff |
| New dependencies | **None.** gthread ships with gunicorn; psycopg 3 (already pinned) does `LISTEN` and `notifies()`; `redis` is already pinned for the optional broker. |

### 2.2 Why these choices

**fetch-streaming instead of EventSource + ticket.**

- `EventSource` can't send headers. A ticket would have to go in the URL, and then:
  - it would appear in gunicorn's access log (`--access-logfile -`) and Render's logs;
  - it would need a shared single-use store (a table) across processes;
  - native auto-reconnect would replay the spent ticket, so we would have to disable it and reconnect by hand anyway.
- With `fetch`:
  - the existing in-memory token and `HttpTransport.refresh()` are reused;
  - `Last-Event-ID` is sent explicitly;
  - nothing secret appears in a URL;
  - the mock can supply the same message stream without HTTP.
- The cost is a small parser and our own reconnect loop, which we need anyway.

**gthread instead of uvicorn/ASGI or gevent.**

- The current image runs **sync** workers (`--workers ${WEB_CONCURRENCY:-3}`, `WEB_CONCURRENCY=2` in `render.yaml`).
  One open stream would pin a whole sync worker, and the 30 s worker timeout would kill it.
- gthread keeps the WSGI app and every v1 view unchanged. Each stream holds one thread that sleeps on a queue.
  gunicorn's `--timeout` checks worker liveness from the main loop, not request duration, so long streams are not
  killed.
- ASGI (uvicorn workers) would run all of v1's sync DRF views through `sync_to_async`, and would need
  `CONN_MAX_AGE`/connection handling to be re-validated. That is too much risk for this feature.
- gevent needs monkey-patching across psycopg, boto3 and Celery.
- gthread's ceiling (tens of streams per process) fits an internal tool. §10 #7 covers growing past it.

**LISTEN/NOTIFY instead of Redis.**

- The Render blueprint is the free plan with no Redis, and Celery already runs inline without one.
- `NOTIFY` (sending) works through a transaction pooler, because it is an ordinary statement delivered at commit.
- `LISTEN` does **not** work through PgBouncer transaction pooling, which Neon's `-pooler` host uses: the
  subscription lives on a server connection that is handed to other clients. Each process therefore opens **one
  direct connection** (`REALTIME_LISTEN_DATABASE_URL`, the Neon host **without** `-pooler`, or the Render Postgres
  URL).
- Session state such as `LISTEN` is lost when Neon suspends the compute, so the listener reconnects with backoff and
  then sends `reset` to its streams (§2.7).
- To let an idle Neon compute scale to zero, the listener connection is opened only while the process has at least
  one stream, and closed 60 s after the last one ends.

### 2.3 The stream endpoint

`GET /api/v1/workspaces/:slug/stream`

| Request header | |
|---|---|
| `Authorization: Bearer <access>` | required |
| `Accept: text/event-stream` | required (else 406 `not_acceptable`) |
| `Last-Event-ID: 8812` | optional; replay after this id (§2.6) |

Query: `v=1` (optional; the protocol version the client speaks; unknown → 400 `unsupported_version`, `details.supported:
[1]`).

Errors before streaming (JSON):

| Status | Code | When |
|---|---|---|
| 401 | `not_authenticated` / `token_not_valid` | v1 auth |
| 404 | `not_found` | not a member of the workspace |
| 429 | `throttled` | more than 30 connects per minute per user (scope `stream`), `Retry-After` |
| 503 | `realtime_unavailable` | `REALTIME_ENABLED=false`, or the broker is down at connect time; `Retry-After: 300` |
| 503 | `realtime_busy` | this process already holds `SSE_MAX_STREAMS_PER_PROCESS` streams; `Retry-After: 60` |

Success: `200`, headers:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

The body (Django `StreamingHttpResponse` over a generator; returned from a DRF `APIView` so DRF auth applies) is UTF-8
SSE:

```
retry: 3000

event: hello
data: {"v":1,"type":"hello","data":{"connectionId":"c_9f2e","serverTime":"2026-10-09T09:00:00Z","heartbeatSec":15,"maxLifetimeSec":300,"projects":["5f0e…","a71c…"],"replayed":0}}

id: 8813
event: task.changed
data: {"v":1,"type":"task.changed","id":"8813","ws":"0c1d…","projectId":"5f0e…","actorId":"u-riley…","at":"2026-10-09T09:00:04Z","data":{"taskId":"7a3b…","key":"PRJ-42","op":"updated","version":9,"fields":["dueDate"]}}

: ping 2026-10-09T09:00:15Z

event: presence.updated
data: {"v":1,"type":"presence.updated","ws":"0c1d…","projectId":"5f0e…","actorId":"u-jordan…","at":"2026-10-09T09:00:16Z","data":{ "…": "§2.4" }}

event: reconnect
data: {"v":1,"type":"reconnect","data":{"reason":"lifetime","retryMs":500}}
```

What the server does:

- **Connect.** Authenticate. Resolve the workspace (404 rules). Compute the set of projects in the workspace where the
  user has `project.view` (archived included, soft-deleted excluded). This set is the **filter** for the stream's
  lifetime.
- **Admission.** Take a slot from the per-process semaphore (else 503 `realtime_busy`).
- **Prelude.** Write `retry: 3000`, then `hello`, then the replay (§2.6). Then **close the thread's DB connection**
  (`connection.close()`) before waiting, so idle streams hold no database connections.
- **Loop.** Block on the subscription queue with a timeout of `SSE_HEARTBEAT_SECONDS` (15). On timeout, write a comment
  `: ping <serverTime>`. On an event, write it.
- **End** with `reconnect`, then return (closing the response), when:
  - the stream has been open `SSE_MAX_LIFETIME_SECONDS` (300, plus up to 30 s jitter): reason `lifetime`;
  - the access token's `exp` is less than 30 s away: reason `token_expiry`. The token's `exp` comes from
    `request.auth`; the stream must never outlive its credential;
  - an `access.changed` event targets this user (role or membership changed; the project filter is stale): reason
    `access_changed`;
  - the process is shutting down: reason `shutdown`.
- **Overflow.** On queue overflow (§2.7): `reset` (reason `slow_consumer`), then end with `reconnect` `retryMs: 1000`.
- **Release.** The slot is released in a `finally` block. A client disconnect surfaces as a write error, or on the
  next heartbeat at the latest.

The stream view itself is never throttled by the default `user` throttle (it is one request); the `stream` scope above
applies.

### 2.4 Envelope and event catalogue (protocol version 1)

Every `data:` line is one JSON object:

```ts
interface RealtimeEnvelope<T extends string = string, D = unknown> {
  v: 1;
  type: T;
  id?: string;          // durable events only; same as the SSE `id:` line
  ws?: ID;              // workspace id
  projectId?: ID | null;
  actorId?: ID | null;  // who caused it (null = system)
  at?: ISODateTime;
  data: D;
}
```

**Durable** events have an `id` and are replayable. **Volatile** events (presence, control) have no id and are never
replayed. Clients **must ignore unknown types and unknown fields**: adding either is non-breaking. A breaking change
bumps `v` and the server serves both versions until clients move (`?v=`).

| Type | Kind | Delivered to | `data` | Emitted by |
|---|---|---|---|---|
| `hello` | control | the new connection | `{ connectionId, serverTime, heartbeatSec, maxLifetimeSec, projects: ID[], replayed: number }` | stream start |
| `reset` | control | one connection | `{ reason: "unknown_cursor" \| "gap" \| "slow_consumer" \| "broker_restart" }`; the client must refetch everything live (§7.8) | §2.6, §2.7 |
| `reconnect` | control | one connection, then the server closes | `{ reason: "lifetime" \| "token_expiry" \| "access_changed" \| "shutdown", retryMs: number }` | §2.3 |
| `task.changed` | durable | project members | `{ taskId, key, op: "created" \| "updated" \| "moved" \| "deleted" \| "restored", version: number \| null, fields: string[] }`. `fields` are camelCase `Task` field names from the audit diff (`statusId`, `dueDate`, `customFields.<id>`, …); `[]` when unknown. | task services (via audit, §6.2) |
| `tasks.bulk_changed` | durable | project members | `{ taskIds: ID[] (≤ 200; more → `null`, meaning "many"), op }` | bulk update/delete/restore, imports |
| `comment.changed` | durable | project members | `{ taskId, key, commentId, op: "created" \| "updated" \| "deleted" }` | comment services |
| `attachment.changed` | durable | project members | `{ taskId, key, op: "created" \| "deleted" }` | attachment services |
| `project.changed` | durable | project members | `{ areas: ("settings" \| "statuses" \| "labels" \| "members" \| "sprints" \| "epics" \| "objectives" \| "milestones" \| "custom_fields" \| "dependencies" \| "time")[] }` | project and planning services |
| `dashboard.changed` | durable | shared: project members; personal: the owner only | `{ dashboardId, op: "created" \| "updated" \| "layout" \| "deleted", version: number \| null }` | dashboard services |
| `inbox.changed` | durable | one user (`userId` target) | `{ unread: number }` | notification creation, read, read-all |
| `access.changed` | durable | one user | `{ projectId: ID \| null }` | membership or role change; the stream then ends with `reconnect` |
| `presence.updated` | volatile | project members | the full roster of **one location**: `{ location: { kind, id }, people: PresencePerson[], at }` (§5.3 shape) | presence services |
| `import.progress` | volatile | project members with `project.import` | reserved for board 40: `{ jobId, status, progress }`. **Not emitted in this release**; `useImportJob` keeps polling (§10 #8). | — |

Rules:

- **Data minimisation.** Events carry ids, keys, versions and field names, never titles, comment text or values. A
  client refetches through the normal endpoints, so every permission rule of the REST API still applies. Only people
  with `project.view` on `projectId` receive project events; the filter is applied per connection in the hub.
- **Origin echo.** The actor's own tabs also receive the events, and treat them as cheap no-ops when the cache is
  already at that `version` (§7.8).

### 2.5 Heartbeats and liveness

- **Server.** A comment line `: ping <ISO time>` every 15 s of silence. Comments are ignored by SSE consumers but
  reset idle timers in proxies. 15 s is well under any edge idle timeout we may sit behind (Render's edge, Cloudflare's
  100 s).
- **Client watchdog.** No bytes for 45 s → abort the fetch and reconnect (counts as a failure, §2.10).
- **Lifetime.** Streams end themselves every 5 min (plus jitter). This bounds any proxy's per-request limit, re-checks
  access and token, and spreads reconnects across processes after a deploy.

### 2.6 Reconnecting with `Last-Event-ID`

- The client remembers the last **durable** `id` it applied (in memory, shared across tabs through the leader).
- Every reconnect sends it in `Last-Event-ID`. CORS: add `last-event-id` to `CORS_ALLOW_HEADERS` (§2.9).
- Server replay:
  - No header → no replay.
  - Header id < the oldest retained id, or not a number → `reset` (`unknown_cursor`).
  - Otherwise, stream every retained event with `id > last` that matches the connection's filter, in id order, up to
    **500**. More than 500 → `reset` (`gap`) and continue live.
  - `hello.replayed` says how many were sent.
- **Ordering guarantee.** Durable events are inserted after the business transaction commits, in their own short
  transaction that first takes a global advisory lock (`pg_advisory_xact_lock(<REALTIME_LOCK_KEY>)`), inserts the row
  and calls `pg_notify`. Ids are therefore allocated **in commit order**, so `id > last` can't skip an event that
  committed later with a smaller id. The lock is held for about 1 ms per event, acceptable at this scale; §10 #7 covers
  the bigger setup.
- **Retention.** Events older than `REALTIME_EVENT_RETENTION_SECONDS` (900) are deleted by the hub's housekeeping
  (§2.7), so replay covers a 15-minute gap. A longer absence gets `reset`.
- **Client backoff.**
  - After an error: full-jitter exponential backoff of 1, 2, 4, 8, 16, then 30 s maximum.
  - After a `reconnect` event: `retryMs` plus 0–2 s jitter.
  - After a 503 or 429: `Retry-After`.
  - The backoff resets after a stream stays up for 60 s.

### 2.7 Hub, backpressure and housekeeping (per process)

`apps/realtime/hub.py` holds one `Hub` per process (module singleton, thread-safe):

- **`subscribe(filter)`** creates a `Subscription` with a bounded `queue.Queue(maxsize=256)`.
  - Filter: `{ workspace_id, project_ids: set, user_id }`.
  - An event matches when its `ws` equals the workspace and either its `projectId` is in `project_ids`, or its
    `userId` target equals the user.
- **Listener thread.** Daemon, started on the first subscribe and stopped 60 s after the last unsubscribe.
  - Connects to `REALTIME_LISTEN_DATABASE_URL` with `psycopg.connect(..., autocommit=True)`, runs
    `LISTEN lightex_rt`, and loops on `conn.notifies(timeout=5)`.
  - Each notification payload is the JSON envelope plus `userId` (target). Payloads over 7,500 bytes are sent as
    `{"id": "<id>", "ref": true}` and the listener reads the row; Postgres caps NOTIFY payloads at 8,000 bytes.
  - Fan-out is `put_nowait` to every matching subscription.
- **Backpressure.**
  - A full queue marks the subscription `overflowed`. Its stream sends `reset` (`slow_consumer`) and `reconnect`,
    then closes, and the client refetches.
  - Nothing ever blocks the listener.
  - Writes to a slow socket block only that stream's thread, which ends at its lifetime limit at worst.
  - On the client side, events are coalesced (§7.8).
- **Broker loss.** If the LISTEN connection drops (network, Neon suspend, deploy of the database):
  - the listener reconnects with backoff (1 to 30 s);
  - after reconnecting, it sends `reset` (`broker_restart`) to every subscription, because events may have been
    missed in between;
  - while the listener is down, new connections still succeed (they get replay from the table) and are marked
    degraded.
- **Housekeeping** (the listener thread, while it runs; idempotent across processes):
  - every 15 s: `DELETE FROM realtime_presencesession WHERE expires_at < now() RETURNING …`, then publish a
    `presence.updated` for each affected location. Each expired row is returned to exactly one process;
  - every 60 s: delete `RealtimeEvent` rows past retention.
- **Shutdown.** gunicorn sends SIGTERM to workers on deploy. Streams end within `--graceful-timeout` (10 s): the hub
  installs an `atexit` hook and a `worker_exit` hook in `gunicorn.conf.py` that set `hub.closing`, so every stream
  sends `reconnect` (`shutdown`, `retryMs` 1000–5000 random). Any stream that is cut harder is just a network error to
  the client, which reconnects with `Last-Event-ID`.

**Publishing** (`apps/realtime/services.py`):

```python
def publish(type: str, *, workspace, project=None, user=None, actor=None, data: dict, durable=True) -> None:
    """Called inside service code. Sends after the surrounding transaction commits (never on rollback)."""
    transaction.on_commit(lambda: broker().send(Envelope(...), durable=durable))
```

The brokers:

- **`PostgresBroker.send`:**
  - Durable events: `with transaction.atomic(): SELECT pg_advisory_xact_lock(K); INSERT … RETURNING id; SELECT
    pg_notify('lightex_rt', payload)`.
  - Volatile events: `SELECT pg_notify(...)` only.
  - Runs on the normal (pooled) connection; NOTIFY works through PgBouncer.
- **`RedisBroker`** (`REALTIME_BROKER=redis`): durable rows are still inserted in Postgres (replay), then
  `PUBLISH lightex_rt payload`. The listener `SUBSCRIBE`s instead of `LISTEN`. Use it when Redis exists; then the
  direct database URL is not needed.
- **`LocalBroker`** (tests, `runserver`, one process): an in-memory dispatch, synchronous on commit.

Publishing failures are logged and swallowed. A missed hint is healed by the client's refetch-on-focus and the
`reset` paths; it must never fail a user's write.

### 2.8 Presence storage

`realtime.PresenceSession`, one row per **browser tab** (§3.4). Rules:

- **Session id.** The client generates `crypto.randomUUID()` per tab (in memory, not storage). The key is
  `(user, session_id)`, so a client can never touch another user's row.
- **Heartbeat.** `PUT /workspaces/:slug/presence/:sessionId` (§5.3) every **20 s** while the tab is visible, and
  immediately (debounced 300 ms) when the location, field or typing changes. Each PUT sets
  `expires_at = now + PRESENCE_TTL_SECONDS (45)`.
- **Typing** is a flag with its own short life: `typing_until = now + 8 s` when the PUT says `typing: true`. The client
  re-sends every 4 s while keys keep coming and sends `typing: false` on blur, on send, or after 5 s idle.
- **Leaving.**
  - Navigating away from a location → PUT with the new location.
  - Tab hidden for 30 s → `DELETE`.
  - `pagehide` → `DELETE` with `fetch(..., { keepalive: true })` and the bearer header (`sendBeacon` can't send
    headers).
  - Otherwise the TTL expires and housekeeping removes the row.
- **Broadcast only on change.** A PUT that changes `location`, `state`, `field` or `typing` (or creates the row) →
  publish `presence.updated` for the **old** location (if it changed) and the new one. A pure refresh publishes
  nothing.
- **Roster** for a location = live rows (`expires_at > now()`), aggregated per user:
  - state precedence `editing` > `viewing`;
  - `field` and `since` from that user's earliest editing row;
  - `typing` = any row with `typing_until > now()`.
  - Sorted by `since` (first arrival first).
- **Validation of the location:**
  - `task` must be a live task in a project where the caller has `project.view` (404 otherwise);
  - `dashboard` must be visible to the caller (404 otherwise); for a **personal** dashboard the row is stored but
    never broadcast (nobody else may see it);
  - `board` id must be a project id with `project.view`.
- **Write volume.** One upsert per visible tab per 20 s: 30 people ≈ 1.5 small writes/s, on the pooled connection. It
  isn't audited.

### 2.9 Running under the actual deployment

**gunicorn** (Dockerfile `CMD`, also documented in `backend/README.md`):

```
gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} \
  --workers ${WEB_CONCURRENCY:-2} --worker-class gthread --threads ${GUNICORN_THREADS:-24} \
  --timeout 30 --graceful-timeout 10 --keep-alive 5 --config gunicorn.conf.py --access-logfile -
```

| Setting (env) | Default | Why |
|---|---|---|
| `WEB_CONCURRENCY` | 2 (`render.yaml` already sets 2) | processes; each holds one LISTEN connection while it has streams |
| `GUNICORN_THREADS` | 24 | threads per process for **all** requests |
| `SSE_MAX_STREAMS_PER_PROCESS` | 16 | at most 16 of the 24 threads may be streams, so ≥ 8 always serve the API. Must be < `GUNICORN_THREADS`; settings assert it at startup. 2 × 16 = **32 concurrent browsers** live; the rest fall back to polling (`realtime_busy`). |
| `SSE_HEARTBEAT_SECONDS` | 15 | §2.5 |
| `SSE_MAX_LIFETIME_SECONDS` | 300 | §2.5 |
| `REALTIME_ENABLED` | `true` | `false` → 503 `realtime_unavailable` and every client polls (kill switch) |
| `REALTIME_BROKER` | `postgres` (`local` in test settings) | `postgres` \| `redis` \| `local` |
| `REALTIME_LISTEN_DATABASE_URL` | `DATABASE_URL` | **Must be a direct connection.** On Neon: the host without `-pooler`. On Render Postgres: the internal URL as is. |
| `REALTIME_EVENT_RETENTION_SECONDS` | 900 | §2.6 |
| `PRESENCE_TTL_SECONDS` | 45 | §2.8 |
| `CORS_ALLOW_HEADERS` | corsheaders defaults **+ `last-event-id`** | the client sends it cross-origin |
| Throttles | `stream: 30/min`, `presence: 240/min` per user | new scopes in `DEFAULT_THROTTLE_RATES` (`THROTTLE_STREAM`, `THROTTLE_PRESENCE`) |

**Database connections.**

- gthread lets each thread hold a Django connection (`CONN_MAX_AGE=60`), up to 2 × 24 = 48. Neon's pooler absorbs
  that; Render Postgres free allows about 100. Streams close theirs before waiting, so the realistic number is the
  API-busy threads plus 2 LISTEN connections.
- If you run behind the Neon pooler, keep `DB_POOLED=true`.

**Memory.** Threads are cheap compared with a Django process (about 100 MB each); 2 × 24 threads fit the 512 MB free
instance.

**Render specifics.**

- Response buffering: Render's edge streams `text/event-stream`. The `X-Accel-Buffering: no` and `no-transform` headers
  guard against intermediaries. There is no gzip middleware in the stack (it would buffer); don't add one.
- Timeouts: streams end themselves every 5 min and ping every 15 s, so they don't depend on any platform request or
  idle limit.
- Free-plan spin-down after 15 min without incoming requests: an open stream is outgoing traffic and may not count, but
  every visible tab sends a presence `PUT` every 20 s, which does. When nobody has the app open, the service may spin
  down. Clients then see network errors, go to polling, and reconnect after the cold start.
- **Deploys:** see shutdown in §2.7.

**Local and Docker.**

- `docker compose up` gets the same CMD.
- `runserver` (dev) serves streams fine (threaded) with `REALTIME_BROKER=postgres` or `local`.
- Tests use `local` (§8.1).

### 2.10 Fallback to polling

The client keeps one status store: `realtime.status ∈ "connecting" | "live" | "polling" | "off"`.

| Trigger | Result |
|---|---|
| `hello` received | `live` |
| Connect fails 3 times in a row, or 503 `realtime_unavailable`/`realtime_busy`, or 404 (an older backend without the route), or the watchdog fires twice within 2 min | `polling`; keep retrying the stream in the background with backoff (§2.6), at most once per 5 min after `realtime_unavailable` |
| Any `reset`, or switching from `polling` to `live` | invalidate every **active** query of the workspace once |
| 401 after one refresh | `off`; `authEvents.emit("expired")` (v1 re-auth modal) |
| Tab hidden ≥ 2 min in every tab | the leader closes the stream (frees a server thread); status stays as it was; a visible tab reconnects with `Last-Event-ID` |
| `NEXT_PUBLIC_REALTIME=off` (build flag) or mock control "Realtime: polling" | `polling` without trying |

What changes with the status:

| | `live` | `polling` |
|---|---|---|
| Board, inbox, unread count, saved-view counts | no interval; events invalidate; refetch on focus (v1) | v1: `refetchInterval` 30 s while visible |
| Dashboard widgets | no interval; events invalidate | 30 s while visible |
| Presence roster | `presence.updated` events; refetch roster on every `hello` | the heartbeat `PUT` response (every 20 s) carries the project roster |
| Typing indicators, "Updated just now" toast, row flash | on | off |
| Activity widget meta "live" | shown | hidden |

Implementation: `useLiveInterval(ms)` returns `false` when `live`, otherwise `ms`. It replaces the literal `POLL_MS` in
board, inbox, unread and views queries, and is used by the widget queries.

---

## 3. Data model (backend)

All models extend `apps.common.models.BaseModel` (UUID `id`, `created_at`, `updated_at`).

### 3.1 App placement

| Model | App | Why |
|---|---|---|
| `Dashboard`, `DashboardWidget` | **new `apps/dashboards`** (standard layering) | own CRUD, own permission rules |
| `RealtimeEvent`, `PresenceSession` | **new `apps/realtime`** (models, services, broker, hub, selectors, views, urls) | infrastructure shared by every app |
| — | `apps/reports` | `workload` service and view; `quarter` on progress rows |

Add both apps to `INSTALLED_APPS` and their urls to the v1 router.

### 3.2 `dashboards.Dashboard`

| Field | Type | Notes |
|---|---|---|
| `project` | FK `projects.Project`, CASCADE, `related_name="dashboards"` | |
| `owner` | FK user, CASCADE, `related_name="dashboards"` | creator; personal dashboards belong to them |
| `name` | `CharField(60)` | trimmed, 1–60 |
| `visibility` | `CharField(8)`, choices `shared`, `personal` | |
| `version` | `PositiveIntegerField(default=1)` | +1 on every write (rename, visibility, layout) |

Indexes: `(project, visibility)`, `(project, owner)`. Constraint: `UniqueConstraint("project", "owner",
Lower("name"), name="dashboard_name_unique_per_owner")`. Hard delete (audited); widgets cascade. Removing a user from
the project deletes their **personal** dashboards there (service hook in `remove_member`); their shared dashboards stay.

### 3.3 `dashboards.DashboardWidget`

| Field | Type | Notes |
|---|---|---|
| `dashboard` | FK `Dashboard`, CASCADE, `related_name="widgets"` | |
| `type` | `CharField(16)`, choices `burndown`, `my_tasks`, `objectives`, `workload`, `velocity`, `activity` | |
| `position` | `PositiveSmallIntegerField` | 0-based, dense; layout order |
| `w` | `PositiveSmallIntegerField` | 3–12 |
| `h` | `PositiveSmallIntegerField` | `MIN_H[type]`–4 |
| `config` | `JSONField(default=dict)` | validated per type (below) |

Constraints:

- `UniqueConstraint("dashboard", "type", name="dashboard_widget_type_unique")`;
- `UniqueConstraint("dashboard", "position", name="dashboard_widget_position_unique", deferrable=Deferred.DEFERRED)`;
- `CheckConstraint(w__gte=3, w__lte=12)`;
- `CheckConstraint(h__gte=1, h__lte=4)` (the per-type minimum is a service rule).

Config schemas (server-validated; unknown keys are dropped; missing keys take defaults; the stored config is always
complete):

| `type` | Schema | Default | Validation messages (`widgets.N.config.<key>`) |
|---|---|---|---|
| `burndown` | `{ "sprintId": ID \| null }` (null = the active sprint at read time) | `{ "sprintId": null }` | `Pick a sprint from this project` |
| `my_tasks` | `{ "showDone": boolean }` (show tasks done in the last 7 days) | `{ "showDone": true }` | `Use true or false` |
| `objectives` | `{ "quarter": string \| null }` (exact `Objective.quarter` text, null = all) | `{ "quarter": null }` | `Up to 16 characters` |
| `workload` | `{ "unit": "points" \| "hours", "sprintId": ID \| null, "personField": ID \| null }`. `personField` = a **Person** custom field (board 39) used instead of the assignee. | `{ "unit": "points", "sprintId": null, "personField": null }` | `Pick points or hours` · `Pick a sprint from this project` · `Pick a person field from this project` |
| `velocity` | `{ "range": "last2" \| "last6" }` | `{ "range": "last6" }` | `Pick last2 or last6` |
| `activity` | `{}` | `{}` | — |

A deleted sprint or custom field referenced by a config is not an error on read: the widget falls back to the default
(`null`) and the next save writes the default.

`MIN_H = { burndown: 2, my_tasks: 1, objectives: 1, workload: 2, velocity: 2, activity: 1 }`.

### 3.4 `realtime.PresenceSession`

| Field | Type | Notes |
|---|---|---|
| `user` | FK user, CASCADE | |
| `session_id` | `UUIDField` | client-generated per tab |
| `workspace` | FK `workspaces.Workspace`, CASCADE | |
| `project` | FK `projects.Project`, CASCADE | denormalised from the location (rosters and filtering) |
| `location_kind` | `CharField(10)`, choices `board`, `dashboard`, `task` | |
| `location_id` | `UUIDField` | project / dashboard / task id |
| `private` | `BooleanField(default=False)` | true for a personal dashboard: never broadcast or listed |
| `state` | `CharField(8)`, choices `viewing`, `editing` | |
| `field` | `CharField(48, null=True)` | `title`, `description`, `statusId`, `assigneeId`, `dueDate`, `priority`, `estimate`, `labels`, `sprintId`, `epicId`, `startDate`, `timeEstimateMinutes`, `cf.<uuid>`, `comment`, `layout` (dashboards). Free text, validated against `^[a-zA-Z.]{1,10}[a-zA-Z0-9.\-]{0,38}$`. |
| `typing_until` | `DateTimeField(null=True)` | |
| `since` | `DateTimeField` | when this session entered the current location or state |
| `expires_at` | `DateTimeField` | |

Constraints and indexes: `UniqueConstraint("user", "session_id")`; `Index(fields=["project", "expires_at"])`;
`Index(fields=["location_kind", "location_id"])`; `Index(fields=["expires_at"])`. Hard-deleted on leave and expiry.
Not audited and not shown in any feed.

### 3.5 `realtime.RealtimeEvent`

| Field | Type | Notes |
|---|---|---|
| `id` | `BigAutoField` (overrides the UUID base; the model extends `models.Model` with `created_at` only) | the SSE id; allocated under the advisory lock (§2.6) |
| `workspace` | FK, CASCADE, `db_index=False` | |
| `project` | FK, CASCADE, null | |
| `user` | FK, CASCADE, null | target for user-scoped events |
| `type` | `CharField(32)` | |
| `payload` | `JSONField` | the full envelope |
| `created_at` | `DateTimeField(auto_now_add)` | |

Indexes: `(workspace, id)` (replay), `(created_at)` (retention).

### 3.6 Migrations

- `dashboards` 0001: Dashboard, DashboardWidget.
- `realtime` 0001: PresenceSession, RealtimeEvent.
- `access` 00xx (data, idempotent): create `dashboard.create` and `dashboard.manage` if missing, then add them to the
  existing **system** roles by `system_key` per §4.2. Custom roles are untouched. Reverse = no-op.
- No change to existing tables. `ProgressRow.quarter` is read from `Objective.quarter`, which exists.

---

## 4. Permissions

### 4.1 New catalogue entries (project scope)

| Code | Group | Label | Description |
|---|---|---|---|
| `dashboard.create` | Reports | Create dashboards | Build dashboards and edit the ones you created |
| `dashboard.manage` | Reports | Manage shared dashboards | Edit, rearrange and delete any shared dashboard |

Not new permissions (deliberately):

- **Viewing** dashboards, presence and the stream: `project.view`.
- **Report widgets**: the existing `report.view`.
- **Completing a task from My tasks**: v1's status-only rule.

Placement:

- `backend/apps/access/catalogue.py` `PERMISSIONS`: both right before `report.view`.
- `PROJECT_ORDER`: both after `attachment.delete_any`, before `report.view`.
- Mirror both in `frontend/src/lib/permissions/catalogue.ts` and `PROJECT_PERMISSIONS` (`types.ts`).

### 4.2 Default roles

| Role (scope) | dashboard.create | dashboard.manage |
|---|---|---|
| Owner, Admin, Member (workspace) | — (workspace scope) | — |
| Project Admin | ✓ (core: stays `list(PROJECT_ORDER)`) | ✓ (core) |
| Manager | ✓ (stays "PROJECT_ORDER minus archive/delete/manage_members") | ✓ |
| Member (`project_member`) | ✓ (add after `attachment.upload` in its explicit list) | — |
| Viewer | — | — |

### 4.3 Object rules (backend `dashboards.services.can_edit`, frontend `canEditDashboard`)

```
can_edit(user, dashboard) =
    (dashboard.owner == user and has(user, "dashboard.create", project))
 or (dashboard.visibility == "shared" and has(user, "dashboard.manage", project))
can_view(user, dashboard) =
    has(user, "project.view", project) and (dashboard.visibility == "shared" or dashboard.owner == user)
can_change_visibility(user, dashboard) = dashboard.owner == user and has(user, "dashboard.create", project)
```

- A personal dashboard of someone else is **404**, never 403.
- A denial on a visible dashboard → 403 `forbidden`, with `details.permission: "dashboard.manage"` (shared) or
  `"dashboard.create"` (own).
- The client derives everything from `my_permissions` plus `ownerId` and `visibility`, as `canEditTask` does.

### 4.4 `my_permissions` order

`PROJECT_ORDER` / `PROJECT_PERMISSIONS` become, exactly (including board 40's `project.import`):

```
project.view, project.update, project.archive, project.delete, project.manage_members,
objective.manage, milestone.manage, epic.manage, sprint.manage, status.manage, field.manage,
task.create, task.edit_any, task.edit_own, task.delete, task.assign, task.move, project.import,
time.log, time.delete_any,
comment.create, comment.edit_own, comment.delete_any, attachment.upload, attachment.delete_any,
dashboard.create, dashboard.manage,
report.view
```

Example for Sam (project Member on PRJ):
`["project.view","task.create","task.edit_own","task.assign","task.move","project.import","time.log","comment.create","comment.edit_own","attachment.upload","dashboard.create","report.view"]`.

---

## 5. Endpoints

All paths are under `/api/v1`. Every view declares `required = {METHOD: code}` as in v1, plus the service checks of
§4.3.

### 5.0 Summary

| # | Method | Path | Permission | Response |
|---|---|---|---|---|
| DB1 | GET | `/projects/:id/dashboards` | `project.view` | 200 `DashboardSummary[]` |
| DB2 | POST | `/projects/:id/dashboards` | `dashboard.create` | 201 `Dashboard` |
| DB3 | GET | `/dashboards/:id` | `can_view` | 200 `Dashboard` |
| DB4 | PATCH | `/dashboards/:id` | `can_edit` (`visibility`: `can_change_visibility`) | 200 `Dashboard` |
| DB5 | PUT | `/dashboards/:id/layout` | `can_edit` | 200 `Dashboard` |
| DB6 | DELETE | `/dashboards/:id` | `can_edit` | 204 |
| W1 | GET | `/projects/:id/reports/workload` | `report.view` | 200 `WorkloadReport` |
| — | GET | `/projects/:id/reports/progress` (existing) | `report.view` | objective rows gain `quarter` |
| P1 | PUT | `/workspaces/:slug/presence/:sessionId` | workspace member + `project.view` on the location | 200 `{ expiresAt, roster }` |
| P2 | DELETE | `/workspaces/:slug/presence/:sessionId` | workspace member | 204 (idempotent) |
| P3 | GET | `/workspaces/:slug/presence?filter[project]=<id>` | `project.view` on that project | 200 `PresenceRoster` |
| S1 | GET | `/workspaces/:slug/stream` | workspace member | 200 `text/event-stream` (§2.3) |

Unchanged endpoints used by widgets: burndown, velocity, progress, project tasks, project activity, `PATCH /tasks/:id`.

### 5.1 Shapes

```ts
type WidgetType = "burndown" | "my_tasks" | "objectives" | "workload" | "velocity" | "activity";
type WidgetConfig =
  | { type: "burndown"; config: { sprintId: ID | null } }
  | { type: "my_tasks"; config: { showDone: boolean } }
  | { type: "objectives"; config: { quarter: string | null } }
  | { type: "workload"; config: { unit: "points" | "hours"; sprintId: ID | null; personField: ID | null } }
  | { type: "velocity"; config: { range: "last2" | "last6" } }
  | { type: "activity"; config: Record<string, never> };
type DashboardWidget = WidgetConfig & { id: ID; w: number; h: number };   // array order = position
```

`Dashboard` (DB2–DB5):

```json
{
  "id": "d3b1…",
  "projectId": "5f0e…",
  "name": "Sprint 14 health",
  "visibility": "shared",
  "ownerId": "u-alex…",
  "owner": { "id": "u-alex…", "name": "Alex Kim", "hue": 285, "avatarUrl": null },
  "version": 7,
  "widgets": [
    { "id": "w1…", "type": "burndown",   "w": 6, "h": 2, "config": { "sprintId": null } },
    { "id": "w2…", "type": "my_tasks",   "w": 3, "h": 2, "config": { "showDone": true } },
    { "id": "w3…", "type": "objectives", "w": 3, "h": 2, "config": { "quarter": "Q4" } },
    { "id": "w4…", "type": "workload",   "w": 6, "h": 2, "config": { "unit": "points", "sprintId": null, "personField": null } },
    { "id": "w5…", "type": "velocity",   "w": 3, "h": 2, "config": { "range": "last6" } },
    { "id": "w6…", "type": "activity",   "w": 3, "h": 2, "config": {} }
  ],
  "createdAt": "2026-10-01T09:00:00Z",
  "updatedAt": "2026-10-08T15:12:40Z"
}
```

The server returns **every** widget, including types the caller can't read. The client hides those (§1.3); the data
endpoints enforce `report.view` anyway.

`DashboardSummary` (DB1): `{ id, projectId, name, visibility, ownerId, widgetCount, updatedAt }`. Order: shared
(name A–Z), then the caller's personal ones (name A–Z).

### 5.2 Dashboard endpoints

**DB1 `GET /projects/:id/dashboards`**: plain array as above. Archived projects included.

**DB2 `POST /projects/:id/dashboards`**

```json
{ "name": "Sprint 14 health", "visibility": "shared", "template": "sprint_health" }
```

`template`: `"blank"` (default) or `"sprint_health"` (§1.6; types the caller can't read are skipped). Response 201
`Dashboard` (`version: 1`).

| Status | Code | Field / message |
|---|---|---|
| 422 | `validation_failed` | `name: "Name is required"` · `name: "Up to 60 characters"` · `name: "You already have a dashboard with this name"` · `visibility: "Pick shared or personal"` · `template: "Pick blank or sprint_health"` |
| 409 | `dashboard_limit` | "A project can have up to 20 shared dashboards." / "You can have up to 10 personal dashboards in a project." |
| 403 | `forbidden` | `details.permission: "dashboard.create"` |

**DB3 `GET /dashboards/:id`**: 200 `Dashboard`. 404 `not_found` "Dashboard not found." for unknown, invisible or
another user's personal dashboard. A dashboard in a project the caller isn't on → v1 403
`project_membership_required`, but only when it is shared; personal → 404.

**DB4 `PATCH /dashboards/:id`**

```json
{ "name": "Release health", "visibility": "personal", "version": 7 }
```

`version` is required. The other keys are optional. 409 `version_conflict` with `details.current`. Same name
validation as DB2. Changing `visibility` without being the owner → 403 `forbidden`
(`details.permission: "dashboard.create"`, message "Only the owner can change who sees this dashboard."). Response 200
`Dashboard`. Version +1.

**DB5 `PUT /dashboards/:id/layout`**

```json
{
  "version": 7,
  "widgets": [
    { "id": "w1…", "type": "burndown", "w": 12, "h": 2, "config": { "sprintId": null } },
    { "id": "w3…", "type": "objectives", "w": 3, "h": 1, "config": { "quarter": "Q4" } },
    { "type": "velocity", "w": 3, "h": 2, "config": {} }
  ]
}
```

- **Complete ordered list** (replace):
  - items with an `id` of this dashboard are updated (`w`, `h`, `config`, position = index);
  - items without `id` are created;
  - existing widgets missing from the list are deleted.
- `type` of an existing id can't change. Within one request, an id may appear once and a type may appear once.
- Version is checked first (409 `version_conflict`, `details.current`), then bumped once. One audit row
  (`dashboard.layout_updated`). Response 200 `Dashboard`.

| Path | Message |
|---|---|
| `widgets` | `Send a list of widgets` · `Up to 6 widgets` · `Each widget type can appear once` |
| `widgets.N.id` | `Unknown widget` |
| `widgets.N.type` | `Pick a widget type` · `A widget’s type can’t be changed` |
| `widgets.N.w` | `Width is 3 to 12 columns` |
| `widgets.N.h` | `Height is 1 to 4 rows` / `Burndown needs at least 2 rows` (per `MIN_H`) |
| `widgets.N.config.*` | §3.3 |

Adding a report widget type requires the editor to hold `report.view` (`widgets.N.type: "You can’t view this
report"`). Keeping an existing one does not, so a custom-role editor can still rearrange.

**DB6 `DELETE /dashboards/:id`**: 204. Hard delete (widgets cascade); audit row.

### 5.3 Presence endpoints

```ts
type PresenceLocationKind = "board" | "dashboard" | "task";
interface PresenceLocation { kind: PresenceLocationKind; id: ID }
interface PresencePerson {
  user: { id: ID; name: string; hue: number; avatarUrl: string | null };
  state: "viewing" | "editing";
  field: string | null;
  typing: boolean;
  since: ISODateTime;
}
interface PresenceRoster {
  projectId: ID;
  at: ISODateTime;            // server time of the snapshot; clients drop older snapshots
  locations: { location: PresenceLocation; people: PresencePerson[] }[];   // only non-empty locations
}
```

Rosters **include the caller** (the UI places "you" last and never shows your own typing or editing). Private
(personal-dashboard) sessions never appear in rosters, except that the owner always sees themselves on their own
personal dashboard, which the client knows locally.

**P1 `PUT /workspaces/:slug/presence/:sessionId`**

```json
{ "location": { "kind": "task", "id": "7a3b…" }, "state": "editing", "field": "dueDate", "typing": false }
```

- Upserts the session (§2.8).
- `field` is required when `state` is `editing`, and must be null otherwise.
- `typing: true` needs `field` `comment` or `description`.

Response 200:

```json
{
  "expiresAt": "2026-10-09T09:00:45Z",
  "heartbeatSec": 20,
  "roster": {
    "projectId": "5f0e…",
    "at": "2026-10-09T09:00:00Z",
    "locations": [
      { "location": { "kind": "task", "id": "7a3b…" }, "people": [
        { "user": { "id": "u-jordan…", "name": "Jordan Lee", "hue": 200, "avatarUrl": null }, "state": "editing", "field": "description", "typing": false, "since": "2026-10-09T08:58:10Z" },
        { "user": { "id": "u-riley…", "name": "Riley Chen", "hue": 150, "avatarUrl": null }, "state": "editing", "field": "dueDate", "typing": false, "since": "2026-10-09T08:59:30Z" },
        { "user": { "id": "u-alex…", "name": "Alex Kim", "hue": 285, "avatarUrl": null }, "state": "viewing", "field": null, "typing": false, "since": "2026-10-09T09:00:00Z" }
      ] },
      { "location": { "kind": "board", "id": "5f0e…" }, "people": [ "…" ] }
    ]
  }
}
```

`roster` covers the whole **project** of the location, because the board needs every task's viewers. That is what
keeps presence fresh in polling mode.

| Status | Code | Message |
|---|---|---|
| 422 | `validation_failed` | `location.kind: "Pick board, dashboard or task"` · `location.id: "Pick a location"` · `state: "Pick viewing or editing"` · `field: "Name the field being edited"` · `field: "Unknown field"` · `typing: "Typing needs the comment or description field"` |
| 404 | `not_found` | location not visible (§2.8) |
| 403 | `project_membership_required` | v1 |
| 429 | `throttled` | scope `presence` |

**P2 `DELETE /workspaces/:slug/presence/:sessionId`**: 204 whether or not the row existed. Publishes
`presence.updated` for the location it left.

**P3 `GET /workspaces/:slug/presence?filter[project]=<id>`**: 200 `PresenceRoster`. `filter[project]` is required
(422 `filter[project]: "Pick a project"`).

### 5.4 Reports

**W1 `GET /projects/:id/reports/workload?filter[sprint]=<id>&filter[unit]=points|hours&filter[person]=assignee|<customFieldId>`**

- **Sprint.** `filter[sprint]` defaults to the active sprint. Unknown → 404 "Sprint not found." (as burndown).
- **Tasks.** Live tasks in the sprint whose status category is `todo` (→ `todo`) or `in_progress` (→ `inProgress`).
  Done and canceled are excluded. Sub-tasks count separately, like v1 burndown.
- **Person.** `assignee` (default), or the value of a board 39 Person custom field. Unknown or non-person field → 422
  `filter[person]: "Pick a person field from this project"`.
- **Unit `points`** (default):
  - work = `estimate`; unestimated tasks count 0 and are counted in `unestimated`;
  - **capacity** = that person's mean completed points (done, not canceled) over the project's **last 3 completed
    sprints**; the mean divides by the number of those sprints (1–3); rounded; `null` when the project has no
    completed sprint.
- **Unit `hours`** (board 39 time tracking):
  - work = `max(0, timeEstimateMinutes − loggedMinutes)` per task, in **minutes**; tasks without an estimate count 0
    and appear in `unestimated`;
  - capacity = that person's mean minutes logged on this project's tasks per completed sprint, over the same 3
    sprints' date ranges; `null` without history.
- **Rows.** People with work in the sprint, plus project members with a non-null capacity; former members with work
  are kept and named. Sorted by name. Work on tasks with no person goes to `unassigned`.
- **Scale.** `scale` = a round maximum for the bars: `niceMax(max(total, capacity))`, step 2 for points, 120 for
  minutes.

```json
{
  "sprint": { "id": "s14…", "name": "Sprint 14", "number": 14, "startDate": "2026-10-01", "endDate": "2026-10-14" },
  "unit": "points",
  "personField": null,
  "scale": 14,
  "rows": [
    { "user": { "id": "u-alex…", "name": "Alex Kim", "hue": 285, "avatarUrl": null }, "inProgress": 5, "todo": 6, "capacity": 10, "unestimated": 0 },
    { "user": { "id": "u-sam…", "name": "Sam Patel", "hue": 20, "avatarUrl": null }, "inProgress": 2, "todo": 6, "capacity": 8, "unestimated": 1 }
  ],
  "unassigned": { "inProgress": 0, "todo": 3, "unestimated": 2 }
}
```

`personField` echoes `{ "id", "name" }` when used. With no sprint: `{ "sprint": null, "unit": …, "personField": …,
"scale": 0, "rows": [], "unassigned": { "inProgress": 0, "todo": 0, "unestimated": 0 } }`. The widget's "over
capacity" is `inProgress + todo > capacity` (client). Constant query count regardless of task count
(`django_assert_num_queries`).

**Progress (existing `GET /projects/:id/reports/progress`)**: objective rows gain `quarter: string | null` (the
objective's `quarter`); milestone rows get `quarter: null`. Additive; the Reports screen ignores it.

### 5.5 Stream

S1 is fully specified in §2.3 to §2.7. In `docs/openapi.yaml` document it with `responses: 200: content:
text/event-stream: schema: string` plus the 401/404/429/503 JSON errors, and describe the event catalogue in the
operation description. drf-spectacular can't type SSE, so the catalogue lives in this document and in
`frontend/src/lib/realtime/events.ts`.

---

## 6. Side effects

### 6.1 Audit rows (`apps.audit.services.record`)

| Action | Scope | `target` | `changes` / `data` |
|---|---|---|---|
| `dashboard.created` | ws, project | name | `data: { "visibility": "shared", "template": "sprint_health" }` |
| `dashboard.updated` | ws, project | name | `change("Name", …)`, `change("Visibility", "shared", "personal")` |
| `dashboard.layout_updated` | ws, project | name | `data: { "widgets": ["burndown:6x2", "my_tasks:3x2", …] }` (after) |
| `dashboard.deleted` | ws, project | name | `data: { "visibility": "shared", "widgets": 6 }` |

All dashboard actions are audit-only (not in activity feeds). Personal dashboards are audited too (the audit log is
`audit.view`-gated). Presence and stream connections are never audited. Frontend `auditActionKind`: `*_created` →
created, `*_deleted` → deleted, else updated (board 39 rule).

### 6.2 Realtime publication points

One hook covers almost every write. `audit.services.record()` calls
`realtime.services.publish_for_audit(row)` (on commit), which maps `entity_type` and `action` to an event of §2.4:

| Audit `entity_type` / action | Event |
|---|---|
| `task.*` (created, updated, status_changed, assigned, deleted, restored, dependency_*, time_*) | `task.changed` (`op` from the verb, `fields` = camelCase names from `changes`, `version` = task version after the write) |
| `comment.*` | `comment.changed` |
| `attachment.*` | `attachment.changed` |
| `project.*`, `status.*`, `label.*`, `sprint.*`, `epic.*`, `objective.*`, `milestone.*`, `member.*`, `project.custom_field_*` | `project.changed` with the matching `areas` |
| `dashboard.*` | `dashboard.changed` |
| `import.*` (board 40) | `tasks.bulk_changed` with `taskIds: null` at the end of the import |

Explicit `publish()` calls where no audit row is written, or a different audience is needed:

- `tasks.services.move` (board drag) → `task.changed` (`op: "moved"`, `fields: ["statusId","position"]`);
- bulk operations → one `tasks.bulk_changed` instead of N events (the audit hook skips rows flagged `bulk=True`);
- notification create, read and read-all → `inbox.changed` to the recipient (`unread` = new count);
- membership or role changes → `access.changed` to the affected user (plus `project.changed` `["members"]`);
- presence services → `presence.updated` (volatile).

The mock (§7.10) publishes the same events from the same places.

### 6.3 Notifications and activity

None new. Dashboards don't notify. Presence never notifies.

---

## 7. Frontend

Lift the ban first, and keep the paper trail:

- `frontend/CLAUDE.md`:
  - in "v2 features, only as scoped", move board 33 (dashboards and presence) to "In scope" and remove "No
    WebSockets or live presence" from the "Planned next" line;
  - change the freshness rule to: "No WebSockets. One SSE stream (`src/lib/realtime/`) invalidates queries while
    live; otherwise refetch on window focus and poll the board and inbox every 30s while visible";
  - add `dashboards` to the project views list.
- `frontend/docs/final-report.md`: add every endpoint, field and event of §5 and §2.4 to "Requested API additions".

**No new npm dependency:**

- drag and resize are hand-written pointer events (as in the design and board 32);
- the SSE parser is about 60 lines;
- Web Locks and BroadcastChannel are browser APIs, with a fallback;
- charts reuse Recharts, which is already in the reports route.

### 7.1 Routes and tabs

| Path | What |
|---|---|
| `src/app/[workspace]/projects/[key]/dashboards/page.tsx` | thin; `DashboardsIndex` picks the dashboard (§1.2) and `replaceUrl`s to it, or renders "No dashboards yet" |
| `src/app/[workspace]/projects/[key]/dashboards/[dashboardId]/page.tsx` | thin; `<Suspense><DashboardScreen /></Suspense>` |
| `src/lib/routes.ts` | `ProjectView` gains `"dashboards"`; `routes.dashboard(slug, key, id)` |
| `features/projects/project-shell.tsx` `projectTabs` | `{ view: "dashboards", label: "Dashboards", show: true }` right after Reports |
| `src/app/[workspace]/layout.tsx` | mounts `<RealtimeProvider slug>` (§7.7) |

### 7.2 `src/lib/api/types.ts`

```ts
/* Permissions: PROJECT_PERMISSIONS becomes the exact §4.4 list. */

/* ── Dashboards (board 33) ── */
export type WidgetType = "burndown" | "my_tasks" | "objectives" | "workload" | "velocity" | "activity";
export interface WidgetConfigMap {
  burndown: { sprintId: ID | null };
  my_tasks: { showDone: boolean };
  objectives: { quarter: string | null };
  workload: { unit: "points" | "hours"; sprintId: ID | null; personField: ID | null };
  velocity: { range: "last2" | "last6" };
  activity: Record<string, never>;
}
export type DashboardWidget = {
  [T in WidgetType]: { id: ID; type: T; w: number; h: number; config: WidgetConfigMap[T] };
}[WidgetType];
export type DashboardWidgetInput = Omit<DashboardWidget, "id"> & { id?: ID };
export type DashboardVisibility = "shared" | "personal";
export interface Dashboard {
  id: ID; projectId: ID; name: string; visibility: DashboardVisibility; ownerId: ID;
  owner: Pick<User, "id" | "name" | "hue" | "avatarUrl">; version: number; widgets: DashboardWidget[];
  createdAt: ISODateTime; updatedAt: ISODateTime;
}
export interface DashboardSummary {
  id: ID; projectId: ID; name: string; visibility: DashboardVisibility; ownerId: ID; widgetCount: number; updatedAt: ISODateTime;
}

/* ── Reports ── */
export interface ProgressRow { /* v1 */ quarter?: string | null }
export interface WorkloadRow { user: Pick<User, "id" | "name" | "hue" | "avatarUrl">; inProgress: number; todo: number; capacity: number | null; unestimated: number }
export interface WorkloadReport {
  sprint: { id: ID; name: string; number: number; startDate: ISODate; endDate: ISODate } | null;
  unit: "points" | "hours"; personField: { id: ID; name: string } | null; scale: number;
  rows: WorkloadRow[]; unassigned: { inProgress: number; todo: number; unestimated: number };
}

/* ── Presence ── */
export type PresenceLocationKind = "board" | "dashboard" | "task";
export interface PresenceLocation { kind: PresenceLocationKind; id: ID }
export interface PresencePerson {
  user: Pick<User, "id" | "name" | "hue" | "avatarUrl">; state: "viewing" | "editing";
  field: string | null; typing: boolean; since: ISODateTime;
}
export interface PresenceRoster { projectId: ID; at: ISODateTime; locations: { location: PresenceLocation; people: PresencePerson[] }[] }
export interface PresenceUpdate { location: PresenceLocation; state: "viewing" | "editing"; field: string | null; typing: boolean }
```

`src/lib/realtime/events.ts` holds the envelope and the discriminated union of every §2.4 type (`RealtimeEvent`), plus
`RealtimeStatus = "connecting" | "live" | "polling" | "off"`.

### 7.3 `src/lib/api/endpoints.ts`

```ts
export const dashboards = {
  list: (projectId: string) => http.get<DashboardSummary[]>(`/projects/${enc(projectId)}/dashboards`),
  create: (projectId: string, body: { name: string; visibility: DashboardVisibility; template?: "blank" | "sprint_health" }) =>
    http.post<Dashboard>(`/projects/${enc(projectId)}/dashboards`, body),
  get: (id: string) => http.get<Dashboard>(`/dashboards/${enc(id)}`),
  update: (id: string, body: { name?: string; visibility?: DashboardVisibility; version: number }) =>
    http.patch<Dashboard>(`/dashboards/${enc(id)}`, body),
  saveLayout: (id: string, version: number, widgets: DashboardWidgetInput[]) =>
    http.put<Dashboard>(`/dashboards/${enc(id)}/layout`, { version, widgets }),
  remove: (id: string) => http.del(`/dashboards/${enc(id)}`),
};

// reports gains:
//   workload: (projectId, q: { sprintId?: string; unit: "points" | "hours"; person?: string }) =>
//     http.get<WorkloadReport>(`/projects/${enc(projectId)}/reports/workload`,
//       { filter: { sprint: q.sprintId, unit: q.unit, person: q.person } }),

export const presence = {
  put: (slug: string, sessionId: string, body: PresenceUpdate) =>
    http.put<{ expiresAt: string; heartbeatSec: number; roster: PresenceRoster }>(`/workspaces/${enc(slug)}/presence/${enc(sessionId)}`, body),
  leave: (slug: string, sessionId: string, opts?: { keepalive?: boolean }) =>
    http.del(`/workspaces/${enc(slug)}/presence/${enc(sessionId)}`, undefined, opts),
  roster: (slug: string, projectId: string) =>
    http.get<PresenceRoster>(`/workspaces/${enc(slug)}/presence`, { filter: { project: projectId } }),
};

/** The stream is not a JSON request: it is opened by src/lib/realtime (§7.7). Path kept here for the paper trail. */
export const realtime = { streamPath: (slug: string) => `/workspaces/${enc(slug)}/stream` };
// api = { …, dashboards, presence, realtime }
```

`RequestOptions` gains `keepalive?: boolean`, passed to `fetch` by `HttpTransport` and ignored by the mock.

### 7.4 `src/lib/api/query-keys.ts`

```ts
dashboards: (projectId: string) => ["p", projectId, "dashboards"] as const,
dashboard: (id: string) => ["dashboard", id] as const,
/** Project presence roster; outside ["p", id] so qk.scope invalidation doesn't refetch it. */
presence: (slug: string, projectId: string) => ["presence", slug, projectId] as const,
// widgets reuse qk.reports(projectId, kind, ...args) (shared cache with the Reports screen):
//   qk.reports(id, "burndown", sprintId?), qk.reports(id, "velocity", range),
//   qk.reports(id, "progress"), qk.reports(id, "workload", sprintId ?? "active", unit, person ?? "assignee")
// my_tasks: ["p", projectId, "tasks", "mine"]; activity: qk.activity(projectId) (limit 10 page)
```

Mutation invalidation:

- Dashboard create, update or delete → `qk.dashboards(projectId)`; `setQueryData(qk.dashboard(id), response)`.
- Layout save → `setQueryData(qk.dashboard(id))` and `qk.dashboards` (widget count).
- My-tasks toggle → the v1 `useUpdateTask` path (optimistic; it already reaches every `{ data }` list under
  `["p", id]`).

### 7.5 Permissions (`src/lib/permissions/`)

- Add both `prj(...)` entries per §4.1 and update `DEFAULT_ROLES` per §4.2.
- New helper `canEditDashboard(d, perms, meId)` and `canChangeVisibility(d, perms, meId)` per §4.3, unit-tested
  against the same truth table as the backend.
- Widget visibility: `WIDGET_NEEDS: Record<WidgetType, Permission>` (§1.3).

Nothing is inferred from role names. Edit layout, New dashboard, Rename, Share and Delete are **not rendered** when not
allowed.

### 7.6 Components (`src/features/dashboards/`)

| File | What |
|---|---|
| `dashboard-screen.tsx` | header (crumb picker, presence stack, editing pills, Edit/Add/Cancel/Save), states (§1.7), live region, toasts |
| `dashboards-index.tsx` | landing chooser and "No dashboards yet" |
| `dashboard-picker.tsx`, `dashboard-dialogs.tsx` | menu (§1.6), new/rename dialog, delete confirm with 5 s pending delete |
| `layout-grid.tsx` | absolute-positioned cards from `pack()`, guides, placeholder, pointer drag (`setPointerCapture`, 4 px threshold, touch 200 ms press-and-hold), resize, keyboard reorder/resize, focus return to the grip |
| `layout-lib.ts` | `pack(widgets, cols=12)` → rects (port of the design's `pack`), `reorder`, `clampSize(type, w, h)`, `MIN_H`, `DEFAULT_SIZE`, `STACK_HEIGHT`, `rowsFor(h)` (My tasks row count), `layoutEquals`, `toInput` |
| `widget-frame.tsx` | card chrome (`db-card`): grip, title, meta, settings gear, ×, resize handle, size badge, per-widget loading/error/empty |
| `widget-gallery.tsx` | dialog (desktop) / sheet (mobile) with the six mini previews from the design SVGs |
| `widget-settings.tsx` | popover with the type's options (sprint select from `useSprints`, quarter select from `useObjectives` quarters, unit, person field from `qk.customFields` filtered to `user`, range) |
| `widgets/burndown-widget.tsx`, `velocity-widget.tsx` | compact bodies built from `features/reports/chart-kit.tsx` and the chart bodies extracted from `BurndownCard`/`VelocityCard` into `BurndownChart`/`VelocityChart` (`features/reports/charts.tsx` re-uses them; Reports looks the same) |
| `widgets/objectives-widget.tsx`, `workload-widget.tsx` | hb-row bar lists with tooltips (§1.3) |
| `widgets/my-tasks-widget.tsx`, `activity-widget.tsx` | list rows; toggle through `useUpdateTask`; activity text from `features/tasks/activity-text.ts` |
| `use-live-flash.ts` | keeps the previous data per widget, diffs rows by key after a refetch caused by someone else's event, returns `flash` keys (1.6 s), and raises the "Updated just now by X" toast (throttled 4 s) |
| `queries.ts` | `useDashboards`, `useDashboard`, the widget queries with `refetchInterval: useLiveInterval(POLL_MS)`, mutations |

`src/features/presence/`:

| File | What |
|---|---|
| `use-presence.ts` | `usePresence(location, { state, field, typing })`: the tab session, heartbeat, debounce, hidden-tab leave, `pagehide` keepalive DELETE, writes the PUT's `roster` into `qk.presence` |
| `use-typing.ts` | `useTypingSignal()` → `{ onKeyDown, onBlur, onSend }` with the 4 s / 5 s rules |
| `presence-lib.ts` | `peopleAt(roster, location, meId)`, `othersFirst`, `groupLabel` ("Jordan and Riley are here", "Jordan and 2 others are here"), `typingLabel`, `editingLabel`, `fieldFlags(roster, taskId, meId) → Map<field, person>` |
| `presence-stack.tsx` | the `pr` avatar stack (sizes 26/20, live ring, dot, +N, `role=group`) |
| `editing-pill.tsx`, `field-flag.tsx`, `typing-indicator.tsx` | the design's `pr-edit`, `flag`, `cm-ty` |

Edits to existing files:

- `board/task-card.tsx`: presence avatars and live border, from `fieldFlags`/`peopleAt` of the board's roster.
- `board/board-screen.tsx`: header stack; `usePresence({kind:"board"})`; pauses realtime application while dragging
  (§7.8).
- `tasks/task-detail.tsx`: header stack and editing pill; `usePresence({kind:"task"})` with `state/field` driven by
  which inline editor is open.
- `tasks/task-properties.tsx`: `FieldFlag` on rows.
- Description editor: border and flag when another person edits it.
- Comment composer: `useTypingSignal`; `TypingIndicator` under the thread.
- `notifications/queries.ts`, `workspace/queries.ts`, `filters/views.ts`, `board/board-screen.tsx`:
  `refetchInterval: useLiveInterval(POLL_MS)`.
- `lib/audit.ts`: §6.1 actions.

Appearance follows board 33 (`db-*`, `pr-*`, `tk-*`, `cm-*`, `gal-*` classes are the reference):

- token classes only; animate only transform and opacity (cards move by `transform: translate`, not `left/top`);
- reduced motion: no pulse, flash, dots or lift;
- 390 px stacks;
- navy, black and light themes.

### 7.7 Realtime client (`src/lib/realtime/`)

| File | What |
|---|---|
| `sse-parser.ts` | Incremental UTF-8 SSE parser (`TextDecoderStream`): `id:`, `event:`, `data:` (multi-line join with `\n`), `retry:`, comments (`:` lines, reported as `ping`), CR/LF/CRLF, BOM. Pure, unit-tested with chunk splits at every byte. |
| `source.ts` | `interface RealtimeSource { run(opts: { slug; lastEventId; signal; onEvent; onPing }): Promise<"ended" \| "unauthorized" \| "unavailable">` and `getRealtimeSource()` (live → `HttpRealtimeSource`, mock → `MockRealtimeSource` from `@/lib/mock/realtime`, loaded lazily like `getTransport`) |
| `http-source.ts` | `fetch(apiUrl + "/api/v1" + realtime.streamPath(slug) + "?v=1", { headers: { Accept: "text/event-stream", Authorization: "Bearer " + token, "Last-Event-ID"?: id }, credentials: "include", cache: "no-store", signal })` |
| `status-store.ts` | `createStore<RealtimeStatus>`; `useRealtimeStatus()`; `useLiveInterval(ms)` |
| `leader.ts` | one stream per browser per workspace: `navigator.locks.request("lightex-rt:" + slug, …)` elects the leader; events, status and `lastEventId` go to followers over `BroadcastChannel("lightex-rt:" + slug)`; followers post `{ visible: true }` every 20 s while visible. Without Web Locks or BroadcastChannel, every tab runs its own stream. |
| `apply-event.ts` | event → cache actions (§7.8); pure apart from the `QueryClient`; unit-tested |
| `provider.tsx` | `RealtimeProvider`: runs the loop (leader only), applies events in **every** tab, exposes `pause()` / `resume()` |

**Token handling (http-source).**

- Before each connect: if `tokenStore.get()` is null, call `(await getTransport() as HttpTransport).refresh()`.
- 401 → refresh once and retry once. Still 401 → status `off` and `authEvents.emit("expired")`.
- `reconnect` with reason `token_expiry` → refresh **before** reconnecting.
- The client never decodes the JWT.

**Visibility and lifecycle.**

- The leader connects while any tab of the workspace is visible, or was visible within the last 2 min.
- When all tabs have been hidden for 2 min, it aborts the stream.
- On `visibilitychange` to visible it reconnects immediately with `Last-Event-ID`, and the v1 refetch-on-focus still
  runs.
- `online`/`offline` events: offline aborts; online reconnects without backoff.

**Loop pseudo-code:**

```ts
while (!stopped) {
  status.set(attempt === 0 ? "connecting" : status.get());
  const outcome = await source.run({ slug, lastEventId, signal, onEvent, onPing: kickWatchdog });
  if (outcome === "unauthorized") { status.set("off"); authEvents.emit("expired"); return; }
  if (outcome === "unavailable" || ++failures >= 3) status.set("polling");
  await sleep(nextDelay(outcome, lastReconnectEvent, failures));   // §2.6 backoff
}
```

### 7.8 How events update the TanStack Query cache

`applyEvent(qc, ev, ctx)`:

- Invalidations are **batched** per animation frame plus 150 ms (a `Set` of serialised keys), and always use
  `refetchType: "active"`. Inactive queries are just marked stale.
- While the board is dragging (`provider.pause("board")`), events touching that project are queued and applied on drop
  (v1 already stops polling during a drag).

| Event | Cache action |
|---|---|
| `hello` (first after `connecting`/`polling`) | invalidate every active query under `["p", …]`, `["task", …]`, `["t", …]`, `["dashboard", …]`, `["notifications", …]`, `["presence", …]`, `["workspace", slug, …]` once; then `status = live` |
| `reset` | same as above |
| `task.changed` | Look the task up in the caches (`findTask` from `optimistic.ts` by `taskId`). If the cached `version >= data.version`, **skip** (own echo or already fresh). Otherwise invalidate `qk.task(slug, key)`, `qk.board(projectId, *)`, `qk.taskList(projectId)`, `qk.backlog`, `["p", projectId, "schedule"]`, `["p", projectId, "tasks", "mine"]`, `qk.summary`, `qk.activity`, `qk.reports(projectId)` (prefix), `qk.views(slug)`. `op: "deleted"` additionally removes the card at once (`removeTask`). If the open task panel shows `taskId` and `actorId !== me`, flag the toast with `fields[0]` mapped to a label ("PRJ-42 · Due"). |
| `tasks.bulk_changed` | invalidate `qk.scope(projectId)` and `qk.views(slug)` |
| `comment.changed` | `qk.comments(taskId)`, `qk.taskActivity(taskId)`, `qk.activity(projectId)`; `qk.task` (comment count) |
| `attachment.changed` | `qk.attachments(taskId)`, `qk.task` |
| `project.changed` | per area: `statuses` → `qk.statuses`; `labels` → `qk.labels`; `members` → `qk.members`, `qk.project`; `sprints` → `qk.sprints`, board, reports; `epics`, `objectives`, `milestones` → their keys and `qk.reports(projectId, "progress")`; `custom_fields` → `qk.customFields`; `settings` → `qk.project`, `qk.projects` |
| `dashboard.changed` | `op: "deleted"` → remove `qk.dashboard(id)`; if it is open, toast "This dashboard was deleted" and go to the index. `layout`/`updated` → if cached `version >= data.version` skip, else invalidate `qk.dashboard(id)`. **If you are in edit mode**, don't touch the draft; show the editing pill as information only (the save will 409 with the current version). Always invalidate `qk.dashboards(projectId)`. |
| `inbox.changed` | `setQueryData(qk.unread(), { count: data.unread })` for the workspace and the all-workspaces key; invalidate `qk.notifications` (prefix) |
| `access.changed` | invalidate `qk.workspace(slug)`, `qk.projects(slug)`, `qk.project` (prefix), `qk.me()`; the stream reconnects by itself |
| `presence.updated` | `setQueryData(qk.presence(slug, projectId), r => replaceLocation(r, data))`, ignoring snapshots whose `at` is older than the location's current `at` |
| unknown type | ignored (logged once in dev) |

Widget flashes and toasts: `use-live-flash` reads a small "last remote actor per query key" map that `applyEvent`
fills (actor id plus a widget or field label). When the refetch for that key completes with changed rows, it flashes
them and raises the toast once.

### 7.9 Fallback behaviour on screen

- **Status visible** only in the dev pill ("Realtime: live / polling / off"), and as the activity widget's "live"
  meta. There is no user-facing banner: polling is a working mode, not an error.
- **In polling mode:** presence avatars and editing pills still render (from heartbeats). Typing rows, flashes and
  "Updated just now" toasts are off.

### 7.10 Mock backend

New handler files, registered in `mock/transport.ts`:

- **`handlers/dashboards.ts`** (`registerDashboards()`):
  - DB1–DB6 with the same validation messages, limits, `version` handling and §4.3 rules;
  - W1 (points and hours, derived capacity from the mock's completed sprints);
  - `quarter` added to `GET /projects/:id/reports/progress` objective rows.
- **`handlers/presence.ts`** (`registerPresence()`): P1–P3 against an in-memory session table (not persisted to
  localStorage), with the same TTL rules. A 15 s sweeper (only while the tab is visible) expires sessions and publishes
  `presence.updated`.
- **`mock/realtime.ts`:**
  - `mockBus`: `publish(event)`, assigning increasing ids to durable events and keeping the last 500 for replay;
  - `MockRealtimeSource`:
    - subscribes to the bus filtered by the session user's projects;
    - emits `hello`, replays by `lastEventId` (older than the buffer → `reset`), then pings every 15 s;
    - ends with `reconnect` after 5 min;
    - honours mock controls `offline` (ends with a network error), `errorRate` (a failed connect counts as
      `unavailable`) and a new control `realtime: "live" | "polling"` ("polling" → `unavailable`, so the UI exercises
      the fallback).
- **Publishing points** mirror §6.2: `logActivity` and the mock audit helper call `mockBus.publish`; so do the task
  move and bulk handlers, `notify` (inbox), member and role changes, the dashboard handlers and the presence handlers.

**Simulated teammates** (the existing dev-pill control "Teammates edit tasks every ~45s", `mockControls.teammates`)
gains presence, in `mock/teammates.ts`:

- `startTeammates()` also starts `startPresenceSim()` with a **7 s** tick (the design's "live every 7s"), only while
  the tab is visible and `teammates` is on.
- Each tick picks from the current user's project members other than me (deterministic order, then a seeded random
  pick):
  - keeps up to 2 teammates **viewing** whatever location the user is on (board, dashboard or task), rotating one
    every ~30 s;
  - when the user has a task open: one teammate switches to **editing** a property field (`dueDate`, `priority`,
    `assigneeId`) for 10–20 s; another sometimes edits `description` (border and flag);
  - when the comment composer is visible: a teammate **types** for 3–5 s (typing row);
  - every 3rd tick on a dashboard: performs a real change through the mock DB (moves a sprint task one step, as
    `simulateTeammateEdit` does), which publishes `task.changed`, so the burndown, workload or my-tasks widget refetch,
    flash, and show "Updated just now by Riley · Burndown".
- Teammate sessions are written through the same presence store (so rosters, events and expiry behave like real
  ones).
- Turning `teammates` off clears them within one tick. e2e already sets `teammates: false`, so tests stay
  deterministic and see only their own presence.

**DB shape** (no `SCHEMA` bump; new collections are optional and created lazily, as boards 39 and 40 did):

```ts
interface MockDB {
  /* … */
  dashboards?: (Omit<Dashboard, "owner">)[];
  /** Board 33 upgrade marker for databases cached before v2. */
  ext33?: boolean;
}
```

`ensureExt33(db)` runs on first use of a dashboards route **and** from `createSeed()`:

1. Adds `dashboard.create` and `dashboard.manage` to cached **system** roles by key (§4.2).
2. Seeds the dashboards below if `ext33` is unset; sets `ext33 = true`.

### 7.11 Seed data (mock and `seed_demo`)

- PRJ: shared **"Sprint 14 health"**, owner `u_alex`, the design's default layout (Burndown 6×2, My tasks 3×2,
  Objective progress 3×2 with `quarter: "Q4"`, Workload 6×2, Velocity 3×2, Recent activity 3×2).
- PRJ: personal **"My focus"** for `u_sam`: My tasks 6×2, Recent activity 6×2.
- MOB: none (exercises "No dashboards yet").
- Riley Chen's custom role on PRJ is untouched (no dashboard keys), which tests the custom-role path.

---

## 8. Test plan

### 8.1 Backend (pytest, PostgreSQL; gates unchanged: ruff, mypy, coverage ≥ 85 %, `apps/access` ≥ 95 %)

**Test settings:** `REALTIME_BROKER = "local"`, `SSE_HEARTBEAT_SECONDS = 0.05`, `SSE_MAX_LIFETIME_SECONDS = 0.5`, and a
test hook `SSE_TEST_MAX_EVENTS` that ends the generator after N events. Use `freezegun` for TTLs.

- **Models and migrations:**
  - constraints: widget type unique per dashboard, `w`/`h` checks, name unique per owner (case-insensitive),
    presence `(user, session_id)` unique;
  - `makemigrations --check`;
  - the access data migration grants the §4.2 codes to system roles, is idempotent, and leaves custom roles alone.
- **Catalogue:** `GET /permissions` order; `my_permissions` equals §4.4 exactly; Sam's example; archived projects drop
  both codes.
- **Dashboards:**
  - DB1 lists shared plus own personal only, in order;
  - DB2: templates (including skipping report widgets for a custom role without `report.view`), every 422, both
    409 limits;
  - DB3: another user's personal → 404; non-member → 403 or 404 per §5.2;
  - DB4: rename, visibility by owner only, version conflict with `details.current`;
  - DB5: create, update and delete in one PUT; order; every 422 (including per-type `MIN_H`, config schemas, type
    change, duplicate type, adding a report type without `report.view`); version bumped once; one audit row;
  - DB6: hard delete, cascade;
  - the §4.3 truth table (owner/non-owner × create/manage × shared/personal);
  - removing a member deletes their personal dashboards;
  - IDOR suite entries for every new route;
  - permission-matrix entries for every new route and method (the suite fails without them).
- **Reports:**
  - W1: points and hours; capacity from 0, 1 and 3 completed sprints; unestimated counting; person custom field and
    its 422; unassigned bucket; no sprint; former member with work; constant query count for 5 vs 50 tasks;
    `report.view` required;
  - progress rows carry `quarter`.
- **Presence:**
  - P1 upsert and validation messages;
  - location visibility (task in another project 404, personal dashboard private);
  - the roster aggregates per user (editing beats viewing; typing any; `since` ordering);
  - TTL expiry: rows past `expires_at` are excluded from rosters, and the sweeper deletes them and publishes;
  - typing expires after 8 s;
  - P2 is idempotent;
  - P3 requires `filter[project]`;
  - events are published only on change, not on pure refresh;
  - throttle scope.
- **Publishing:**
  - `publish` sends nothing on rollback (`transaction.on_commit`);
  - `publish_for_audit` maps every audited action to the right event, with `fields` and `version`;
  - move, bulk, notification and membership publish explicitly;
  - durable events get increasing ids;
  - the advisory lock is taken (assert via `pg_locks` in a second connection, or by patching the SQL executor).
- **Stream view:**
  - 406 without the Accept header; 401; 404 for a non-member; 400 for an unknown `v`; 503 when disabled;
    503 `realtime_busy` when the semaphore is exhausted (set the cap to 1);
  - response headers;
  - `retry` and `hello` content (projects list = visible projects only);
  - heartbeat comment after idle;
  - filtering: events from a project the user isn't on are never written; user-targeted events only reach that user;
  - replay with `Last-Event-ID`: exact ids after the cursor; an older-than-retention cursor → `reset`; more than 500
    → `reset` `gap`;
  - ends with `reconnect` on lifetime, on token expiry (a token minted with a 20 s lifetime), and on `access.changed`;
  - the overflow path (queue size 2) → `reset` `slow_consumer`;
  - the DB connection is closed before waiting (`connection.connection is None` after the prelude).
- **Postgres broker integration** (marked `realtime_pg`; runs in CI against the service Postgres): a real
  `LISTEN` connection receives a `pg_notify` from a separate connection; the payload round-trips; an oversize payload
  uses `ref` and the listener reads the row; after the listener connection is killed (`pg_terminate_backend`) it
  reconnects and broadcasts `reset`.
- **gunicorn smoke** (`backend/scripts/sse_smoke.sh`, run manually and in the Docker check):
  - start the image with `--worker-class gthread --threads 4` and `SSE_MAX_STREAMS_PER_PROCESS=2`;
  - open 2 streams with curl, then: a third gets 503 `realtime_busy`; `GET /health` still answers in < 1 s; a task
    PATCH arrives on both streams within 1 s.
- **OpenAPI:** regenerate `docs/openapi.yaml` (stream documented as `text/event-stream`); the drift check passes.

### 8.2 Frontend (`npm run check`; Vitest with `--maxWorkers=2` on this machine)

- **Unit:**
  - `sse-parser` (every field, multi-line data, comments, CRLF, BOM, chunk boundaries at every byte, a partial event
    at stream end discarded);
  - `layout-lib` (`pack` with the shared vectors §8.3, `reorder`, `clampSize` per `MIN_H`, `rowsFor`, `layoutEquals`);
  - `presence-lib` labels ("Jordan and Riley are here", "Jordan and 2 others are here", "Sam is typing", "Sam and
    Riley are typing", "3 people are typing", "Jordan and 1 other are editing") and field flags;
  - `apply-event` (each row of §7.8 against a seeded `QueryClient`; version skip; batching; pause and resume;
    stale presence snapshot ignored);
  - `canEditDashboard` truth table;
  - backoff schedule;
  - `useLiveInterval`.
- **Realtime loop** (fake timers, a scripted fake source):
  - `hello` → live;
  - 3 failures → polling, with the board query's interval switching to 30 s;
  - recovery → live, with one blanket invalidation;
  - `reconnect` `token_expiry` calls `refresh()` before reconnecting;
  - 401 twice → `off` and `expired` emitted;
  - watchdog at 45 s;
  - hidden 2 min → aborted; visible → reconnect with `Last-Event-ID`;
  - leader election with two simulated tabs (BroadcastChannel polyfill in jsdom): one stream, both caches updated.
- **Mock handlers** (`mock.test.ts` style):
  - DB1–DB6, W1 and P1–P3: happy paths and every error code and message;
  - version conflicts;
  - the mock bus publishes the §6.2 events for a task PATCH, move, comment and notification;
  - `MockRealtimeSource` replay and `reset`;
  - `ensureExt33` upgrades a cached v1 DB exactly once;
  - the presence sim does nothing when `teammates` is false.
- **Permissions:** `can.test.tsx` covers both keys for all 7 roles. Role matrix in e2e:
  - Viewer (Taylor): Dashboards tab, no Edit layout, no New dashboard, report widgets hidden ("Nothing to show" on a
    reports-only dashboard; My tasks and Activity visible);
  - Member (Sam): New dashboard yes, Edit on own "My focus" yes, Edit on "Sprint 14 health" no;
  - Manager and Project Admin: edit everything shared.
- **e2e (Playwright, port 3100, `teammates: false`):**
  - open PRJ → Dashboards → "Sprint 14 health" renders 6 widgets;
  - Edit layout: drag Velocity before Workload (pointer); move with the keyboard (grip + →); resize Burndown to 12×2
    with the keyboard; remove Activity; Add widget → Activity back; Save → toast, reload, order persisted;
  - Cancel restores;
  - two browser contexts as Alex and Jordan: Jordan opens PRJ-42 → Alex's board card shows Jordan's avatar and the
    panel shows "Jordan is here"; Jordan opens the Due editor → Alex sees the "Jordan" flag on Due; Jordan types a
    comment → "Jordan is typing"; Jordan changes the due date → Alex's panel shows it within 2 s plus the toast;
    Jordan saves a layout while Alex is editing → Alex's save shows "Someone else changed this dashboard";
  - fallback: set the mock control `realtime: "polling"` → status polling, board refetches every 30 s (assert with
    the clock), presence still updates through the heartbeat, no typing row;
  - mobile 390: widgets stack, no Edit layout, gallery sheet from the empty state.
- **Visual sweep:** dashboard (ready, edit, gallery, loading, empty, error, nothing-to-show), board cards with
  presence, the task panel with pill, flags and description border, and the comments typing row. At 1440 and 390, in
  navy, black and light, as `u_taylor` and `u_alex`. No console errors and no horizontal page scroll.
- **Live mode:** against `seed_demo` with gunicorn gthread: every surface loads with no failed API call; DevTools shows
  one `stream` request per browser (not per tab); stopping the backend → polling; restarting → live with replay.

### 8.3 Shared packing vectors

`backend/apps/dashboards/tests/pack_vectors.json` and `frontend/src/features/dashboards/pack-vectors.json` (identical
files, checked by a test on each side that hashes both). Each case is `widgets [{type, w, h}]` → `rects [{x, y, w,
h}]`. Cases:

- the design default;
- all 3×1;
- 12×4 then 3×1;
- 6, 3, 3, 6, 3, 3;
- a 3×2 that back-fills a hole;
- an empty list.

The backend uses them only in the mock-parity test of `seed_demo`. They exist so the mock, the client and any future
server-side rendering agree.

---

## 9. Conflicts (design vs conventions) and resolutions

| # | Design | Conventions | Resolution |
|---|---|---|---|
| 1 | One role prop gates everything (`canEdit = role !== 'viewer'`) | Permissions only from `my_permissions`; 7 default roles; never role names | `dashboard.create` / `dashboard.manage` plus the §4.3 object rule; widget visibility by `report.view` / `project.view`; My-tasks toggle by the v1 status rule. |
| 2 | Any non-viewer can edit the (shared) dashboard's layout | A Member shouldn't be able to rearrange the team's dashboard without a grant | Members create and edit **their own** dashboards; shared dashboards they didn't create need `dashboard.manage` (Manager, Project Admin). |
| 3 | The viewer frame shows Burndown, Workload and Velocity | Viewer has no `report.view`; Reports is hidden for Viewers in v1 | Report widgets are not rendered without `report.view`; packing skips them; "Nothing to show" state when none remain (§1.7). |
| 4 | Workload capacity comes from a fixture (10/8 per person) | No capacity in the data model | Derived capacity: mean completed points (or logged hours) over the last 3 completed sprints; `null` → no tick. Explicit capacity is §10 #3. |
| 5 | Positions computed by first-fit packing of an ordered list (no x/y) | — | Kept: the stored layout is order + `w`/`h`; identical `pack()` on both sides with shared vectors (§8.3). |
| 6 | Row unit differs per frame (116, 128, 170 px) | One geometry | `U` = 152 px at ≥ 1024 px grid width, 128 px below; stacked heights from the design's `STACK`. |
| 7 | Live updates are a 7 s demo timer mutating fixtures | Real data and the agreed SSE exception | SSE events invalidate queries; the mock's teammate simulator runs on the design's 7 s cadence. |
| 8 | Description shows another person's characters streaming in with a named caret | Tiptap JSON, server truth, optimistic `version` writes; no co-editing engine | No character streaming. Presence `editing` on `description` shows the border and name flag ("Jordan"); the text updates after they save (`task.changed`). Co-editing is §10 #5. |
| 9 | Remote mouse cursor and remote text selection in comments | Would need ~20 updates/s per user over a request/response upstream; no WebSockets | Dropped. The typing indicator is kept. |
| 10 | "Jordan is editing" pill and field flags with no definition of "editing" | Behaviour needed | `editing` = an inline editor (field, description, property popover, dashboard layout) is open in that tab; `field` names it (§3.4). |
| 11 | Error meta "timeout · 3 widgets" | v1 `ErrorState` with status and request ref | Title kept; meta `<status> · request <ref>`. Widget-level failures are inline per card. |
| 12 | The crumb picker opens nothing; no sharing UI | Personal/shared and management must be reachable | Picker menu with the shared and personal sections, New, Rename, Share/Make personal, Delete (§1.6). |
| 13 | No widget configuration UI; widgets hard-code Sprint 14, Q4, points, S9–S13 | Real data needs a sprint, quarter, unit and range | Per-type config (§3.3) with defaults that reproduce the design; a gear popover in edit mode for types with options. |
| 14 | Gallery marks types "Added"; "N of 6 added" | — | Kept as a server rule: one widget per type per dashboard. |
| 15 | My-tasks checkbox toggles done locally | Status changes are server writes with `version`, permission-gated | Complete → first done status; Reopen → first todo status; v1 `useUpdateTask` (optimistic + rollback + toast); plain glyph without permission. |
| 16 | Toast "Updated just now by Riley" for every remote event, every 7 s | Toast noise; own changes | Only for others' events that change something on screen; at most one per 4 s; never in polling mode. |
| 17 | The mobile frame has its own top bar with title and avatars | App shell top bar + tabs at 390 | Keep the shell; the small avatar stack goes into `TopBarActions`; the dashboard name stays in the picker. |
| 18 | The sidebar project items lack Dashboards; the frame selects the project with no sub-item | v1 project `NavTabs` | New "Dashboards" project tab after Reports, shown with `project.view`. |
| 19 | The "Viewing now" stack always shows you (AK, no ring) | Avoid noise when alone | The stack renders only when at least one other person is present; you are then last, without a ring. |
| 20 | Empty state copy "Ask an editor to add widgets" for viewers | Gating by permission | Shown to anyone who can't edit this dashboard; "Add widget" to those who can. |
| 21 | Objective widget meta "Q4" from a fixture | Progress rows have no quarter | Additive `ProgressRow.quarter` plus config `quarter`; meta = the configured quarter or "All quarters". |
| 22 | Workload is in points only | Board 39 added time tracking | Config `unit: points \| hours`; hours = remaining estimate (estimate − logged), capacity from logged history. |
| 23 | Workload groups by assignee only | Board 39 Person custom fields exist | Optional `personField` (a Person custom field) in place of the assignee. |
| 24 | Live region messages for move, resize, add, remove, save, discard | v1 a11y | Kept verbatim (§1.4); keyboard reorder and resize as designed. |
| 25 | "Edit layout" is also implied on mobile (the empty state Add widget) | Drag and resize at 390 is unusable | No edit mode ≤ 760 px; the gallery still adds widgets from the empty state and saves at once. |
| 26 | `frontend/CLAUDE.md`: board 33 "planned next, not built", "No WebSockets or live presence"; freshness = polling | The user lifted the v2 ban and chose SSE | The "no WebSockets" rule stands. SSE is the agreed exception; polling stays as the fallback. CLAUDE.md is updated (§7). |
| 27 | Board 40 chose polling for import progress, pending a shared stream | One stream for everything | The `import.progress` event is reserved in the catalogue (§2.4); `useImportJob` keeps its 1 s poll in this release (§10 #8). |

---

## 10. Open questions

None blocks implementation; each has a default above that both sides build to.

**Deployment changes the user must make** (all required before `NEXT_PUBLIC_API_MODE=live` uses realtime). Until they
are done, the client simply runs in polling mode:

1. **Switch gunicorn to gthread.**
   - Change the Dockerfile `CMD` (§2.9). Backend work, but it is a deploy change.
   - Keep `WEB_CONCURRENCY=2` on the free plan and set `GUNICORN_THREADS=24` and `SSE_MAX_STREAMS_PER_PROCESS=16` (or
     rely on the defaults). That allows about 32 live browsers; the rest poll.
2. **Give the listener a direct database URL.**
   - **Neon:** set `REALTIME_LISTEN_DATABASE_URL` to the connection string **without `-pooler`** in the host. Keep
     `DATABASE_URL` on the pooler with `DB_POOLED=true`.
   - **Render Postgres** (the blueprint's `lightex-db`): nothing to do; `DATABASE_URL` is already direct.
   - Watch Neon compute hours. The listener only connects while someone has the app open, and is closed 60 s after
     the last stream. Presence heartbeats, though, keep the compute awake for as long as any tab is visible, which is
     no different from the app being used.
3. **CORS.** Add `last-event-id` to `CORS_ALLOW_HEADERS` (a setting change in `base.py`; backend work). No new origin is
   needed.
4. **Verify on the real host once:**
   - `curl -N -H "Authorization: Bearer …" -H "Accept: text/event-stream" https://<api>/api/v1/workspaces/<slug>/stream`
     prints `hello` immediately and a ping every 15 s (no buffering at Render's edge);
   - a deploy produces `reconnect`/network errors that clients recover from.
5. **Kill switch.** `REALTIME_ENABLED=false` returns everyone to polling without a frontend deploy.

Product and engineering questions:

1. **Polling as a safety net while live.**
   - Default: off. Commit-ordered ids, replay and `reset` close the known gaps, and refetch-on-focus remains.
   - The one unhealed case: a process crashes between a business commit and its event insert. The change then shows
     on the next focus or event.
   - If that matters, set the board and inbox to poll every 5 min while live.
2. **Workspace dashboards** (cross-project widgets) are not designed. They need workspace-level report endpoints and
   a workspace permission (`dashboard.create` in workspace scope).
3. **Explicit capacity.** Default: derived from history. If teams want to set it, add
   `ProjectMember.capacity_points` (nullable) edited in project members settings, and use it in W1 when set.
4. **Presence opt-out** ("appear offline"). Default: none; everyone on the project sees who is viewing. It would be a
   per-user preference that makes P1 store `private=true`.
5. **Co-editing and live cursors** (§9 #8, #9) need a different engine: a CRDT such as Yjs over a bidirectional
   channel, which is a WebSocket or a dedicated service. That would revisit the "no WebSockets" decision; out of scope
   here.
6. **Duplicate dashboard / set a project default dashboard.** Default: neither. The index opens your last dashboard.
7. **Scale beyond gthread** (more than about 32 concurrent browsers on 2 processes, or many busy projects). The next
   steps, in order:
   1. more processes and threads on a paid instance;
   2. `REALTIME_BROKER=redis` (Render Key Value) to drop the direct database connections;
   3. move only `/stream` to a small ASGI service (Starlette/uvicorn) that shares the database and broker, with the
      rest staying on gthread;
   4. replace the global advisory lock with per-workspace sequences.
8. **Import progress over the stream** (board 40). Default: keep the 1 s poll. Switching means emitting
   `import.progress` once per batch to project members with `project.import`, and making `useImportJob` use events
   when live and keep polling otherwise.
9. **Board presence for list, backlog and timeline views.** Default: board view only (the design shows the board). Add
   a `view` field to the `board` location to cover the others.

---

## 11. Delivery checklist

**Backend:**

- `apps/dashboards` (models, migrations, services with §4.3 rules, selectors, serializers, views, urls), templates and
  config validation.
- W1 workload and `ProgressRow.quarter`.
- `apps/realtime`: models and migrations, `publish`/`publish_for_audit`, Postgres, Redis and local brokers, hub with
  the listener thread and housekeeping, stream view, P1–P3, throttle scopes.
- The audit hook and the explicit publish points (§6.2).
- Catalogue, default roles and the access data migration.
- Settings and env vars (§2.9), `CORS_ALLOW_HEADERS`.
- Dockerfile CMD with gthread, `gunicorn.conf.py` (`worker_exit` hook), README deployment section.
- `seed_demo` dashboards.
- Tests (§8.1), the `sse_smoke.sh` script, regenerated `docs/openapi.yaml`.

**Frontend:**

- CLAUDE.md ban lifted and freshness rule reworded; final-report paper trail.
- Types, endpoints, query keys; `RequestOptions.keepalive`.
- Permissions catalogue, roles, `canEditDashboard`.
- `src/lib/realtime/*` (parser, sources, leader, status, apply-event, provider) and `useLiveInterval` adopted by the
  board, inbox and views.
- `features/dashboards/*` and `features/presence/*`; board, task panel, description and comment edits.
- Reports chart bodies extracted (`BurndownChart`, `VelocityChart`).
- Mock: dashboards and presence handlers, `mockBus` and `MockRealtimeSource`, the `realtime` mock control in the dev
  pill, the teammate presence simulator, `ensureExt33` and the seed.
- Tests (§8.2) and the visual sweep.

**Order:**

1. Ship after boards 39 and 40, which define the `PROJECT_ORDER` this contract extends and the Person field and time
   data that W1 can use.
2. Deploy the backend (with gthread and the listener URL) before a frontend that opens the stream. An older backend
   answers 404, and the client then polls (§2.10), so the order is safe either way.
