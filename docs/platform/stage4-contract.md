# Stage 4 contract: teams and data scope

The parent document is `docs/platform-architecture.md`, section 6. Stages 1 to 3 are committed: there is a module registry, the
permission catalogue is assembled from ModuleDefinitions, and the Stage 2 fake module is available for tests.

## 1. Teams (`core/access`, or a `core/teams` app)

- `Team`: workspace (FK, non-null), name (unique per workspace, case-insensitive), description (blank allowed),
  created_at, plus soft delete if the base model offers it.
- `TeamMember`: workspace (FK, non-null), team, user, is_lead. Unique on (team, user). Teams are flat, and a user may
  be in several teams.
- A team member must be a workspace member. Removing someone from the workspace removes their team memberships.
- Reads are open to any workspace member. Writes need `core.teams.manage`. Every write is audited
  (`core.team.created|updated|deleted`, `core.team.member_added|member_removed|member_updated`).
- API (base `/api/v1/`):
  - `GET|POST workspaces/{slug}/teams`. List items: `{id, name, description, memberCount, leadIds: string[],
    createdAt}`. Create takes `{name, description?}`. Reusing a name gives 409 `team_name_taken`.
  - `GET|PATCH|DELETE teams/{id}`. Detail is the list item plus `members`.
  - `GET|POST teams/{id}/members`. POST takes `{userId, isLead?}`. A user outside the workspace gives 400
    `not_a_workspace_member`; one already in the team gives 409 `already_a_member`.
  - `PATCH|DELETE teams/{id}/members/{userId}`. PATCH takes `{isLead}`.
  - Member item: `{userId, name, email, avatarUrl, isLead}`. Copy the user fields from the existing
    workspace member serializer.
  - Tenant rule: a team from another workspace gives 404.
  - (The doc says "under `/api/v1/teams`". The list and create routes are nested under the workspace like every other
    collection.)

## 2. Scopable permissions and data scope

- `PermissionDef` and `Permission` gain `scopable: bool` (default false). `GET permissions` returns `scopable`.
  Scopable permissions are workspace scope only in this phase.
- `RolePermission.data_scope`: nullable, one of `own`, `team`, `all`. It's required when the permission is scopable
  and null otherwise; the service layer enforces this, and the sync and seed code must comply.
- `default_role_grants` in ModuleDefinition can give a scope for scopable codes. Unless the module says otherwise,
  Owner and Admin get `all` and Member gets `own`.
- **Role permissions API:** the existing role-permission update request gains `dataScopes: {code: scope}`.
  Granting a scopable code without a scope gives 400 `data_scope_required` (details `{codes}`); giving a scope for a
  non-scopable code gives 400 `data_scope_not_allowed`. Role responses that list permissions gain
  `dataScopes: {code: scope}`. Keep the existing request and response fields as they are.
- Workspace responses gain `myDataScopes: {code: scope}` for the scopable codes the user holds (disabled modules
  excluded). Project responses gain it too, holding the same workspace-level map, for symmetry.

## 3. visible_to

- `visible_to(queryset, user, code, workspace) -> queryset` in `core/access` is the single place data scope is
  applied. The model declares its owner field with a class attribute (for example `data_scope_owner_field = "owner"`).
- Semantics:
  - no grant, or the module is disabled → `queryset.none()`;
  - `own` → owner == user;
  - `team` → the owner shares at least one team with the user (as member or lead), including the user's own records;
  - `all` → the whole workspace.
  It always filters by workspace.
- Calling it with a non-scopable code raises an error (a programming mistake), and so does a model without an owner
  field.
- Tests use the fake module: give it a scopable `fake.widget.view` and a Widget model with an `owner`. Cover own, team
  and all, users in several teams, leads, users in no team, cross-workspace isolation, and a disabled module.
  `core.access` coverage must reach 95% (`coverage report --include="core/access/*" --fail-under=95`); add tests for
  `can()` workspace-scope paths inside core if moving tests in Stage 2 lowered it.

## 4. Frontend

- Types and client for teams (section 1), `scopable` on catalogue entries, `dataScopes` on roles, and
  `myDataScopes` on workspace and project. Add a `useDataScope(code)` hook next to `useCan`. The mock implements all of
  it, including the error codes and the `team_name_taken` / `already_a_member` conflicts.
- **Settings → Teams** (`/[workspace]/settings/teams`): list teams; create, rename and delete; manage
  members (add from workspace members, remove, toggle lead). The page is readable by members, and write controls
  are gated by `core.teams.manage` with a `disabledReason`.
- **Role editor:** scopable permissions show an Own / Team / All selector when granted, and saving sends
  `dataScopes`. No real module has a scopable permission yet, so unit-test the selector with a fixture catalogue.
- Bump the mock `SCHEMA` and seed a few teams.

## 5. Details settled by the frontend (the backend must match)

- The team list is not paginated and is sorted by name, case-insensitively. Create and PATCH return the full team detail
  (with `members`).
- `name` is 1–60 characters and `description` up to 280, otherwise 422 using the API's usual validation error. Deleting a team is a soft delete.
- An unknown `dataScopes` value gives 422. A role update that leaves out `dataScopes` keeps the stored scopes.
- Team writes publish no realtime event.
