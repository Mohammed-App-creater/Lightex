import { enc, http } from "./client";
import type { ListQuery } from "./transport";
import type {
  SalesActivity,
  SalesActivityLogResult,
  SalesBody,
  SalesBulkAssignResult,
  SalesCalendar,
  SalesCompany,
  SalesCompanySummary,
  SalesContact,
  SalesDailyReport,
  SalesDailyReportPage,
  SalesDashboard,
  SalesDashboardPeriod,
  SalesDuplicateCheck,
  SalesEffectiveTargets,
  SalesFollowUp,
  SalesFollowUpCompleteResult,
  SalesFollowUpPage,
  SalesHoliday,
  SalesLead,
  SalesLeadConvertResult,
  SalesListQuery,
  SalesLostReason,
  SalesOpportunity,
  SalesPipeline,
  SalesProduct,
  SalesQuery,
  SalesQuotation,
  SalesRanking,
  SalesReport,
  SalesReportInfo,
  SalesRes,
  SalesSettings,
  SalesStage,
  SalesTarget,
  SalesTargetAllocation,
  SalesTargetYear,
  SalesTeamDailyReport,
  SalesTimelinePage,
  SalesUserPerformance,
} from "./types";

/*
 * The sales module's client (docs/sales/api.md). Workspace collections are `/sales/workspaces/{slug}/<collection>`,
 * single records `/sales/<collection>/{id}`. Owned-record lists are cursor pages `{data, nextCursor}`; reference data
 * is a plain array. Money is a decimal string (ETB), never a float. Every route answers 403 `module_disabled` while
 * the module is off.
 */

const W = (slug: string, path = "") => `/sales/workspaces/${enc(slug)}${path}`;
const R = (collection: string, id: string, path = "") => `/sales/${collection}/${enc(id)}${path}`;
/** The typed queries are a subset of `ListQuery` (flat params + `filter: {…}`). */
const lq = (q: object | undefined) => q as ListQuery | undefined;

const settings = {
  get: (slug: string) => http.get<SalesSettings>(W(slug, "/settings")),
  update: (slug: string, body: SalesBody<"sales_settings_update">) => http.put<SalesSettings>(W(slug, "/settings"), body),
};

const stages = {
  list: (slug: string) => http.get<SalesStage[]>(W(slug, "/stages")),
  create: (slug: string, body: SalesBody<"sales_stages_create">) => http.post<SalesStage>(W(slug, "/stages"), body),
  reorder: (slug: string, stageIds: string[]) => http.post<SalesStage[]>(W(slug, "/stages/reorder"), { stageIds }),
  update: (id: string, body: SalesBody<"sales_stages_partial_update">) => http.patch<SalesStage>(R("stages", id), body),
  remove: (id: string) => http.del(R("stages", id)),
};

const products = {
  list: (slug: string, query?: SalesListQuery<"sales_products_list">) => http.get<SalesProduct[]>(W(slug, "/products"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_products_create">) => http.post<SalesProduct>(W(slug, "/products"), body),
  update: (id: string, body: SalesBody<"sales_products_partial_update">) => http.patch<SalesProduct>(R("products", id), body),
  remove: (id: string) => http.del(R("products", id)),
};

const lostReasons = {
  list: (slug: string, query?: SalesListQuery<"sales_lost_reasons_list">) => http.get<SalesLostReason[]>(W(slug, "/lost-reasons"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_lost_reasons_create">) => http.post<SalesLostReason>(W(slug, "/lost-reasons"), body),
  update: (id: string, body: SalesBody<"sales_lost_reasons_partial_update">) => http.patch<SalesLostReason>(R("lost-reasons", id), body),
  remove: (id: string) => http.del(R("lost-reasons", id)),
};

const calendar = {
  get: (slug: string) => http.get<SalesCalendar>(W(slug, "/calendar")),
  update: (slug: string, weekdayWeights: number[]) => http.put<SalesCalendar>(W(slug, "/calendar"), { weekdayWeights }),
};

const holidays = {
  list: (slug: string, query?: SalesListQuery<"sales_holidays_list">) => http.get<SalesHoliday[]>(W(slug, "/holidays"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_holidays_create">) => http.post<SalesHoliday>(W(slug, "/holidays"), body),
  update: (id: string, body: SalesBody<"sales_holidays_partial_update">) => http.patch<SalesHoliday>(R("holidays", id), body),
  remove: (id: string) => http.del(R("holidays", id)),
};

const companies = {
  list: (slug: string, query?: SalesListQuery<"sales_companies_list">) =>
    http.get<SalesRes<"sales_companies_list">>(W(slug, "/companies"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_companies_create">) => http.post<SalesCompany>(W(slug, "/companies"), body),
  /** Warns only (§6.3): matches any live company in the workspace, whatever the caller's scope. */
  checkDuplicate: (slug: string, query: SalesQuery<"sales_companies_check_duplicate">) =>
    http.get<SalesDuplicateCheck>(W(slug, "/companies/check-duplicate"), lq(query)),
  get: (id: string) => http.get<SalesCompany>(R("companies", id)),
  update: (id: string, body: SalesBody<"sales_companies_partial_update">) => http.patch<SalesCompany>(R("companies", id), body),
  remove: (id: string) => http.del(R("companies", id)),
  summary: (id: string) => http.get<SalesCompanySummary>(R("companies", id, "/summary")),
  timeline: (id: string, query?: SalesListQuery<"sales_companies_timeline">) => http.get<SalesTimelinePage>(R("companies", id, "/timeline"), lq(query)),
};

const contacts = {
  list: (slug: string, query?: SalesListQuery<"sales_contacts_list">) => http.get<SalesRes<"sales_contacts_list">>(W(slug, "/contacts"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_contacts_create">) => http.post<SalesContact>(W(slug, "/contacts"), body),
  get: (id: string) => http.get<SalesContact>(R("contacts", id)),
  update: (id: string, body: SalesBody<"sales_contacts_partial_update">) => http.patch<SalesContact>(R("contacts", id), body),
  remove: (id: string) => http.del(R("contacts", id)),
};

const leads = {
  list: (slug: string, query?: SalesListQuery<"sales_leads_list">) => http.get<SalesRes<"sales_leads_list">>(W(slug, "/leads"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_leads_create">) => http.post<SalesLead>(W(slug, "/leads"), body),
  bulkAssign: (slug: string, body: SalesBody<"sales_leads_bulk_assign">) => http.post<SalesBulkAssignResult>(W(slug, "/leads/bulk-assign"), body),
  get: (id: string) => http.get<SalesLead>(R("leads", id)),
  update: (id: string, body: SalesBody<"sales_leads_partial_update">) => http.patch<SalesLead>(R("leads", id), body),
  remove: (id: string) => http.del(R("leads", id)),
  qualify: (id: string) => http.post<SalesLead>(R("leads", id, "/qualify")),
  disqualify: (id: string, reason: string) => http.post<SalesLead>(R("leads", id, "/disqualify"), { reason }),
  convert: (id: string, body: SalesBody<"sales_leads_convert">) => http.post<SalesLeadConvertResult>(R("leads", id, "/convert"), body),
};

const opportunities = {
  list: (slug: string, query?: SalesListQuery<"sales_opportunities_list">) =>
    http.get<SalesRes<"sales_opportunities_list">>(W(slug, "/opportunities"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_opportunities_create">) => http.post<SalesOpportunity>(W(slug, "/opportunities"), body),
  bulkAssign: (slug: string, body: SalesBody<"sales_opportunities_bulk_assign">) =>
    http.post<SalesBulkAssignResult>(W(slug, "/opportunities/bulk-assign"), body),
  get: (id: string) => http.get<SalesOpportunity>(R("opportunities", id)),
  update: (id: string, body: SalesBody<"sales_opportunities_partial_update">) => http.patch<SalesOpportunity>(R("opportunities", id), body),
  remove: (id: string) => http.del(R("opportunities", id)),
  /** 409 `version_conflict` with `details.current` (the opportunity now); 409 `opportunity_closed`. */
  move: (id: string, body: SalesBody<"sales_opportunities_move">) => http.post<SalesOpportunity>(R("opportunities", id, "/move"), body),
  won: (id: string, body: SalesBody<"sales_opportunities_won"> = {}) => http.post<SalesOpportunity>(R("opportunities", id, "/won"), body),
  lost: (id: string, body: SalesBody<"sales_opportunities_lost">) => http.post<SalesOpportunity>(R("opportunities", id, "/lost"), body),
  reopen: (id: string, body: SalesBody<"sales_opportunities_reopen"> = {}) => http.post<SalesOpportunity>(R("opportunities", id, "/reopen"), body),
  timeline: (id: string, query?: SalesListQuery<"sales_opportunities_timeline">) =>
    http.get<SalesTimelinePage>(R("opportunities", id, "/timeline"), lq(query)),
};

const pipeline = {
  /** Open stages only, in board order; `limit` = cards per stage. Continue a column with `opportunities.list`. */
  get: (slug: string, query?: SalesListQuery<"sales_pipeline_retrieve">) => http.get<SalesPipeline>(W(slug, "/pipeline"), lq(query)),
};

const quotations = {
  list: (slug: string, query?: SalesListQuery<"sales_quotations_list">) => http.get<SalesRes<"sales_quotations_list">>(W(slug, "/quotations"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_quotations_create">) => http.post<SalesQuotation>(W(slug, "/quotations"), body),
  get: (id: string) => http.get<SalesQuotation>(R("quotations", id)),
  update: (id: string, body: SalesBody<"sales_quotations_partial_update">) => http.patch<SalesQuotation>(R("quotations", id), body),
  remove: (id: string) => http.del(R("quotations", id)),
  send: (id: string, body: SalesBody<"sales_quotations_send"> = {}) => http.post<SalesQuotation>(R("quotations", id, "/send"), body),
  accept: (id: string) => http.post<SalesQuotation>(R("quotations", id, "/accept")),
  reject: (id: string) => http.post<SalesQuotation>(R("quotations", id, "/reject")),
};

const activities = {
  list: (slug: string, query?: SalesListQuery<"sales_activities_list">) => http.get<SalesRes<"sales_activities_list">>(W(slug, "/activities"), lq(query)),
  /** Optionally schedules a follow-up in the same call: `{activity, followUp | null}`. */
  create: (slug: string, body: SalesBody<"sales_activities_create">) => http.post<SalesActivityLogResult>(W(slug, "/activities"), body),
  get: (id: string) => http.get<SalesActivity>(R("activities", id)),
  update: (id: string, body: SalesBody<"sales_activities_partial_update">) => http.patch<SalesActivity>(R("activities", id), body),
  remove: (id: string) => http.del(R("activities", id)),
};

const followUps = {
  /** `{data, nextCursor, counts: {overdue, today, upcoming}}`. */
  list: (slug: string, query?: SalesListQuery<"sales_follow_ups_list">) => http.get<SalesFollowUpPage>(W(slug, "/follow-ups"), lq(query)),
  create: (slug: string, body: SalesBody<"sales_follow_ups_create">) => http.post<SalesFollowUp>(W(slug, "/follow-ups"), body),
  get: (id: string) => http.get<SalesFollowUp>(R("follow-ups", id)),
  update: (id: string, body: SalesBody<"sales_follow_ups_partial_update">) => http.patch<SalesFollowUp>(R("follow-ups", id), body),
  remove: (id: string) => http.del(R("follow-ups", id)),
  complete: (id: string, body: SalesBody<"sales_follow_ups_complete"> = {}) =>
    http.post<SalesFollowUpCompleteResult>(R("follow-ups", id, "/complete"), body),
  reschedule: (id: string, dueDate: string) => http.post<SalesFollowUp>(R("follow-ups", id, "/reschedule"), { dueDate }),
  reassign: (id: string, ownerId: string) => http.post<SalesFollowUp>(R("follow-ups", id, "/reassign"), { ownerId }),
};

const targets = {
  list: (slug: string, query?: SalesListQuery<"sales_targets_list">) => http.get<SalesTarget[]>(W(slug, "/targets"), lq(query)),
  /** Create or update by (subject, periodType, periodStart). */
  set: (slug: string, body: SalesBody<"sales_targets_set">) => http.post<SalesTarget>(W(slug, "/targets"), body),
  get: (id: string) => http.get<SalesTarget>(R("targets", id)),
  remove: (id: string) => http.del(R("targets", id)),
  /** `subject` = `company` | `team:<id>` | `user:<id>`. */
  allocation: (slug: string, query?: SalesQuery<"sales_targets_allocation">) => http.get<SalesTargetAllocation>(W(slug, "/targets/allocation"), lq(query)),
  allocate: (slug: string, body: SalesBody<"sales_targets_allocate">) => http.post<SalesTargetYear>(W(slug, "/targets/allocate"), body),
  effective: (slug: string, query?: SalesQuery<"sales_targets_effective">) => http.get<SalesEffectiveTargets>(W(slug, "/targets/effective"), lq(query)),
};

const performance = {
  user: (slug: string, userId: string, query?: SalesQuery<"sales_performance_user">) =>
    http.get<SalesUserPerformance>(W(slug, `/performance/users/${enc(userId)}`), lq(query)),
  ranking: (slug: string, query?: SalesQuery<"sales_performance_ranking">) => http.get<SalesRanking>(W(slug, "/performance/ranking"), lq(query)),
};

const dailyReports = {
  /** Your report for today; created as a draft on first read. */
  today: (slug: string) => http.get<SalesDailyReport>(W(slug, "/daily-reports/me/today")),
  list: (slug: string, query?: SalesListQuery<"sales_daily_reports_list">) => http.get<SalesDailyReportPage>(W(slug, "/daily-reports"), lq(query)),
  team: (slug: string, query?: SalesQuery<"sales_daily_reports_team">) => http.get<SalesTeamDailyReport>(W(slug, "/daily-reports/team"), lq(query)),
  get: (id: string) => http.get<SalesDailyReport>(R("daily-reports", id)),
  /** Author only; 409 `report_reviewed` once reviewed. */
  update: (id: string, body: SalesBody<"sales_daily_reports_update">) => http.put<SalesDailyReport>(R("daily-reports", id), body),
  submit: (id: string) => http.post<SalesDailyReport>(R("daily-reports", id, "/submit")),
  review: (id: string, comment?: string) => http.post<SalesDailyReport>(R("daily-reports", id, "/review"), comment ? { comment } : {}),
  reopen: (id: string) => http.post<SalesDailyReport>(R("daily-reports", id, "/reopen")),
};

type ReportQuery = Omit<SalesQuery<"sales_report">, "format">;

const reports = {
  catalogue: (slug: string) => http.get<SalesReportInfo[]>(W(slug, "/reports")),
  get: (slug: string, key: string, query?: ReportQuery) => http.get<SalesReport>(W(slug, `/reports/${enc(key)}`), lq(query)),
  /** `format=csv` (needs `sales.report.export`): the CSV text (UTF-8 BOM included). Save it with `downloadCsv`. */
  csv: (slug: string, key: string, query?: ReportQuery) => http.get<string>(W(slug, `/reports/${enc(key)}`), lq({ ...query, format: "csv" })),
};

export const sales = {
  settings,
  stages,
  products,
  lostReasons,
  calendar,
  holidays,
  companies,
  contacts,
  leads,
  opportunities,
  pipeline,
  quotations,
  activities,
  followUps,
  targets,
  performance,
  dailyReports,
  reports,
  /** S6 dashboard: 403 `forbidden` for a user / team outside the caller's scope. */
  dashboard: (slug: string, query: { period?: SalesDashboardPeriod; date?: string; userId?: string; teamId?: string } = {}) =>
    http.get<SalesDashboard>(W(slug, "/dashboard"), query),
};
