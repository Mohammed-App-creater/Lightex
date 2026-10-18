# Sales S0 contract: core prerequisites

Parent: `docs/sales/spec.md` §2 and §13 (S0). Backend paths are under `backend/core/`. The schema is
`docs/openapi.yaml`. Old request and response fields still work, so a frontend that hasn't been updated keeps running.

## 1. Several workspace roles per member

- A workspace member holds **one or more** workspace-scope roles (`WorkspaceMemberRole`: workspace, member, role;
  unique on (member, role)). A member always has at least one role. Project roles are unchanged: one per project
  member.
- **Effective permissions** are the union of every role's grants. For a scopable code, the widest data scope across
  the roles wins (`all` > `team` > `own`). This drives `can()`, `visible_to()`, `my_permissions` and `myDataScopes`.
- **Role precedence** sets the order of `roleIds` and picks the "primary" role (`roleId`, `roleName`, `myRoleId`):
  Owner, then Admin, then Member, then every other role by name (case-insensitive). `roleId` is always `roleIds[0]`.

### Responses
| Shape | Change |
|---|---|
| `WorkspaceMember` | gains `roleIds: string[]` (in precedence order). `roleId` stays and is the primary role. |
| `Workspace` | gains `myRoleIds: string[]` and `timezone: string`. `myRoleId` stays and is the primary role. |
| `Invite` | gains `roleIds: string[]` and `roleNames: string[]` (same order). `roleId` and `roleName` stay and are the primary role. |
| `Role` | `memberCount` counts the active members holding the role, whatever other roles they hold. |
| Search `user` result | `roleName` is the primary role's name. |

### Requests
- `PATCH /workspaces/{slug}/members/{userId}` takes `{roleIds: string[]}` and **replaces** the member's roles. The old
  `{roleId}` still works and means `roleIds: [roleId]`. When both are sent, `roleIds` wins. The response is the
  member.
- `POST /workspaces/{slug}/invites` takes `{emails, roleIds: string[]}`. The old `{emails, roleId}` still works. On
  accept, the new member gets every role on the invite.
- The member list filter `?role=<id>` (repeatable) returns members holding **any** of the given roles.

### Errors
- `roleIds` not a list or empty, or neither field sent → 422 `validation_failed`, `details.fields.roleIds` = "Pick
  at least one role".
- Any id in `roleIds` that isn't a workspace role of this workspace (unknown, malformed, from another workspace, or
  project scope) → 422 `validation_failed`, `details.fields.roleIds` = "Pick workspace roles". With the old field,
  the error is `details.fields.roleId` = "Pick a workspace role", as before. Duplicate ids are ignored.
- No privilege escalation: adding or removing a role whose permissions the actor doesn't hold → 403 `forbidden` with
  `details.permission`. Roles the member keeps are not checked.
- **Last Owner:** a change that leaves the workspace with no active member holding `core.workspace.delete` → 409
  `last_owner`. This covers removing the Owner role from the last owner (even when they keep other roles), removing
  the last owner, deleting a role, and editing a role's permissions. There is no member deactivation endpoint.
- `DELETE /roles/{id}` with `reassignTo`: holders of the deleted role get the target role (no duplicates), and pending
  invites carrying the role get the target in its place. Without `reassignTo`, a role still held by a member → 409
  `role_in_use` (unchanged). Invites whose only role is deleted are deleted with it, as before.
- Audit: `core.member.role_changed` and `core.member.invited` record the roles on the field `Roles` (names in
  precedence order, joined with ", "). The invitation email names every role.

## 2. Workspace timezone

- `Workspace.timezone`: an IANA name, default `Africa/Addis_Ababa`. It's in every workspace response as `timezone`
  and editable with `PATCH /workspaces/{slug}` `{timezone}` (permission `core.workspace.update`, audited as a
  `Time zone` change). An unknown name → 422 `validation_failed`, `details.fields.timezone` = "Pick a valid time
  zone".
- Helpers (`core/workspaces/timezone.py`): `workspace_zone(ws)`, `workspace_now(ws, now=None)` (an aware datetime
  in the workspace zone), `workspace_today(ws, now=None)`, `local_date(ws, instant)`, `day_bounds(ws, day)` and
  `range_bounds(ws, first_day, last_day)`. The last two return half-open UTC `[start, end)` instants for filtering
  timestamps by local business dates.

## 3. Scheduled jobs (`core/jobs`)

- `register_job(name, func, *, module=None, schedule="", description="")` from a module's `ready()`. `func(workspace,
  *, now)` runs once per workspace. `now` is the run's instant in the **workspace timezone**. Each workspace runs in
  its own transaction, scoped to that workspace, so one workspace's failure doesn't stop the others. Workspaces where
  `module` is disabled are skipped, and so are soft-deleted workspaces.
- Idempotency: `claim(workspace, job, key) -> bool` inserts a `JobMark` row keyed by (workspace, job, key). It
  returns False when the key was already claimed, so "running twice sends once" (for example the key
  `"2026-10-17"` for a daily digest). A failed run rolls the mark back.
- Command: `python manage.py run_job <name> [--workspace <id>]`, plus `run_job --list`.
- Celery: the task `core.jobs.run_job(name, workspace_id=None)` calls the same runner. No beat schedule ships.
- HTTP: `POST /api/v1/internal/jobs/{name}` with the header `X-Jobs-Secret: <JOBS_SECRET>` and an optional body
  `{workspaceId}`. There's no user auth.
  - If `JOBS_SECRET` is unset or blank, every call is refused. A missing or wrong header → 403 `forbidden` (the
    secret is compared in constant time). An unknown job → 404 `not_found`, checked after the secret. An unknown or
    deleted `workspaceId` → 404 `not_found`.
  - 200 `{job, ran, skipped, failed, workspaces: [{workspaceId, status: "ran"|"skipped"|"failed", error?}]}`.
    `error` is the exception class name only. A failed workspace still returns 200; the command exits non-zero.
  - It has no CSRF exposure, because there is no cookie auth. The default anonymous throttle applies (per IP).

## 4. Module-contributed default roles

- `ModuleDefinition.default_roles: tuple[DefaultRole, ...]`, where `DefaultRole(key, name, description="", grants={code:
  scope | None})`. Grants may name the module's own workspace codes and core codes. A scopable code takes `own`,
  `team` or `all` (None means `own`), and a non-scopable code takes None. `key` is the role's `system_key` (prefix it
  with the module key, for example `sales_salesperson`).
- Seeding happens when a workspace is created with the module, and every time the module is enabled. It creates each
  missing role as a system role (it can't be deleted or renamed, but its permissions are editable). A role that
  already exists, found by `system_key`, is left exactly as it is, so admin edits survive. If the name is taken by
  another role, the new role is called `<name> (<module name>)`. If that name is taken too, the role is skipped.
  Seeding raises `LookupError` for a code that isn't a workspace permission.
- Disabling the module keeps the roles and their members. The role's grants of the disabled module are hidden, as for
  every role.

## 5. `OwnedModel`

`core.common.models.OwnedModel` is an abstract model with `owner` (FK to the user, nullable, `SET_NULL`, no
reverse accessor) and `data_scope_owner_field = "owner"`. Combine it with `WorkspaceScopedModel` or
`WorkspaceScopedSoftDeleteModel`.
