# Stage 2 contract: generic services

The parent document is `docs/platform-architecture.md` (sections 2, 7 and 12). Stage 1 is committed: the backend
lives in `core/` and `modules/tracking/`, and import-linter ignores about 48 core→tracking imports marked
`# Stage 2 removes`.

**Goal:** core holds no tracking-specific code. When this stage is done, the production `ignore_imports` list for
core→modules is **empty**. Core tests that exercise tracking behavior move under `modules/tracking/**/tests`. A
fake test module proves the platform is generic.

## 1. Target registry (`core/targets`, or `core/common/targets.py`)

- `register_target_type(key, resolver)`, where `key` is `module.entity` (for example `tracking.task`).
- Resolver protocol: `exists(workspace, id)`, `can_view(user, id)`, `can_comment(user, id)`, `can_attach(user, id)`,
  `describe(id) -> {title, link, ...}`, `workspace_of(id)`, and optional `subscribers(id) -> users` (who is notified
  about activity on the target, for example a task's assignee, reporter and watchers).
- Tracking registers `tracking.task` (and any other target it needs) in its AppConfig `ready()`.
- A management command `check_orphan_targets` reports references whose target no longer exists.

## 2. Generic comments and attachments (`core.collab`)

- Models refer to `workspace` (non-null FK) plus `target_type` and `target_id` (UUID). The task FK is removed, and a
  data migration fills the new columns from it.
- Routes (base `/api/v1/`):
  - `GET|POST targets/{targetType}/{targetId}/comments`
  - `GET targets/{targetType}/{targetId}/attachments`
  - `POST targets/{targetType}/{targetId}/attachments/upload-url`
  - unchanged: `comments/{id}`, `attachments/{id}`, `attachments/{id}/confirm`, `attachments/{id}/download-url`,
    `storage/*`.
  - **Removed:** `tracking/tasks/{ref}/comments`, `tracking/tasks/{ref}/attachments` and
    `tracking/tasks/{ref}/attachments/upload-url`.
- `targetId` is the record's UUID (for tasks, `task.id`, not the key).
- Permission checks go through the resolver. The tracking resolver uses the existing `tracking.comment.*` and
  `tracking.attachment.*` codes. The R2 flow, limits and allowlist are unchanged.
- Comment and attachment response objects gain `targetType` and `targetId`. Existing fields keep their names.
  A `taskId` field may stay only if it's derived without core importing tracking; otherwise drop it and the
  frontend uses `targetId`.

## 3. Domain events (`core.events`)

- A new app `core/events` owns `DomainEvent` (moved from notifications; keep the table through
  `SeparateDatabaseAndState` or a fresh migration). Fields: workspace, type, target_type, target_id, actor, payload,
  created_at, processed_at, attempts, error. The `project` FK goes into `payload`, or is derived by the resolver.
- `emit(type, workspace, target_type, target_id, actor, payload)` writes the row inside the caller's transaction.
  Dispatch runs `on_commit`, inline when no Celery worker is configured.
- `register_handler(event_type_pattern, handler, module=<key>)`. Handlers must be idempotent, and a failure records
  `attempts` and `error` for a safe retry. Store the handler's `module` now; Stage 3 skips handlers of disabled
  modules.
- Event type registry: modules declare their event types with a label and default notification channels
  (`register_event_type(key, label, default_channels, module)`). The notification preference matrix is built from
  this registry, not from a hard-coded list.

## 4. Notifications, audit, search, trash, realtime and access

- **Notifications:** generic. A notification refers to `target_type` and `target_id` and uses `describe()` for the
  title and link. Comment notifications are produced in core from the resolver's `subscribers()` and mentions, so the
  preference keys `tracking.comment.created` and `tracking.comment.mentioned` become `core.comment.created` and
  `core.comment.mentioned` (data migration). Task, sprint and other tracking notifications are emitted by
  tracking handlers. Existing response fields stay, and `targetType`, `targetId` and `link` are added.
- **Audit:** `AuditLog` gains `module`, `target_type` and `target_id`. Entity values are namespaced: `entity_type`
  becomes `target_type` with values like `tracking.task`. Response objects keep existing fields and add
  `module`, `targetType` and `targetId`.
- **Search:** `register_search_provider(module, provider)`, where the provider is
  `search(user, workspace, query, limit) -> [{targetType, targetId, title, link, ...}]`. `GET /search` and
  `GET /workspaces/{slug}/search` fan out across the registered providers. Keep the existing response shape, so
  tracking's provider returns what the endpoint returns today.
- **Trash:** modules register trashable kinds (list, restore, purge). The workspace trash lists items with a `module`
  field. The `trash/{kind}/{id}/restore` route keeps working, with namespaced kinds accepted (`tracking.task`) and
  the old bare kinds also accepted.
- **Realtime:** core must not import tracking. Anything presence or stream needs from tracking (for example who
  may see a project-scoped event, or a location's validity) goes through a registered hook. Collab realtime events
  become `core.comment.created|updated|deleted|restored|purged` and `core.attachment.created|changed|deleted`, with
  `targetType` and `targetId` in the payload.
- **Access:** project-scope `can()` must not import tracking. Tracking registers the scope provider for `project`
  (membership lookup and project role). `can(user, code, scope_obj)` stays the single decision point, with
  unchanged semantics and invariants.
- **Workspaces, roles and seed:** anything core does to tracking (creating defaults, cascading deletes, seeding demo
  data, test factories) moves into tracking, driven by events, registered hooks or a seeder registry.
  `seed_demo` keeps its command name and output.

## 5. Fake module test (mandatory)

A test-only app (for example `core/tests/fake_module`, installed only in test settings) registers target type
`fake.widget`, an event type, a search provider and a trash kind. Tests prove that, with no core changes, it gets
comments, attachments, comment notifications, search results and audit entries.

## 6. Frontend

- Comments and attachments call the `targets/{targetType}/{targetId}/…` routes (`targetType` `tracking.task`,
  `targetId` the task's id), in the client and in the mock.
- Realtime: `apply-event.ts` and the mock bus use `core.comment.*` and `core.attachment.*` with
  `targetType`/`targetId` payloads.
- Notification preference keys `core.comment.created` and `core.comment.mentioned`. Labels come from the
  `GET notification-preferences` response if the backend sends them; otherwise keep the frontend label table.
- Audit and trash handle namespaced `targetType` and kind values.
- Remove platform→tracking imports in `frontend/src/platform` where practical (registry-driven). Finish the
  Stage 1 leftovers: move `lib/mock`, `lib/realtime` and `lib/routes` to their proper homes (`src/api/mock`,
  `src/platform/realtime`, `src/platform/routes` or similar).
- Bump the mock `SCHEMA`.
