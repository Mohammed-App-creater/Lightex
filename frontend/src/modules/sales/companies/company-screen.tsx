"use client";

import { CalendarCheck, CalendarPlus, CalendarX, FileText, Globe, Mail, MapPin, MoreHorizontal, Pencil, Phone, Plus, Star, Trash2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { isApiError, isNotFound } from "@/api/errors";
import type { SalesCompany, SalesTimelineItem } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Panel, StatTile } from "@/ui/card";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/feedback";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { ConfirmDialog, Modal } from "@/ui/modal";
import { toast } from "@/ui/toast";
import { agoOrDate, shortDate } from "@/lib/utils/dates";
import { RecordCollab } from "../activities/record-collab";
import { useUrlState } from "../activities/url-state";
import { pageItems, useCompanySummary, useCompanyTimeline, useContacts, useDeleteCompany, useOpportunities, useSlug, useUpdateCompany } from "../api";
import { formatMoney } from "../shared/money";
import { QuickActionsMenu, type QuickActionTarget } from "../shared/quick-actions";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { StagePill } from "../shared/stage-pill";
import { ContactDialog } from "../contacts/contact-dialog";
import { CompanyDialog } from "./company-dialog";
import { CompanyStatusBadge } from "./companies-screen";

/** Customer summary page (`/[ws]/sales/companies/[id]`, api.md §6.4). */
export function CompanyScreen({ id }: { id: string }) {
  return (
    <SalesGate permission="sales.company.view" name="Company">
      <Company id={id} />
    </SalesGate>
  );
}

function Company({ id }: { id: string }) {
  const ws = useSlug();
  const url = useUrlState();
  const q = useCompanySummary(id);
  const s = q.data;

  if (q.isPending)
    return (
      <SalesPageFrame title={<Skeleton className="h-5 w-48" />}>
        <div className="grid grid-cols-3 gap-3 max-[760px]:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-lg" />
          ))}
        </div>
        <SkeletonRows rows={4} />
      </SalesPageFrame>
    );
  if (q.isError || !s)
    return (
      <SalesPageFrame title="Company">
        {isNotFound(q.error) ? (
          <EmptyState
            title="Company not found"
            body="It was deleted, or it isn’t in your view."
            actions={
              <Button asChild>
                <Link href={salesRoutes.companies(ws)}>All companies</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState title="Couldn’t load this company" onRetry={() => void q.refetch()} retrying={q.isRefetching} />
        )}
      </SalesPageFrame>
    );

  const c = s.company;
  const target: QuickActionTarget = { targetType: "sales.company", targetId: c.id, name: c.name };
  return (
    <SalesPageFrame
      title={c.name}
      actions={
        <>
          <CompanyStatusBadge status={c.status} />
          <QuickActionsMenu target={target} />
          <CompanyMenu company={c} onEdit={() => url.set({ edit: "1" })} />
        </>
      }
    >
      <div className="grid grid-cols-6 gap-3 max-[1200px]:grid-cols-3 max-[600px]:grid-cols-2">
        <StatTile label="Contacts" value={s.contactCount} />
        <StatTile label="Open deals" value={s.openOpportunityCount} />
        <StatTile label="Pipeline value" value={<span className="text-[22px]">{formatMoney(s.pipelineValue, { compact: true })}</span>} />
        <StatTile label="Won value" value={<span className="text-[22px]">{formatMoney(s.wonValue, { compact: true })}</span>} />
        <StatTile label="Open follow-ups" value={s.openFollowUpCount} />
        <StatTile label="Last contact" value={<span className="text-[22px]">{s.lastContactAt ? agoOrDate(s.lastContactAt) : "—"}</span>} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4 max-[1100px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <OpportunitiesPanel companyId={c.id} />
          <TimelinePanel companyId={c.id} />
          <RecordCollab target={{ targetType: "sales.company", targetId: c.id }} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <DetailsPanel c={c} />
          <ContactsPanel company={c} primaryId={s.primaryContact?.id} />
        </div>
      </div>

      {url.get("edit") === "1" && c.canEdit && <CompanyDialog company={c} onClose={() => url.set({ edit: null })} />}
    </SalesPageFrame>
  );
}

function CompanyMenu({ company: c, onEdit }: { company: SalesCompany; onEdit: () => void }) {
  const ws = useSlug();
  const router = useRouter();
  const del = useDeleteCompany();
  const update = useUpdateCompany();
  const [confirm, setConfirm] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  if (!c.canEdit && !c.canDelete) return null;
  const markInactive = () =>
    update.mutate(
      { id: c.id, body: { status: "inactive" } },
      {
        onSuccess: () => {
          toast.success(`${c.name} marked inactive`);
          setBlocked(null);
        },
      },
    );
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon aria-label="More actions">
            <MoreHorizontal size={16} aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={200}>
          {c.canEdit && (
            <MenuItem icon={<Pencil size={14} />} onSelect={onEdit}>
              Edit
            </MenuItem>
          )}
          {c.canEdit && c.status !== "inactive" && (
            <MenuItem icon={<CalendarX size={14} />} onSelect={markInactive}>
              Mark inactive
            </MenuItem>
          )}
          {c.canDelete && (
            <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setConfirm(true)}>
              Delete
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${c.name}?`}
        description="The company and its contacts go to the trash; an admin can restore them."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() =>
          del
            .mutateAsync(c.id)
            .then(() => {
              toast.success("Company deleted");
              router.push(salesRoutes.companies(ws));
            })
            .catch((e: unknown) => {
              if (isApiError(e) && e.code === "company_has_opportunities") setBlocked(e.message);
            })
        }
      />
      <Modal
        open={blocked !== null}
        onOpenChange={(o) => !o && setBlocked(null)}
        title="This company has deals"
        description={blocked || "A company with opportunities can’t be deleted."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBlocked(null)}>
              Keep it
            </Button>
            {c.canEdit && c.status !== "inactive" && (
              <Button variant="primary" loading={update.isPending} onClick={markInactive}>
                Mark inactive
              </Button>
            )}
          </>
        }
      >
        <p className="m-0 text-[13px] text-fg-2">Archive it instead: an inactive company keeps its history and deals.</p>
      </Modal>
    </>
  );
}

function DetailsPanel({ c }: { c: SalesCompany }) {
  const rows = [
    c.phone && { icon: Phone, node: <a href={`tel:${c.phone}`} className="hover:underline">{c.phone}</a> },
    c.email && { icon: Mail, node: <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> },
    c.website && { icon: Globe, node: <span className="truncate">{c.website}</span> },
    (c.address || c.city || c.region) && { icon: MapPin, node: <span>{[c.address, c.city, c.region].filter(Boolean).join(", ")}</span> },
  ].filter(Boolean) as { icon: typeof Phone; node: ReactNode }[];
  return (
    <Panel title="Details">
      <div className="flex flex-col gap-2.5 text-[13px]">
        {rows.map((r, i) => (
          <div key={i} className="flex min-w-0 items-start gap-2 text-fg">
            <r.icon size={14} aria-hidden className="mt-0.5 flex-none text-fg-3" />
            {r.node}
          </div>
        ))}
        <dl className="m-0 grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-fg-2">
          <dt className="text-fg-3">Industry</dt>
          <dd className="m-0">{c.industry || "—"}</dd>
          <dt className="text-fg-3">Owner</dt>
          <dd className="m-0 flex items-center gap-1.5">
            {c.owner && <Avatar name={c.owner.name} hue={c.owner.hue} size={18} decorative />}
            {c.owner?.name ?? "—"}
          </dd>
          <dt className="text-fg-3">Since</dt>
          <dd className="m-0">{c.createdAt ? shortDate(c.createdAt.slice(0, 10)) : "—"}</dd>
        </dl>
        {c.notes && <p className="m-0 whitespace-pre-wrap text-fg-2">{c.notes}</p>}
      </div>
    </Panel>
  );
}

function ContactsPanel({ company, primaryId }: { company: SalesCompany; primaryId?: string }) {
  const ws = useSlug();
  const canCreate = useCan("sales.contact.create");
  const [adding, setAdding] = useState(false);
  const q = useContacts({ filter: { company: company.id }, limit: 50 });
  const rows = pageItems(q.data);
  return (
    <Panel
      title="Contacts"
      actions={
        canCreate && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden /> Add
          </Button>
        )
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={2} />
      ) : q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-meta text-fg-3">No contacts yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((ct) => (
            <li key={ct.id}>
              <Link href={salesRoutes.contact(ws, ct.id)} className="flex min-h-11 items-center gap-2.5 rounded-sm px-1.5 py-1.5 hover:bg-hover">
                <Avatar name={ct.name} size={24} decorative />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1 truncate text-[13px] font-medium">
                    {ct.name}
                    {(ct.isPrimary || ct.id === primaryId) && <Star size={12} aria-label="Primary contact" className="fill-current text-warn" />}
                  </span>
                  <span className="truncate text-meta text-fg-3">{[ct.jobTitle, ct.phone].filter(Boolean).join(" · ")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {adding && <ContactDialog company={{ id: company.id, name: company.name }} onClose={() => setAdding(false)} />}
    </Panel>
  );
}

function OpportunitiesPanel({ companyId }: { companyId: string }) {
  const ws = useSlug();
  const canView = useCan("sales.opportunity.view");
  const q = useOpportunities({ filter: { company: companyId }, sort: "-createdAt", limit: 50 }, canView);
  if (!canView) return null;
  const rows = pageItems(q.data);
  return (
    <Panel title="Opportunities">
      {q.isPending ? (
        <SkeletonRows rows={2} />
      ) : q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-meta text-fg-3">No deals with this company yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((o) => (
            <li key={o.id}>
              <Link href={salesRoutes.opportunity(ws, o.id)} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-1.5 py-1.5 hover:bg-hover">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{o.title}</span>
                <StagePill stage={o.stage} />
                <span className="tabular w-[110px] text-right text-[13px] text-fg-2 max-[600px]:w-auto">{formatMoney(o.wonValue ?? o.expectedValue, { compact: true })}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const KIND_ICON: Partial<Record<SalesTimelineItem["kind"], typeof Phone>> = {
  activity_logged: Phone,
  followup_scheduled: CalendarPlus,
  followup_completed: CalendarCheck,
  followup_cancelled: CalendarX,
  quotation_created: FileText,
  quotation_sent: FileText,
  quotation_accepted: FileText,
  quotation_rejected: FileText,
  quotation_expired: FileText,
};

/** Timeline items (api.md §10.7 shape): icon, summary, actor, time. */
export function TimelineList({ items }: { items: SalesTimelineItem[] }) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {items.map((it) => {
        const Icon = KIND_ICON[it.kind] ?? TrendingUp;
        return (
          <li key={it.id} className="relative flex gap-3 pb-3 last:pb-0">
            <span className="flex size-7 flex-none items-center justify-center rounded-full border border-line bg-raised text-fg-2">
              <Icon size={13} aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
              <span className="text-[13px] leading-5 text-fg">{it.summary}</span>
              {it.activity?.outcome && <span className="text-meta text-fg-2">Outcome: {it.activity.outcome}</span>}
              <span className="text-meta text-fg-3">
                {it.actor?.name ? `${it.actor.name} · ` : ""}
                {agoOrDate(it.at)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TimelinePanel({ companyId }: { companyId: string }) {
  const q = useCompanyTimeline(companyId);
  const items = pageItems(q.data);
  return (
    <Panel title="Timeline">
      {q.isPending ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <p className="m-0 text-meta text-fg-3">No activity yet. Log a call or visit to start the history.</p>
      ) : (
        <>
          <TimelineList items={items} />
          {q.hasNextPage && (
            <Button className="mt-3 self-start" size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Show older
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}
