"use client";

import { ArrowLeft, ArrowRightLeft, BadgeCheck, Ban, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { isNotFound } from "@/api/errors";
import type { SalesLead } from "@/api/types";
import { agoOrDate } from "@/lib/utils/dates";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/feedback";
import { Tabs } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { useLead, useQualifyLead, useSlug } from "../api";
import { EntityLink } from "../shared/entity-link";
import { formatMoney } from "../shared/money";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { RecordComments } from "../activities";
import { RecordActivities, RecordFollowUps, type RecordTarget } from "../opportunities/record-panels";
import { formatDay, useUrlState } from "../pipeline/url-state";
import { ConvertDialog, DisqualifyDialog, LEAD_SOURCES, LeadFormDialog } from "./lead-dialogs";
import { LeadStatusChip } from "./leads-screen";

/* Lead detail (`/sales/leads/[id]`, docs/sales/api.md §9): edit, qualify, disqualify, convert, activity, comments. */

type Tab = "activities" | "follow-ups" | "comments";
const TABS: { value: Tab; label: string }[] = [
  { value: "activities", label: "Activities" },
  { value: "follow-ups", label: "Follow-ups" },
  { value: "comments", label: "Comments" },
];

export function LeadScreen({ id }: { id: string }) {
  return (
    <SalesGate permission="sales.lead.view" name="Lead">
      <LeadPage id={id} />
    </SalesGate>
  );
}

function LeadPage({ id }: { id: string }) {
  const ws = useSlug();
  const q = useLead(id);
  const back = (
    <Link href={salesRoutes.leads(ws)} className="inline-flex items-center gap-1 text-[12px] text-fg-2 hover:text-fg">
      <ArrowLeft size={14} aria-hidden /> Leads
    </Link>
  );
  if (q.isPending)
    return (
      <SalesPageFrame title={<Skeleton className="h-6 w-56" />}>
        <SkeletonRows rows={6} label="Loading lead" />
      </SalesPageFrame>
    );
  if (q.isError)
    return (
      <SalesPageFrame title="Lead">
        {back}
        {isNotFound(q.error) ? (
          <EmptyState illustration="results" title="Lead not found" body="It may have been deleted, or it's outside what you can see." />
        ) : (
          <ErrorState onRetry={() => q.refetch()} retrying={q.isFetching} />
        )}
      </SalesPageFrame>
    );
  return <Detail lead={q.data} back={back} />;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-fg-3">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-[13px]">{children || "—"}</dd>
    </div>
  );
}

function Detail({ lead, back }: { lead: SalesLead; back: ReactNode }) {
  const ws = useSlug();
  const router = useRouter();
  const url = useUrlState();
  const tab = (TABS.find((t) => t.value === url.get("tab"))?.value ?? "activities") as Tab;
  const [dialog, setDialog] = useState<"edit" | "disqualify" | "convert" | null>(null);
  const canConvert = useCan("sales.lead.convert");
  const qualify = useQualifyLead();
  const converted = lead.status === "converted";
  const target: RecordTarget = { targetType: "sales.lead", targetId: lead.id, name: lead.displayName };
  return (
    <SalesPageFrame
      title={
        <span className="inline-flex items-center gap-2">
          {lead.displayName} <LeadStatusChip status={lead.status} />
        </span>
      }
      actions={
        !converted && (
          <>
            {lead.canEdit && (
              <Button size="sm" onClick={() => setDialog("edit")}>
                <Pencil size={14} aria-hidden /> Edit
              </Button>
            )}
            {canConvert && lead.canEdit && lead.status !== "qualified" && (
              <Button size="sm" loading={qualify.isPending} onClick={() => qualify.mutate(lead.id, { onSuccess: () => toast.success("Lead qualified") })}>
                <BadgeCheck size={14} aria-hidden /> Qualify
              </Button>
            )}
            {canConvert && lead.canEdit && lead.status !== "disqualified" && (
              <Button size="sm" onClick={() => setDialog("disqualify")}>
                <Ban size={14} aria-hidden /> Disqualify
              </Button>
            )}
            {canConvert && lead.canEdit && lead.status !== "disqualified" && (
              <Button size="sm" variant="primary" onClick={() => setDialog("convert")}>
                <ArrowRightLeft size={14} aria-hidden /> Convert
              </Button>
            )}
          </>
        )
      }
    >
      {back}
      {converted && lead.convertedOpportunityId && (
        <p className="m-0 rounded-md border border-line bg-raised px-3 py-2 text-[13px]">
          Converted {lead.convertedAt ? formatDay(lead.convertedAt) : ""} —{" "}
          <EntityLink kind="opportunity" id={lead.convertedOpportunityId} name="open the opportunity" className="font-medium" />
        </p>
      )}
      {lead.status === "disqualified" && lead.disqualifyReason && (
        <p className="m-0 rounded-md bg-danger-s px-3 py-2 text-[13px] text-danger">Disqualified: {lead.disqualifyReason}</p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-5 max-[1023px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Tabs label="Lead sections" value={tab} onChange={(v) => url.set({ tab: v === "activities" ? null : v })} items={TABS} className="max-w-full overflow-x-auto" />
          {tab === "activities" && <RecordActivities target={target} />}
          {tab === "follow-ups" && <RecordFollowUps target={target} />}
          {tab === "comments" && <RecordComments target={target} />}
        </div>
        <dl className="m-0 grid grid-cols-1 gap-3 self-start rounded-lg border border-line bg-surface p-4 max-[1023px]:grid-cols-2">
          <Fact label="Company">{lead.company ? <EntityLink kind="company" id={lead.companyId} name={lead.company.name} /> : lead.companyName}</Fact>
          <Fact label="Contact">{lead.contact ? <EntityLink kind="contact" id={lead.contactId} name={lead.contact.name} /> : lead.contactName}</Fact>
          <Fact label="Phone">{lead.phone && <a href={`tel:${lead.phone}`}>{lead.phone}</a>}</Fact>
          <Fact label="Email">{lead.email && <a href={`mailto:${lead.email}`}>{lead.email}</a>}</Fact>
          <Fact label="Source">{LEAD_SOURCES.find((s) => s.value === lead.source)?.label}</Fact>
          <Fact label="Product">{lead.product?.name}</Fact>
          <Fact label="Estimated value">{lead.estimatedValue && formatMoney(lead.estimatedValue)}</Fact>
          <Fact label="Owner">
            {lead.owner && (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={lead.owner.name} hue={lead.owner.hue} size={20} decorative /> {lead.owner.name}
              </span>
            )}
          </Fact>
          <Fact label="Last activity">{lead.lastActivityAt && agoOrDate(lead.lastActivityAt)}</Fact>
          <Fact label="Created">{formatDay(lead.createdAt)}</Fact>
          {lead.notes && (
            <div className="col-span-full flex flex-col gap-0.5">
              <dt className="text-[12px] text-fg-3">Notes</dt>
              <dd className="m-0 whitespace-pre-wrap text-[13px]">{lead.notes}</dd>
            </div>
          )}
        </dl>
      </div>
      {dialog === "edit" && <LeadFormDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === "disqualify" && <DisqualifyDialog lead={lead} onClose={() => setDialog(null)} />}
      {dialog === "convert" && <ConvertDialog lead={lead} onClose={() => setDialog(null)} onDone={(r) => router.push(salesRoutes.opportunity(ws, r.opportunity.id))} />}
    </SalesPageFrame>
  );
}
