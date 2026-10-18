"use client";

import type { SalesDailyReport } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { EntityLink, kindOfTarget } from "../shared/entity-link";
import { formatMoney, formatPct } from "../shared/money";

export type Metrics = SalesDailyReport["metrics"];
export type PlanItem = SalesDailyReport["tomorrowPlan"][number];
export type ReportStatus = SalesDailyReport["status"] | "missing";

/** The auto-computed daily metrics (spec §5 Daily report), in display order. */
export const METRICS: { key: keyof Metrics; label: string; money?: boolean; pct?: boolean }[] = [
  { key: "target", label: "Target", money: true },
  { key: "sales", label: "Sales", money: true },
  { key: "achievement", label: "Achievement", pct: true },
  { key: "newLeads", label: "New leads" },
  { key: "calls", label: "Calls" },
  { key: "visits", label: "Visits" },
  { key: "meetings", label: "Meetings" },
  { key: "quotationsSent", label: "Quotations sent" },
  { key: "followUpsCompleted", label: "Follow-ups done" },
  { key: "newOpportunities", label: "New opportunities" },
  { key: "dealsWon", label: "Won" },
  { key: "dealsLost", label: "Lost" },
];

export function metricValue(m: Partial<Metrics>, key: keyof Metrics, def: (typeof METRICS)[number]) {
  const v = m[key];
  if (def.money) return formatMoney(v as string | null);
  if (def.pct) return formatPct(v as number | null);
  return String(v ?? 0);
}

/** Read-only metric tiles: two columns on phones, more on wider screens. */
export function MetricsGrid({ metrics, compact }: { metrics: Partial<Metrics>; compact?: boolean }) {
  return (
    <dl className={cn("m-0 grid gap-2", compact ? "grid-cols-[repeat(auto-fill,minmax(120px,1fr))]" : "grid-cols-2 min-[600px]:grid-cols-3 min-[1000px]:grid-cols-4")}>
      {METRICS.map((d) => (
        <div key={d.key} className={cn("flex flex-col gap-0.5 rounded-md border border-line bg-surface", compact ? "px-2.5 py-1.5" : "px-3.5 py-3")}>
          <dt className="text-meta text-fg-3">{d.label}</dt>
          <dd className={cn("m-0 tabular font-semibold", compact ? "text-[14px]" : "text-[18px] leading-7")}>{metricValue(metrics, d.key, d)}</dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS: Record<ReportStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "border-line-2 text-fg-2" },
  submitted: { label: "Submitted", cls: "border-accent text-accent" },
  reviewed: { label: "Reviewed", cls: "border-ok text-ok" },
  missing: { label: "Missing", cls: "border-danger text-danger" },
};

export function ReportStatusPill({ status }: { status: ReportStatus }) {
  const s = STATUS[status];
  return <span className={cn("inline-flex h-[22px] items-center rounded-sm border px-2 text-[12px] font-medium", s.cls)}>{s.label}</span>;
}

export function LateBadge() {
  return <span className="inline-flex h-[22px] items-center rounded-sm bg-warn-s px-2 text-[12px] font-medium text-warn">Late</span>;
}

export const timeOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

/** Read-only comments and plan (team view, frozen reports). */
export function NotesView({ comments, plan }: { comments: string[]; plan: PlanItem[] }) {
  return (
    <div className="grid gap-4 min-[760px]:grid-cols-2">
      <section className="flex flex-col gap-1.5">
        <h4 className="m-0 text-meta font-medium text-fg-2">Comments</h4>
        {comments.length ? (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px]">
            {comments.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-meta text-fg-3">No comments.</p>
        )}
      </section>
      <section className="flex flex-col gap-1.5">
        <h4 className="m-0 text-meta font-medium text-fg-2">Tomorrow’s plan</h4>
        {plan.length ? (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px]">
            {plan.map((p, i) => (
              <li key={i}>
                {p.text}
                <PlanRef item={p} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-meta text-fg-3">No plan.</p>
        )}
      </section>
    </div>
  );
}

export function PlanRef({ item, name }: { item: PlanItem; name?: string }) {
  const kind = item.targetType ? kindOfTarget(item.targetType) : null;
  if (!kind || !item.targetId) return null;
  return (
    <>
      {" · "}
      <EntityLink kind={kind} id={item.targetId} name={name ?? `Linked ${kind}`} className="text-meta" />
    </>
  );
}
