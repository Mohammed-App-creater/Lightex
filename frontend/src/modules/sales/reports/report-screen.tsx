"use client";

import { ArrowLeft, Download } from "lucide-react";
import Link from "next/link";
import { isForbidden, isNotFound } from "@/api/errors";
import type { SalesReport, SalesReportColumn } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { useExportReport, useReport, useReportCatalogue, useSlug } from "../api";
import { DataGrid } from "../dashboard/kit";
import { addMoney, formatMoney, formatPct } from "../shared/money";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { StatusDot } from "../shared/status-dot";
import { ReportFilters, reportQuery, reportSearch, useReportFilters } from "./report-filters";

/** `/[workspace]/sales/reports/[key]`: one report as a table, with CSV export (`sales.report.export`). */
export function ReportScreen({ reportKey }: { reportKey: string }) {
  return (
    <SalesGate permission="sales.report.view" name="Reports">
      <ReportView reportKey={reportKey} />
    </SalesGate>
  );
}

function ReportView({ reportKey }: { reportKey: string }) {
  const ws = useSlug();
  const canExport = useCan("sales.report.export");
  const info = useReportCatalogue().data?.find((r) => r.key === reportKey);
  const { value } = useReportFilters();
  const query = reportQuery(value);
  const q = useReport(query ? reportKey : "", query ?? {});
  const exp = useExportReport();
  const back = (
    <Link href={`${salesRoutes.reports(ws)}${reportSearch(value)}`} className="inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
      <ArrowLeft size={14} aria-hidden /> Reports
    </Link>
  );
  const actions = (
    <>
      {back}
      {canExport && (
        <Button
          size="sm"
          variant="secondary"
          disabled={!query || exp.isPending}
          onClick={() => query && exp.mutate({ key: reportKey, query })}
        >
          <Download size={14} aria-hidden /> Export CSV
        </Button>
      )}
    </>
  );

  if (q.isError && isNotFound(q.error)) {
    return (
      <SalesPageFrame title="Report" actions={back}>
        <EmptyState title="Report not found" body="This report doesn’t exist." />
      </SalesPageFrame>
    );
  }
  return (
    <SalesPageFrame title={q.data?.title ?? info?.title ?? "Report"} actions={actions}>
      {info && <p className="m-0 -mt-3 text-meta text-fg-3">{info.description}</p>}
      <ReportFilters defaultPeriod={info?.defaultPeriod} />
      {!query ? (
        <EmptyState title="Pick a date range" body="Choose a “From” and a “To” date (at most 366 days apart)." />
      ) : q.isPending ? (
        <SkeletonRows rows={8} label="Loading the report" />
      ) : q.isError ? (
        isForbidden(q.error) ? (
          <EmptyState title="Outside your view" body="You can’t run this report for that team or person." />
        ) : (
          <ErrorState title="Couldn’t load the report" onRetry={() => void q.refetch()} retrying={q.isFetching} />
        )
      ) : (
        <>
          <p className="m-0 text-meta text-fg-3">
            {q.data.period.start} – {q.data.period.end} · {q.data.rows.length} {q.data.rows.length === 1 ? "row" : "rows"}
          </p>
          {q.data.rows.length === 0 ? <EmptyState title="No data for this period" /> : <ReportTable report={q.data} />}
        </>
      )}
    </SalesPageFrame>
  );
}

const NUMERIC = new Set(["int", "money", "pct"]);
/** Id columns stay in the CSV; the table shows the names beside them. */
const visible = (c: SalesReportColumn) => !/Id$/.test(c.key) && c.key !== "id";

function cell(c: SalesReportColumn, v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  if (c.key === "status") return <StatusDot status={String(v)} showLabel />;
  if (c.type === "money") return formatMoney(String(v));
  if (c.type === "pct") return formatPct(typeof v === "number" ? v : null);
  if (c.type === "int" && typeof v === "number") return v.toLocaleString();
  return String(v);
}

/** Totals for money and count columns (not ranks), when there is more than one row. */
function totals(cols: SalesReportColumn[], rows: SalesReport["rows"]) {
  if (rows.length < 2) return undefined;
  const sums = cols.map((c) => {
    if (c.key === "rank") return null;
    if (c.type === "money") return formatMoney(addMoney(...rows.map((r) => (typeof r[c.key] === "string" ? (r[c.key] as string) : null))));
    if (c.type === "int") return rows.reduce((s, r) => s + (typeof r[c.key] === "number" ? (r[c.key] as number) : 0), 0).toLocaleString();
    return null;
  });
  if (sums.every((s) => s === null)) return undefined;
  return sums.map((s, i) => (i === 0 ? (s ?? "Total") : (s ?? "")));
}

function ReportTable({ report }: { report: SalesReport }) {
  const cols = report.columns.filter(visible);
  return (
    <Card className="p-4 max-[760px]:p-3">
      <DataGrid
        label={report.title}
        head={cols.map((c) => c.label)}
        numeric={cols.map((c) => NUMERIC.has(c.type))}
        keys={report.rows.map((_, i) => String(i))}
        rows={report.rows.map((r) => cols.map((c) => cell(c, r[c.key])))}
        foot={totals(cols, report.rows)}
      />
    </Card>
  );
}
