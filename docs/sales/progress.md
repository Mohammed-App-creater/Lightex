# Sales module progress

Parent: `docs/sales/spec.md` §13. The API reference is `docs/sales/api.md`.

| Stage | Status |
|---|---|
| S0 core prerequisites | done: multiple workspace roles, workspace time zone, jobs framework, role seeding hook (`s0-contract.md`) |
| S1 reference data and customers | done: permissions and default roles, settings, stages, products, lost reasons, calendar, companies, contacts, duplicate check |
| S2 leads, opportunities and pipeline | done: leads and conversion, opportunities, stage history, pipeline board, won / lost / reopen, quotations, events |
| S3 activities and follow-ups | done: activities, follow-ups (buckets, completion), flags, notifications, digest job |
| S4 targets and performance | done: targets, allocation, effective targets, KPI service, status colors, performance and ranking |
| S5 daily reports | done: auto-built report, submit, review, reminders, team daily report |
| S6 dashboards and reports | done: role dashboards, management daily report and job, report engine, CSV export |
| S7 hardening | done: indexes checked, seed data, security review fixes, docs (this file) |

All stages are backend only; the frontend has not been pointed at the sales API yet.

## S7 (done, backend)

- **Indexes (spec §11):** all present since S2–S5, no migration needed: opportunities `(workspace, owner, stage)`,
  `(workspace, won_at)`, `(workspace, expected_close_date)`; follow-ups `(workspace, owner, status, due_date)`;
  activities `(workspace, owner, occurred_at)`; daily reports unique `(workspace, user, report_date)`; targets'
  two unique keys.
- **Seed data:** `python manage.py seed_demo_sales [--workspace slug] [--reset] [--force]` (`seed.py`; DEBUG only
  unless `--force`; idempotent). Written through the services, then back-dated. Not registered with `seed_demo`:
  that command mirrors the web client's mock fixture; run `seed_demo_sales --workspace platform` after it if wanted.
- **Owner / Admin:** no longer hold `sales.dailyreport.submit` by default (they got reminders and showed as missing in
  team daily reports). Migration `0006` removes the grant from existing workspaces.
  `sales.dailyreport.submit` is a **self-service** permission (`PermissionDef.self_service`): the no-escalation checks
  (assigning member roles, invitations, creating / editing roles, moving a deleted role's members) skip self-service
  codes, so anyone allowed to assign roles may grant them without holding them. Every other code still has to be
  held by the actor, and data scopes can't exceed the actor's own (owners exempt from the scope rule).
- **Security review fixes** (regressions in `tests/test_hardening.py`):
  - medium: assigning roles (member roles, invitations, moving a deleted role's members) checked permission codes but
    not data scopes, so someone with `manage_members` and a `team` sales role could give themselves CEO / GM (`all`).
    Now refused (`data_scope_exceeds_own`) unless the actor is an owner (`core/access/roles.ensure_scopes_within_own`).
  - low: a record endpoint answered 403 (missing action permission) before the scope check, revealing that an
    out-of-scope id exists. Now 404 when the caller holds the view code but the record is outside its scope; callers
    without the view code at all keep the plain 403 (`views.SalesRecordView.check_permissions`).
  - low: a crafted timeline cursor with a naive timestamp caused a 500; now 400 `invalid_cursor`.
- **Left as is (by design or low risk):**
  - dashboard and management-report lists show deal titles under the dashboard / report scope, not each record's own
    view scope. The default roles use one scope per role, so only a custom role mixing scopes is affected.
  - `core.audit.view` holders see every sales audit row whatever their sales scope (default: Owner / Admin only).
  - CSV export prefixes negative numbers with `'` (formula safety in `core/common/csvsafe.py`, shared with the web
    client's test vectors); spreadsheets read those cells as text.
  - clearing other contacts' primary flag isn't audited separately (the contact edit is).
- **Line endings:** there is no `.gitattributes`; files keep their committed endings (some sales files are CRLF).

### Spec §14 decisions (defaults, all editable)

1. Saturday weight 0 (set 0.5 in the calendar if half days are worked).
2. Salespeople see only their own companies and rely on the duplicate check (`exists` + owner name).
3. Fiscal year starts in January; weeks start on Monday.
4. Large-deal threshold 1,000,000.00 ETB.

### Known gaps

- Leads have no `noNextStep` / `stale` flags (opportunities do).
- Lead follow-ups are not moved to the opportunity on conversion.
- Who completed a follow-up is not stored (only when; the audit entry has the actor).
- The allocation tree leaves out users who are in no team.
- Daily report plan items' target references are not checked for existence.
- `daily_reports.submitters()` checks members' permissions one by one (fine for small teams).
- Reopen has no domain event; a dashboard / report scope wider than a record's view scope shows its title (above).

### Roles and scopes → screens

Default roles (api.md §2). Scope: own = records they own; team = their teams' members' records; all = everything.
Owner and Admin see everything with `all` (no daily report of their own). Member sees no sales screens.

| Screen | Sales Admin (all) | CEO / GM (all) | Sales Manager (team) | Salesperson (own) |
|---|---|---|---|---|
| Dashboard | company-wide | company-wide | team | own |
| Pipeline board, opportunities | full edit, delete, reopen | read only | create, edit, move, close, assign | create, edit, move, close own |
| Leads | full | read only | full (create, edit, delete, assign, convert) | create, edit, convert own |
| Companies, contacts | full incl. delete | read only | create, edit (no delete) | create, edit own; duplicate check |
| Quotations | full | read only | full | create, edit, send own |
| Activities, follow-ups | full | read only | full, reassign | log, edit, complete, delete own |
| Targets and allocation | view and manage all | view and manage all | view and manage team | view own |
| Daily report (mine) | submit | — | submit | submit |
| Team daily reports, review | all | all | team | own (read) |
| Performance and ranking | all | all | team | own |
| Reports and CSV export | all | all | team | — |
| Settings | yes | — | — | — |

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
