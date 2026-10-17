# Sales API reference

The contract the frontend builds the sales module from. Parent: `docs/sales/spec.md`. The machine-readable schema is
`docs/openapi.yaml` (tag `sales`, operation ids `sales_*`, components `Sales*`); this page explains the rules the
schema can't. Each stage appends its endpoints here.

| Stage | Sections |
|---|---|
| S1 reference data and customers | §1–§8 |
| S2 leads, opportunities and pipeline | §9–§13 (and the S2 notes in §1, §5, §6.4, §8) |
| S3 activities and follow-ups | §14–§17 |

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
- **Lists of owned records** (companies, contacts, leads, opportunities, quotations) are cursor pages: `{data: [...], nextCursor: string | null}`. Pass
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
  `filter[entity]` groups are `company`, `contact`, `lead`, `opportunity`, `quotation` and `sales_settings`
  (settings, stages, products, lost reasons, calendar, holidays).

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
  "Pick someone in your team"). The change is audited as an `Owner` change on `sales.<entity>.updated`. Leads and
  opportunities use their `assign` codes the same way (§9.3, §10.5); follow-ups use `reassign` (S3).

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
- An open stage can be deleted only if another open stage remains (409 `last_open_stage`) and no opportunity, live
  or in the trash, is in it (409 `stage_in_use`).
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
Deleting a product used by leads or opportunities (live or in the trash) → 409 `product_in_use` (deactivate it
instead). Leads and opportunities can only be given active products; keeping an inactive one is fine. Audit
`sales.product.*`.

### 5.4 Lost reasons

`SalesLostReason`: `{id, name, isActive, createdAt, updatedAt}`. Same routes and rules as products under
`lost-reasons` (`/sales/workspaces/{slug}/lost-reasons`, `/sales/lost-reasons/{id}`); in-use delete (a lost
opportunity names it) → 409 `lost_reason_in_use`. `lost` accepts active reasons only. Audit `sales.lostreason.*`.

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
contacts. Deleting a company that has opportunities (live or in the trash) → 409 `company_has_opportunities`
(archive with `status: "inactive"` instead).

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

### 6.4 Summary

`SalesCompanySummary`:
`{company: SalesCompany, contactCount, primaryContact: SalesContact | null, openOpportunityCount, pipelineValue,
wonValue, openFollowUpCount: 0, lastContactAt: null, timeline: []}`. `contactCount` and `primaryContact` count only
contacts the caller can see. From S2: `openOpportunityCount` and `pipelineValue` (sum of expected values) cover the
company's **open** opportunities in the caller's `sales.opportunity.view` scope, `wonValue` the won values of its won
ones in scope. S3 fills the follow-up, last-contact and timeline fields (items use the §10.7 shape).

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
  `sales.company`, `sales.contact`, `sales.lead`, `sales.opportunity` and `sales.quotation`. Viewing, commenting and
  attaching need the entity's `view` scope to reach the record (else 404). Deleting someone else's comment or
  attachment needs the entity's `edit` scope (`details.permission` = `sales.<entity>.edit`). Notifications go to the
  record's owner. Contacts of a deleted company and quotations of a deleted opportunity are not targets (404).
- **Search**: workspace search (`/workspaces/{slug}/search?filter[type]=company|contact|lead|opportunity|quotation`)
  and global search (`/search?type=…`) return only records in the caller's view scope. Result:
  `{type: "company", company: {id, name, status, city}, targetType: "sales.company", targetId, title, link}` and
  `{type: "contact", contact: {id, name, companyId, companyName}, targetType: "sales.contact", ...}`. Links are
  `{FRONTEND_URL}/{slug}/sales/companies/{id}` and `/sales/contacts/{id}`. S2 adds
  `{type: "lead", lead: {id, name, status, contactName}, targetType: "sales.lead", …}`,
  `{type: "opportunity", opportunity: {id, title, status, stageName, companyId, companyName}, …}` and
  `{type: "quotation", quotation: {id, number, title, status, opportunityId}, …}`, linking to `/sales/leads/{id}`,
  `/sales/opportunities/{id}` and `/sales/quotations/{id}`.
- **Trash** kinds `sales.company`, `sales.contact`, `sales.lead`, `sales.opportunity` and `sales.quotation`: listed
  for users holding the `delete` code, limited to their delete scope; restore and purge use the core trash routes.
  Deleting an opportunity takes its live quotations along (restoring it brings exactly those back, like a company and
  its contacts); quotations deleted earlier stay in the trash as their own items.
- **Jobs** (`core/jobs`): `sales_expire_quotations`, suggested schedule `daily 00:15` (§11.4).

## 9. Leads (S2)

`SalesLead`:

```
{ id, displayName, source, status, companyId, company: {id, name} | null, companyName, contactId,
  contact: {id, name} | null, contactName, phone, email, productId, product: {id, name} | null,
  estimatedValue: money | null, disqualifyReason, convertedOpportunityId, convertedAt,
  notes, ownerId, owner, canEdit, canDelete, createdAt, updatedAt }
```

- `source`: `referral`, `website`, `call`, `event`, `visit`, `social`, `other` (default `other`).
- `status`: `new` → `contacted` (by edit) → `qualified` / `disqualified` (actions) → `converted` (action).
- `displayName` = the linked company's name, else the typed `companyName`, else `contactName`. `companyName` is the
  company as typed when it isn't a known company yet.

### 9.1 Routes

| Route | Permission | Body / query | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/leads` | lead.view | §9.2 | 200 `SalesLeadPage` |
| `POST /sales/workspaces/{slug}/leads` | lead.create | `SalesLeadIn` | 201 `SalesLead` |
| `POST /sales/workspaces/{slug}/leads/bulk-assign` | lead.assign | `{leadIds: uuid[1..200], ownerId}` | 200 `{updated}` |
| `GET /sales/leads/{id}` | lead.view (scope) | | 200 `SalesLead` |
| `PATCH /sales/leads/{id}` | lead.edit (scope) | `SalesLeadUpdateIn` | 200 `SalesLead` |
| `DELETE /sales/leads/{id}` | lead.delete (scope) | | 204 |
| `POST /sales/leads/{id}/qualify` | lead.convert (scope) | | 200 `SalesLead` |
| `POST /sales/leads/{id}/disqualify` | lead.convert (scope) | `{reason}` (required, ≤ 500) | 200 `SalesLead` |
| `POST /sales/leads/{id}/convert` | lead.convert (scope) | `SalesLeadConvertIn` | 200 `SalesLeadConvertResult` |

`SalesLeadIn`: `source`, `companyId` (a company the caller can see, else 422 `companyId`), `companyName` (≤ 200),
`contactId` (a contact the caller can see, of `companyId` when one is set, else 422 `contactId`), `contactName`
(≤ 120), `phone`, `email`, `productId` (an active product, else 422 `productId`), `estimatedValue` (≥ 0 or null),
`status` (`new` or `contacted` only; else 422 — use the actions), `notes`, `ownerId`. A lead needs `companyId`,
`companyName` or `contactName` (422 `companyName`: "Name the company or the contact"). The update body takes the same
fields, all optional; changing the company clears a contact of the old company.

- **Owner**: `ownerId` someone else (create or edit) needs `sales.lead.assign` — scope `team` or `all`, reaching the
  record on edit — with §3's rules (403 `{permission: "sales.lead.assign", scope: "team"}`, 422 `ownerId`).
- **Converted leads are read-only**: edit, qualify, disqualify and convert answer 409 `lead_converted`,
  `details: {opportunityId}`. Delete still works.
- **Qualify** (from `new`, `contacted` or `disqualified`) clears the disqualify reason; qualifying a qualified lead is
  a no-op 200. **Disqualify** needs a `reason` (422 `reason`).
- Delete is a soft delete into the trash (kind `sales.lead`). Audit `sales.lead.created`, `.updated` (owner changes
  included), `.qualified`, `.disqualified`, `.converted`, `.deleted`, `.restored`, `.purged`. Events
  `sales.lead.created` `{leadId, ownerId}` and `sales.lead.converted` (§9.4).

### 9.2 List parameters

| Parameter | Meaning |
|---|---|
| `filter[status]`, `filter[source]` | repeatable; unknown values → 422 |
| `filter[owner]` | user id or `me` (repeatable) |
| `filter[team]` | team id (repeatable): leads owned by its members; unknown teams → 422 |
| `filter[product]`, `filter[company]` | ids (repeatable) |
| `filter[createdFrom]`, `filter[createdTo]` | `YYYY-MM-DD`, business dates in the workspace time zone, inclusive |
| `q` | contains, in company name (typed or linked), contact name, phone or email |
| `sort` | `-createdAt` (default), `createdAt`, `updatedAt`, `name` (display name), `status`, `estimatedValue` (no value sorts first) |

Always limited to the caller's `sales.lead.view` scope.

### 9.3 Bulk assign

All or nothing: every id must be a live lead the caller can see (else 422 `leadIds`, nothing changes) and reach with
`sales.lead.assign` (else 403 `{permission: "sales.lead.assign"}`); the new owner follows §3 (`team` scope: a
team-mate). Leads already owned by `ownerId` are skipped; a converted lead in the batch → 409 `lead_converted`. One
audit row per changed lead (`sales.lead.updated`, an `Owner` change, `data: {bulk: true}`). Answer `{updated: n}`.

### 9.4 Convert

`SalesLeadConvertIn` (everything optional):

```
{ companyId?: uuid, company?: {name, industry?, region?, city?, address?, phone?, email?, website?},
  contactId?: uuid, contact?: {name, jobTitle?, phone?, email?},
  opportunity?: {title?, expectedValue?, expectedCloseDate?} }
```

1. **Company**: `companyId` (a company the caller can see) → linked; else `company` → created; else the lead's linked
   company (if live); else the oldest company **in the caller's company view scope** whose normalized name (the
   lead's `companyName`, else `contactName`) or phone matches, with the duplicate check's normalization (§6.3) →
   linked; else a new company from the lead (name, phone, email). Sending both `companyId` and `company` → 422.
2. **Contact**: `contactId` (of that company) → linked; else `contact` → created; else the lead's contact if it
   belongs to that company; else a contact of the company with the same name (case-insensitive) → linked; else, when
   the lead has a `contactName`, a new contact (with the lead's phone and email). Created contacts are primary when
   the company has none.
3. **Opportunity**: created in the **first open stage**, owned by the lead's owner, with the lead's product,
   `expectedValue` = the lead's estimated value (0 without one) and `title` = "Company – Product" (or the company
   name); `opportunity` overrides title, value and expected close date. `sourceLeadId` = the lead.
4. The lead becomes `converted` with `convertedOpportunityId`, `convertedAt`, and its `companyId` / `contactId` set
   to the result. Companies and contacts created here are owned by the lead's owner (§3's owner rule applies to the
   caller, so a manager converting a team-mate's lead works).

Answer `SalesLeadConvertResult`: `{lead, opportunity: SalesOpportunity, company: SalesCompany, contact: SalesContact |
null, companyCreated, contactCreated}`. Errors: 409 `lead_converted` (converting twice: the lead row is locked, so
concurrent conversions make one opportunity), 409 `lead_disqualified` (qualify it first), 422 `company` (nothing to
name a new company after). Audit `sales.lead.converted` (plus the company, contact and opportunity `created` rows);
event `sales.lead.converted` `{leadId, opportunityId, companyId, contactId, companyCreated, contactCreated}` (and
`sales.opportunity.created`).

## 10. Opportunities and the pipeline (S2)

`SalesOpportunity`:

```
{ id, title, status: "open" | "won" | "lost", companyId, company: {id, name}, contactId, contact: {id, name} | null,
  productId, product: {id, name} | null, stageId, stage: {id, name, category}, expectedValue: money,
  probabilityOverride: 0..100 | null, probability, weightedValue: money, expectedCloseDate, nextAction,
  sourceLeadId, creditedUserId, creditedUser: {id, name, hue} | null, wonAt, wonValue: money | null, lostAt,
  lostReasonId, lostReason: {id, name} | null, lostNote, lastActivityAt, version,
  notes, flags: {overdueClose, noNextStep, stale},
  ownerId, owner, canEdit, canDelete, canMove, canClose, createdAt, updatedAt }
```

- `status` is the stage's category. `probability` = `probabilityOverride` if set, else the stage's default
  probability (so won = 100, lost = 0). `weightedValue` = `expectedValue × probability / 100`, rounded half up to
  cents.
- `flags.overdueClose`: open with `expectedCloseDate` before today (workspace time). `noNextStep` and `stale` are in
  the shape now and always `false` until S3 (follow-ups and activities).
- `canMove` / `canClose`: the caller's `move` / `close` scope reaches the record (like `canEdit`).
- `version` starts at 1 and goes up on every change (edit, move, won, lost, reopen, reassignment).

### 10.1 Routes

| Route | Permission | Body / query | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/opportunities` | opportunity.view | §10.2 | 200 `SalesOpportunityPage` |
| `POST /sales/workspaces/{slug}/opportunities` | opportunity.create | `SalesOpportunityIn` | 201 `SalesOpportunity` |
| `POST /sales/workspaces/{slug}/opportunities/bulk-assign` | opportunity.assign | `{opportunityIds, ownerId}` | 200 `{updated}` |
| `GET /sales/workspaces/{slug}/pipeline` | opportunity.view | §10.6 | 200 `SalesPipeline` |
| `GET /sales/opportunities/{id}` | opportunity.view (scope) | | 200 |
| `PATCH /sales/opportunities/{id}` | opportunity.edit (scope) | `SalesOpportunityUpdateIn` | 200 |
| `DELETE /sales/opportunities/{id}` | opportunity.delete (scope) | | 204 |
| `POST /sales/opportunities/{id}/move` | opportunity.move (scope) | `{stageId, version}` | 200 |
| `POST /sales/opportunities/{id}/won` | opportunity.close (scope) | `{wonValue?, wonAt?, version?}` | 200 |
| `POST /sales/opportunities/{id}/lost` | opportunity.close (scope) | `{lostReasonId, lostNote?, version?}` | 200 |
| `POST /sales/opportunities/{id}/reopen` | opportunity.reopen + close (scope) | `{stageId?, version?}` | 200 |
| `GET /sales/opportunities/{id}/timeline` | opportunity.view (scope) | `cursor`, `limit` | 200 `SalesTimelinePage` |

`SalesOpportunityIn`: `title` (required, ≤ 200), `companyId` (required; a company the caller can see, else 422),
`contactId` (a contact the caller can see, of that company), `productId` (active), `stageId` (an **open** stage;
default the first; won/lost → 422 `stageId`), `expectedValue` (≥ 0, default 0), `probabilityOverride` (0–100 or
null), `expectedCloseDate`, `nextAction` (≤ 300), `notes`, `ownerId` (someone else needs `sales.opportunity.assign`,
§3's rules). The update body takes the same fields except `stageId` (stages change only through the actions below),
plus `creditedUserId` (§10.5) and an optional `version` (sent → a mismatch is 409 `version_conflict`). Changing the
company clears a contact of the old company.

Delete is a soft delete into the trash (kind `sales.opportunity`), taking the opportunity's live quotations along.
Audit `sales.opportunity.created`, `.updated` (owner and credit changes included), `.moved`, `.won`, `.lost`,
`.reopened`, `.deleted`, `.restored`, `.purged`. Events §10.8.

### 10.2 List parameters

| Parameter | Meaning |
|---|---|
| `filter[status]` | `open`, `won`, `lost` (repeatable) |
| `filter[stage]`, `filter[product]`, `filter[company]` | ids (repeatable) |
| `filter[owner]`, `filter[team]` | as for leads (§9.2) |
| `filter[expectedCloseFrom]`, `filter[expectedCloseTo]` | `YYYY-MM-DD`, inclusive |
| `filter[wonFrom]`, `filter[wonTo]` | `YYYY-MM-DD` business dates in the workspace time zone, inclusive, on `wonAt` |
| `q` | contains, in title or company name |
| `sort` | `-updatedAt` (default), `createdAt`, `title`, `expectedValue`, `expectedCloseDate` (no date sorts last), `wonAt` (open deals by creation) |

### 10.3 Move and versions

`POST …/move {stageId, version}`. Checks in order: `move` scope (403), `version` required (422) and equal to the
current version, else **409 `version_conflict`** with `details.current` = the opportunity as it is now (the board
reloads the card); the opportunity must be open (409 `opportunity_closed`, `details.status`); the stage must be an
open stage of the workspace (422 `stageId`; Won and Lost are reached only through `won` and `lost`). The same stage
is a no-op 200. A move bumps `version`, writes a stage-history row, audit `sales.opportunity.moved` (a `Stage`
change) and event `sales.opportunity.moved` `{opportunityId, fromStageId, toStageId}`.

`won`, `lost`, `reopen` and edits accept an optional `version` with the same 409 when it doesn't match.

### 10.4 Won, lost, reopen

- **Won** (open deals only, else 409 `opportunity_closed`): moves to the Won stage; `wonValue` defaults to
  `expectedValue`; `creditedUser` = the current owner; clears any lost fields; the company becomes `active` (audited
  as `sales.company.updated`); event `sales.opportunity.won` `{opportunityId, wonValue, wonAt, creditedUserId,
  companyId}`.
- **`wonAt`** (default now): a timestamp (`2026-10-14T23:30:00+03:00`; without an offset it is workspace time) or a
  date (`2026-10-14` = that date at 12:00 workspace time; today's date = now). Rules:
  - never in the future (422 `wonAt`);
  - any time **earlier today** (workspace date) is fine for anyone who may close the deal;
  - an **earlier business date** needs `sales.opportunity.close` with scope `team` or `all` (else 403 `forbidden`,
    `details: {permission: "sales.opportunity.close", scope: "team"}`), and must fall in the **current closing
    period, the current calendar month in the workspace time zone** (else 422 `wonAt`: "Pick a date in the current
    period (from YYYY-MM-DD)"). Closed months stay closed, so monthly actuals never move after the month ends.
  - KPIs count a won deal on the **workspace date** of `wonAt` (`filter[wonFrom]` / `filter[wonTo]`): a deal won at
    23:30 Addis time counts that day, one at 00:30 the next day, though both are the same UTC date.
- **Lost** (open deals only): `lostReasonId` required and active (422), `lostNote` optional (≤ 1000); moves to the
  Lost stage, sets `lostAt`, clears won fields; event `sales.opportunity.lost` `{opportunityId, lostReasonId,
  lostReason}`.
- **Reopen** (closed deals only, else 409 `opportunity_open`): the route needs `sales.opportunity.reopen`; both
  `reopen` and `close` must reach the record (403 with the missing code). Back to `stageId` (an open stage) or the
  first open stage; clears `wonAt`, `wonValue`, `creditedUser`, `lostAt`, `lostReason`, `lostNote`. Audited
  (`sales.opportunity.reopened` with the cleared values); no event.

Every won, lost and reopen writes a stage-history row and bumps `version`.

### 10.5 Reassignment and credit

- Changing `ownerId` (edit or `opportunities/bulk-assign`) needs `sales.opportunity.assign` reaching the record and
  §3's owner rule. It moves the opportunity's quotations (live and trashed) to the new owner, bumps `version`, is
  audited as an `Owner` change and emits `sales.opportunity.reassigned` `{opportunityId, fromOwnerId, toOwnerId}`.
  It **never changes `creditedUser`**.
- Bulk assign works like leads (§9.3): all or nothing, 422 `opportunityIds` / 403, one audit row per changed deal.
- `creditedUserId` on edit: won deals only (else 422 `creditedUserId`); needs `sales.opportunity.reopen` reaching the
  record (403); must be an active member (422). Audited as a `Credited to` change.

### 10.6 Pipeline board — `GET /sales/workspaces/{slug}/pipeline`

Filters: `filter[owner]`, `filter[team]`, `filter[product]`, `filter[expectedCloseFrom]`, `filter[expectedCloseTo]`;
`limit` = cards per stage (1–200, default 50). Always limited to the caller's `sales.opportunity.view` scope.

```
SalesPipeline = { stages: [{ stage: SalesStage, count, value, weightedValue,
                             opportunities: SalesOpportunity[], nextCursor }],
                  count, value, weightedValue, leadCount: int | null }
```

- Open stages only, in board order. Won and lost deals are listed with `opportunities?filter[status]=won|lost`.
- `value` = sum of expected values, `weightedValue` = sum of `expectedValue × probability`; the top-level totals add
  up the columns (the weighted pipeline of spec §6).
- Each column's cards are the most recently updated first. `nextCursor` continues the column on the list endpoint:
  `GET opportunities?filter[stage]=<id>&sort=-updatedAt&cursor=<nextCursor>` with the same filters.
- `leadCount`: open leads (`new`, `contacted`, `qualified`) in the caller's `sales.lead.view` scope with the same
  owner, team and product filters (the dashboard's "leads" column); null without `sales.lead.view`.

### 10.7 Timeline — `GET /sales/opportunities/{id}/timeline`

Every child of the opportunity, **whatever the child's own owner** (spec §3: the timeline returns all children of a
parent the caller can view), newest first, as a cursor page `{data: SalesTimelineItem[], nextCursor}` (`limit` 1–200,
default 50; keyset on `(at, id)`).

```
SalesTimelineItem = { id: string, kind, at: timestamp, actor: {id, name, hue} | null, summary: string,
                      stageChange: {fromStageId, fromStage, toStageId, toStage} | null,
                      quotation: {id, number, title, amount, status} | null,
                      activity: null, followUp: null }
```

- `id` is unique within the timeline (a stage-history id, or `<quotationId>:<event>`), not always a record id.
- S2 kinds: `stage_created` (`fromStage` null), `stage_moved`, `stage_won`, `stage_lost`, `stage_reopened`;
  `quotation_created`, `quotation_sent`, `quotation_accepted`, `quotation_rejected`, `quotation_expired` (`actor`
  null: the nightly job). A quotation's `status` is its current status.
- S3 adds activity and follow-up kinds, filling `activity` / `followUp` (null otherwise); clients should ignore kinds
  they don't know. Stage names are copied at the time of the change, so renaming or deleting a stage doesn't rewrite
  history. Deleted quotations drop out.

### 10.8 Events

| Event | Payload |
|---|---|
| `sales.opportunity.created` | `{opportunityId, ownerId, sourceLeadId}` |
| `sales.opportunity.moved` | `{opportunityId, fromStageId, toStageId}` |
| `sales.opportunity.won` | `{opportunityId, wonValue, wonAt, creditedUserId, companyId}` |
| `sales.opportunity.lost` | `{opportunityId, lostReasonId, lostReason}` |
| `sales.opportunity.reassigned` | `{opportunityId, fromOwnerId, toOwnerId}` |

Events carry `targetType: "sales.opportunity"` and the actor. All S2 event types are registered without a notification
preference row; S3 adds the notification types.

## 11. Quotations (S2)

`SalesQuotation`:

```
{ id, number, opportunityId, opportunity: {id, title, companyId, companyName}, title, amount: money,
  status: "draft" | "sent" | "accepted" | "rejected" | "expired", sentAt, validUntil, respondedAt, expiredAt,
  notes, ownerId, owner, canEdit, canDelete, createdAt, updatedAt }
```

### 11.1 Routes

| Route | Permission | Body / query | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/quotations` | quotation.view | `filter[status]`, `filter[opportunity]`, `filter[owner]`, `filter[team]`, `q` (number, title, company name), `sort` = `-createdAt` (default) / `createdAt` / `updatedAt` / `number` / `amount` / `validUntil`, `cursor`, `limit` | 200 `SalesQuotationPage` |
| `POST /sales/workspaces/{slug}/quotations` | quotation.create | `{opportunityId, title, amount, validUntil?, notes?}` | 201 |
| `GET /sales/quotations/{id}` | quotation.view (scope) | | 200 |
| `PATCH /sales/quotations/{id}` | quotation.edit (scope) | `{title?, amount?, validUntil?, notes?}` | 200 |
| `DELETE /sales/quotations/{id}` | quotation.delete (scope) | | 204 |
| `POST /sales/quotations/{id}/send` | quotation.edit (scope) | `{validUntil?}` | 200 |
| `POST /sales/quotations/{id}/accept` | quotation.edit (scope) | | 200 |
| `POST /sales/quotations/{id}/reject` | quotation.edit (scope) | | 200 |

- The opportunity must be one the caller can see (422 `opportunityId`). `amount` ≥ 0, `title` ≤ 200.
- **Owner** = the opportunity's owner, always: set on create, moved on reassignment (§10.5), re-synced on restore.
  There is no `ownerId` input. Quotations are scoped by that owner (`sales.quotation.*` codes).
- **Number** `Q-<year>-0001`: a per-workspace counter per year (the workspace's current year at creation), taken
  under a row lock, so concurrent creates never repeat or skip a number. Numbers are never reused (deleted
  quotations keep theirs).
- Quotations of a deleted opportunity are hidden (404) until it is restored.

### 11.2 Transitions

| From | Action | To |
|---|---|---|
| draft | `send` | sent (`sentAt` = now; `validUntil` = the body's date, else today + `quotationValidityDays`, workspace time) |
| sent | `accept` / `reject` | accepted / rejected (`respondedAt` = now) |
| sent | nightly job, `validUntil` before today | expired (`expiredAt`) |
| draft, sent | `PATCH` | unchanged |

Anything else → 409 `invalid_transition`, `details: {status, action}`. `send` with a `validUntil` before today → 422.
**Accepting does not win the opportunity** (use `won`). Audit `sales.quotation.created`, `.updated`, `.sent`,
`.accepted`, `.rejected`, `.expired` (no actor), `.deleted`, `.restored`, `.purged`. Event `sales.quotation.sent`
`{quotationId, opportunityId, number, validUntil}`.

Spec §5's "quotation activity entry" on send: activities arrive in S3. Until then the timeline shows the send as a
`quotation_sent` item; S3 creates the activity from the `on_quotation_sent` hook.

### 11.3 Awaiting response

"Awaiting customer response" = `filter[status]=sent`.

### 11.4 Job `sales_expire_quotations`

Registered with `core/jobs` (suggested schedule `daily 00:15`; `manage.py run_job sales_expire_quotations` or
`POST /api/v1/internal/jobs/sales_expire_quotations`). Per workspace, in its time zone: sent quotations with
`validUntil` before the workspace's today become `expired`. Idempotent (a second run finds nothing to do); skipped
where sales is off.

## 12. Permission notes (S2)

- Default grants are unchanged (§2). In practice: Salespeople create, edit, move, close and convert their own; Sales
  Managers also assign, delete leads and quotations, within their team; only Sales Admin (and Owner / Admin) delete
  opportunities, reopen deals and change the credit; CEO / GM view everything and change nothing.
- `qualify` and `disqualify` use `sales.lead.convert`; `send`, `accept` and `reject` use `sales.quotation.edit`.
- Back-dating a won date needs `close` scope `team` or `all` (§10.4).

## 13. Platform hooks (S2)

Collab targets, search types, trash kinds, audit groups and the job are listed in §8. Indexes (spec §11):
opportunities `(workspace, owner, stage)`, `(workspace, won_at)`, `(workspace, expected_close_date)`.

## 14. Activities (S3)

`SalesActivity`: `{id, type, occurredAt, durationMinutes, targetType, targetId, target: {type, id, name}, companyId,
company: {id, name} | null, quotationId, summary, outcome, ownerId, owner, canEdit, canDelete, createdAt, updatedAt}`.

| Route | Permission | Body / query | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/activities` | activity.view | `filter[type]`, `filter[owner]`, `filter[team]`, `filter[targetType]`, `filter[target]` (record id), `filter[company]`, `filter[occurredFrom]` / `filter[occurredTo]` (workspace dates), `q`, `sort` = `-occurredAt` (default) / `occurredAt` / `createdAt`, `cursor`, `limit` | 200 `SalesActivityPage` |
| `POST /sales/workspaces/{slug}/activities` | activity.create | `{type, targetType, targetId, occurredAt?, durationMinutes?, summary?, outcome?, followUp?: {title?, dueDate, notes?}}` | 201 `{activity, followUp \| null}` |
| `GET/PATCH/DELETE /sales/activities/{id}` | activity.view / edit / delete (scope) | PATCH: any field; `targetType` + `targetId` together | 200 / 204 |

- Types: `call`, `visit`, `meeting`, `email`, `note`, `other`, plus **`quotation`**, written by the system when a
  quotation is sent (spec §5); it can't be logged or changed by hand (422 `type`). Its `quotationId` is set.
- Targets: `sales.lead|opportunity|company|contact`, a live record of the workspace in the caller's view scope for
  its type, else 422 `targetId`. `company` is the target's company (kept in sync when the record changes company).
- `occurredAt` defaults to now; later than now + 5 minutes → 422 (plan it as a follow-up).
- `followUp` creates a follow-up on the same record (a contact's company) in the same transaction; it needs
  `sales.followup.create` (403).
- Activities are owned by whoever logged them and scoped by that owner. Hard delete. Audit `sales.activity.*`.
- Every write refreshes `lastActivityAt` (opportunities, leads, companies): the latest activity or completed
  follow-up (a company's covers all its records). It never bumps an opportunity's `version`.

## 15. Follow-ups (S3)

`SalesFollowUp`: `{id, title, notes, dueDate, status: pending|done|cancelled, bucket, completedAt,
completedActivityId, cancelledAt, targetType (lead, opportunity or company), targetId, target, companyId, company,
createdById, createdBy, ownerId, owner, canEdit, canDelete, canComplete, canReassign, createdAt, updatedAt}`.

| Route | Permission | Body | Answer |
|---|---|---|---|
| `GET /sales/workspaces/{slug}/follow-ups` | followup.view | `bucket` = `overdue` / `today` / `upcoming` / `all` (default); `filter[status]`, `filter[owner]`, `filter[team]`, `filter[targetType]`, `filter[target]`, `filter[company]`, `filter[dueFrom]` / `filter[dueTo]`, `q`, `sort` = `dueDate` (default) / `createdAt` / `updatedAt` | 200 `{data, nextCursor, counts: {overdue, today, upcoming}}` |
| `POST /sales/workspaces/{slug}/follow-ups` | followup.create | `{targetType, targetId, title, dueDate, notes?, ownerId?}` | 201 |
| `GET/PATCH/DELETE /sales/follow-ups/{id}` | followup.view / edit / delete | PATCH `{title?, notes?, dueDate?, status?: "cancelled"}` | 200 / 204 |
| `POST /sales/follow-ups/{id}/complete` | followup.complete | `{activity?: {type, summary?, outcome?, occurredAt?, durationMinutes?}, createNext?: {dueDate, title?}}` | 200 `{followUp, activity \| null, next \| null}` |
| `POST /sales/follow-ups/{id}/reschedule` | followup.edit | `{dueDate}` | 200 |
| `POST /sales/follow-ups/{id}/reassign` | followup.reassign | `{ownerId}` | 200 |

- **Buckets** (pending only, workspace time): overdue = due before today; today; upcoming = after today up to today +
  `upcomingDays`. The row's `bucket` adds `later` (beyond the window) and is null when done or cancelled. `counts`
  cover the same filters, whatever `bucket`.
- `dueDate` must be today or later on create, edit, reschedule and `createNext` (422).
- Only pending follow-ups can be edited, cancelled, rescheduled, reassigned or completed: else 409
  `invalid_transition`, `details: {status, action}`. Delete works in every status (hard delete).
- `ownerId` someone else (create) and `reassign` need `sales.followup.reassign` with scope `team` / `all` and §3's
  owner rule (403 / 422). Audited (`sales.followup.created`, `.updated`, `.cancelled`, `.rescheduled`, `.reassigned`,
  `.completed`, `.deleted`).
- `complete`: the activity is logged on the same record (needs `sales.activity.create`), the next follow-up keeps the
  owner and record (needs `sales.followup.create`); one transaction. Updates `lastActivityAt`; event
  `sales.followup.completed` `{followUpId, ownerId, targetType, targetId, activityId, nextFollowUpId}`.
- Children of a record in the trash are hidden (404, out of lists, digests and counts) until it is restored.

## 16. Flags, last contact and timelines (S3)

- Opportunities: `flags.noNextStep` = open with no pending follow-up on it; `flags.stale` = open with
  `lastActivityAt` (else `createdAt`) older than `staleDays`; new field `lastContactAt` = the latest call, visit,
  meeting or email on the opportunity or its company. Computed with annotations (lists and the board: no N+1).
- Leads and companies gain `lastActivityAt`.
- Timeline kinds added: `activity_logged` (`activity` filled; `quotation` too for quotation entries),
  `followup_scheduled`, `followup_completed`, `followup_cancelled` (`followUp` filled). The opportunity timeline
  leaves out `quotation` activities (the send is already the `quotation_sent` item).
- `GET /sales/companies/{id}/timeline` (company.view scope, cursor page): every activity and follow-up on the company
  or any of its records, whatever their owner. The company summary now fills `openFollowUpCount` (pending, in the
  caller's follow-up scope), `lastContactAt` and `timeline` (the newest 20 items).

## 17. Notifications and jobs (S3)

Preference rows (in-app, plus the `sales_notice` email where on by default):

| Type | Default | Sent to |
|---|---|---|
| `sales.followup.due_today` | in-app, email | the morning digest (below) |
| `sales.followup.overdue` | in-app, email | the morning digest when nothing is due today, or `due_today` is off |
| `sales.opportunity.reassigned` (“assigned to me”) | in-app, email | the new owner on reassignment, bulk assign, or an opportunity created / converted for them by someone else |
| `sales.opportunity.won` | in-app | the leads of the credited user's teams and members whose `sales.dailyreport.review` scope reaches the credited user (`all`, or `team` sharing a team); never the actor or the credited user |
| `sales.quotation.expiring` | in-app, email | the owner, once per quotation and `validUntil`, from 3 days before it |

- Job `sales_followup_digest` (`daily 07:30`, workspace time): one notification per owner of pending follow-ups due
  today or overdue, payload `{date, dueToday, overdue}`; idempotent per (workspace, user, date); skipped where sales is
  off. `sales_expire_quotations` (nightly) now also sends the expiring notices.
- Recipients must still see the record; handlers are skipped where sales is off.

