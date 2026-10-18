"use client";

import { Building2, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { SalesCompany, SalesCompanyStatus } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Input } from "@/ui/input";
import { Select } from "@/ui/select";
import { agoOrDate } from "@/lib/utils/dates";
import { cn } from "@/lib/utils/cn";
import { useDebounced } from "../activities/form-dialog";
import { useUrlState } from "../activities/url-state";
import { pageItems, useCompanies, useSlug } from "../api";
import { QuickActionsMenu } from "../shared/quick-actions";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { COMPANY_STATUSES, CompanyDialog } from "./company-dialog";

const ANY = "__any";
const STATUS_TONE: Record<SalesCompanyStatus, string> = { prospect: "text-accent", active: "text-ok", inactive: "text-fg-3" };

export function CompanyStatusBadge({ status }: { status: SalesCompanyStatus }) {
  return (
    <Badge>
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", STATUS_TONE[status])} />
      {COMPANY_STATUSES.find((s) => s.value === status)?.label ?? status}
    </Badge>
  );
}

const distinct = (list: SalesCompany[], k: "industry" | "region") =>
  [...new Set(list.map((c) => c[k].trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Companies list (`/[ws]/sales/companies`): search, status / industry / region / owner filters, create. */
export function CompaniesScreen() {
  return (
    <SalesGate permission="sales.company.view" name="Companies">
      <Companies />
    </SalesGate>
  );
}

function Companies() {
  const url = useUrlState();
  const canCreate = useCan("sales.company.create");
  const { beyondOwn } = useSalesScope("sales.company.view");
  const [q, setQ] = useState(url.get("q"));
  const dq = useDebounced(q.trim());
  const status = url.get("status") as SalesCompanyStatus | "";
  const industry = url.get("industry");
  const region = url.get("region");
  const owner = url.get("owner");
  const creating = url.get("new") === "1";

  const list = useCompanies({
    q: dq || undefined,
    filter: { status: status || undefined, industry: industry || undefined, region: region || undefined, owner: owner || undefined },
  });
  const all = pageItems(useCompanies({ limit: 200 }).data);
  const rows = pageItems(list.data);
  const filtered = Boolean(dq || status || industry || region || owner);

  return (
    <SalesPageFrame
      title="Companies"
      actions={
        <>
          <QuickActionsMenu className="max-[1023px]:hidden" />
          {canCreate && (
            <Button variant="primary" size="sm" onClick={() => url.set({ new: "1" })}>
              <Plus size={14} aria-hidden /> New company
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        <Input
          aria-label="Search companies"
          placeholder="Search name, phone, email, city…"
          leading={<Search size={14} />}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            url.set({ q: e.target.value.trim() || null });
          }}
          className="w-[280px] max-[760px]:w-full"
        />
        <Select
          label="Status"
          hideLabel
          placeholder="Any status"
          value={status || ANY}
          onChange={(v) => url.set({ status: v === ANY ? null : v })}
          options={[{ value: ANY, label: "Any status" }, ...COMPANY_STATUSES]}
          className="w-[150px] max-[760px]:w-[calc(50%-4px)]"
        />
        <Select
          label="Industry"
          hideLabel
          value={industry || ANY}
          onChange={(v) => url.set({ industry: v === ANY ? null : v })}
          options={[{ value: ANY, label: "Any industry" }, ...distinct(all, "industry").map((v) => ({ value: v, label: v }))]}
          className="w-[160px] max-[760px]:w-[calc(50%-4px)]"
        />
        <Select
          label="Region"
          hideLabel
          value={region || ANY}
          onChange={(v) => url.set({ region: v === ANY ? null : v })}
          options={[{ value: ANY, label: "Any region" }, ...distinct(all, "region").map((v) => ({ value: v, label: v }))]}
          className="w-[150px] max-[760px]:w-[calc(50%-4px)]"
        />
        {beyondOwn && (
          <UserPicker value={owner || null} onChange={(id) => url.set({ owner: id })} label="Owner" noneLabel="Any owner" className="max-[760px]:w-[calc(50%-4px)]" />
        )}
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQ("");
              url.set({ q: null, status: null, industry: null, region: null, owner: null });
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {list.isPending ? (
        <SkeletonRows rows={6} label="Loading companies" />
      ) : list.isError ? (
        <ErrorState title="Couldn’t load companies" onRetry={() => void list.refetch()} retrying={list.isRefetching} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Building2 size={18} />}
          title={filtered ? "No companies match" : "No companies yet"}
          body={filtered ? "Try other filters." : "Add the customers you sell to."}
          actions={
            canCreate && !filtered ? (
              <Button variant="primary" onClick={() => url.set({ new: "1" })}>
                <Plus size={14} aria-hidden /> New company
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[minmax(0,2fr)_110px_minmax(0,1fr)_minmax(0,1fr)_140px_90px] gap-3 border-b border-line px-3 pb-2 text-meta text-fg-3 max-[900px]:hidden">
            <span>Name</span>
            <span>Status</span>
            <span>Industry</span>
            <span>City</span>
            <span>Owner</span>
            <span className="text-right">Last activity</span>
          </div>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((c) => (
              <CompanyRow key={c.id} c={c} />
            ))}
          </ul>
          {list.hasNextPage && (
            <Button className="mt-3 self-center" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          )}
        </div>
      )}

      {creating && <CompanyDialog onClose={() => url.set({ new: null })} />}
    </SalesPageFrame>
  );
}

function CompanyRow({ c }: { c: SalesCompany }) {
  const ws = useSlug();
  return (
    <li className="border-b border-line">
      <Link
        href={salesRoutes.company(ws, c.id)}
        className="grid grid-cols-[minmax(0,2fr)_110px_minmax(0,1fr)_minmax(0,1fr)_140px_90px] items-center gap-3 px-3 py-2.5 text-[13px] hover:bg-hover max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:gap-y-1"
      >
        <span className="min-w-0 truncate font-medium text-fg">{c.name}</span>
        <span className="max-[900px]:col-start-2 max-[900px]:row-start-1">
          <CompanyStatusBadge status={c.status} />
        </span>
        <span className="min-w-0 truncate text-fg-2 max-[900px]:hidden">{c.industry || "—"}</span>
        <span className="min-w-0 truncate text-fg-2 max-[900px]:col-span-2 max-[900px]:text-meta max-[900px]:text-fg-3">
          {[c.city, c.industry].filter(Boolean).join(" · ") || "—"}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-fg-2 max-[900px]:hidden">
          {c.owner ? (
            <>
              <Avatar name={c.owner.name} hue={c.owner.hue} size={20} decorative />
              <span className="truncate">{c.owner.name}</span>
            </>
          ) : (
            "—"
          )}
        </span>
        <span className="text-right text-meta text-fg-3 max-[900px]:hidden">{c.lastActivityAt ? agoOrDate(c.lastActivityAt) : "—"}</span>
      </Link>
    </li>
  );
}
