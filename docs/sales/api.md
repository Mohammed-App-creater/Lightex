# Sales API reference

The contract the frontend builds the sales module from. Parent: `docs/sales/spec.md`. The machine-readable schema is
`docs/openapi.yaml` (tag `sales`, operation ids `sales_*`, components `Sales*`); this page explains the rules the
schema can't. Each stage appends its endpoints here.

| Stage | Sections |
|---|---|
| S1 reference data and customers | §1–§8 |

## 1. Conventions

- **Base path** `/api/v1/sales/`, bearer auth, JSON bodies, camelCase fields.
- **URL scheme.** Workspace collections live under `/api/v1/sales/workspaces/{slug}/<collection>`. Single records live
  under `/api/v1/sales/<collection>/{id}` (the record's workspace is found from the id).
- **Order of checks** on every route:
  1. Not signed in → 401 `unauthorized`.
  2. Not an active member of the workspace (or an unknown id) → 404 `not_found`.
  3. The sales module is off in that workspace → 403 `module_disabled`, `details: {module: "sales"}`. Data is kept, and
     turning the module back on restores everything.
  4. The method's permission code is missing → 403 `forbidden`, `details: {permission: "<code>"}`.
  5. An owned record outside the caller's **view** scope → 404 `not_found`, the same answer as a missing record (§3).
  6. An owned record inside the view scope but outside the **action's** scope (for example `edit` granted with a
     narrower scope than `view`) → 403 `forbidden`, `details: {permission: "<code>"}`.
- **Errors** use the platform shape `{code, message, details}`. Validation is 422 `validation_failed` with
  `details.fields: {fieldName: "message"}`. Query parameter errors name the parameter (`filter[status]`, `sort`).
- **Lists of owned records** (companies, contacts) are cursor pages: `{data: [...], nextCursor: string | null}`. Pass
  `cursor` (opaque) and `limit` (1–200, default 50). A broken cursor is 400 `invalid_cursor`. Filters use
  `filter[field]=value` (repeat a key for OR), free text uses `q`, and ordering uses `sort=<field>` or `sort=-<field>`
  for descending. Results are always tie-broken by id, so pages are stable.
- **Reference data** (stages, products, lost reasons, holidays) is small and returned as a plain array, not paged.
- **Money** is a decimal string with two places (`"250000.50"`), ETB, never a float. **Weights** (working calendar) are
  JSON numbers. **Dates** are `YYYY-MM-DD`, **times of day** `HH:MM`, **timestamps** ISO 8601 UTC.
- **Owned records** carry `ownerId`, `owner: {id, name, hue} | null`, and two hints for the UI: `canEdit` and
  `canDelete` (the caller's `edit` / `delete` scope reaches this record). The UI still checks `my_permissions` for the
  buttons that don't depend on a record (create, settings).
- **Audit.** Every mutation writes one audit row. Actions are `sales.<entity>.<verb>`; the audit log's
  `filter[entity]` groups are `company`, `contact` and `sales_settings` (settings, stages, products, lost reasons,
  calendar, holidays).

## 2. Permissions and default roles

The whole catalogue (spec §3) is declared from S1, so roles won't change in later stages. Every code is workspace
scope. A **scopable** code (S) is granted with a data scope `own`, `team` or `all`; `my_data_scopes` (workspace
response `myDataScopes`) holds the caller's widest scope per code.

Default roles are seeded (as system roles: not deletable or renamable, permissions editable) when a workspace is
created with sales and whenever sales is turned on. Existing roles are never touched, so admin edits survive.

| Code | S | Sales Admin (all) | CEO / GM (all) | Sales Manager (team) | Salesperson (own) |
|---|---|---|---|---|---|
| sales.dashboard.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.company.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.company.create | | ✓ | | ✓ | ✓ |
| sales.company.edit | S | ✓ | | ✓ | ✓ |
| sales.company.delete | S | ✓ | | | |
| sales.contact.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.contact.create | | ✓ | | ✓ | ✓ |
| sales.contact.edit | S | ✓ | | ✓ | ✓ |
| sales.contact.delete | S | ✓ | | | |
| sales.lead.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.lead.create | | ✓ | | ✓ | ✓ |
| sales.lead.edit | S | ✓ | | ✓ | ✓ |
| sales.lead.delete | S | ✓ | | ✓ | |
| sales.lead.assign | S | ✓ | | ✓ | |
| sales.lead.convert | S | ✓ | | ✓ | ✓ |
| sales.opportunity.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.opportunity.create | | ✓ | | ✓ | ✓ |
| sales.opportunity.edit | S | ✓ | | ✓ | ✓ |
| sales.opportunity.move | S | ✓ | | ✓ | ✓ |
| sales.opportunity.close | S | ✓ | | ✓ | ✓ |
| sales.opportunity.delete | S | ✓ | | | |
| sales.opportunity.assign | S | ✓ | | ✓ | |
| sales.opportunity.reopen | S | ✓ | | | |
| sales.quotation.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.quotation.create | | ✓ | | ✓ | ✓ |
| sales.quotation.edit | S | ✓ | | ✓ | ✓ |
| sales.quotation.delete | S | ✓ | | ✓ | |
| sales.activity.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.activity.create | | ✓ | | ✓ | ✓ |
| sales.activity.edit | S | ✓ | | ✓ | ✓ |
| sales.activity.delete | S | ✓ | | ✓ | ✓ |
| sales.followup.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.followup.create | | ✓ | | ✓ | ✓ |
| sales.followup.edit | S | ✓ | | ✓ | ✓ |
| sales.followup.complete | S | ✓ | | ✓ | ✓ |
| sales.followup.reassign | S | ✓ | | ✓ | |
| sales.followup.delete | S | ✓ | | ✓ | ✓ |
| sales.target.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.target.manage | S | ✓ | ✓ | ✓ | |
| sales.dailyreport.submit | | ✓ | | ✓ | ✓ |
| sales.dailyreport.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.dailyreport.review | S | ✓ | ✓ | ✓ | |
| sales.performance.view | S | ✓ | ✓ | ✓ | ✓ |
| sales.report.view | S | ✓ | ✓ | ✓ | |
| sales.report.export | S | ✓ | ✓ | ✓ | |
| sales.settings.manage | | ✓ | | | |

- Every sales role also grants `core.workspace.view`, so someone whose only role is a sales role can open the
  workspace. Members may hold several roles; permissions are the union and the widest scope wins.
- Role keys (`system_key`): `sales_admin`, `sales_ceo`, `sales_manager`, `sales_salesperson`.
- **Built-in roles:** Owner and Admin get every sales code with scope `all`. Member gets nothing in sales: people get
  sales access through the sales roles (for example Member + Salesperson).
- Reasoning: deleting customers and deals is an admin act (archive a company by setting its status to `inactive`);
  managers may delete leads, quotations, activities and follow-ups in their team; salespeople may delete their own
  activities and follow-ups (logging mistakes). Reopening won/lost deals is Sales Admin only. Spec §14 default:
  salespeople see only their own companies and use the duplicate check (§6.3) to avoid duplicates.
- **Navigation:** the module's nav item (`sales`) needs `sales.dashboard.view`, which every sales role holds; it is
  the "can use Sales" code. Reading reference data (§5) needs it too.

## 3. Data scope rules

- `own`: records whose `owner` is the caller. `team`: records owned by the caller or by anyone sharing a live team
  with them (as member or lead; a user may be in several teams). `all`: every record in the workspace.
- Every list and search of owned records goes through `visible_to()` with the entity's `view` code.
- Single records: outside the **view** scope → **404** (no existence leak, the same as tracking's hidden records).
  Inside the view scope but outside the action's scope → 403 `forbidden` with the permission. A caller who holds no
  grant at all for the method's code gets 403 before any record check.
- **Contacts are scoped by their own owner**, not by their company's owner. A contact's response includes its
  company's id and name.
- **Owner changes.** Companies and contacts have no `assign` code. Setting `ownerId` to someone other than the caller
  (on create or update) needs the entity's `edit` code with scope `team` or `all`; otherwise 403 `forbidden`,
  `details: {permission: "sales.company.edit", scope: "team"}`. The new owner must be an active member (422
  `ownerId`: "Pick a member of this workspace") and, with scope `team`, the caller or a team-mate (422 `ownerId`:
  "Pick someone in your team"). The change is audited as an `Owner` change on `sales.<entity>.updated`. Leads,
  opportunities and follow-ups use their `assign` / `reassign` codes (S2, S3).

## 4. Module guard and defaults

- Turning sales off answers 403 `module_disabled` on every sales route, hides sales search results, trash kinds and
  comments on sales targets (404), and keeps all data.
- **Defaults** (settings, the five default stages and the working calendar) are created lazily on the first read of
  settings, stages or the calendar, idempotently, once per workspace. The frontend never needs to seed anything.

## 5. Reference data and settings

Reads need `sales.dashboard.view`; writes need `sales.settings.manage`.

### 5.1 Settings — `GET/PUT /sales/workspaces/{slug}/settings`

`SalesSettings`:

| Field | Type | Default | PUT rule |
|---|---|---|---|
| weekStart | `monday` … `sunday` | `monday` | |
| fiscalYearStartMonth | int | 1 | 1–12 |
| statusGreenPct | int | 100 | 1–1000 |
| statusYellowPct | int | 70 | 0–1000, at most `statusGreenPct` |
| upcomingDays | int | 7 | 1–90 |
| staleDays | int | 14 | 1–365 |
| largeDealThreshold | money | `"1000000.00"` | ≥ 0, two decimals |
| dailyReportCutoff | `HH:MM` | `"18:00"` | |
| dailyReportRequired | bool | true | |
| quotationValidityDays | int | 30 | 1–365 |
| calendarDisplay | `gregorian` / `ethiopian` | `gregorian` | reserved; dates are always stored Gregorian |
| updatedAt | timestamp | | read-only |

`PUT` is a partial update: fields left out keep their value. 200 with the settings. 422 per field (yellow above
green → `statusYellowPct`). Audit `sales.settings.updated` (only when something changed).

### 5.2 Pipeline stages

`SalesStage`: `{id, name, order, category: "open"|"won"|"lost", defaultProbability: 0–100, isSystem}`.

| Route | Body | Answer |
|---|---|---|
| `GET /sales/workspaces/{slug}/stages` | | 200 `SalesStage[]`: open stages in order, then Won, then Lost |
| `POST /sales/workspaces/{slug}/stages` | `{name, defaultProbability}` | 201 `SalesStage`: a new **open** stage, placed after the last open stage |
| `POST /sales/workspaces/{slug}/stages/reorder` | `{stageIds: [every open stage id, in the new order]}` | 200 `SalesStage[]` |
| `PATCH /sales/stages/{id}` | `{name?, defaultProbability?}` | 200 `SalesStage` |
| `DELETE /sales/stages/{id}` | | 204 |

Invariants and errors:
- Defaults: Opportunity 20, Quotation 40, Negotiation 70 (open); Won 100; Lost 0 (system).
- Exactly one Won and one Lost stage. They can be renamed but not deleted (409 `stage_is_system`) and their
  probability is fixed (422 `defaultProbability`). Won and Lost always sort after the open stages; `order` is
  0…n-1.
- Stage names are unique per workspace, case-insensitively: 409 `name_taken`, `details: {name}`.
- An open stage can be deleted only if another open stage remains (409 `last_open_stage`) and no opportunity is in it
  (409 `stage_in_use`, enforced from S2).
- At most 20 open stages: 409 `too_many_stages`.
- Reorder must list every open stage exactly once (no Won/Lost, no duplicates): else 422 `stageIds`.
- Audit: `sales.stage.created`, `.updated`, `.deleted`, `.reordered`.

### 5.3 Products

`SalesProduct`: `{id, name, code, category, isActive, createdAt, updatedAt}`.

| Route | Body | Answer |
|---|---|---|
| `GET /sales/workspaces/{slug}/products?filter[active]=true\|false` | | 200 `SalesProduct[]` by name |
| `POST /sales/workspaces/{slug}/products` | `{name, code?, category?, isActive?}` | 201 |
| `PATCH /sales/products/{id}` | any of the same | 200 |
| `DELETE /sales/products/{id}` | | 204 |

Name unique (case-insensitive) → 409 `name_taken`; a non-empty code unique (case-insensitive) → 409 `code_taken`.
Deleting a product used by leads or opportunities → 409 `product_in_use` (from S2; deactivate it instead). Audit
`sales.product.*`.

### 5.4 Lost reasons

`SalesLostReason`: `{id, name, isActive, createdAt, updatedAt}`. Same routes and rules as products under
`lost-reasons` (`/sales/workspaces/{slug}/lost-reasons`, `/sales/lost-reasons/{id}`); in-use delete → 409
`lost_reason_in_use` (from S2). Audit `sales.lostreason.*`.

### 5.5 Working calendar — `GET/PUT /sales/workspaces/{slug}/calendar`

`SalesCalendar`: `{weekdayWeights: number[7] (Monday first), updatedAt}`. Default `[1, 1, 1, 1, 1, 0, 0]`. PUT
`{weekdayWeights}`: exactly seven numbers between 0 and 1 with at most two decimals (0.5 = half day), at least one
above 0; else 422 `weekdayWeights`. Audit `sales.calendar.updated` with one change per weekday.

### 5.6 Holidays

`SalesHoliday`: `{id, date, name}`.

| Route | Body | Answer |
|---|---|---|
| `GET /sales/workspaces/{slug}/holidays?filter[year]=2026` | | 200 `SalesHoliday[]` by date |
| `POST /sales/workspaces/{slug}/holidays` | `{date, name}` | 201 |
| `PATCH /sales/holidays/{id}` | `{date?, name?}` | 200 |
| `DELETE /sales/holidays/{id}` | | 204 |

One holiday per date: 409 `date_taken`, `details: {date}`. A bad year → 422 `filter[year]`. Audit `sales.holiday.*`.

## 6. Companies

`SalesCompany`:

```
{ id, name, industry, region, city, address, phone, email, website,
  status: "prospect" | "active" | "inactive", notes,
  ownerId, owner: {id, name, hue} | null, canEdit, canDelete, createdAt, updatedAt }
```

Text fields are `""` when empty, never null. `status` becomes `active` automatically on the first won deal (S2);
`inactive` is how a company is archived.

### 6.1 Routes

| Route | Permission | Body / query | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/companies` | company.view | see §6.2 | 200 `SalesCompanyPage` |
| `POST /sales/workspaces/{slug}/companies` | company.create | `SalesCompanyIn` | 201 `SalesCompany` |
| `GET /sales/workspaces/{slug}/companies/check-duplicate` | company.view | see §6.3 | 200 `SalesDuplicateCheck` |
| `GET /sales/companies/{id}` | company.view (scope) | | 200 `SalesCompany` |
| `PATCH /sales/companies/{id}` | company.edit (scope) | `SalesCompanyUpdateIn` | 200 `SalesCompany` |
| `DELETE /sales/companies/{id}` | company.delete (scope) | | 204 |
| `GET /sales/companies/{id}/summary` | company.view (scope) | | 200 `SalesCompanySummary` |

`SalesCompanyIn`: `name` (required, ≤ 200), `industry`, `region`, `city` (≤ 80), `address` (≤ 300), `phone` (≤ 40),
`email` (valid email or ""), `website` (≤ 200), `status` (default `prospect`), `notes` (≤ 5000), `ownerId` (default:
the caller; §3 owner rule). The update body takes the same fields, all optional. Leading and trailing spaces are
trimmed. Audit `sales.company.created` / `.updated` (with the changed fields) / `.deleted` / `.restored` / `.purged`.

**Delete** is a soft delete into the workspace trash (kind `sales.company`), and the company's live contacts go with
it. Restoring the company from the trash (`POST /workspaces/{slug}/trash/restore`) brings back exactly those
contacts. Deleting a company that has opportunities → 409 `company_has_opportunities` (from S2; archive with
`status: "inactive"` instead).

### 6.2 List parameters

| Parameter | Meaning |
|---|---|
| `filter[status]` | `prospect`, `active`, `inactive` (repeatable); other values → 422 |
| `filter[owner]` | a user id or `me` (repeatable); bad ids → 422 |
| `filter[industry]`, `filter[region]`, `filter[city]` | exact match, case-insensitive (repeatable) |
| `q` | contains, in name, phone, email or city |
| `sort` | `name` (default, case-insensitive), `createdAt`, `updatedAt`, `status`; `-` for descending; else 422 |
| `cursor`, `limit` | §1 |

Always limited to the caller's `sales.company.view` scope.

### 6.3 Duplicate check

`GET /sales/workspaces/{slug}/companies/check-duplicate?name=&phone=&excludeId=` → `{exists: boolean, ownerName:
string | null}`.

- Matches any **live company in the workspace, whatever the caller's scope**, by normalized name **or** normalized
  phone. It returns nothing else: no id, name, phone or link. `ownerName` is null when nothing matches or the match
  has no owner. With several matches, the oldest wins.
- Name normalization: lower case, accents removed, `&` → `and`, dots dropped, other punctuation → spaces, spaces
  collapsed, trailing legal-form words dropped (`plc`, `ltd`, `limited`, `llc`, `inc`, `co`, `corp`, `company`,
  `sc`, `share`, `pvt`…). "Abay Trading P.L.C." matches "abay trading".
- Phone normalization: the last nine digits ("+251 911 22 33 44" = "0911223344" = "911223344"); fewer than seven
  digits never match.
- `excludeId` ignores one company (the one being edited). Send at least `name` or `phone`, else 422 `name`; a bad
  `excludeId` → 422.
- It warns only: creating a duplicate is allowed.

### 6.4 Summary (S1 stub)

`SalesCompanySummary`:
`{company: SalesCompany, contactCount, primaryContact: SalesContact | null, openOpportunityCount: 0, pipelineValue:
"0.00", wonValue: "0.00", openFollowUpCount: 0, lastContactAt: null, timeline: []}`. `contactCount` and
`primaryContact` count only contacts the caller can see. S2 fills the opportunity fields, S3 the follow-up,
last-contact and timeline fields (S3 defines the timeline item shape).

## 7. Contacts

`SalesContact`:

```
{ id, companyId, company: {id, name}, name, jobTitle, phone, email, isPrimary, notes,
  ownerId, owner: {id, name, hue} | null, canEdit, canDelete, createdAt, updatedAt }
```

| Route | Permission | Body / query | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/contacts` | contact.view | `filter[company]`, `filter[owner]` (id or `me`), `filter[primary]=true\|false`, `q` (name, phone, email, company name), `sort` = `name` (default) / `createdAt` / `updatedAt`, `cursor`, `limit` | 200 `SalesContactPage` |
| `POST /sales/workspaces/{slug}/contacts` | contact.create | `SalesContactIn` | 201 `SalesContact` |
| `GET /sales/contacts/{id}` | contact.view (scope) | | 200 |
| `PATCH /sales/contacts/{id}` | contact.edit (scope) | `SalesContactUpdateIn` | 200 |
| `DELETE /sales/contacts/{id}` | contact.delete (scope) | | 204 |

- `SalesContactIn`: `companyId` (required), `name` (required, ≤ 120), `jobTitle` (≤ 120), `phone`, `email`,
  `isPrimary`, `notes`, `ownerId` (§3). The company must be live and inside the caller's `sales.company.view` scope,
  else 422 `companyId` ("Pick a company you can see"). The same applies when `companyId` changes on update.
- One primary contact per company: setting `isPrimary: true` clears it on the company's other contacts.
- Contacts of a deleted company are hidden everywhere (404) until the company is restored. Delete is a soft delete
  into the trash (kind `sales.contact`). Audit `sales.contact.*`.

## 8. Platform hooks

- **Comments and attachments** (`/api/v1/targets/{targetType}/{targetId}/comments|attachments`) work on
  `sales.company` and `sales.contact`. Viewing, commenting and attaching need the entity's `view` scope to reach the
  record (else 404). Deleting someone else's comment or attachment needs the entity's `edit` scope (`details.permission`
  = `sales.company.edit` / `sales.contact.edit`). Notifications go to the record's owner. `sales.lead`,
  `sales.opportunity` and `sales.quotation` are registered in S2.
- **Search**: workspace search (`/workspaces/{slug}/search?filter[type]=company|contact`) and global search
  (`/search?type=company|contact`) return only records in the caller's view scope. Result:
  `{type: "company", company: {id, name, status, city}, targetType: "sales.company", targetId, title, link}` and
  `{type: "contact", contact: {id, name, companyId, companyName}, targetType: "sales.contact", ...}`. Links are
  `{FRONTEND_URL}/{slug}/sales/companies/{id}` and `/sales/contacts/{id}`.
- **Trash** kinds `sales.company` and `sales.contact`: listed for users holding the `delete` code, limited to their
  delete scope; restore and purge use the core trash routes.
