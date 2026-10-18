"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { SalesReportInfo } from "@/api/types";
import { EmptyState, ErrorState, Skeleton } from "@/ui/feedback";
import { useReportCatalogue, useSlug } from "../api";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { ReportFilters, reportSearch, useReportFilters } from "./report-filters";

/** Catalogue groups (the API has none): unknown keys land in "Other". */
const GROUPS: [string, string[]][] = [
  ["Sales and targets", ["daily-sales", "sales-performance", "target-achievement", "target-vs-actual", "annual-summary", "revenue-forecast"]],
  ["Pipeline and leads", ["pipeline-analysis", "pipeline-movement", "new-leads", "conversion", "win-loss"]],
  ["People and activity", ["salesperson-performance", "ranking", "team-performance", "daily-activity", "followup-performance"]],
  ["Products and customers", ["product-performance", "customer-performance"]],
];

export function groupReports(list: SalesReportInfo[]): [string, SalesReportInfo[]][] {
  const known = new Set(GROUPS.flatMap(([, ks]) => ks));
  const out: [string, SalesReportInfo[]][] = GROUPS.map(([title, keys]) => [title, keys.flatMap((k) => list.filter((r) => r.key === k))]);
  out.push(["Other", list.filter((r) => !known.has(r.key))]);
  return out.filter(([, rs]) => rs.length > 0);
}

/** `/[workspace]/sales/reports`: the reports center (api.md §22). Filters carry over into the report opened. */
export function ReportsScreen() {
  return (
    <SalesGate permission="sales.report.view" name="Reports">
      <Center />
    </SalesGate>
  );
}

function Center() {
  const ws = useSlug();
  const q = useReportCatalogue();
  const { value } = useReportFilters();
  const qs = reportSearch(value);
  return (
    <SalesPageFrame title="Reports">
      <ReportFilters />
      {q.isPending ? (
        <div aria-busy="true" aria-label="Loading reports" className="grid gap-3 min-[760px]:grid-cols-2 min-[1200px]:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-lg" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the reports" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No reports" />
      ) : (
        groupReports(q.data).map(([title, reports]) => (
          <section key={title} className="flex flex-col gap-2">
            <h2 className="m-0 text-[13px] font-semibold text-fg-2">{title}</h2>
            <ul className="m-0 grid list-none gap-3 p-0 min-[760px]:grid-cols-2 min-[1200px]:grid-cols-3">
              {reports.map((r) => (
                <li key={r.key}>
                  <Link
                    href={`${salesRoutes.report(ws, r.key)}${qs}`}
                    className="group flex h-full items-start gap-3 rounded-lg border border-line bg-surface p-4 hover:bg-hover"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-[14px] font-medium">{r.title}</span>
                      <span className="line-clamp-2 text-meta text-fg-3">{r.description}</span>
                    </span>
                    <ChevronRight size={16} aria-hidden className="mt-0.5 flex-none text-fg-3 group-hover:text-fg" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </SalesPageFrame>
  );
}
