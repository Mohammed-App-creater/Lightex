"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { SalesDailyReport, SalesTeamDailyReport } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { useTeams } from "@/platform/teams/queries";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { DatePicker } from "@/ui/date-picker";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Field, Textarea } from "@/ui/input";
import { Modal } from "@/ui/modal";
import { Select } from "@/ui/select";
import { Tabs } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { pageItems, useDailyReports, useReopenDailyReport, useReviewDailyReport, useSlug, useTeamDailyReport } from "../api";
import { formatMoney, formatPct } from "../shared/money";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { useQueryParam } from "../settings/use-query-param";
import { LateBadge, MetricsGrid, NotesView, ReportStatusPill, timeOf, type Metrics, type PlanItem, type ReportStatus } from "./report-bits";

type Row = {
  key: string;
  reportId: string | null;
  user: { id: string; name: string };
  status: ReportStatus;
  isLate: boolean;
  submittedAt: string | null;
  comments: string[];
  tomorrowPlan: PlanItem[];
  metrics: Metrics;
  date?: string;
  reviewComment?: string;
  reviewedBy?: { name: string } | null;
};

const ALL = "all";

/**
 * Team daily reports (`/sales/daily-reports`, api.md §20 and §23): a day view (totals + one row per person, with
 * review and reopen gated by `sales.dailyreport.review`) and a history list filtered by person and status.
 */
export function TeamReportsScreen() {
  return (
    <SalesGate permission="sales.dailyreport.view" name="Team reports">
      <Body />
    </SalesGate>
  );
}

function Body() {
  const [tab, setTab] = useQueryParam("tab", "day");
  return (
    <SalesPageFrame title="Team daily reports">
      <Tabs
        label="View"
        value={tab === "history" ? "history" : "day"}
        onChange={setTab}
        items={[
          { value: "day", label: "Day" },
          { value: "history", label: "History" },
        ]}
      />
      {tab === "history" ? <HistoryView /> : <DayView />}
    </SalesPageFrame>
  );
}

function DayView() {
  const slug = useSlug();
  const [date, setDate] = useQueryParam("date");
  const [team, setTeam] = useQueryParam("team", ALL);
  const teams = useTeams(slug).data ?? [];
  const q = useTeamDailyReport({ ...(date ? { date } : {}), ...(team !== ALL ? { teamId: team } : {}) });
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Date">
          <DatePicker value={date || q.data?.date || null} onChange={(d) => setDate(d)} />
        </Field>
        {teams.length > 0 && (
          <Select
            label="Team"
            className="w-[200px]"
            value={team}
            onChange={setTeam}
            options={[{ value: ALL, label: "Everyone I can see" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
          />
        )}
      </div>
      {q.isPending ? (
        <SkeletonRows rows={5} label="Loading team reports" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the team reports" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <Totals d={q.data} />
          {q.data.users.length === 0 ? (
            <EmptyState title="Nobody to show" body="No one in this view submits daily reports." />
          ) : (
            <ReportRows
              rows={q.data.users.map((u) => ({ ...u, key: u.user.id }))}
              showDate={false}
            />
          )}
        </>
      )}
    </>
  );
}

function Totals({ d }: { d: SalesTeamDailyReport }) {
  const t = d.totals;
  const counts: [string, number, string][] = [
    ["Submitted", t.submitted, "text-accent"],
    ["Reviewed", t.reviewed, "text-ok"],
    ["Drafts", t.drafts, "text-fg-2"],
    ["Missing", t.missing, "text-danger"],
    ["Late", t.late, "text-warn"],
  ];
  return (
    <Panel
      title={`Summary · ${d.date}`}
      actions={!d.required && <span className="text-meta text-fg-3">Not a working day — reports optional</span>}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[14px]">
          <span>
            Target <strong className="tabular">{formatMoney(t.target)}</strong>
          </span>
          <span>
            Sales <strong className="tabular">{formatMoney(t.sales)}</strong>
          </span>
          <span>
            Achievement <strong className="tabular">{formatPct(t.achievement)}</strong>
          </span>
          <span>
            People <strong className="tabular">{t.people}</strong>
          </span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
          {counts.map(([l, n, c]) => (
            <span key={l} className="text-fg-2">
              {l} <strong className={`tabular ${c}`}>{n}</strong>
            </span>
          ))}
        </div>
        <MetricsGrid metrics={t} compact />
      </div>
    </Panel>
  );
}

function ReportRows({ rows, showDate }: { rows: Row[]; showDate: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<Row | null>(null);
  const review = useSalesScope("sales.dailyreport.review");
  const me = useSession().user?.id;
  const reopen = useReopenDailyReport();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Reports">
      {rows.map((r) => {
        const expanded = open === r.key;
        const mayReview = review.allowed && r.user.id !== me && r.reportId;
        return (
          <li key={r.key} className="rounded-lg border border-line bg-surface">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} ${r.user.name}${showDate && r.date ? ` ${r.date}` : ""}`}
                onClick={() => setOpen(expanded ? null : r.key)}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
              >
                {expanded ? <ChevronDown size={14} aria-hidden className="text-fg-3" /> : <ChevronRight size={14} aria-hidden className="text-fg-3" />}
                <Avatar name={r.user.name} size={20} decorative />
                <span className="min-w-0 truncate text-[14px] font-medium">{r.user.name}</span>
                {showDate && r.date && <span className="tabular text-meta text-fg-3">{r.date}</span>}
              </button>
              <ReportStatusPill status={r.status} />
              {r.isLate && <LateBadge />}
              {r.submittedAt && <span className="text-meta text-fg-3">{timeOf(r.submittedAt)}</span>}
              <span className="tabular text-meta text-fg-2 max-[600px]:hidden">
                {formatMoney(r.metrics.sales, { compact: true })} / {formatMoney(r.metrics.target, { compact: true })}
              </span>
              {mayReview && r.status === "submitted" && (
                <Button size="sm" variant="primary" onClick={() => setReviewing(r)}>
                  Review
                </Button>
              )}
              {mayReview && (r.status === "submitted" || r.status === "reviewed") && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={reopen.isPending && reopen.variables === r.reportId}
                  onClick={() => reopen.mutate(r.reportId!, { onSuccess: () => toast.success(`Reopened ${r.user.name}’s report`) })}
                >
                  Reopen
                </Button>
              )}
            </div>
            {expanded && (
              <div className="flex flex-col gap-4 border-t border-line px-3 py-3">
                {r.status === "missing" ? (
                  <p className="m-0 text-[13px] text-fg-3">No report yet. Live numbers for the day:</p>
                ) : null}
                <MetricsGrid metrics={r.metrics} compact />
                <NotesView comments={r.comments} plan={r.tomorrowPlan} />
                {r.reviewComment && (
                  <p className="m-0 text-[13px] text-fg-2">
                    Review{r.reviewedBy ? ` by ${r.reviewedBy.name}` : ""}: {r.reviewComment}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
      {reviewing && <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} />}
    </ul>
  );
}

function ReviewDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const review = useReviewDailyReport();
  const save = () =>
    review.mutate(
      { id: row.reportId!, comment: comment.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Reviewed ${row.user.name}’s report`);
          onClose();
        },
      },
    );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Review ${row.user.name}’s report`}
      description="Reviewing locks the report. You can reopen it later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={review.isPending} onClick={save}>
            Mark reviewed
          </Button>
        </>
      }
    >
      <Field label="Comment (optional)">
        <Textarea value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
      </Field>
    </Modal>
  );
}

const STATUSES = [
  { value: ALL, label: "Any status" },
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "reviewed", label: "Reviewed" },
] as const;
type HistStatus = (typeof STATUSES)[number]["value"];

function HistoryView() {
  const [user, setUser] = useQueryParam("user");
  const [rawStatus, setStatus] = useQueryParam("status", ALL);
  const status = (STATUSES.some((s) => s.value === rawStatus) ? rawStatus : ALL) as HistStatus;
  const { beyondOwn } = useSalesScope("sales.dailyreport.view");
  const q = useDailyReports({ filter: { ...(user ? { user } : {}), ...(status !== ALL ? { status } : {}) }, limit: 30 });
  const items = pageItems(q.data);
  const toRow = (r: SalesDailyReport): Row => ({ ...r, key: r.id, reportId: r.id, date: r.reportDate });
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        {beyondOwn && (
          <div className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-fg-2">Person</span>
            <UserPicker value={user || null} onChange={(id) => setUser(id)} noneLabel="Everyone" />
          </div>
        )}
        <Select label="Status" className="w-[160px]" value={status} onChange={setStatus} options={[...STATUSES]} />
      </div>
      {q.isPending ? (
        <SkeletonRows rows={5} label="Loading reports" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the reports" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState title="No reports match" />
      ) : (
        <>
          <ReportRows rows={items.map(toRow)} showDate />
          {q.hasNextPage && (
            <Button variant="secondary" className="self-center" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Load more
            </Button>
          )}
        </>
      )}
    </>
  );
}
