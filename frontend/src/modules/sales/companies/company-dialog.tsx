"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { SalesCompany, SalesCompanyStatus } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/input";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { FormDialog, fieldErrorsOf, useDebounced } from "../activities/form-dialog";
import { useCreateCompany, useDuplicateCheck, useUpdateCompany } from "../api";
import { OwnerPicker } from "../shared/user-picker";

export const COMPANY_STATUSES: { value: SalesCompanyStatus; label: string }[] = [
  { value: "prospect", label: "Prospect" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

/** Live duplicate warning (api.md §6.3): warns only, never blocks. */
export function DuplicateWarning({ name, phone, excludeId }: { name: string; phone: string; excludeId?: string }) {
  const n = useDebounced(name.trim(), 350);
  const p = useDebounced(phone.trim(), 350);
  const q = useDuplicateCheck({ name: n || undefined, phone: p || undefined, excludeId });
  if (!q.data?.exists) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-md border border-line-2 bg-raised px-3 py-2 text-[13px] text-fg-2">
      <AlertTriangle size={14} aria-hidden className="mt-0.5 flex-none text-warn" />
      <span>
        A company with this name or phone already exists{q.data.ownerName ? ` (owner: ${q.data.ownerName})` : ""}. Check with them before adding it
        again.
      </span>
    </div>
  );
}

/** Create or edit a company. The owner field follows the owner-change rule (`OwnerPicker`, api.md §3). */
export function CompanyDialog({ company, onClose, onCreated }: { company?: SalesCompany; onClose: () => void; onCreated?: (c: SalesCompany) => void }) {
  const { user } = useSession();
  const create = useCreateCompany();
  const update = useUpdateCompany();
  const m = company ? update : create;
  const [f, setF] = useState({
    name: company?.name ?? "",
    phone: company?.phone ?? "",
    email: company?.email ?? "",
    website: company?.website ?? "",
    industry: company?.industry ?? "",
    region: company?.region ?? "",
    city: company?.city ?? "",
    address: company?.address ?? "",
    notes: company?.notes ?? "",
    status: (company?.status ?? "prospect") as SalesCompanyStatus,
  });
  const [ownerId, setOwnerId] = useState<string | null>(company ? company.ownerId : (user?.id ?? null));
  const [nameErr, setNameErr] = useState("");
  const errs = fieldErrorsOf(m.error);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = () => {
    if (!f.name.trim()) return setNameErr("Name is required");
    setNameErr("");
    const ownerChanged = company ? ownerId !== company.ownerId : ownerId !== user?.id;
    const body = { ...f, name: f.name.trim(), ownerId: ownerChanged && ownerId ? ownerId : undefined };
    if (company)
      update.mutate(
        { id: company.id, body },
        {
          onSuccess: () => {
            toast.success("Company saved");
            onClose();
          },
        },
      );
    else
      create.mutate(body, {
        onSuccess: (c) => {
          toast.success("Company added");
          onCreated?.(c);
          onClose();
        },
      });
  };

  return (
    <FormDialog
      title={company ? "Edit company" : "New company"}
      onOpenChange={(o) => !o && onClose()}
      onSubmit={submit}
      width={600}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={m.isPending}>
            {company ? "Save" : "Add company"}
          </Button>
        </>
      }
    >
      <Field label="Name" error={nameErr || errs.name}>
        <Input autoFocus maxLength={200} value={f.name} onChange={set("name")} />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <Field label="Phone" error={errs.phone}>
          <Input type="tel" maxLength={40} value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Email" error={errs.email}>
          <Input type="email" maxLength={254} value={f.email} onChange={set("email")} />
        </Field>
      </div>
      <DuplicateWarning name={f.name} phone={f.phone} excludeId={company?.id} />
      <div className="grid grid-cols-3 gap-3 max-[560px]:grid-cols-1">
        <Field label="Industry" error={errs.industry}>
          <Input maxLength={80} value={f.industry} onChange={set("industry")} />
        </Field>
        <Field label="Region" error={errs.region}>
          <Input maxLength={80} value={f.region} onChange={set("region")} />
        </Field>
        <Field label="City" error={errs.city}>
          <Input maxLength={80} value={f.city} onChange={set("city")} />
        </Field>
      </div>
      <Field label="Address" error={errs.address}>
        <Input maxLength={300} value={f.address} onChange={set("address")} />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <Field label="Website" error={errs.website}>
          <Input maxLength={200} value={f.website} onChange={set("website")} />
        </Field>
        <Select label="Status" value={f.status} onChange={(v) => setF((x) => ({ ...x, status: v }))} options={COMPANY_STATUSES} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-medium text-fg-2">Owner</span>
        <OwnerPicker code="sales.company.edit" value={ownerId} onChange={setOwnerId} />
        {errs.ownerId && (
          <span role="alert" className="text-meta text-danger">
            {errs.ownerId}
          </span>
        )}
      </div>
      <Field label="Notes" error={errs.notes}>
        <Textarea rows={3} maxLength={5000} value={f.notes} onChange={set("notes")} />
      </Field>
    </FormDialog>
  );
}
