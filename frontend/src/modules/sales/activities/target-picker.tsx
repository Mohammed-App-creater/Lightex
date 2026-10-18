"use client";

import { Building2, Search, Target, User, UserPlus } from "lucide-react";
import { useState, type ComponentType } from "react";
import type { Permission } from "@/api/types";
import { usePermissions } from "@/platform/roles/can";
import { Button } from "@/ui/button";
import { Segmented } from "@/ui/choice";
import { Input } from "@/ui/input";
import { cn } from "@/lib/utils/cn";
import { pageItems, useCompanies, useContacts, useLeads, useOpportunities } from "../api";
import type { QuickActionTarget, QuickActionTargetType } from "../shared/quick-actions";
import { useDebounced } from "./form-dialog";

type Kind = QuickActionTargetType;
const KINDS: { value: Kind; label: string; icon: ComponentType<{ size?: number }>; permission: Permission }[] = [
  { value: "sales.opportunity", label: "Deal", icon: Target, permission: "sales.opportunity.view" },
  { value: "sales.lead", label: "Lead", icon: UserPlus, permission: "sales.lead.view" },
  { value: "sales.company", label: "Company", icon: Building2, permission: "sales.company.view" },
  { value: "sales.contact", label: "Contact", icon: User, permission: "sales.contact.view" },
];

export const targetKindLabel = (t: string) => KINDS.find((k) => k.value === t)?.label ?? "Record";

type Hit = { id: string; name: string; sub?: string };

function useHits(kind: Kind, q: string): { hits: Hit[]; pending: boolean } {
  const query = { q: q || undefined, limit: 6 };
  const co = useCompanies(query, kind === "sales.company");
  const ct = useContacts(query, kind === "sales.contact");
  const le = useLeads(query, kind === "sales.lead");
  const op = useOpportunities({ ...query, filter: { status: "open" } }, kind === "sales.opportunity");
  if (kind === "sales.company") return { hits: pageItems(co.data).map((c) => ({ id: c.id, name: c.name, sub: c.city })), pending: co.isPending };
  if (kind === "sales.contact")
    return { hits: pageItems(ct.data).map((c) => ({ id: c.id, name: c.name, sub: c.company?.name })), pending: ct.isPending };
  if (kind === "sales.lead") return { hits: pageItems(le.data).map((l) => ({ id: l.id, name: l.displayName, sub: l.companyName })), pending: le.isPending };
  return { hits: pageItems(op.data).map((o) => ({ id: o.id, name: o.title, sub: o.company?.name })), pending: op.isPending };
}

/**
 * Pick the record an activity or follow-up is about: the record type, then a search. A prefilled target (opened from
 * a record page) shows as a chip with "Change".
 */
export function TargetPicker({
  value,
  onChange,
  types = KINDS.map((k) => k.value),
  error,
  label = "Related to",
}: {
  label?: string;
  value: QuickActionTarget | null;
  onChange: (t: QuickActionTarget | null) => void;
  types?: Kind[];
  error?: string;
}) {
  const check = usePermissions();
  const kinds = KINDS.filter((k) => types.includes(k.value) && check(k.permission));
  const [kind, setKind] = useState<Kind>(value?.targetType ?? kinds[0]?.value ?? "sales.company");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const { hits, pending } = useHits(kind, value ? "" : dq);

  if (value) {
    const K = KINDS.find((k) => k.value === value.targetType);
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-medium text-fg-2">{label}</span>
        <div className="flex min-h-11 items-center gap-2.5 rounded-sm border border-line bg-raised px-2.5 py-1.5 min-[1024px]:min-h-8">
          {K && <K.icon size={14} />}
          <span className="text-meta text-fg-3">{targetKindLabel(value.targetType)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{value.name ?? "Selected record"}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
        {error && (
          <span role="alert" className="text-meta text-danger">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-fg-2">{label}</span>
      {kinds.length > 1 && (
        <Segmented
          label="Record type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setQ("");
          }}
          options={kinds.map((k) => ({ value: k.value, label: k.label }))}
          className="w-full"
        />
      )}
      <Input
        aria-label={`Search ${targetKindLabel(kind).toLowerCase()}s`}
        placeholder={`Search ${targetKindLabel(kind).toLowerCase()}s…`}
        leading={<Search size={14} />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul aria-label="Matching records" className="m-0 flex max-h-[220px] list-none flex-col overflow-y-auto rounded-sm border border-line p-1">
        {pending ? (
          <li className="px-2 py-2 text-meta text-fg-3">Searching…</li>
        ) : hits.length === 0 ? (
          <li className="px-2 py-2 text-meta text-fg-3">Nothing found.</li>
        ) : (
          hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onChange({ targetType: kind, targetId: h.id, name: h.name })}
                className={cn("flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] hover:bg-hover min-[1024px]:min-h-8")}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                {h.sub && <span className="max-w-[45%] truncate text-meta text-fg-3">{h.sub}</span>}
              </button>
            </li>
          ))
        )}
      </ul>
      {error && (
        <span role="alert" className="text-meta text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
