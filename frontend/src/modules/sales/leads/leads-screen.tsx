"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useState } from "react";
import type { SalesLead, SalesLeadSource, SalesLeadStatus, SalesListQuery } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { useCan } from "@/platform/roles/can";
import { useTeams } from "@/platform/teams/queries";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Input } from "@/ui/input";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { pageItems, useBulkAssignLeads, useLeads, useProducts, useSlug } from "../api";
import { formatMoney } from "../shared/money";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { formatDay, useUrlState } from "../pipeline/url-state";
import { LEAD_SOURCES, LeadFormDialog } from "./lead-dialogs";

/* Leads list (docs/sales/api.md §9.2–§9.3): filters in the URL, search, bulk assign, "New lead". */

export const LEAD_STATUSES: { value: SalesLeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "disqualified", label: "Disqualified" },
  { value: "converted", label: "Converted" },
];
const STATUS_TONE: Record<SalesLeadStatus, string> = {
  new: "bg-accent-s text-accent-t",
  contacted: "bg-raised text-fg-2",
  qualified: "bg-ok-s text-ok",
  disqualified: "bg-danger-s text-danger",
  converted: "bg-raised text-fg-3",
};

export function LeadStatusChip({ status }: { status: SalesLeadStatus }) {
  return (
    <span className={cn("inline-flex h-[20px] items-center rounded-sm px-1.5 text-[11px] font-medium", STATUS_TONE[status])}>
      {LEAD_STATUSES.find((s) => s.value === status)?.label ?? status}
    </span>
  );
}

type Filter = NonNullable<SalesListQuery<"sales_leads_list">["filter"]>;

export function LeadsScreen() {
  return (
    <SalesGate permission="sales.lead.view" name="Leads">
      <Leads />
    </SalesGate>
  );
}

function Leads() {
  const ws = useSlug();
  const router = useRouter();
  const url = useUrlState();
  const { beyondOwn } = useSalesScope("sales.lead.view");
  const canCreate = useCan("sales.lead.create");
  const canAssign = useCan("sales.lead.assign");
  const teams = useTeams(ws).data ?? [];
  const products = (useProducts().data ?? []).filter((p) => p.isActive);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(url.get("q"));
  const q = useDeferredValue(search.trim());
  const filter: Filter = {};
  const status = url.get("status") as SalesLeadStatus | "";
  const source = url.get("source") as SalesLeadSource | "";
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (url.get("owner")) filter.owner = url.get("owner");
  if (url.get("team")) filter.team = url.get("team");
  if (url.get("product")) filter.product = url.get("product");
  if (url.get("from")) filter.createdFrom = url.get("from");
  if (url.get("to")) filter.createdTo = url.get("to");
  const list = useLeads({ filter, q: q || undefined, limit: 50 });
  const items = pageItems(list.data);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState<string | null>(null);
  const bulk = useBulkAssignLeads();
  const selectable = canAssign;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const sel = items.filter((l) => selected.has(l.id));
  return (
    <SalesPageFrame
      title="Leads"
      actions={
        canCreate && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden /> New lead
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        <Input
          aria-label="Search leads"
          leading={<Search size={14} aria-hidden />}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            url.set({ q: e.target.value.trim() });
          }}
          placeholder="Search company, contact, phone…"
          className="w-64 max-[760px]:w-full"
        />
        <Select label="Status" hideLabel className="w-36" value={status} onChange={(v) => url.set({ status: v })} options={[{ value: "", label: "Any status" }, ...LEAD_STATUSES]} />
        <Select label="Source" hideLabel className="w-36" value={source} onChange={(v) => url.set({ source: v })} options={[{ value: "", label: "Any source" }, ...LEAD_SOURCES]} />
        {beyondOwn && <UserPicker label="Owner" noneLabel="Any owner" value={url.get("owner") || null} onChange={(v) => url.set({ owner: v })} className="w-44" />}
        {beyondOwn && teams.length > 0 && (
          <Select label="Team" hideLabel className="w-36" value={url.get("team")} onChange={(v) => url.set({ team: v })} options={[{ value: "", label: "Any team" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
        )}
        <Select
          label="Product"
          hideLabel
          className="w-36"
          value={url.get("product")}
          onChange={(v) => url.set({ product: v })}
          options={[{ value: "", label: "Any product" }, ...products.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
          Created
          <Input type="date" aria-label="Created from" value={url.get("from")} onChange={(e) => url.set({ from: e.target.value })} className="w-36" />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
          to
          <Input type="date" aria-label="Created to" value={url.get("to")} onChange={(e) => url.set({ to: e.target.value })} className="w-36" />
        </label>
      </div>

      {selectable && sel.length > 0 && (
        <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-[13px]">
          <span className="font-medium">{sel.length} selected</span>
          <UserPicker label="Assign to" noneLabel="Pick an owner" value={assignee} onChange={setAssignee} className="w-48" />
          <Button
            size="sm"
            variant="primary"
            disabled={!assignee}
            loading={bulk.isPending}
            onClick={() =>
              assignee &&
              bulk.mutate(
                { leadIds: sel.map((l) => l.id), ownerId: assignee },
                {
                  onSuccess: (r) => {
                    toast.success(`${r.updated} lead${r.updated === 1 ? "" : "s"} reassigned`);
                    setSelected(new Set());
                  },
                },
              )
            }
          >
            Assign
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {list.isPending ? (
        <SkeletonRows rows={6} label="Loading leads" />
      ) : list.isError ? (
        <ErrorState title="Couldn’t load leads" onRetry={() => list.refetch()} retrying={list.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState illustration="results" title="No leads" body={q || Object.keys(filter).length ? "Nothing matches these filters." : "New leads you capture show up here."} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line max-[760px]:hidden">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-raised text-left text-[12px] text-fg-2">
                  {selectable && (
                    <th className="w-9 px-3 py-2">
                      <Checkbox
                        aria-label="Select all"
                        checked={sel.length > 0 && sel.length === items.length}
                        indeterminate={sel.length > 0 && sel.length < items.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(items.map((l) => l.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th className="px-3 py-2 font-medium">Lead</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">Est. value</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id} className="border-b border-line last:border-0 hover:bg-hover">
                    {selectable && (
                      <td className="px-3 py-2">
                        <Checkbox aria-label={`Select ${l.displayName}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                      </td>
                    )}
                    <td className="max-w-[260px] px-3 py-2">
                      <Link href={salesRoutes.lead(ws, l.id)} className="block truncate font-medium text-fg hover:underline">
                        {l.displayName}
                      </Link>
                      {l.contactName && <span className="block truncate text-[12px] text-fg-3">{l.contactName}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <LeadStatusChip status={l.status} />
                    </td>
                    <td className="px-3 py-2 text-fg-2">{LEAD_SOURCES.find((s) => s.value === l.source)?.label}</td>
                    <td className="px-3 py-2 text-fg-2">{l.product?.name ?? "—"}</td>
                    <td className="tabular px-3 py-2 text-right font-mono">{formatMoney(l.estimatedValue)}</td>
                    <td className="px-3 py-2">{l.owner ? <OwnerCell lead={l} /> : "—"}</td>
                    <td className="px-3 py-2 text-fg-2">{formatDay(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="m-0 hidden list-none flex-col gap-2 p-0 max-[760px]:flex">
            {items.map((l) => (
              <li key={l.id} className="flex items-start gap-3 rounded-md border border-line bg-surface p-3">
                {selectable && <Checkbox aria-label={`Select ${l.displayName}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="mt-0.5" />}
                <Link href={salesRoutes.lead(ws, l.id)} className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{l.displayName}</span>
                    <LeadStatusChip status={l.status} />
                  </span>
                  <span className="truncate text-[12px] text-fg-2">
                    {[l.contactName, l.product?.name, l.estimatedValue ? formatMoney(l.estimatedValue, { compact: true }) : null].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span className="text-[12px] text-fg-3">
                    {l.owner?.name ?? "No owner"} · {formatDay(l.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button variant="ghost" className="self-center" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          )}
        </>
      )}
      {creating && <LeadFormDialog onClose={() => setCreating(false)} onCreated={(l) => router.push(salesRoutes.lead(ws, l.id))} />}
    </SalesPageFrame>
  );
}

function OwnerCell({ lead }: { lead: SalesLead }) {
  if (!lead.owner) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Avatar name={lead.owner.name} hue={lead.owner.hue} size={20} decorative />
      <span className="truncate">{lead.owner.name}</span>
    </span>
  );
}
