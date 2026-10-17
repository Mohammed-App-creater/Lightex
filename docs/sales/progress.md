# Sales module progress

Parent: `docs/sales/spec.md` §13. The API reference is `docs/sales/api.md`.

| Stage | Status |
|---|---|
| S0 core prerequisites | done (`docs/sales/s0-contract.md`) |
| S1 reference data and customers | done |
| S2 leads, opportunities and pipeline | done (backend) |
| S3 activities and follow-ups | next |
| S4–S7 | not started |

## S2 (done, backend)

Backend only (`backend/modules/sales/`; the API is api.md §9–§13):

- Models and migration `0002_pipeline`: Lead, Opportunity (with `version`), OpportunityStageHistory, Quotation and
  SalesSequence (per-workspace counters). Spec §11 indexes on opportunities: `(workspace, owner, stage)`,
  `(workspace, won_at)`, `(workspace, expected_close_date)`.
- Code: `pipeline_selectors.py` (reads, pipeline board, timeline, company deal totals), `pipeline_services.py`
  (writes), `pipeline_serializers.py`, `pipeline_views.py`, and `periods.py` (day / week / month / quarter / fiscal
  year periods in the workspace time zone, with `previous()` and UTC `bounds()`, for S4 and S6 to reuse).
- API: leads (CRUD, filters, qualify, disqualify, convert, bulk assign), opportunities (CRUD, move, won, lost,
  reopen, bulk assign, timeline), the pipeline board, quotations (CRUD, send, accept, reject).
- Filled S1 hooks: `stage_in_use`, `product_in_use`, `lost_reason_in_use`, `company_has_opportunities` (all count
  trashed records too); the company summary's opportunity count, pipeline value and won value.
- Platform: collab targets `sales.lead`, `sales.opportunity`, `sales.quotation`; search types `lead`,
  `opportunity`, `quotation`; trash kinds for all three; audit groups `lead`, `opportunity`, `quotation`; event
  types (spec §9, S2 subset, no preference rows yet); job `sales_expire_quotations` (`daily 00:15`).
- Tests: `test_leads.py`, `test_opportunities.py`, `test_quotations.py`, `test_pipeline_platform.py`, the permission
  matrix rows for every new route, and the tenant-isolation kwargs (`lead_id`, `opportunity_id`, `quotation_id`).

### Decisions

- Records: soft-deleted and owned, same URL scheme and 404 / 403 rules as S1. Owner changes on leads and
  opportunities use their `assign` codes with S1's owner rule (`team` scope: a team-mate).
- `qualify` / `disqualify` use `sales.lead.convert`; `send` / `accept` / `reject` use `sales.quotation.edit`.
  Converted leads are read-only (409 `lead_converted`); disqualified leads must be qualified before converting.
- Conversion links before it creates: the lead's company, else a company **in the caller's view scope** matching
  the duplicate check's normalized name or phone; contacts by name at that company. New records are owned by the
  lead's owner.
- Bulk assign is all or nothing: 422 for ids outside the view scope, 403 for ids outside the assign scope.
- `version` increases on every opportunity change; it is required on `move`, optional (checked when sent) on edits
  and the close actions. A conflict returns the current record in `details.current`.
- Won date back-dating: an earlier business date needs `close` scope `team` / `all` and must be in the current
  **calendar month** in workspace time (`periods.CLOSING_PERIOD`). A date-only `wonAt` means 12:00 workspace time
  (today's date means now); naive timestamps are workspace time; never in the future.
- Won makes the company `active` whatever its status (archived customers who buy again come back).
- Reopen has no domain event (spec §9 lists none); it is audited with the cleared values.
- `creditedUser` changes only through an explicit edit with `sales.opportunity.reopen`; reassignment never touches it.
- Quotations are always owned by the opportunity's owner (synced on reassignment and restore). Numbers come from a
  locked per-workspace, per-year counter row, never reused.
- Pipeline board: open stages only (won / lost through the list's `filter[status]`); column cards continue on the
  list endpoint with the column's `nextCursor`. `leadCount` counts open leads (`new`, `contacted`, `qualified`).
- Timeline: one item shape for every kind (`stageChange`, `quotation`, and `activity` / `followUp` reserved for S3),
  cursor-paged on `(at, id)`; children appear whatever their own owner.
- `Opportunity.company` and `.stage` use `RESTRICT` (a whole-workspace delete still cascades); the company trash kind
  purges a workspace's opportunities before its companies.

### Deferred to S3 (hooks left in place)

- `flags.noNextStep` and `flags.stale` are in the response and always false; `lastActivityAt` stays null.
- Spec §5's "quotation activity entry" on send: `pipeline_services.on_quotation_sent()` is the hook; the timeline
  shows a `quotation_sent` item meanwhile. S3 appends its timeline sources to `pipeline_selectors.TIMELINE_SOURCES`.
- Notification types (opportunity assigned to you, won, quotation expiring) and their preference rows.
- The company summary's follow-up, last-contact and timeline fields.

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
