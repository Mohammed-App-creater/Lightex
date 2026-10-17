# Lightex Sales Module Specification (v1)

Status: approved scope, ready to build.
Depends on: `docs/platform-architecture.md` (platform core and modules). Everything here is a **module** named `sales`, built under `backend/modules/sales` and `frontend/src/modules/sales`, following the architecture document's rules (namespacing, `can()` / `visible_to()`, generic collab services, domain events, workspace scoping, import rules). If this document conflicts with the architecture document on platform behavior, the architecture document wins, except for the core prerequisites in section 2, which amend it.

> **Repo mapping (added when the spec was committed):** "platform" in this document means the backend core package
> `backend/core/` (it is not called `platform` because that clashes with the Python stdlib). So `platform.jobs` is
> `core/jobs`, and the `OwnedModel` mixin is added to `core/common/models.py` in S0 (an abstract model with an `owner`
> foreign key and `data_scope_owner_field = "owner"`). Stage contracts and progress notes live next to this file.

## 1. Purpose and scope

A sales performance and CRM system for sales teams: customers, leads, a pipeline, activities, follow-ups, targets from annual down to daily, auto-built daily reports, salesperson performance, and management dashboards and reports. It is based on the team's proposal, reduced to the sales part.

**Decisions (confirmed):**
- **Actual sales** = the value of opportunities marked **Won**, counted on the won date, credited to the user who owned the opportunity when it was won.
- **Currency**: ETB only. Store amounts as `Decimal(14,2)`; no currency field in v1.
- **Working calendar** (working-day weights and holidays) drives daily and weekly target calculation.
- Dates and "today" are computed in the **workspace timezone** (default `Africa/Addis_Ababa`). Timestamps are stored in UTC, dates for business days are stored as dates.

**In scope:** dashboards, customers (companies and contacts), leads, opportunities and pipeline, light quotations, activities, follow-ups, targets and allocation, working calendar, daily reports with manager review, salesperson performance and ranking, reports, settings, notifications, scheduled jobs.

**Out of scope for v1:** contracts, projects, delivery, invoices and payments, sales orders, customer support, email integration, native mobile apps (the UI must be responsive and PWA-friendly), multi-currency, CSV import, Ethiopian calendar display (store Gregorian; reserve a display setting only), forecasting beyond weighted pipeline. The `sales.opportunity.won` event is the future hand-off point to contracts and projects.

## 2. Core prerequisites (changes to the platform, do these first)

1. **Multiple workspace roles per member.** A member may hold several workspace-scope roles (for example `Member` plus `Salesperson`). Replace the single role on `WorkspaceMember` with a many-to-many (`WorkspaceMemberRole`). Effective permissions are the union; for scopable permissions the widest data scope wins (`all` > `team` > `own`). Update `can()`, `visible_to()`, `my_permissions`, `my_data_scopes`, invitations (assign one or more roles), the member list and role editor UI, and tests. Invariants about the last Owner still hold.
2. **Workspace timezone.** Add `timezone` (IANA name, default `Africa/Addis_Ababa`) to `Workspace`, editable in workspace settings, exposed in workspace responses, and used by a shared helper `workspace_today(workspace)`.
3. **Scheduled jobs.** Add `platform.jobs`: a registry where modules register named, idempotent jobs with a suggested schedule; a management command `run_job <name> [--workspace ID]`; and `POST /api/v1/internal/jobs/{name}` protected by a shared secret header (for free hosts that only support external cron). Jobs run per workspace in the workspace timezone and skip workspaces where the module is disabled. Celery beat may call the same registry when available.
4. **Module-contributed default roles**: confirm the architecture's seeding hook works for workspace-scope roles contributed by `sales`.
5. Replace the sales skeleton (`sales.health.view`) with the real module while keeping the module guard.

## 3. Roles and permissions

All permission codes are `sales.resource.action`, scope `workspace` (sales has no project scope). **S** marks a scopable permission that carries a data scope (`own`, `team`, `all`) defined by the role.

| Code | S | Meaning |
|---|---|---|
| sales.dashboard.view | S | See dashboards aggregated over the visible users |
| sales.company.view / edit / delete | S | Companies |
| sales.company.create | | Create companies |
| sales.contact.view / edit / delete | S | Contacts |
| sales.contact.create | | |
| sales.lead.view / edit / delete / assign / convert | S | Leads; assign means change owner |
| sales.lead.create | | |
| sales.opportunity.view / edit / move / close / delete / assign | S | Opportunities; close means won or lost; reopen requires `close` plus `sales.opportunity.reopen` |
| sales.opportunity.create | | |
| sales.opportunity.reopen | S | Reopen won or lost opportunities |
| sales.quotation.view / edit / delete | S | Quotations |
| sales.quotation.create | | |
| sales.activity.view / edit / delete | S | Activities |
| sales.activity.create | | |
| sales.followup.view / edit / complete / reassign / delete | S | Follow-ups |
| sales.followup.create | | |
| sales.target.view | S | See targets |
| sales.target.manage | S | Set and allocate targets for users within scope (a manager with `team` sets targets for team members; `all` includes team and company targets) |
| sales.dailyreport.submit | | Submit your own daily report |
| sales.dailyreport.view / review | S | View and review daily reports |
| sales.performance.view | S | Salesperson performance pages and ranking |
| sales.report.view / export | S | Reports and CSV export |
| sales.settings.manage | | Products, lost reasons, stages, calendar, thresholds, report cutoff |

### Default roles (workspace scope, seeded when the module is enabled, editable)
| Role | Data scope | Highlights |
|---|---|---|
| Sales Admin | all | Everything, including `sales.settings.manage` |
| CEO / GM | all | View everything, dashboards, performance, reports and export, review daily reports, manage targets; no day-to-day record editing |
| Sales Manager | team | Create, edit, assign, move and close within team; manage team targets; review team daily reports; reports and export |
| Salesperson | own | Create and edit own companies, contacts, leads, opportunities, quotations, activities and follow-ups; submit daily report; view own performance and targets; own dashboard |

A Project Manager role is not part of v1 (it belongs with the future projects module). Because members may hold several roles, a user can be a plain workspace Member and a Salesperson at once.

### Data scope rules
- Every owned record has an `owner` (users). `visible_to()` is applied to every list, search, dashboard and report query for scopable permissions.
- **Child records** (activities, follow-ups, quotations) are scoped by their own `owner`; the opportunity or company timeline endpoint additionally returns all children of a parent the user can view.
- **Duplicate check**: `GET /sales/companies/check-duplicate?name=&phone=` returns only `exists` and the owner's display name even if the company is outside the caller's scope (so salespeople avoid creating duplicates without seeing details).
- Reassigning a record needs the `assign` / `reassign` permission within scope and writes an audit entry.

## 4. Data model

All tables have `workspace`, `created_at`, `updated_at`. Records marked (soft) have `deleted_at`. "Owner" tables use the platform `OwnedModel` mixin for data scope.

### Reference and settings
| Table | Fields |
|---|---|
| SalesSettings (1 per workspace) | week_start (default Monday), fiscal_year_start_month (default 1), status_green_pct (100), status_yellow_pct (70), upcoming_days (7), stale_days (14), large_deal_threshold (Decimal), daily_report_cutoff (time, default 18:00), daily_report_required (bool), quotation_validity_days (30) |
| PipelineStage | name, order, category (`open` / `won` / `lost`), default_probability (0-100), is_system. Defaults: Opportunity 20, Quotation 40, Negotiation 70 (open); Won 100; Lost 0. Exactly one won and one lost stage (system, not deletable); open stages can be added, renamed, reordered, removed when empty |
| Product | name, code, category, is_active |
| LostReason | name, is_active |
| SalesCalendar (1 per workspace) | weekday weights for Mon..Sun (default Mon-Fri 1.0, Sat-Sun 0; allows 0.5 for half days) |
| Holiday | date, name (unique per workspace and date) |

### CRM
| Table | Key fields |
|---|---|
| Company (soft, owned) | name, normalized_name, industry, region, city, address, phone, email, website, status (`prospect` / `active` / `inactive`; becomes `active` automatically on first won deal), notes |
| Contact (soft, owned) | company, name, job_title, phone, email, is_primary, notes |
| Lead (soft, owned) | source (referral, website, call, event, visit, social, other), company (nullable), company_name_text, contact (nullable), contact_name, phone, email, product, estimated_value (nullable), status (`new` / `contacted` / `qualified` / `disqualified` / `converted`), disqualify_reason, converted_opportunity (nullable), notes |
| Opportunity (soft, owned) | company, contact, title, product, expected_value, probability_override (nullable), stage, expected_close_date, next_action (text), source_lead, credited_user (set when won), won_at, won_value, lost_at, lost_reason, lost_note, last_activity_at (denormalized), version (optimistic concurrency), notes |
| OpportunityStageHistory | opportunity, from_stage, to_stage, changed_by, changed_at |
| Quotation (soft, owned by opportunity owner) | opportunity, number (per workspace sequence like `Q-2026-0001`), title, amount, status (`draft` / `sent` / `accepted` / `rejected` / `expired`), sent_at, valid_until, responded_at, notes. Files via generic attachments |
| Activity (owned) | type (`call` / `visit` / `meeting` / `email` / `note` / `other`), occurred_at, duration_minutes (nullable), target_type and target_id (`sales.lead`, `sales.opportunity`, `sales.company`, `sales.contact`), company (denormalized), summary, outcome |
| FollowUp (owned) | target_type and target_id (lead, opportunity or company), company (denormalized), title, due_date, status (`pending` / `done` / `cancelled`), completed_at, completed_activity (nullable), created_by |

Comments and attachments on companies, leads, opportunities and quotations use the **generic collab services**; register `sales.company`, `sales.contact`, `sales.lead`, `sales.opportunity`, `sales.quotation` as target types with resolvers.

### Targets, reports
| Table | Key fields |
|---|---|
| Target | subject_type (`user` / `team` / `company`), subject_id (null for company), period_type (`year` / `quarter` / `month`), period_start (date), amount, note. Unique per (workspace, subject, period_type, period_start). Fiscal year and quarters follow `fiscal_year_start_month` |
| DailyReport (owned by the user) | user, report_date, status (`draft` / `submitted` / `reviewed`), comments (list of text), tomorrow_plan (list of {text, optional target ref}), submitted_at, is_late, reviewed_by, reviewed_at, review_comment, snapshot (JSON frozen at submit). Unique per (workspace, user, report_date) |

Weekly and daily targets are **derived, never stored** (section 6).

## 5. Business rules

**Leads and opportunities**
- Lead `qualify` sets status `qualified`. `convert` creates (or links) the company and contact, creates an opportunity in the first open stage inheriting owner, product and value, marks the lead `converted`, and links both ways. `disqualify` requires a reason.
- Probability = `probability_override` if set, else the stage default. Weighted value = expected_value x probability.
- **Move** (stage change) uses the opportunity `version`; a mismatch returns 409 `version_conflict`. Every move writes stage history and an audit entry. Moving to the won or lost stage is only allowed through the `won` and `lost` actions.
- **Won**: requires `sales.opportunity.close`; sets `won_value` (default expected_value), `won_at` (default now; a past date within the current period may be set by a user with scope `team` or `all`), `credited_user` = current owner, marks the company `active`, emits `sales.opportunity.won`. Later reassignment does not change `credited_user` (changing it needs `sales.opportunity.reopen` and is audited).
- **Lost**: requires a lost reason; sets lost_at; emits `sales.opportunity.lost`.
- **Reopen**: back to an open stage, clears won or lost fields, audited.
- **Flags** (computed, not stored): `no_next_step` (open opportunity with no pending follow-up), `stale` (no activity for `stale_days`), `overdue_close` (expected_close_date in the past while open).
- `last_contact` = latest call, visit, meeting or email activity on the opportunity or its company.
- Deleting a company with opportunities is refused; archive by setting status `inactive`.

**Follow-ups**
- Overdue = pending and due_date earlier than today (workspace timezone); Today = due today; Upcoming = within the next `upcoming_days`.
- `complete` may log an activity in the same call and may create the next follow-up (`create_next` with a date). Completing updates `last_activity_at`.

**Quotations**
- `send` sets sent_at and valid_until (default today + `quotation_validity_days`), creates a `quotation` activity entry, and appears in "awaiting customer response" until accepted, rejected or expired. A job expires overdue quotations. Accepting a quotation does not auto-win the opportunity.

**Daily report**
- One per user per business date. `GET /daily-reports/me/today` returns the (created on demand) draft with **auto-computed** metrics: today's target, today's sales, achievement, new leads, calls, visits, meetings, quotations sent, follow-ups completed, new opportunities, deals won and lost. The salesperson edits only comments and tomorrow's plan; they fix the numbers by logging the missing activities, not by typing counts.
- `submit` freezes `snapshot`, sets `is_late` if after the cutoff, and emits `sales.dailyreport.submitted`. Editable until reviewed; `review` locks it; a reviewer can reopen.
- Non-working days (per the working calendar) do not require a report.
- Team daily report (`/daily-reports/team?date=`) shows each visible user with their metrics, submission status and comments, plus the aggregated management report (section 8).

**Targets**
- Year, quarter and month targets are stored explicitly. Allocation endpoints can create quarter and month targets from a year target using `equal`, `working_days` (weighted by working-day weights) or `manual` amounts. Sum mismatches between a parent and its children are reported as `allocation_gap` and never block.
- **Effective targets are derived**: day target = month target x (day weight / sum of weights in that month), zero on non-working days and holidays; week target = sum of the day targets in the week (weeks may span months); `required_daily_run_rate` = (target - actual so far) / remaining working days including today.
- User, team and company targets are independent subjects; the allocation view shows company -> teams -> users with allocated and unallocated amounts.
- Achievement % = actual / target x 100, null when there is no target.

## 6. KPI definitions (single source of truth, implement in one module)

| KPI | Definition |
|---|---|
| Actual sales | Sum of `won_value` of opportunities won in the period, by `won_at` date in the workspace timezone, grouped by `credited_user` |
| Target | Effective target for the period and subject (section 5) |
| Achievement % | Actual / Target x 100 |
| Win rate (shown as "Conversion rate") | Won / (Won + Lost), among opportunities **closed** in the period |
| Lead-to-opportunity rate | Leads converted in the period / Leads created in the period |
| Average deal size | Total won value / number of won deals |
| Pipeline value | Sum of expected_value of open opportunities (optionally filtered to expected close within the period) |
| Weighted pipeline | Sum of expected_value x probability for open opportunities |
| Pipeline coverage | Pipeline value (expected close within the period) / Period target |
| Sales growth % | (Current - Previous) / Previous x 100, comparing with the immediately preceding equal period; null when Previous is 0 |
| New leads / New opportunities | Counts created in the period (opportunities created directly or via conversion) |
| Won / Lost deals | Counts closed in the period |
| Follow-up performance | Completed on or before due date / all follow-ups due in the period |

**Status colors** for a user, team or company in a period:
- Closed periods: green if Achievement >= `status_green_pct`, yellow if >= `status_yellow_pct`, otherwise red.
- Current period: compare actual to the **pro-rata expected** (target x elapsed working-day weight / total working-day weight) with the same thresholds, so a salesperson is not red on day 3 of the month.

**Periods**: today, this week (from `week_start`), this month, this quarter, this year (fiscal), plus custom ranges for reports. Every KPI endpoint accepts `period` and returns the previous period for comparison.

## 7. API (all under `/api/v1/sales`, module guard, namespaced permissions, standard errors and cursor lists)

- **Dashboard**: `GET /dashboard?period=&user_id=&team_id=` returns KPIs with comparison, pipeline by stage (leads count plus open stages with value), team or user ranking with status colors, follow-up counts (overdue, today, upcoming), and attention items (overdue follow-ups, quotations awaiting response, large opportunities closing this week, opportunities with no next step, stale opportunities). Adapts to the caller's data scope.
- **Companies**: CRUD, `GET /companies/{id}/summary` (sales view: counts, pipeline value, won value, open follow-ups, last contact, timeline), `GET /companies/check-duplicate`.
- **Contacts**: CRUD.
- **Leads**: CRUD, `POST /leads/{id}/qualify`, `/disqualify`, `/convert`, `POST /leads/bulk-assign`.
- **Opportunities**: CRUD, `GET /pipeline` (board grouped by stage with totals, filters owner, team, product, expected close range), `POST /opportunities/{id}/move`, `/won`, `/lost`, `/reopen`, `GET /opportunities/{id}/timeline`, `POST /opportunities/bulk-assign`.
- **Quotations**: CRUD, `POST /quotations/{id}/send`, `/accept`, `/reject`.
- **Activities**: list and create, update, delete (logging an activity may include an optional `follow_up` object).
- **Follow-ups**: list with `bucket=overdue|today|upcoming|all`, CRUD, `POST /follow-ups/{id}/complete`, `/reschedule`, `/reassign`.
- **Targets**: list, create or update, delete; `GET /targets/allocation?subject=&year=`; `POST /targets/allocate`; `GET /targets/effective?user_id=&date=` (day, week, month, quarter, year targets, actual, achievement, required daily run rate).
- **Calendar**: `GET/PUT /calendar` (weekday weights), holidays CRUD.
- **Daily reports**: `GET /daily-reports/me/today`, `PUT /daily-reports/{id}`, `POST /daily-reports/{id}/submit`, `GET /daily-reports` (filters date, user, team, status), `GET /daily-reports/{id}`, `POST /daily-reports/{id}/review`, `POST /daily-reports/{id}/reopen`, `GET /daily-reports/team?date=`.
- **Performance**: `GET /performance/users/{id}?period=`, `GET /performance/ranking?period=&team_id=`.
- **Reports**: `GET /reports` (catalog), `GET /reports/{key}?period=&from=&to=&format=json|csv`. One report engine, parameterized by period. Keys: `daily-sales`, `daily-activity`, `target-achievement`, `salesperson-performance`, `pipeline-movement`, `new-leads`, `conversion`, `followup-performance`, `sales-performance`, `target-vs-actual`, `ranking`, `product-performance`, `customer-performance`, `win-loss`, `revenue-forecast` (weighted pipeline by expected close), `pipeline-analysis`, `team-performance`, `annual-summary`. Daily, weekly and monthly reports are the same keys with a different period.
- **Settings**: `GET/PUT /settings`, products CRUD, lost-reasons CRUD, stages CRUD with reorder.
- **Search provider** for companies, contacts, leads, opportunities, quotations, filtered by data scope.
- Root-level platform endpoints used as-is: teams, notifications, comments, attachments, audit, modules, roles.

## 8. Management daily report (generated, not typed)

For a date and the caller's scope: team target, team actual, achievement, new leads, opportunities, quotations, won, lost; top performer and at-risk users (status colors); major opportunities (largest open or closing this week); management attention (overdue follow-ups, quotations awaiting response, large opportunities closing this week, users who have not submitted their daily report). A scheduled job delivers it as an in-app notification and email at end of day to users holding `sales.report.view` with scope `team` or `all`.

## 9. Events, notifications and jobs

**Domain events**: `sales.lead.created`, `sales.lead.converted`, `sales.opportunity.created`, `sales.opportunity.moved`, `sales.opportunity.won`, `sales.opportunity.lost`, `sales.opportunity.reassigned`, `sales.quotation.sent`, `sales.followup.completed`, `sales.dailyreport.submitted`, `sales.dailyreport.reviewed`, `sales.target.changed`.

**Notification types** (in-app and email; preferences per type): follow-up due today (morning digest), follow-up overdue, opportunity assigned to you, opportunity won (to team leads and reviewers in scope), daily report submitted (to reviewers), daily report reviewed (to the author), daily report reminder, target set or changed, quotation expiring.

**Jobs** (idempotent, per workspace, workspace timezone): `sales_followup_digest` (07:30), `sales_report_reminder` (one hour before cutoff, only for users who have not submitted on working days), `sales_management_daily_report` (end of day), `sales_expire_quotations` (nightly). Register them with `platform.jobs`.

## 10. Frontend screens (for the design and frontend prompts)

Sales dashboard (adapts to role: CEO/GM, manager, salesperson); pipeline board with drag between stages and a list toggle; opportunity detail (timeline, quotations, follow-ups, comments, files); leads list and lead detail with convert; companies list and customer summary page; contacts; follow-ups workspace (overdue, today, upcoming); activity quick-log (mobile-friendly); targets and allocation screen; daily report (auto-filled metrics, comments, tomorrow's plan, submit); team daily reports and review; salesperson performance page and ranking; reports center with filters and CSV export; settings (stages, products, lost reasons, calendar, thresholds). Sidebar section appears only when the module is enabled and the user holds at least one sales permission. Mobile-first quick actions for log call, log visit, add follow-up and submit report.

## 11. Non-functional requirements

- Index for the hot paths: opportunities (workspace, owner, stage), (workspace, won_at), (workspace, expected_close_date); follow-ups (workspace, owner, status, due_date); activities (workspace, owner, occurred_at); daily reports (workspace, user, report_date); targets unique key.
- KPIs are computed from source tables in v1 (no rollup tables); keep the calculation in one service so rollups can be added later without changing the API.
- Money never uses floats. All "today" and period boundaries use the workspace timezone helper.
- Every mutation writes an audit entry; every state change that others care about emits a domain event.

## 12. Testing requirements

- Permission matrix entries for every sales endpoint and every default role (allowed and denied).
- Data scope tests for own, team and all on every list, search, dashboard and report endpoint, including users in multiple teams and users holding multiple roles (widest scope wins).
- Tenant isolation tests for all sales endpoints.
- KPI tests with a fixed dataset and expected numbers: achievement, win rate, lead-to-opportunity rate, average deal size, pipeline coverage, growth (including zero previous), status colors for closed and in-progress periods.
- Target tests: allocation methods, holidays and half days, week spanning two months, required daily run rate, fiscal year start other than January.
- Timezone tests: a deal won at 23:30 and 00:30 workspace time lands on the correct day; job runs respect the workspace timezone.
- Business rule tests: lead conversion, won, lost, reopen, credited_user stability after reassignment, version conflicts on move, duplicate check leak-proofing, daily report lifecycle and lateness, non-working days.
- Job idempotency (running twice sends once), module disabled behavior (API 403, jobs skipped, data kept), generic collab on sales targets.
- Coverage: 85 percent overall for the module, 95 percent on KPI, target and scope code.

## 13. Build stages

Each stage ends with lint, types and tests green, a commit, a regenerated OpenAPI file and updated docs.

- **S0 Core prerequisites** (section 2): multiple workspace roles, workspace timezone, jobs framework, role seeding hook.
- **S1 Reference data and customers**: sales permissions and default roles, settings, stages, products, lost reasons, calendar and holidays, companies, contacts, duplicate check, generic collab targets, search provider.
- **S2 Leads, opportunities and pipeline**: leads and conversion, opportunities, stage history, pipeline board endpoint, won and lost and reopen, quotations, events.
- **S3 Activities and follow-ups**: activities, follow-ups with buckets and completion flow, flags (no next step, stale), notifications and the digest job.
- **S4 Targets and performance**: targets, allocation, effective targets, KPI service, status colors, performance and ranking endpoints.
- **S5 Daily reports**: auto-built daily report, submit, review, reminders, team daily report.
- **S6 Dashboards and reports**: dashboard endpoint per role, management daily report and job, report engine and CSV export.
- **S7 Hardening**: indexes, seed data, full test pass, security review, docs (how roles and scopes map to screens).

**Seed data** (`seed_demo_sales`, dev only): two teams, one CEO/GM, one manager per team, four salespeople, 20 companies with contacts, 40 leads, 60 opportunities across all stages and the last 90 days of won and lost deals, quotations, activities and follow-ups (some overdue), annual targets with quarter and month allocation, a working calendar with a few demo holidays, and submitted and reviewed daily reports.

## 14. Open decisions

1. Default Saturday weight (the spec defaults to 0; set 0.5 in settings if half days are worked).
2. Whether salespeople should see all companies (read-only) to reduce duplicates. The spec uses the duplicate check instead; relax the role default if the team prefers.
3. Fiscal year start (default January) and week start (default Monday) should be confirmed with management.
4. Large deal threshold default value.
