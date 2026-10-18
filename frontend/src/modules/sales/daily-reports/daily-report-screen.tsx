"use client";

import { CalendarOff, Clock, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SalesDailyReport } from "@/api/types";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { ErrorState, Skeleton } from "@/ui/feedback";
import { Input, Textarea } from "@/ui/input";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { pageItems, useMyDailyReport, useOpportunities, useSubmitDailyReport, useUpdateDailyReport } from "../api";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { LateBadge, MetricsGrid, NotesView, ReportStatusPill, timeOf, type PlanItem } from "./report-bits";

/**
 * My daily report (`/sales/daily-report`, api.md §20): today's auto metrics (live while a draft, frozen at submit),
 * editable comments and tomorrow's plan, save and submit. Editable until reviewed; mobile-first.
 */
export function DailyReportScreen() {
  return (
    <SalesGate permission="sales.dailyreport.submit" name="Daily report">
      <Body />
    </SalesGate>
  );
}

function Body() {
  const q = useMyDailyReport();
  const r = q.data;
  // Held here so a save → refetch (which remounts the form) never drops a submit in flight.
  const update = useUpdateDailyReport();
  const submit = useSubmitDailyReport();
  return (
    <SalesPageFrame
      title="My daily report"
      actions={
        r && (
          <>
            <span className="text-meta text-fg-3">{r.reportDate}</span>
            <ReportStatusPill status={r.status} />
            {r.isLate && <LateBadge />}
          </>
        )
      }
    >
      {q.isPending ? (
        <div aria-busy="true" aria-label="Loading your report" className="grid grid-cols-2 gap-2 min-[600px]:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-17 rounded-md" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState title="Couldn’t load your daily report" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <Report key={`${q.data.id}:${q.data.updatedAt}`} report={q.data} update={update} submit={submit} />
      )}
    </SalesPageFrame>
  );
}

function Notice({ r }: { r: SalesDailyReport }) {
  if (r.status !== "draft")
    return (
      <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2">
        <Clock size={14} aria-hidden />
        Submitted {timeOf(r.submittedAt)}
        {r.isLate ? " (after the cutoff)" : ""}. The numbers are frozen as of submission.
      </p>
    );
  if (!r.required)
    return (
      <p className="m-0 flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-fg-2">
        <CalendarOff size={14} aria-hidden />
        Today is not a working day — no report is required, but you can still submit one.
      </p>
    );
  return (
    <p className="m-0 flex items-center gap-2 rounded-md border border-accent bg-accent-s px-3 py-2 text-[13px] text-fg">
      <Clock size={14} aria-hidden />
      Required today — submit by {timeOf(r.cutoffAt)}.
    </p>
  );
}

function Report({
  report: r,
  update,
  submit,
}: {
  report: SalesDailyReport;
  update: ReturnType<typeof useUpdateDailyReport>;
  submit: ReturnType<typeof useSubmitDailyReport>;
}) {
  const [comments, setComments] = useState<string[]>(r.comments);
  const [plan, setPlan] = useState<PlanItem[]>(r.tomorrowPlan);
  const editable = r.canEdit && r.status !== "reviewed";
  const dirty = JSON.stringify(comments) !== JSON.stringify(r.comments) || JSON.stringify(plan) !== JSON.stringify(r.tomorrowPlan);
  const body = () => ({ comments: comments.map((c) => c.trim()).filter(Boolean), tomorrowPlan: plan.filter((p) => p.text.trim()).map((p) => ({ ...p, text: p.text.trim() })) });

  const save = () => update.mutate({ id: r.id, body: body() }, { onSuccess: () => toast.success("Report saved") });
  const send = async () => {
    try {
      if (dirty) await update.mutateAsync({ id: r.id, body: body() });
    } catch {
      return;
    }
    submit.mutate(r.id, { onSuccess: (x) => void toast.success(x.isLate ? "Report submitted (late)" : "Report submitted") });
  };

  return (
    <>
      <Notice r={r} />
      <MetricsGrid metrics={r.metrics} />

      {r.status === "reviewed" && (
        <Panel title="Review">
          <p className="m-0 text-[13px] text-fg-2">
            Reviewed by {r.reviewedBy?.name ?? "a manager"}
            {r.reviewedAt ? ` · ${new Date(r.reviewedAt).toLocaleString()}` : ""}
          </p>
          {r.reviewComment && <p className="m-0 mt-2 whitespace-pre-wrap text-[14px]">{r.reviewComment}</p>}
        </Panel>
      )}

      {editable ? (
        <div className="grid gap-4 min-[900px]:grid-cols-2">
          <Panel title="Comments">
            <ListEditor
              items={comments}
              placeholder="What happened today?"
              addLabel="Add comment"
              onChange={setComments}
              render={(v, set, i) => <Textarea aria-label={`Comment ${i + 1}`} className="min-h-16" value={v} placeholder="What happened today?" onChange={(e) => set(e.target.value)} />}
            />
          </Panel>
          <Panel title="Tomorrow’s plan">
            <PlanEditor plan={plan} onChange={setPlan} />
          </Panel>
        </div>
      ) : (
        <Panel>
          <NotesView comments={r.comments} plan={r.tomorrowPlan} />
        </Panel>
      )}

      {editable && (
        <div className="sticky bottom-20 z-10 flex flex-wrap justify-end gap-2 rounded-lg border border-line bg-surface p-3 min-[1024px]:static min-[1024px]:border-0 min-[1024px]:bg-transparent min-[1024px]:p-0">
          <Button variant="secondary" disabled={!dirty} disabledReason={!dirty ? "No changes to save" : undefined} loading={update.isPending && !submit.isPending} onClick={save}>
            Save
          </Button>
          {r.status === "draft" && (
            <Button variant="primary" loading={submit.isPending} onClick={() => void send()}>
              Submit report
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function ListEditor<T>({
  items,
  onChange,
  render,
  addLabel,
  blank,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  render: (v: T, set: (v: T) => void, i: number) => ReactNode;
  addLabel: string;
  placeholder?: string;
  blank?: T;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((v, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">{render(v, (nv) => onChange(items.map((x, j) => (j === i ? nv : x))), i)}</div>
          <Button icon size="sm" variant="ghost" aria-label={`Remove ${addLabel.replace("Add ", "")} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="self-start" onClick={() => onChange([...items, (blank ?? "") as T])}>
        <Plus size={14} aria-hidden /> {addLabel}
      </Button>
    </div>
  );
}

const NO_REF = "none";

function PlanEditor({ plan, onChange }: { plan: PlanItem[]; onChange: (p: PlanItem[]) => void }) {
  const opps = pageItems(useOpportunities({ filter: { owner: "me", status: "open" }, limit: 50 }).data);
  const options = [{ value: NO_REF, label: "No link" }, ...opps.map((o) => ({ value: o.id, label: o.title }))];
  return (
    <ListEditor
      items={plan}
      onChange={onChange}
      addLabel="Add plan item"
      blank={{ text: "", targetType: null, targetId: null }}
      render={(p, set, i) => (
        <div className="flex flex-col gap-1.5">
          <Input aria-label={`Plan item ${i + 1}`} value={p.text} placeholder="e.g. Call Abay about the quotation" onChange={(e) => set({ ...p, text: e.target.value })} />
          <Select
            label={`Plan item ${i + 1} link`}
            hideLabel
            value={p.targetType === "sales.opportunity" && p.targetId ? p.targetId : p.targetId ? `${p.targetType}:${p.targetId}` : NO_REF}
            onChange={(v) => set(v === NO_REF ? { ...p, targetType: null, targetId: null } : v.includes(":") ? p : { ...p, targetType: "sales.opportunity", targetId: v })}
            options={
              p.targetId && p.targetType !== "sales.opportunity"
                ? [...options, { value: `${p.targetType}:${p.targetId}`, label: `Linked ${p.targetType?.replace("sales.", "")}` }]
                : p.targetId && !opps.some((o) => o.id === p.targetId)
                  ? [...options, { value: p.targetId, label: "Linked opportunity" }]
                  : options
            }
          />
        </div>
      )}
    />
  );
}
