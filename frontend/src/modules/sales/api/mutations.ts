"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { errorMessage, isApiError, isConflict } from "@/api/errors";
import type { SalesBody, SalesOpportunity, SalesPipeline } from "@/api/types";
import { toast } from "@/ui/toast";
import { addMoney, subMoney } from "../shared/money";
import { DERIVED, sk, type SalesGroup } from "./keys";
import { useSlug } from "./queries";

/*
 * Sales write hooks. Each one is a thin `useWrite(fn, groups)`: on settle it invalidates the listed groups (plus the
 * KPI-derived ones for owned records); on error it toasts, except 422 `validation_failed` (forms show
 * `err.fieldErrors` next to the fields). Updates write the server's record into its detail cache.
 */

export const isValidation = (e: unknown) => isApiError(e) && e.code === "validation_failed";

export function invalidateSales(qc: QueryClient, slug: string, groups: readonly SalesGroup[]) {
  for (const g of new Set(groups)) void qc.invalidateQueries({ queryKey: sk.group(slug, g) });
}

type Opts<V, R> = { derived?: boolean; detail?: SalesGroup; onSuccess?: (r: R, v: V) => void };

function useWrite<V, R>(fn: (v: V) => Promise<R>, groups: SalesGroup[], opts: Opts<V, R> = {}) {
  const qc = useQueryClient();
  const slug = useSlug();
  const derived = opts.derived ?? true;
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      const id = (r as { id?: unknown } | undefined)?.id;
      if (opts.detail && typeof id === "string") qc.setQueryData(sk.one(slug, opts.detail, id), r);
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      // 409 `version_conflict`: take the server's copy so the next try sends the right version.
      const current = isConflict(e) ? (e as { details?: { current?: { id?: unknown } } }).details?.current : undefined;
      if (opts.detail && typeof current?.id === "string") qc.setQueryData(sk.one(slug, opts.detail, current.id), current);
      if (!isValidation(e)) toast.error(isConflict(e) ? "Someone else changed this. Showing the latest version." : errorMessage(e));
    },
    onSettled: () => invalidateSales(qc, slug, derived ? [...groups, ...DERIVED] : groups),
  });
}

type Patch<B> = { id: string; body: B };
const REF = { derived: false } as const;

/* ── Settings and reference data (sales.settings.manage) ── */
export const useUpdateSalesSettings = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_settings_update">) => api.sales.settings.update(slug, b), ["settings", "dashboard", "performance"], REF);
};
export const useCreateStage = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_stages_create">) => api.sales.stages.create(slug, b), ["stages", "pipeline"], REF);
};
export const useReorderStages = () => {
  const slug = useSlug();
  return useWrite((ids: string[]) => api.sales.stages.reorder(slug, ids), ["stages", "pipeline"], REF);
};
export const useUpdateStage = () => useWrite(({ id, body }: Patch<SalesBody<"sales_stages_partial_update">>) => api.sales.stages.update(id, body), ["stages", "pipeline"], REF);
export const useDeleteStage = () => useWrite((id: string) => api.sales.stages.remove(id), ["stages", "pipeline"], REF);
export const useCreateProduct = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_products_create">) => api.sales.products.create(slug, b), ["products"], REF);
};
export const useUpdateProduct = () => useWrite(({ id, body }: Patch<SalesBody<"sales_products_partial_update">>) => api.sales.products.update(id, body), ["products"], REF);
export const useDeleteProduct = () => useWrite((id: string) => api.sales.products.remove(id), ["products"], REF);
export const useCreateLostReason = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_lost_reasons_create">) => api.sales.lostReasons.create(slug, b), ["lostReasons"], REF);
};
export const useUpdateLostReason = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_lost_reasons_partial_update">>) => api.sales.lostReasons.update(id, body), ["lostReasons"], REF);
export const useDeleteLostReason = () => useWrite((id: string) => api.sales.lostReasons.remove(id), ["lostReasons"], REF);
export const useUpdateSalesCalendar = () => {
  const slug = useSlug();
  return useWrite((weights: number[]) => api.sales.calendar.update(slug, weights), ["calendar", "targets", "performance", "dashboard"], REF);
};
export const useCreateHoliday = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_holidays_create">) => api.sales.holidays.create(slug, b), ["holidays", "targets", "performance"], REF);
};
export const useUpdateHoliday = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_holidays_partial_update">>) => api.sales.holidays.update(id, body), ["holidays", "targets", "performance"], REF);
export const useDeleteHoliday = () => useWrite((id: string) => api.sales.holidays.remove(id), ["holidays", "targets", "performance"], REF);

/* ── Companies and contacts ── */
export const useCreateCompany = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_companies_create">) => api.sales.companies.create(slug, b), ["companies"], { detail: "companies" });
};
export const useUpdateCompany = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_companies_partial_update">>) => api.sales.companies.update(id, body), ["companies", "contacts"], {
    detail: "companies",
  });
export const useDeleteCompany = () => useWrite((id: string) => api.sales.companies.remove(id), ["companies", "contacts", "leads", "opportunities"]);
export const useCreateContact = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_contacts_create">) => api.sales.contacts.create(slug, b), ["contacts", "companies"], { detail: "contacts" });
};
export const useUpdateContact = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_contacts_partial_update">>) => api.sales.contacts.update(id, body), ["contacts", "companies"], {
    detail: "contacts",
  });
export const useDeleteContact = () => useWrite((id: string) => api.sales.contacts.remove(id), ["contacts", "companies"]);

/* ── Leads ── */
const LEAD: SalesGroup[] = ["leads", "companies"];
export const useCreateLead = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_leads_create">) => api.sales.leads.create(slug, b), LEAD, { detail: "leads" });
};
export const useUpdateLead = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_leads_partial_update">>) => api.sales.leads.update(id, body), LEAD, { detail: "leads" });
export const useDeleteLead = () => useWrite((id: string) => api.sales.leads.remove(id), LEAD);
export const useBulkAssignLeads = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_leads_bulk_assign">) => api.sales.leads.bulkAssign(slug, b), LEAD);
};
export const useQualifyLead = () => useWrite((id: string) => api.sales.leads.qualify(id), LEAD, { detail: "leads" });
export const useDisqualifyLead = () => useWrite(({ id, reason }: { id: string; reason: string }) => api.sales.leads.disqualify(id, reason), LEAD, { detail: "leads" });
/** Creates the company / contact / opportunity as asked: refreshes all of them. */
export const useConvertLead = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_leads_convert">>) => api.sales.leads.convert(id, body), [...LEAD, "contacts", "opportunities"]);

/* ── Opportunities ── */
const OPP: SalesGroup[] = ["opportunities", "companies", "quotations"];
export const useCreateOpportunity = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_opportunities_create">) => api.sales.opportunities.create(slug, b), OPP, { detail: "opportunities" });
};
/** Send `version`; on 409 `version_conflict` the detail cache takes `details.current` (useWrite does it). */
export const useUpdateOpportunity = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_opportunities_partial_update">>) => api.sales.opportunities.update(id, body), OPP, {
    detail: "opportunities",
  });
export const useDeleteOpportunity = () => useWrite((id: string) => api.sales.opportunities.remove(id), OPP);
export const useBulkAssignOpportunities = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_opportunities_bulk_assign">) => api.sales.opportunities.bulkAssign(slug, b), OPP);
};
export const useWinOpportunity = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_opportunities_won">>) => api.sales.opportunities.won(id, body), OPP, { detail: "opportunities" });
export const useLoseOpportunity = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_opportunities_lost">>) => api.sales.opportunities.lost(id, body), OPP, { detail: "opportunities" });
export const useReopenOpportunity = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_opportunities_reopen">>) => api.sales.opportunities.reopen(id, body), OPP, { detail: "opportunities" });

/** Moves a card between pipeline columns in every cached board (money as decimal strings). */
export function movePipelineCard(board: SalesPipeline, opp: SalesOpportunity, toStageId: string): SalesPipeline {
  const from = board.stages.find((c) => c.opportunities.some((o) => o.id === opp.id));
  const to = board.stages.find((c) => c.stage.id === toStageId);
  if (!to || from === to) return board;
  const moved: SalesOpportunity = { ...opp, stageId: toStageId, stage: { id: to.stage.id, name: to.stage.name, category: to.stage.category } };
  return {
    ...board,
    stages: board.stages.map((c) => {
      if (c === from)
        return {
          ...c,
          count: c.count - 1,
          value: subMoney(c.value, opp.expectedValue),
          weightedValue: subMoney(c.weightedValue, opp.weightedValue),
          opportunities: c.opportunities.filter((o) => o.id !== opp.id),
        };
      if (c === to)
        return {
          ...c,
          count: c.count + 1,
          value: addMoney(c.value, opp.expectedValue),
          weightedValue: addMoney(c.weightedValue, opp.weightedValue),
          opportunities: [moved, ...c.opportunities],
        };
      return c;
    }),
  };
}

/**
 * Board move (`POST …/move {stageId, version}`), optimistic on every cached pipeline and the detail. Rolls back on
 * error; a 409 `version_conflict` toasts "Someone else changed this card" and takes `details.current`.
 */
export function useMoveOpportunity() {
  const qc = useQueryClient();
  const slug = useSlug();
  const boards = sk.group(slug, "pipeline");
  return useMutation({
    mutationFn: ({ opp, stageId }: { opp: SalesOpportunity; stageId: string }) => api.sales.opportunities.move(opp.id, { stageId, version: opp.version }),
    onMutate: async ({ opp, stageId }) => {
      await qc.cancelQueries({ queryKey: boards });
      const snap = qc.getQueriesData<SalesPipeline>({ queryKey: boards });
      qc.setQueriesData<SalesPipeline>({ queryKey: boards }, (b) => (b ? movePipelineCard(b, opp, stageId) : b));
      return { snap };
    },
    onSuccess: (r) => qc.setQueryData(sk.one(slug, "opportunities", r.id), r),
    onError: (e, _v, ctx) => {
      for (const [k, d] of ctx?.snap ?? []) qc.setQueryData(k, d);
      if (isConflict(e)) {
        const current = (e as { details?: { current?: SalesOpportunity } }).details?.current;
        if (current) qc.setQueryData(sk.one(slug, "opportunities", current.id), current);
        toast.error("Someone else changed this card");
      } else toast.error(errorMessage(e));
    },
    onSettled: () => invalidateSales(qc, slug, ["pipeline", "opportunities", "dashboard", "performance", "reports"]),
  });
}

/* ── Quotations ── */
const QUO: SalesGroup[] = ["quotations", "opportunities"];
export const useCreateQuotation = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_quotations_create">) => api.sales.quotations.create(slug, b), QUO, { detail: "quotations" });
};
export const useUpdateQuotation = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_quotations_partial_update">>) => api.sales.quotations.update(id, body), QUO, { detail: "quotations" });
export const useDeleteQuotation = () => useWrite((id: string) => api.sales.quotations.remove(id), QUO);
export const useSendQuotation = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_quotations_send">>) => api.sales.quotations.send(id, body), QUO, { detail: "quotations" });
export const useAcceptQuotation = () => useWrite((id: string) => api.sales.quotations.accept(id), QUO, { detail: "quotations" });
export const useRejectQuotation = () => useWrite((id: string) => api.sales.quotations.reject(id), QUO, { detail: "quotations" });

/* ── Activities and follow-ups ── */
const ACT: SalesGroup[] = ["activities", "followUps", "companies", "leads", "opportunities"];
/** Log a call / visit / meeting… optionally with a follow-up in the same call. */
export const useLogActivity = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_activities_create">) => api.sales.activities.create(slug, b), ACT);
};
export const useUpdateActivity = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_activities_partial_update">>) => api.sales.activities.update(id, body), ACT, { detail: "activities" });
export const useDeleteActivity = () => useWrite((id: string) => api.sales.activities.remove(id), ACT);
export const useCreateFollowUp = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_follow_ups_create">) => api.sales.followUps.create(slug, b), ACT, { detail: "followUps" });
};
export const useUpdateFollowUp = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_follow_ups_partial_update">>) => api.sales.followUps.update(id, body), ACT, { detail: "followUps" });
export const useDeleteFollowUp = () => useWrite((id: string) => api.sales.followUps.remove(id), ACT);
export const useCompleteFollowUp = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_follow_ups_complete">>) => api.sales.followUps.complete(id, body), ACT);
export const useRescheduleFollowUp = () =>
  useWrite(({ id, dueDate }: { id: string; dueDate: string }) => api.sales.followUps.reschedule(id, dueDate), ACT, { detail: "followUps" });
export const useReassignFollowUp = () =>
  useWrite(({ id, ownerId }: { id: string; ownerId: string }) => api.sales.followUps.reassign(id, ownerId), ACT, { detail: "followUps" });

/* ── Targets (sales.target.manage) ── */
export const useSetTarget = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_targets_set">) => api.sales.targets.set(slug, b), ["targets"]);
};
export const useDeleteTarget = () => useWrite((id: string) => api.sales.targets.remove(id), ["targets"]);
export const useAllocateTarget = () => {
  const slug = useSlug();
  return useWrite((b: SalesBody<"sales_targets_allocate">) => api.sales.targets.allocate(slug, b), ["targets"]);
};

/* ── Daily reports ── */
const DR: SalesGroup[] = ["dailyReports"];
export const useUpdateDailyReport = () =>
  useWrite(({ id, body }: Patch<SalesBody<"sales_daily_reports_update">>) => api.sales.dailyReports.update(id, body), DR, { detail: "dailyReports", derived: false });
export const useSubmitDailyReport = () => useWrite((id: string) => api.sales.dailyReports.submit(id), DR, { detail: "dailyReports", derived: false });
export const useReviewDailyReport = () =>
  useWrite(({ id, comment }: { id: string; comment?: string }) => api.sales.dailyReports.review(id, comment), DR, { detail: "dailyReports", derived: false });
export const useReopenDailyReport = () => useWrite((id: string) => api.sales.dailyReports.reopen(id), DR, { detail: "dailyReports", derived: false });

/* ── Reports: CSV export (sales.report.export) ── */
/** Saves text as a file (the CSV export). */
export function downloadText(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const useExportReport = () => {
  const slug = useSlug();
  return useWrite(
    ({ key, query }: { key: string; query?: Parameters<typeof api.sales.reports.csv>[2] }) => api.sales.reports.csv(slug, key, query),
    [],
    { derived: false, onSuccess: (text, v) => downloadText(`${v.key}.csv`, text) },
  );
};
