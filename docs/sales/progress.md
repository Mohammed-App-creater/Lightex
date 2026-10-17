# Sales module progress

Parent: `docs/sales/spec.md` §13. The API reference is `docs/sales/api.md`.

| Stage | Status |
|---|---|
| S0 core prerequisites | done (`docs/sales/s0-contract.md`) |
| S1 reference data and customers | done |
| S2 leads, opportunities and pipeline | next |
| S3–S7 | not started |

## S1 (done)

Backend only (`backend/modules/sales/`):

- The full permission catalogue of spec §3 and the four default roles (Sales Admin, CEO / GM, Sales Manager,
  Salesperson) in one grant table (`module.py`, printed in api.md §2). Owner and Admin get every sales code with
  `all`; Member gets none. The skeleton's `sales.health.view` and its health route are gone; the nav item needs
  `sales.dashboard.view`.
- Models and migration: SalesSettings, PipelineStage, Product, LostReason, SalesCalendar, Holiday, Company and
  Contact (soft-deleted, owned, normalized name and phone for the duplicate check, `(workspace, owner)` indexes).
- API: settings, stages (CRUD and reorder, won/lost invariants), products, lost reasons, calendar, holidays,
  companies (filters, search, sorting, cursor pages, summary stub, duplicate check), contacts.
- Platform: `sales.company` and `sales.contact` collab targets, search provider, trash kinds, audit filter groups.
- Tests: `modules/sales/tests/` (permission matrix for every sales route and every default role, data scope, tenant
  isolation via the resolver walk in `modules/tracking/tests/access/test_tenant_isolation.py`, module disabled,
  duplicate-check leak-proofing, stage invariants, collab, search).

### Decisions

- URL scheme: `sales/workspaces/{slug}/<collection>` for collections, `sales/<collection>/{id}` for records.
- Out-of-scope records answer 404; in view scope but outside the action's scope answer 403.
- Owner changes on companies and contacts need the `edit` code with scope `team` or `all` (no `assign` code exists).
- Defaults (settings, five stages, calendar) are seeded lazily and idempotently on first read, not from the enable
  path (core has no per-module enable hook).
- Reference data reads need `sales.dashboard.view`; writes need `sales.settings.manage`.
- Every sales role also grants `core.workspace.view`.
- Company deletion soft-deletes its contacts with it; restoring the company restores them.
- Large-deal threshold default: 1,000,000.00 ETB (spec §14 open decision 4; editable in settings).

### Deferred to later stages (hooks left in place)

- `services.stage_in_use`, `product_in_use`, `lost_reason_in_use`, `company_has_opportunities` answer False until S2
  adds opportunities and leads.
- Company summary: opportunity fields (S2), follow-ups, last contact and timeline (S3).
- Collab target types `sales.lead`, `sales.opportunity`, `sales.quotation` (S2), registered in `hooks.py` like the
  S1 ones.
- Automatic `active` status on the first won deal (S2).
- No domain events in S1 (spec §9 lists none for companies and contacts).
