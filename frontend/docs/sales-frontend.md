# Sales frontend: foundation for phase B

Phase A built the data layer, routes, sidebar and shared UI of the sales module. Phase B replaces the placeholder
screens. Sources of truth: `docs/sales/api.md` (behaviour), `docs/sales/spec.md`, `src/api/schema.d.ts` (shapes).

## Layout

| Path | What |
|---|---|
| `src/api/sales-types.ts` | Type aliases (re-exported from `@/api/types`). `SalesRes<"op">`, `SalesBody<"op">`, `SalesListQuery<"op">` and `SalesQuery<"op">` derive answers, bodies and queries from the schema's `operations` (`sales_*` operation ids). Never hand-write a sales wire shape. |
| `src/api/sales-endpoints.ts` | `api.sales.*`, the whole client (re-exported by `endpoints.ts`). |
| `src/modules/sales/api/` | `keys.ts` (`sk`), `queries.ts` (read hooks), `mutations.ts` (write hooks). Import from `../api`. |
| `src/modules/sales/shared/` | Shared UI and helpers (below). |
| `src/modules/sales/<area>/` | One folder per area, holding its screens, local components and tests. |
| `src/app/[workspace]/sales/**/page.tsx` | Thin client pages: they read `useParams` and render one screen. `layout.tsx` mounts `SalesLayout` (quick actions and FAB). |

## Client (`api.sales`)

Groups: `settings`, `stages`, `products`, `lostReasons`, `calendar`, `holidays`, `companies`, `contacts`, `leads`,
`opportunities`, `pipeline`, `quotations`, `activities`, `followUps`, `targets`, `performance`, `dailyReports`,
`reports`, plus `dashboard(slug, query)`.

- Collection calls take `slug`; record calls take `id`. Most groups have `list`, `create`, `get`, `update` and
  `remove`, plus the action routes: `leads.qualify|disqualify|convert|bulkAssign`,
  `opportunities.move|won|lost|reopen|timeline|bulkAssign`, `quotations.send|accept|reject`,
  `followUps.complete|reschedule|reassign`, `targets.set|allocation|allocate|effective`,
  `performance.user|ranking`, `dailyReports.today|team|submit|review|reopen`, `reports.catalogue|get|csv`,
  `companies.summary|timeline|checkDuplicate`, and `stages.reorder`.
- List queries use the `ListQuery` idiom: `{ filter: { status: ["open"], owner: "me" }, q, sort: "-createdAt", limit }`.
  The filter keys and values are type-checked against the schema.
- `reports.csv` returns the CSV text: `HttpTransport` now returns text for `text/csv`. Save it with `downloadText`,
  or use `useExportReport`.

## Hooks (`src/modules/sales/api`)

Naming: `use<Entity>` reads one record, `use<Entities>` reads a list, and `use<Verb><Entity>` writes. The workspace
comes from `WorkspaceScope` (`useSlug()`). 403 and 404 are never retried (`salesRetry`).

- **Reads.**
  - Reference data and settings: `useSalesSettings`, `useStages`, `useProducts(q)`, `useLostReasons(q)`,
    `useSalesCalendar`, `useHolidays(q)`.
  - Companies and contacts: `useCompanies(q)`, `useCompany(id)`, `useCompanySummary(id)`, `useCompanyTimeline(id)`,
    `useDuplicateCheck({name, phone, excludeId})`, `useContacts(q)`, `useContact(id)`.
  - Leads, deals and quotations: `useLeads(q)`, `useLead(id)`, `useOpportunities(q)`, `useOpportunity(id)`,
    `useOpportunityTimeline(id)`, `usePipeline(q)` (polls every 30 s while realtime is off), `useQuotations(q)`,
    `useQuotation(id)`.
  - Activities and follow-ups: `useActivities(q)`, `useActivity(id)`, `useFollowUps(q)` (page 0 carries `counts`),
    `useFollowUp(id)`.
  - Targets and performance: `useTargets(q)`, `useTarget(id)`, `useTargetAllocation(q)`, `useEffectiveTargets(q)`,
    `usePerformance(userId, q)`, `useRanking(q)`.
  - Daily reports: `useMyDailyReport()`, `useDailyReports(q)`, `useTeamDailyReport(q)`, `useDailyReport(id)`.
  - Dashboard and reports: `useSalesDashboard(q)`, `useReportCatalogue()`, `useReport(key, q)`.
- **Cursor lists** (companies, contacts, leads, opportunities, quotations, activities, follow-ups, daily reports and
  timelines) are infinite queries. Use `pageItems(q.data)`, `q.hasNextPage` and `q.fetchNextPage()`. Lists take an
  optional second argument, `enabled`.
- **Writes.**
  - Settings and reference data: `useUpdateSalesSettings`; `useCreate|Update|DeleteStage` and `useReorderStages`;
    `useCreate|Update|Delete` for `Product`, `LostReason` and `Holiday`; `useUpdateSalesCalendar`.
  - Companies, contacts and leads: `useCreate|Update|Delete` for `Company`, `Contact` and `Lead`;
    `useBulkAssignLeads`, `useQualifyLead`, `useDisqualifyLead`, `useConvertLead`.
  - Opportunities: `useCreate|Update|DeleteOpportunity`, `useBulkAssignOpportunities`, `useMoveOpportunity`,
    `useWinOpportunity`, `useLoseOpportunity`, `useReopenOpportunity`.
  - Quotations: `useCreate|Update|DeleteQuotation`, `useSendQuotation`, `useAcceptQuotation`, `useRejectQuotation`.
  - Activities and follow-ups: `useLogActivity` (can also create a follow-up), `useUpdate|DeleteActivity`,
    `useCreate|Update|DeleteFollowUp`, `useCompleteFollowUp`, `useRescheduleFollowUp`, `useReassignFollowUp`.
  - Targets: `useSetTarget`, `useDeleteTarget`, `useAllocateTarget`.
  - Daily reports: `useUpdate|Submit|Review|ReopenDailyReport`.
  - Reports: `useExportReport` (downloads `<key>.csv`).
  - Update variables are `{ id, body }`; deletes take the id.
- **Write behaviour (`useWrite`).**
  - On settle, a write invalidates its groups. Owned-record writes also invalidate the KPI-derived groups (`DERIVED`:
    pipeline, dashboard, performance, reports, daily reports, targets).
  - The server's record is written into its detail cache.
  - Errors are toasted, except 422 `validation_failed`: forms show `err.fieldErrors[field]`. `isValidation(e)`
    helps here.
  - On 409 `version_conflict`, the detail cache takes `details.current`.
  - Add success toasts and closing in the screen (`mutate(v, { onSuccess })`).
- **`useMoveOpportunity()`** takes `mutate({ opp, stageId })`.
  - It sends `opp.version` and moves the card optimistically in every cached board. Column counts and values are
    updated in cents (`movePipelineCard`).
  - It rolls back on any error. On 409 it toasts "Someone else changed this card" and stores `details.current`.
  - 409 `opportunity_closed` is toasted with the server message.
- **Keys.**
  - `sk.group(slug, g)` is the prefix to invalidate.
  - `sk.list(slug, g, params)` and `sk.one(slug, g, id, part?)` are the keys the hooks use.
  - `invalidateSales(qc, slug, groups)`.

## Shared UI (`src/modules/sales/shared`)

| Export | File | Notes |
|---|---|---|
| `formatMoney(v, {compact, cents, currency})` | `money.ts` | Example: `"250000.50"` → `ETB 250,000.50`. Integer cents (BigInt), no floats. `null` → `—`. |
| `formatPct(n)` | `money.ts` | Example: `72.5%`. |
| `addMoney`, `subMoney`, `toCents`, `fromCents`, `isMoney` | `money.ts` | Use these for any money arithmetic or validation. |
| `StatusDot {status, showLabel}` | `status-dot.tsx` | green, yellow or red; grey when there is no target. |
| `PeriodPicker {value, onChange}`, `usePeriodParam(param?, fallback?)` | `period-picker.tsx` | Today … Year. The period lives in `?period=` via `replaceUrl`. `toKpiPeriod` maps `today` to `day` for performance and targets. |
| `UserPicker {value, onChange, noneLabel?, people?}` | `user-picker.tsx` | Picks one active workspace member. |
| `OwnerPicker {code, value, onChange}` | `user-picker.tsx` | Read-only "You" with an `own` scope on `code`; a `UserPicker` with `team` or `all`. The server enforces the team rule (422 `ownerId`). |
| `useSalesPeople()` | `user-picker.tsx` | Active members as `{id, name, hue}`. |
| `StagePill {stage}`, `ProbabilityBadge {value, overridden}` | `stage-pill.tsx` | |
| `EntityLink {kind, id, name}`, `salesEntityHref`, `kindOfTarget(targetType)` | `entity-link.tsx` | Links companies, contacts, leads and opportunities. A contact link is `contacts?contact=<id>`. |
| `salesRoutes.*`, `salesAreaOf(pathname)` | `routes.ts` | Every sales URL. |
| `useSalesScope(code)` | `scope.ts` | Returns `{allowed, scope, isOwn, beyondOwn, isAll}` on top of `useCan` and `useDataScope`. |
| `hasAnySales(perms)` | `scope.ts` | |
| `useQuickActions().open(kind, target?)` | `quick-actions.tsx` | Kinds: `log-call`, `log-visit`, `add-follow-up` and `submit-report` (`submit-report` navigates). Register the dialogs in `QUICK_ACTION_DIALOGS[kind]`, which get `{target, onClose}`. Until a dialog is registered, opening it toasts "Coming soon". |
| `QuickActionsMenu {target?}`, `QuickActionsFab` | `quick-actions.tsx` | `QuickActionsMenu` is the header button; `QuickActionsFab` is the button below 1024px, mounted by the layout. Both show only the actions the viewer may use. |
| `SalesGate {permission, name}`, `SalesPageFrame {title, actions}`, `SalesPlaceholder` | `sales-page.tsx` | Page gate, page frame, and the phase-A stub. |
| `SALES_NAV`, `salesNavItems(perms)`, `SalesNavSection` | `nav.ts`, `nav-section.tsx` | The sidebar section. |

## Routes → screens

| Route (`/[workspace]/sales/…`) | Screen (`src/modules/sales/…`) | View permission |
|---|---|---|
| (index) | `dashboard/dashboard-screen.tsx` `DashboardScreen` (renders the preview `sales-screen.tsx` until replaced) | `sales.dashboard.view` |
| `pipeline` | `pipeline/pipeline-screen.tsx` `PipelineScreen` | `sales.opportunity.view` |
| `opportunities/[id]` | `opportunities/opportunity-screen.tsx` `OpportunityScreen {id}` | `sales.opportunity.view` |
| `leads`, `leads/[id]` | `leads/leads-screen.tsx` `LeadsScreen`, `leads/lead-screen.tsx` `LeadScreen {id}` | `sales.lead.view` |
| `companies`, `companies/[id]` | `companies/companies-screen.tsx` `CompaniesScreen`, `companies/company-screen.tsx` `CompanyScreen {id}` | `sales.company.view` |
| `contacts` | `contacts/contacts-screen.tsx` `ContactsScreen` (`?contact=<id>` opens one) | `sales.contact.view` |
| `follow-ups` | `follow-ups/follow-ups-screen.tsx` `FollowUpsScreen` | `sales.followup.view` |
| `targets` | `targets/targets-screen.tsx` `TargetsScreen` | `sales.target.view` |
| `daily-report` | `daily-reports/daily-report-screen.tsx` `DailyReportScreen` (my report) | `sales.dailyreport.submit` |
| `daily-reports` | `daily-reports/team-reports-screen.tsx` `TeamReportsScreen` (team and review) | `sales.dailyreport.view` |
| `performance`, `performance/[userId]` | `performance/performance-screen.tsx` `PerformanceScreen`, `performance/performance-user-screen.tsx` `PerformanceUserScreen {userId}` | `sales.performance.view` |
| `reports`, `reports/[key]` | `reports/reports-screen.tsx` `ReportsScreen`, `reports/report-screen.tsx` `ReportScreen {reportKey}` | `sales.report.view` |
| `settings` | `settings/settings-screen.tsx` `SalesSettingsScreen` | `sales.settings.manage` |

Replace the body of each screen and keep its export name and props, so the pages need no change.

## Gating

- **Shell.**
  - The registry hides everything sales while the module is off.
  - `ModuleRouteGuard` shows "Sales is turned off" or a 403 for every `/sales/*` route without
    `sales.dashboard.view`, the code every sales role holds.
- **Sidebar.**
  - The expanded sidebar shows the "Sales" section (`sidebarSections` slot) when the viewer holds any `sales.*`
    code. Each item has its own permission (table above).
  - The collapsed rail and the palette show one "Sales" link (`nav` item with `railOnly: true`). The new
    `ModuleNavItem.railOnly` flag is honoured by `moduleNavItems(ctx, modules, "expanded")`.
- **Screens.** Every screen wraps itself in `SalesGate` with its view permission.
- **Buttons.**
  - Buttons that don't depend on a record (create, settings, export, bulk assign) check `useCan`, and are not
    rendered without it.
  - Record actions use the record's hints: `canEdit`, `canDelete`, and on opportunities `canMove` and `canClose`.
  - Never infer permissions from role names.
- **Data scope.** Use `useSalesScope(code)` to shape the UI, for example hiding owner or team filters for `own`. The
  server applies the scope.
  - Records outside the view scope answer 404: show "not found".
  - Records inside it but outside the action's scope answer 403 with `details.permission`.

## Conventions

- **Money is a string.**
  - Display it with `formatMoney`.
  - Do arithmetic with `addMoney` / `subMoney` and validate input with `isMoney`.
  - Never convert it with `Number()`.
- **Formats.** Percentages are numbers; display them with `formatPct`. Dates are `YYYY-MM-DD` in workspace time.
- **State in the URL.** Filters, period, tabs and dialog state live in the query string, changed with
  `replaceUrl` / `pushUrl`, never `router.push`.
- **Every screen** has skeleton, empty and error (retry) states. It works at 390 px and in all three themes, with
  token colour classes only. Use `SalesPageFrame`; it leaves room for the FAB at the bottom on mobile.
- **Hooks.** Keep new hooks tiny and add them to `api/queries.ts` or `api/mutations.ts`; don't call `api.sales.*`
  from components. For a new key, use `sk`; never inline arrays.
- **Optimistic writes.** Board-like writes are optimistic with rollback (see `useMoveOpportunity`). Writes that send
  a version keep the 409 handling.
- **Mock.** The mock lives in `src/api/mock/sales/` (A2). Mock-backed tests turn sales on or off explicitly; the seed
  has sales on in `platform`.
- **Tests.** Run targeted tests: `npx vitest run --maxWorkers=2 src/modules/sales`.
- **Realtime.** `sales.*` SSE events are not wired into `apply-event.ts` yet. Screens rely on invalidation after
  writes, plus polling (the pipeline polls). Wiring them is phase-B work if needed.
