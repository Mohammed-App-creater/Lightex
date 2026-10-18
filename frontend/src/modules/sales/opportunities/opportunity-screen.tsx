"use client";

import { ArrowLeft, ChevronDown, CircleCheck, CircleX, Pencil, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { isNotFound } from "@/api/errors";
import type { SalesOpportunity, SalesTimelineItem } from "@/api/types";
import { agoOrDate } from "@/lib/utils/dates";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/feedback";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { Tabs } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { pageItems, useMoveOpportunity, useOpportunity, useOpportunityTimeline, useSlug, useStages, useUpdateOpportunity } from "../api";
import { EntityLink } from "../shared/entity-link";
import { formatMoney } from "../shared/money";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { ProbabilityBadge, StagePill } from "../shared/stage-pill";
import { UserPicker } from "../shared/user-picker";
import { OppFlags } from "../pipeline/opp-card";
import { formatDay, useUrlState } from "../pipeline/url-state";
import { LostDialog, OpportunityFormDialog, ReopenDialog, WonDialog } from "./opp-dialogs";
import { QuotationsPanel, QuotationStatus } from "./quotations-panel";
import { RecordAttachments, RecordComments } from "../activities";
import { RecordActivities, RecordFollowUps, type RecordTarget } from "./record-panels";

/* Opportunity detail (`/sales/opportunities/[id]`, docs/sales/api.md §10–§11, §14–§16). */

type Tab = "timeline" | "quotations" | "activities" | "follow-ups" | "comments" | "files";
const TABS: { value: Tab; label: string }[] = [
  { value: "timeline", label: "Timeline" },
  { value: "quotations", label: "Quotations" },
  { value: "activities", label: "Activities" },
  { value: "follow-ups", label: "Follow-ups" },
  { value: "comments", label: "Comments" },
  { value: "files", label: "Files" },
];

export function OpportunityScreen({ id }: { id: string }) {
  return (
    <SalesGate permission="sales.opportunity.view" name="Opportunity">
      <Opportunity id={id} />
    </SalesGate>
  );
}

function Opportunity({ id }: { id: string }) {
  const ws = useSlug();
  const q = useOpportunity(id);
  const back = (
    <Link href={salesRoutes.pipeline(ws)} className="inline-flex items-center gap-1 text-[12px] text-fg-2 hover:text-fg">
      <ArrowLeft size={14} aria-hidden /> Pipeline
    </Link>
  );
  if (q.isPending)
    return (
      <SalesPageFrame title={<Skeleton className="h-6 w-56" />}>
        <SkeletonRows rows={6} label="Loading opportunity" />
      </SalesPageFrame>
    );
  if (q.isError)
    return (
      <SalesPageFrame title="Opportunity">
        {back}
        {isNotFound(q.error) ? (
          <EmptyState illustration="results" title="Opportunity not found" body="It may have been deleted, or it's outside what you can see." />
        ) : (
          <ErrorState onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}
      </SalesPageFrame>
    );
  return <Detail opp={q.data} back={back} />;
}

function Detail({ opp, back }: { opp: SalesOpportunity; back: ReactNode }) {
  const url = useUrlState();
  const tab = (TABS.find((t) => t.value === url.get("tab"))?.value ?? "timeline") as Tab;
  const [dialog, setDialog] = useState<"edit" | "won" | "lost" | "reopen" | null>(null);
  const canClosePerm = useCan("sales.opportunity.close");
  const canReopenPerm = useCan("sales.opportunity.reopen");
  const canAssign = useCan("sales.opportunity.assign");
  const canUpload = useCan("sales.opportunity.edit") && opp.canEdit;
  const open = opp.status === "open";
  const target: RecordTarget = { targetType: "sales.opportunity", targetId: opp.id, name: opp.title };
  return (
    <SalesPageFrame
      title={opp.title}
      actions={
        <>
          {opp.canEdit && (
            <Button size="sm" onClick={() => setDialog("edit")}>
              <Pencil size={14} aria-hidden /> Edit
            </Button>
          )}
          {open && canClosePerm && opp.canClose && (
            <>
              <Button size="sm" onClick={() => setDialog("won")}>
                <CircleCheck size={14} aria-hidden className="text-ok" /> Won
              </Button>
              <Button size="sm" onClick={() => setDialog("lost")}>
                <CircleX size={14} aria-hidden className="text-danger" /> Lost
              </Button>
            </>
          )}
          {!open && canReopenPerm && canClosePerm && opp.canClose && (
            <Button size="sm" onClick={() => setDialog("reopen")}>
              <RotateCcw size={14} aria-hidden /> Reopen
            </Button>
          )}
        </>
      }
    >
      {back}
      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-5 max-[1023px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Header opp={opp} canAssign={canAssign} />
          <Tabs label="Opportunity sections" value={tab} onChange={(v) => url.set({ tab: v === "timeline" ? null : v })} items={TABS} className="max-w-full overflow-x-auto" />
          {tab === "timeline" && <Timeline id={opp.id} />}
          {tab === "quotations" && <QuotationsPanel opportunityId={opp.id} defaultAmount={opp.expectedValue} />}
          {tab === "activities" && <RecordActivities target={target} />}
          {tab === "follow-ups" && <RecordFollowUps target={target} />}
          {tab === "comments" && <RecordComments target={target} />}
          {tab === "files" && <RecordAttachments target={target} canUpload={canUpload} />}
        </div>
        <Facts opp={opp} />
      </div>
      {dialog === "edit" && <OpportunityFormDialog opp={opp} onClose={() => setDialog(null)} />}
      {dialog === "won" && <WonDialog opp={opp} onClose={() => setDialog(null)} />}
      {dialog === "lost" && <LostDialog opp={opp} onClose={() => setDialog(null)} />}
      {dialog === "reopen" && <ReopenDialog opp={opp} onClose={() => setDialog(null)} />}
    </SalesPageFrame>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-3">{label}</span>
      <span className="min-w-0 text-[14px] font-medium">{children}</span>
    </div>
  );
}

function Header({ opp, canAssign }: { opp: SalesOpportunity; canAssign: boolean }) {
  const stages = (useStages().data ?? []).filter((s) => s.category === "open");
  const move = useMoveOpportunity();
  const update = useUpdateOpportunity();
  const canMove = useCan("sales.opportunity.move") && opp.canMove && opp.status === "open";
  const reassign = canAssign && opp.canEdit;
  return (
    <div className="grid grid-cols-3 gap-4 rounded-lg border border-line bg-surface p-4 max-[760px]:grid-cols-2">
      <Stat label="Stage">
        {canMove ? (
          <Menu>
            <MenuTrigger className="inline-flex items-center gap-1 rounded-sm hover:bg-hover" aria-label={`Stage: ${opp.stage.name}. Move`}>
              <StagePill stage={opp.stage as { name: string; category: "open" }} />
              <ChevronDown size={14} aria-hidden className="text-fg-3" />
            </MenuTrigger>
            <MenuContent align="start" width={200}>
              {stages.map((s) => (
                <MenuItem key={s.id} disabled={s.id === opp.stageId} onSelect={() => move.mutate({ opp, stageId: s.id }, { onSuccess: () => toast.success(`Moved to ${s.name}`) })}>
                  {s.name}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : (
          <StagePill stage={opp.stage as { name: string; category: "open" | "won" | "lost" }} />
        )}
      </Stat>
      <Stat label="Value">
        <span className="tabular font-mono">{formatMoney(opp.wonValue ?? opp.expectedValue)}</span>
      </Stat>
      <Stat label="Probability">
        <ProbabilityBadge value={opp.probability} overridden={opp.probabilityOverride != null} />
      </Stat>
      <Stat label="Weighted">
        <span className="tabular font-mono">{formatMoney(opp.weightedValue)}</span>
      </Stat>
      <Stat label="Owner">
        {reassign ? (
          <UserPicker
            label="Owner"
            value={opp.ownerId}
            onChange={(v) => v && v !== opp.ownerId && update.mutate({ id: opp.id, body: { ownerId: v, version: opp.version } }, { onSuccess: () => toast.success("Reassigned") })}
            disabled={update.isPending}
          />
        ) : opp.owner ? (
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={opp.owner.name} hue={opp.owner.hue} size={20} decorative />
            <span className="truncate">{opp.owner.name}</span>
          </span>
        ) : (
          "—"
        )}
      </Stat>
      {opp.status === "won" && (
        <Stat label="Credited to">
          {opp.creditedUser ? (
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={opp.creditedUser.name} hue={opp.creditedUser.hue} size={20} decorative />
              <span className="truncate">{opp.creditedUser.name}</span>
            </span>
          ) : (
            "—"
          )}
        </Stat>
      )}
      <OppFlags opp={opp} className="col-span-full" />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[12px] text-fg-3">{label}</dt>
      <dd className="m-0 min-w-0 text-[13px]">{children || "—"}</dd>
    </div>
  );
}

function Facts({ opp }: { opp: SalesOpportunity }) {
  return (
    <dl className="m-0 flex flex-col gap-3 self-start rounded-lg border border-line bg-surface p-4">
      <Fact label="Company">
        <EntityLink kind="company" id={opp.companyId} name={opp.company.name} />
      </Fact>
      <Fact label="Contact">{opp.contact && <EntityLink kind="contact" id={opp.contactId} name={opp.contact.name} />}</Fact>
      <Fact label="Product">{opp.product?.name}</Fact>
      <Fact label="Expected close">{opp.expectedCloseDate && formatDay(opp.expectedCloseDate)}</Fact>
      <Fact label="Next action">{opp.nextAction}</Fact>
      <Fact label="Last contact">{opp.lastContactAt && agoOrDate(opp.lastContactAt)}</Fact>
      {opp.sourceLeadId && (
        <Fact label="From lead">
          <EntityLink kind="lead" id={opp.sourceLeadId} name="Open lead" />
        </Fact>
      )}
      {opp.status === "won" && <Fact label="Won on">{opp.wonAt && formatDay(opp.wonAt)}</Fact>}
      {opp.status === "lost" && (
        <>
          <Fact label="Lost on">{opp.lostAt && formatDay(opp.lostAt)}</Fact>
          <Fact label="Lost reason">{opp.lostReason?.name}</Fact>
          {opp.lostNote && <Fact label="Lost note">{opp.lostNote}</Fact>}
        </>
      )}
      <Fact label="Notes">{opp.notes && <span className="whitespace-pre-wrap">{opp.notes}</span>}</Fact>
    </dl>
  );
}

/* ── Timeline ── */

function itemText(it: SalesTimelineItem): ReactNode {
  const sc = it.stageChange;
  switch (it.kind) {
    case "stage_created":
      return <>Created in {sc?.toStage}</>;
    case "stage_moved":
      return (
        <>
          Moved from {sc?.fromStage} to {sc?.toStage}
        </>
      );
    case "stage_won":
      return "Marked won";
    case "stage_lost":
      return "Marked lost";
    case "stage_reopened":
      return <>Reopened in {sc?.toStage}</>;
    default:
      return it.summary;
  }
}

function Timeline({ id }: { id: string }) {
  const q = useOpportunityTimeline(id);
  const items = pageItems(q.data);
  if (q.isPending) return <SkeletonRows rows={4} label="Loading timeline" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (items.length === 0) return <EmptyState title="Nothing yet" body="Stage changes, quotations, activities and follow-ups appear here." />;
  return (
    <div className="flex flex-col gap-2">
      <ol className="m-0 flex list-none flex-col p-0">
        {items.map((it) => (
          <li key={it.id} className="relative flex gap-3 border-l border-line pb-4 pl-4 last:pb-0">
            <span aria-hidden className="absolute -left-[4.5px] top-1.5 size-2 rounded-full bg-fg-3" />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-[13px]">
                {itemText(it)}
                {it.quotation && (
                  <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
                    <span className="font-mono text-[12px] text-fg-2">{it.quotation.number}</span>
                    <span className="font-mono text-[12px]">{formatMoney(it.quotation.amount)}</span>
                    <QuotationStatus status={it.quotation.status} />
                  </span>
                )}
              </p>
              {it.activity?.summary && it.kind === "activity_logged" && it.summary !== it.activity.summary && <p className="m-0 text-[12px] text-fg-2">{it.activity.summary}</p>}
              {it.followUp && <p className="m-0 text-[12px] text-fg-2">Due {formatDay(it.followUp.dueDate)}</p>}
              <p className="m-0 text-[12px] text-fg-3">
                {it.actor?.name ?? "System"} · {agoOrDate(it.at)}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <Button size="sm" variant="ghost" className="self-start" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  );
}
