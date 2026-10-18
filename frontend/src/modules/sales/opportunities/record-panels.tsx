"use client";

import { CalendarPlus, Check, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SalesTargetType } from "@/api/types";
import { agoOrDate } from "@/lib/utils/dates";
import { useCan } from "@/platform/roles/can";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { pageItems, useActivities, useCompleteFollowUp, useFollowUps } from "../api";
import { formatDay } from "../pipeline/url-state";
import { AddFollowUpDialog, LogActivityDialog } from "../activities";

/*
 * Panels shared by the opportunity and lead pages: the activities and pending follow-ups of one record (comments and
 * files come from `../activities` `RecordComments` / `RecordAttachments`).
 */

export type RecordTarget = { targetType: SalesTargetType; targetId: string; name: string };

const TYPE_LABEL: Record<string, string> = { call: "Call", visit: "Visit", meeting: "Meeting", email: "Email", note: "Note", other: "Other", quotation: "Quotation" };

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-semibold">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function RecordActivities({ target }: { target: RecordTarget }) {
  const q = useActivities({ filter: { targetType: target.targetType, target: target.targetId }, limit: 20 });
  const canLog = useCan("sales.activity.create");
  const [open, setOpen] = useState(false);
  const items = pageItems(q.data);
  return (
    <Section
      title="Activities"
      action={
        canLog && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus size={14} aria-hidden /> Log activity
          </Button>
        )
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState title="No activities yet" body="Calls, visits and meetings logged here show up in the timeline." />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {items.map((a) => (
            <li key={a.id} className="flex items-start gap-3 py-2.5">
              <span className="mt-0.5 rounded-sm bg-raised px-1.5 py-0.5 text-[11px] font-medium text-fg-2">{TYPE_LABEL[a.type] ?? a.type}</span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13px]">{a.summary || <span className="text-fg-3">No summary</span>}</p>
                {a.outcome && <p className="m-0 text-[12px] text-fg-2">Outcome: {a.outcome}</p>}
                <p className="m-0 text-[12px] text-fg-3">
                  {a.owner?.name ?? "—"} · {agoOrDate(a.occurredAt)}
                  {a.durationMinutes ? ` · ${a.durationMinutes} min` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          Load more
        </Button>
      )}
      {open && <LogActivityDialog target={target} onClose={() => setOpen(false)} />}
    </Section>
  );
}

export function RecordFollowUps({ target }: { target: RecordTarget }) {
  const q = useFollowUps({ filter: { targetType: target.targetType, target: target.targetId, status: "pending" }, limit: 20 });
  const canAdd = useCan("sales.followup.create");
  const complete = useCompleteFollowUp();
  const [open, setOpen] = useState(false);
  const items = pageItems(q.data);
  return (
    <Section
      title="Follow-ups"
      action={
        canAdd && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <CalendarPlus size={14} aria-hidden /> Add follow-up
          </Button>
        )
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={2} />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState title="No next step" body="Add a follow-up so this doesn't go cold." />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {items.map((f) => (
            <li key={f.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-[13px]">{f.title}</p>
                <p className={f.bucket === "overdue" ? "m-0 text-[12px] text-danger" : "m-0 text-[12px] text-fg-3"}>
                  Due {formatDay(f.dueDate)} · {f.owner?.name ?? "—"}
                </p>
              </div>
              {f.canComplete && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={complete.isPending && complete.variables?.id === f.id}
                  onClick={() => complete.mutate({ id: f.id, body: {} }, { onSuccess: () => toast.success("Follow-up done") })}
                >
                  <Check size={14} aria-hidden /> Done
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && <AddFollowUpDialog target={target} onClose={() => setOpen(false)} />}
    </Section>
  );
}
