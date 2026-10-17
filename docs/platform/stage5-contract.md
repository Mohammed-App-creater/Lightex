# Stage 5 contract: cleanup

The parent document is `docs/platform-architecture.md` (sections 8, 12 and 13). Stages 1 to 4 are committed. Testing rule for
this stage: run **targeted** tests while working. The parent decides about one final full-suite run.

## 1. Backend

1. **Remove core→tracking database links.** `AuditLog.task` and `project`, the `Notification` task/project FKs,
   `RealtimeEvent` and `PresenceSession` project FKs, and anything similar become `target_type`/`target_id` (plus
   payload). Tracking-shaped `Notification.TYPES` become event-type keys from the registry. After this, no core model
   has an FK to a tracking model, and core migrations do not depend on tracking migrations.
2. **Workspace scoping.**
   - Every module and platform table, except global ones (users, the permission catalogue, auth tokens and
     similar), has a non-null `workspace` FK. Add it where it's derived through a parent today.
   - `core.common.WorkspaceScopedModel` with a default manager. Queries require `.for_workspace(ws)` or a workspace
     set in request context (middleware sets it from the resolved scope). Otherwise they raise. `.unscoped()` is the
     explicit escape hatch for management commands, migrations, Celery tasks given ids, and tests.
   - Apply it everywhere it fits. Where a model can't use it yet, list it with the reason in the report.
3. **Fresh migrations.** Delete every migration and generate a fresh `0001_initial` per app. Data migrations are dropped
   (there are no users). Include the permission sync and the default role seeding through post_migrate or the existing
   sync, not through migrations. Verify `migrate` on an empty DB and `makemigrations --check`.
4. **Seed.** Rebuild `seed_demo`:
   - one demo user per workspace role (Owner, Admin, Member) and per project role (Project Admin, Manager, Member,
     Viewer), with the same password pattern as today, documented in the README;
   - 3 teams with leads;
   - tracking enabled, and sales enabled in one workspace;
   - the existing tracking demo data.
   It stays idempotent. Its test is updated.
5. **Tenant isolation test.**
   - One parametrized test that walks the URL resolver for every `tracking/` and `sales/` route, plus the core
     workspace-scoped routes.
   - For each method it builds a request as a user of workspace A against an object of workspace B, and asserts
     404 (or 403 where that's the documented rule).
   - Routes that can't be auto-built get explicit cases. Skips are listed with reasons.
6. **Purge.** The trash purge must not delete comments or attachments whose target belongs to a disabled module.
7. **Data scope widening.** Changing a role's data scope to a wider one than the actor holds for that code returns 403
   `data_scope_exceeds_own`. Owners are exempt.
8. **Docs.**
   - `docs/platform/adding-a-module.md`: how to add a module in about ten steps, using sales as the example.
   - Update the backend README.
   - Update the root `CLAUDE.md` layout table (`backend/core`, `backend/modules`).
   - Update `docs/backend-plan.md` path references briefly.
   - Mark `docs/platform-architecture.md` stages 1–5 done in a short status line.
9. Regenerate `docs/openapi.yaml`. The schema must be accurate enough to generate a TypeScript client: run
   `--validate` with no warnings, and give operation ids and component names that are stable and meaningful.

## 2. Frontend (after the backend)

1. **Generated types.** Add `openapi-typescript` (dev dependency) and an `npm run gen:api` script that writes
   `src/api/schema.d.ts` from `../docs/openapi.yaml`. API request and response types in `src/api/types.ts` are
   derived from the generated schema (aliases into `components["schemas"]`), and no handwritten endpoint types remain.
   Where the frontend relies on a client-side computed field, keep a small extension type and comment it. A check
   (`npm run check:api` or a unit test) fails if `schema.d.ts` is stale.
2. The mock stays (mock mode remains the default) and is typed against the generated types.
3. Handle the realtime event `core.module.changed` `{module, enabled}`: refetch workspace and modules, and update
   the sidebar.
4. Update the docs: `frontend/CLAUDE.md`, `README.md`, `docs/api-contract.md`, and `docs/final-report.md`
   (Requested API additions now delivered, plus the remaining known gaps).
