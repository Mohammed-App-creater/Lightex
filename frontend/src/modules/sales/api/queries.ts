"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { isForbidden, isNotFound } from "@/api/errors";
import type { SalesDashboardPeriod, SalesListQuery, SalesQuery } from "@/api/types";
import { useCurrentWorkspace } from "@/platform/roles/can";
import { useLiveInterval } from "@/platform/realtime/status-store";
import { POLL_MS } from "@/platform/workspace/queries";
import { sk, type SalesGroup } from "./keys";

/*
 * Sales read hooks (docs/sales/api.md). One tiny hook per endpoint; the workspace comes from `WorkspaceScope`.
 * Cursor lists are infinite queries (`pageItems(q.data)` flattens them). 403 / 404 are never retried.
 */

/** The current workspace slug (sales screens always render inside `WorkspaceScope`). */
export const useSlug = () => useCurrentWorkspace()?.slug ?? "";

export const salesRetry = (n: number, e: unknown) => !isForbidden(e) && !isNotFound(e) && n < 2;

/** Every item of an infinite cursor list, in order. */
export const pageItems = <T>(data: { pages: { data: T[] }[] } | undefined): T[] => data?.pages.flatMap((p) => p.data) ?? [];

type Cursorable = { cursor?: string };
type Page = { nextCursor: string | null };

function useCursorList<Q extends Cursorable, P extends Page>(g: SalesGroup, query: Q, fetch: (slug: string, q: Q) => Promise<P>, enabled = true) {
  const slug = useSlug();
  return useInfiniteQuery({
    queryKey: sk.list(slug, g, query),
    queryFn: ({ pageParam }) => fetch(slug, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: salesRetry,
    enabled: enabled && Boolean(slug),
  });
}

function useOne<T>(g: SalesGroup, id: string | null | undefined, fetch: (id: string) => Promise<T>, part?: string) {
  const slug = useSlug();
  return useQuery({
    queryKey: sk.one(slug, g, id ?? "", part),
    queryFn: () => fetch(id!),
    retry: salesRetry,
    enabled: Boolean(id && slug),
  });
}

function useRead<T>(g: SalesGroup, params: object, fetch: (slug: string) => Promise<T>, enabled = true) {
  const slug = useSlug();
  return useQuery({ queryKey: sk.list(slug, g, params), queryFn: () => fetch(slug), retry: salesRetry, enabled: enabled && Boolean(slug) });
}

/* ── Reference data and settings ── */
export const useSalesSettings = () => useRead("settings", {}, api.sales.settings.get);
export const useStages = () => useRead("stages", {}, api.sales.stages.list);
export const useProducts = (q: SalesListQuery<"sales_products_list"> = {}) => useRead("products", q, (s) => api.sales.products.list(s, q));
export const useLostReasons = (q: SalesListQuery<"sales_lost_reasons_list"> = {}) => useRead("lostReasons", q, (s) => api.sales.lostReasons.list(s, q));
export const useSalesCalendar = () => useRead("calendar", {}, api.sales.calendar.get);
export const useHolidays = (q: SalesListQuery<"sales_holidays_list"> = {}) => useRead("holidays", q, (s) => api.sales.holidays.list(s, q));

/* ── Companies and contacts ── */
export const useCompanies = (q: SalesListQuery<"sales_companies_list"> = {}, enabled = true) =>
  useCursorList("companies", q, api.sales.companies.list, enabled);
export const useCompany = (id: string | null | undefined) => useOne("companies", id, api.sales.companies.get);
export const useCompanySummary = (id: string | null | undefined) => useOne("companies", id, api.sales.companies.summary, "summary");
export const useCompanyTimeline = (id: string) =>
  useCursorList("companies", { id, part: "timeline" } as Cursorable, (_s, q) => api.sales.companies.timeline(id, { cursor: q.cursor }), Boolean(id));
/** Debounce the input yourself; runs only with a name or phone. */
export const useDuplicateCheck = (q: SalesQuery<"sales_companies_check_duplicate">) =>
  useRead("companies", { dup: q }, (s) => api.sales.companies.checkDuplicate(s, q), Boolean(q.name || q.phone));
export const useContacts = (q: SalesListQuery<"sales_contacts_list"> = {}, enabled = true) =>
  useCursorList("contacts", q, api.sales.contacts.list, enabled);
export const useContact = (id: string | null | undefined) => useOne("contacts", id, api.sales.contacts.get);

/* ── Leads, opportunities, pipeline, quotations ── */
export const useLeads = (q: SalesListQuery<"sales_leads_list"> = {}, enabled = true) => useCursorList("leads", q, api.sales.leads.list, enabled);
export const useLead = (id: string | null | undefined) => useOne("leads", id, api.sales.leads.get);
export const useOpportunities = (q: SalesListQuery<"sales_opportunities_list"> = {}, enabled = true) =>
  useCursorList("opportunities", q, api.sales.opportunities.list, enabled);
export const useOpportunity = (id: string | null | undefined) => useOne("opportunities", id, api.sales.opportunities.get);
export const useOpportunityTimeline = (id: string) =>
  useCursorList("opportunities", { id, part: "timeline" } as Cursorable, (_s, q) => api.sales.opportunities.timeline(id, { cursor: q.cursor }), Boolean(id));
/** The board polls every 30 s while realtime isn't live. */
export function usePipeline(q: SalesListQuery<"sales_pipeline_retrieve"> = {}) {
  const slug = useSlug();
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: sk.list(slug, "pipeline", q),
    queryFn: () => api.sales.pipeline.get(slug, q),
    retry: salesRetry,
    enabled: Boolean(slug),
    refetchInterval: interval,
  });
}
export const useQuotations = (q: SalesListQuery<"sales_quotations_list"> = {}, enabled = true) =>
  useCursorList("quotations", q, api.sales.quotations.list, enabled);
export const useQuotation = (id: string | null | undefined) => useOne("quotations", id, api.sales.quotations.get);

/* ── Activities and follow-ups ── */
export const useActivities = (q: SalesListQuery<"sales_activities_list"> = {}, enabled = true) =>
  useCursorList("activities", q, api.sales.activities.list, enabled);
export const useActivity = (id: string | null | undefined) => useOne("activities", id, api.sales.activities.get);
/** Page 0 carries `counts: {overdue, today, upcoming}`. */
export const useFollowUps = (q: SalesListQuery<"sales_follow_ups_list"> = {}, enabled = true) =>
  useCursorList("followUps", q, api.sales.followUps.list, enabled);
export const useFollowUp = (id: string | null | undefined) => useOne("followUps", id, api.sales.followUps.get);

/* ── Targets and performance ── */
export const useTargets = (q: SalesListQuery<"sales_targets_list"> = {}) => useRead("targets", q, (s) => api.sales.targets.list(s, q));
export const useTarget = (id: string | null | undefined) => useOne("targets", id, api.sales.targets.get);
export const useTargetAllocation = (q: SalesQuery<"sales_targets_allocation"> = {}) =>
  useRead("targets", { allocation: q }, (s) => api.sales.targets.allocation(s, q));
export const useEffectiveTargets = (q: SalesQuery<"sales_targets_effective"> = {}) =>
  useRead("targets", { effective: q }, (s) => api.sales.targets.effective(s, q));
export const usePerformance = (userId: string | null | undefined, q: SalesQuery<"sales_performance_user"> = {}) =>
  useRead("performance", { userId, ...q }, (s) => api.sales.performance.user(s, userId!, q), Boolean(userId));
export const useRanking = (q: SalesQuery<"sales_performance_ranking"> = {}) =>
  useRead("performance", { ranking: q }, (s) => api.sales.performance.ranking(s, q));

/* ── Daily reports ── */
/** Your report for today (created as a draft on first read). Needs `sales.dailyreport.submit`. */
export const useMyDailyReport = (enabled = true) => useRead("dailyReports", { me: "today" }, api.sales.dailyReports.today, enabled);
export const useDailyReports = (q: SalesListQuery<"sales_daily_reports_list"> = {}, enabled = true) =>
  useCursorList("dailyReports", q, api.sales.dailyReports.list, enabled);
export const useTeamDailyReport = (q: SalesQuery<"sales_daily_reports_team"> = {}) =>
  useRead("dailyReports", { team: q }, (s) => api.sales.dailyReports.team(s, q));
export const useDailyReport = (id: string | null | undefined) => useOne("dailyReports", id, api.sales.dailyReports.get);

/* ── Dashboard and reports ── */
export const useSalesDashboard = (q: { period?: SalesDashboardPeriod; date?: string; userId?: string; teamId?: string } = {}) =>
  useRead("dashboard", q, (s) => api.sales.dashboard(s, q));
export const useReportCatalogue = () => useRead("reports", { catalogue: true }, api.sales.reports.catalogue);
export const useReport = (key: string, q: Omit<SalesQuery<"sales_report">, "format"> = {}) =>
  useRead("reports", { key, ...q }, (s) => api.sales.reports.get(s, key, q), Boolean(key));
