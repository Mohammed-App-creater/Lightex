/*
 * Sales API types (docs/sales/api.md), aliased from the generated schema like `types.ts` does. Wire shapes are never
 * hand-written: entities are `Wire<S["Sales…"]>`, and request bodies / list queries / answers come straight from the
 * schema's `operations` through `SalesBody`, `SalesListQuery` and `SalesRes`, so backend drift fails typecheck.
 * Re-exported from `types.ts`.
 */

import type { components, operations } from "./schema";

type S = components["schemas"];
type W<T> = { -readonly [K in keyof T]: T[K] };
type Op = keyof operations;

type Json<R> = R extends { content: { "application/json": infer B } } ? B : never;
/** The success body of a sales operation (200 or 201). */
export type SalesRes<K extends Op> = operations[K]["responses"] extends infer R
  ? R extends { 200: infer A }
    ? W<Json<A>>
    : R extends { 201: infer B }
      ? W<Json<B>>
      : never
  : never;
/** The JSON request body of a sales operation. */
export type SalesBody<K extends Op> = W<Json<NonNullable<operations[K]["requestBody"]>>>;

type RawQuery<K extends Op> = NonNullable<operations[K]["parameters"]["query"]>;
type One<V> = V extends readonly (infer E)[] ? V | E : V;
type FilterPart<Q> = { [K in keyof Q as K extends `filter[${infer F}]` ? F : never]?: One<Q[K]> };
type PlainPart<Q> = { [K in keyof Q as K extends `filter[${string}]` ? never : K]?: Q[K] };
/**
 * A sales list query in the client's `ListQuery` idiom: `filter[status]` becomes `filter: { status }` (a single value
 * or an array), `cursor` / `limit` / `q` / `sort` and the rest stay flat.
 */
export type SalesListQuery<K extends Op> = PlainPart<RawQuery<K>> & { filter?: FilterPart<RawQuery<K>> };
/** A plain (non-filter) query of a sales operation (`period`, `date`, `userId`…). */
export type SalesQuery<K extends Op> = W<RawQuery<K>>;

/* ── Reference data and settings (§5) ── */
export type SalesSettings = W<S["SalesSettings"]>;
export type SalesStage = W<S["SalesStage"]>;
export type SalesStageCategory = S["SalesStageCategoryEnum"];
export type SalesProduct = W<S["SalesProduct"]>;
export type SalesLostReason = W<S["SalesLostReason"]>;
export type SalesCalendar = W<S["SalesCalendar"]>;
export type SalesHoliday = W<S["SalesHoliday"]>;

/* ── Customers (§6–§7) ── */
export type SalesCompany = W<S["SalesCompany"]>;
export type SalesCompanyStatus = S["SalesCompanyStatusEnum"];
export type SalesCompanySummary = W<S["SalesCompanySummary"]>;
export type SalesDuplicateCheck = W<S["SalesDuplicateCheck"]>;
export type SalesContact = W<S["SalesContact"]>;
export type SalesUserBrief = W<S["SalesUserBrief"]>;

/* ── Leads, opportunities, pipeline, quotations (§9–§11) ── */
export type SalesLead = W<S["SalesLead"]>;
export type SalesLeadStatus = S["SalesLeadStatusEnum"];
export type SalesLeadSource = S["SalesLeadSourceEnum"];
export type SalesLeadConvertResult = W<S["SalesLeadConvertResult"]>;
export type SalesOpportunity = W<S["SalesOpportunity"]>;
export type SalesPipeline = W<S["SalesPipeline"]>;
export type SalesPipelineColumn = W<S["SalesPipelineColumn"]>;
export type SalesTimelineItem = W<S["SalesTimelineItem"]>;
export type SalesTimelinePage = W<S["SalesTimelinePage"]>;
export type SalesQuotation = W<S["SalesQuotation"]>;
export type SalesQuotationStatus = S["SalesQuotationStatusEnum"];
export type SalesBulkAssignResult = W<S["SalesBulkAssignResult"]>;

/* ── Activities and follow-ups (§14–§15) ── */
export type SalesActivity = W<S["SalesActivity"]>;
export type SalesActivityType = S["SalesActivityTypeEnum"];
export type SalesActivityLogResult = W<S["SalesActivityLogResult"]>;
export type SalesFollowUp = W<S["SalesFollowUp"]>;
export type SalesFollowUpPage = W<S["SalesFollowUpPage"]>;
export type SalesFollowUpCounts = W<S["SalesFollowUpCounts"]>;
export type SalesFollowUpCompleteResult = W<S["SalesFollowUpCompleteResult"]>;
export type SalesTargetType = S["SalesFollowUpTargetTypeEnum"];

/* ── Targets and performance (§18–§19) ── */
export type SalesTarget = W<S["SalesTarget"]>;
export type SalesTargetYear = W<S["SalesTargetYear"]>;
export type SalesTargetAllocation = W<S["SalesTargetAllocation"]>;
export type SalesEffectiveTargets = W<S["SalesEffectiveTargets"]>;
export type SalesKpis = W<S["SalesKpis"]>;
export type SalesUserPerformance = W<S["SalesUserPerformance"]>;
export type SalesRanking = W<S["SalesRanking"]>;
export type SalesRankingRow = W<S["SalesRankingRow"]>;

/* ── Daily reports (§20) ── */
export type SalesDailyReport = W<S["SalesDailyReport"]>;
export type SalesDailyReportPage = W<S["SalesDailyReportPage"]>;
export type SalesTeamDailyReport = W<S["SalesTeamDailyReport"]>;

/* ── Dashboard and reports (§21–§22) ── */
export type SalesDashboard = W<S["SalesDashboard"]>;
/** Dashboard periods (`today` … `year`); reports add `custom`. */
export type SalesDashboardPeriod = NonNullable<SalesQuery<"sales_dashboard">["period"]>;
export type SalesReportInfo = W<S["SalesReportInfo"]>;
export type SalesReport = W<S["SalesReport"]>;
export type SalesReportColumn = W<S["SalesReportColumn"]>;
export type SalesReportPeriod = S["SalesReportPeriodEnum"];
/** KPI / performance periods (`day` … `year`). */
export type SalesKpiPeriod = NonNullable<SalesQuery<"sales_performance_user">["period"]>;
