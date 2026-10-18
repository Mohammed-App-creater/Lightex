"use client";

import { ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import type { SalesEffectiveTargets } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { cn } from "@/lib/utils/cn";
import { useEffectiveTargets, useSalesSettings, useTargetAllocation } from "../api";
import { formatMoney, formatPct } from "../shared/money";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { useQueryParam } from "../settings/use-query-param";
import { AllocateDialog, GapText, SetTargetDialog, monthLabel, type Subject, type SubjectType, type TreeNode } from "./target-dialogs";

/** The fiscal year containing today (fiscal year N starts in calendar year N). */
function currentFiscalYear(startMonth: number) {
  const d = new Date();
  return d.getMonth() + 1 >= startMonth ? d.getFullYear() : d.getFullYear() - 1;
}

/**
 * Targets and allocation (`/sales/targets`, api.md §18): the allocation tree (company → teams → users) for a fiscal
 * year with allocated / unallocated / gap, set and allocate dialogs gated by `sales.target.manage`'s scope (`all` →
 * company too; `team` → own teams and team-mates; `own` → yourself), and the effective targets of one person.
 */
export function TargetsScreen() {
  return (
    <SalesGate permission="sales.target.view" name="Targets">
      <Body />
    </SalesGate>
  );
}

function Body() {
  const settings = useSalesSettings();
  const startMonth = settings.data?.fiscalYearStartMonth ?? 1;
  const [rawYear, setYear] = useQueryParam("year");
  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : currentFiscalYear(startMonth);
  const manage = useSalesScope("sales.target.manage");
  const me = useSession().user?.id;
  const subjectTypes: SubjectType[] = manage.isAll ? ["company", "team", "user"] : manage.beyondOwn ? ["team", "user"] : ["user"];
  const canManage = (s: { subjectType: SubjectType; subjectId: string | null }) =>
    manage.allowed && (manage.isAll || (manage.beyondOwn ? s.subjectType !== "company" : s.subjectType === "user" && s.subjectId === me));
  const [dialog, setDialog] = useState<{ kind: "set"; subject: Subject | null; node?: TreeNode } | { kind: "allocate"; node: TreeNode } | null>(null);

  return (
    <SalesPageFrame
      title="Targets"
      actions={
        <>
          <div className="flex items-center gap-1" role="group" aria-label="Fiscal year">
            <Button icon size="sm" variant="ghost" aria-label="Previous year" onClick={() => setYear(String(year - 1))}>
              <ChevronLeft size={14} />
            </Button>
            <span className="min-w-[64px] text-center tabular text-[13px] font-medium">FY {year}</span>
            <Button icon size="sm" variant="ghost" aria-label="Next year" onClick={() => setYear(String(year + 1))}>
              <ChevronRight size={14} />
            </Button>
          </div>
          {manage.allowed ? (
            <Button variant="primary" onClick={() => setDialog({ kind: "set", subject: null })}>
              <Plus size={14} aria-hidden /> Set target
            </Button>
          ) : (
            <Badge>Read-only</Badge>
          )}
        </>
      }
    >
      <AllocationPanel
        year={year}
        canManage={canManage}
        onSet={(node) => setDialog({ kind: "set", subject: { type: node.subjectType, id: node.subjectId, name: node.name }, node })}
        onAllocate={(node) => setDialog({ kind: "allocate", node })}
      />
      <EffectivePanel />
      {dialog?.kind === "set" && (
        <SetTargetDialog year={year} startMonth={startMonth} subject={dialog.subject} node={dialog.node} subjectTypes={subjectTypes} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "allocate" && <AllocateDialog node={dialog.node} year={year} onClose={() => setDialog(null)} />}
    </SalesPageFrame>
  );
}

type RowActions = {
  canManage: (s: { subjectType: SubjectType; subjectId: string | null }) => boolean;
  onSet: (n: TreeNode) => void;
  onAllocate: (n: TreeNode) => void;
};

function AllocationPanel({ year, ...actions }: { year: number } & RowActions) {
  const q = useTargetAllocation({ year });
  return (
    <Panel title={`Allocation · FY ${year}`} actions={q.data && <span className="text-meta text-fg-3">{q.data.start} – {q.data.end}</span>}>
      {q.isPending ? (
        <SkeletonRows rows={5} label="Loading targets" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the targets" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="overflow-x-auto">
          <div role="table" aria-label="Target allocation" className="min-w-[640px] text-[13px]">
            <div role="row" className="grid grid-cols-[minmax(180px,2fr)_repeat(4,minmax(96px,1fr))_auto] gap-2 border-b border-line py-2 font-medium text-fg-3">
              <span role="columnheader">Subject</span>
              <span role="columnheader" className="text-right">Target</span>
              <span role="columnheader" className="text-right">Allocated</span>
              <span role="columnheader" className="text-right">Unallocated</span>
              <span role="columnheader" className="text-right">Gap</span>
              <span role="columnheader" className="w-[150px]" />
            </div>
            <TreeRow node={q.data as TreeNode} depth={0} {...actions} />
          </div>
          {!q.data.target && !(q.data.children ?? []).length && <EmptyState className="mt-3" title="No targets yet" body="Set a year target, then allocate it." />}
        </div>
      )}
    </Panel>
  );
}

function TreeRow({ node, depth, canManage, onSet, onAllocate }: { node: TreeNode; depth: number } & RowActions) {
  const kids = node.children ?? [];
  const [open, setOpen] = useState(depth < 1);
  const [detail, setDetail] = useState(false);
  const may = canManage(node);
  const hasKids = kids.length > 0;
  const periodGap = [node.quarterGap, node.monthGap].some((g) => g != null && g !== "0.00");
  return (
    <>
      <div
        role="row"
        className={cn("grid grid-cols-[minmax(180px,2fr)_repeat(4,minmax(96px,1fr))_auto] items-center gap-2 border-b border-line py-1.5", depth === 0 && "font-medium")}
      >
        <span role="cell" className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 20 }}>
          {hasKids ? (
            <Button icon size="sm" variant="ghost" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`} onClick={() => setOpen(!open)}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </Button>
          ) : (
            <span className="w-7" />
          )}
          <button type="button" className="min-w-0 truncate text-left hover:underline" aria-expanded={detail} onClick={() => setDetail(!detail)} title="Show quarters and months">
            {node.name}
          </button>
          <span className="text-meta capitalize text-fg-3">{node.subjectType === "user" ? "" : node.subjectType}</span>
          {periodGap && <span className="ml-1 size-1.5 flex-none rounded-full bg-warn" role="img" aria-label="Quarters or months don’t add up" />}
        </span>
        <span role="cell" className="text-right tabular">{formatMoney(node.target)}</span>
        <span role="cell" className="text-right tabular">{hasKids || node.subjectType !== "user" ? formatMoney(node.allocated) : "—"}</span>
        <span role="cell" className={cn("text-right tabular", node.unallocated && node.unallocated !== "0.00" && "text-warn")}>
          {hasKids || node.subjectType !== "user" ? formatMoney(node.unallocated) : "—"}
        </span>
        <span role="cell" className="text-right">
          {node.subjectType === "user" && !hasKids ? <span className="text-fg-3">—</span> : <GapText gap={node.allocationGap} />}
        </span>
        <span role="cell" className="flex w-[150px] justify-end gap-1">
          {may && (
            <>
              <Button size="sm" variant="ghost" aria-label={`Set target for ${node.name}`} onClick={() => onSet(node)}>
                Set
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Allocate ${node.name}`} onClick={() => onAllocate(node)}>
                Allocate
              </Button>
            </>
          )}
        </span>
      </div>
      {detail && <PeriodBreakdown node={node} depth={depth} />}
      {open && kids.map((k) => <TreeRow key={`${k.subjectType}:${k.subjectId}`} node={k} depth={depth + 1} canManage={canManage} onSet={onSet} onAllocate={onAllocate} />)}
    </>
  );
}

function PeriodBreakdown({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <div role="row" className="border-b border-line bg-raised py-2" style={{ paddingLeft: depth * 20 + 36 }}>
      <div role="cell" className="flex flex-col gap-2 pr-2">
        <span className="text-meta text-fg-2">
          Quarters vs year: <GapText gap={node.quarterGap} /> · Months vs quarters: <GapText gap={node.monthGap} />
        </span>
        <div className="grid gap-2 min-[700px]:grid-cols-4">
          {node.quarters.map((q, i) => (
            <div key={q.start} className="rounded-md border border-line bg-surface p-2">
              <div className="flex justify-between gap-2 font-medium">
                <span>Q{i + 1}</span>
                <span className="tabular">{formatMoney(q.amount, { compact: true })}</span>
              </div>
              {q.months.map((m) => (
                <div key={m.start} className="flex justify-between gap-2 text-meta text-fg-2">
                  <span>{monthLabel(m.start)}</span>
                  <span className="tabular">{formatMoney(m.amount, { compact: true })}</span>
                </div>
              ))}
              <div className="text-meta">
                <GapText gap={q.allocationGap} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const PERIODS: { key: keyof Pick<SalesEffectiveTargets, "day" | "week" | "month" | "quarter" | "year">; label: string }[] = [
  { key: "day", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
];

function EffectivePanel() {
  const view = useSalesScope("sales.target.view");
  const [user, setUser] = useQueryParam("user");
  const q = useEffectiveTargets(user ? { userId: user } : {});
  return (
    <Panel
      title="Effective targets"
      actions={view.beyondOwn && <UserPicker value={user || q.data?.userId || null} onChange={(id) => setUser(id)} label="Person" />}
    >
      {q.isPending ? (
        <SkeletonRows rows={5} label="Loading effective targets" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the effective targets" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="text-fg-3">
                {["Period", "Target", "Actual", "Achievement", "Days left", "Needed per day"].map((h, i) => (
                  <th key={h} className={cn("border-b border-line py-2 pr-3 font-medium", i ? "text-right" : "text-left")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERIODS.map(({ key, label }) => {
                const p = q.data[key];
                return (
                  <tr key={key}>
                    <td className="border-b border-line py-2 pr-3">
                      <span className="block">{label}</span>
                      <span className="block text-meta text-fg-3">
                        {p.start === p.end ? p.start : `${p.start} – ${p.end}`}
                      </span>
                    </td>
                    <td className="border-b border-line py-2 pr-3 text-right tabular">{formatMoney(p.target)}</td>
                    <td className="border-b border-line py-2 pr-3 text-right tabular">{formatMoney(p.actual)}</td>
                    <td className="border-b border-line py-2 pr-3 text-right tabular">{formatPct(p.achievement)}</td>
                    <td className="border-b border-line py-2 pr-3 text-right tabular">{p.remainingWorkingDays}</td>
                    <td className="border-b border-line py-2 text-right tabular">{formatMoney(p.requiredDailyRunRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
