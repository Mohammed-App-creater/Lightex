"use client";

import { AlertTriangle } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { isApiError } from "@/api/errors";
import type { SalesBody, SalesLead, SalesLeadConvertResult, SalesLeadSource } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { Button } from "@/ui/button";
import { Checkbox, Segmented } from "@/ui/choice";
import { Field, Input, Textarea } from "@/ui/input";
import { Modal } from "@/ui/modal";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { pageItems, useCompanies, useConvertLead, useCreateLead, useDisqualifyLead, useDuplicateCheck, useProducts, useUpdateLead } from "../api";
import { isMoney } from "../shared/money";
import { OwnerPicker } from "../shared/user-picker";

/* Lead dialogs: create / edit, disqualify, convert (docs/sales/api.md §9). */

export const LEAD_SOURCES: { value: SalesLeadSource; label: string }[] = [
  { value: "referral", label: "Referral" },
  { value: "website", label: "Website" },
  { value: "call", label: "Call" },
  { value: "event", label: "Event" },
  { value: "visit", label: "Visit" },
  { value: "social", label: "Social" },
  { value: "other", label: "Other" },
];

const fieldErr = (e: unknown) => (isApiError(e) ? e.fieldErrors : {});

function Footer({ onCancel, label, busy, disabled, onSubmit }: { onCancel: () => void; label: string; busy: boolean; disabled?: boolean; onSubmit: () => void }) {
  return (
    <>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" loading={busy} disabled={disabled} onClick={onSubmit}>
        {label}
      </Button>
    </>
  );
}

export function LeadFormDialog({ lead, onClose, onCreated }: { lead?: SalesLead; onClose: () => void; onCreated?: (l: SalesLead) => void }) {
  const { user } = useSession();
  const products = (useProducts().data ?? []).filter((p) => p.isActive || p.id === lead?.productId);
  const [source, setSource] = useState<SalesLeadSource>(lead?.source ?? "other");
  const [companyName, setCompanyName] = useState(lead?.company?.name ?? lead?.companyName ?? "");
  const [contactName, setContactName] = useState(lead?.contactName ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [email, setEmail] = useState(lead?.email ?? "");
  const [productId, setProductId] = useState(lead?.productId ?? "");
  const [value, setValue] = useState(lead?.estimatedValue ?? "");
  const [status, setStatus] = useState<"new" | "contacted">(lead?.status === "contacted" ? "contacted" : "new");
  const [notes, setNotes] = useState(lead?.notes ?? "");
  const [ownerId, setOwnerId] = useState<string | null>(lead?.ownerId ?? user?.id ?? null);
  const create = useCreateLead();
  const update = useUpdateLead();
  const m = lead ? update : create;
  const errs = fieldErr(m.error);
  const badValue = value.trim() !== "" && !isMoney(value);
  const editableStatus = !lead || lead.status === "new" || lead.status === "contacted";
  const submit = () => {
    const body = {
      source,
      // A linked company keeps its link; the typed name is only sent when it changed.
      ...(lead?.companyId && companyName === lead.company?.name ? {} : { companyName: companyName.trim() }),
      contactName: contactName.trim(),
      phone: phone.trim(),
      email: email.trim(),
      productId: productId || null,
      estimatedValue: value.trim() || null,
      notes,
      ...(editableStatus ? { status } : {}),
      ...(ownerId && ownerId !== lead?.ownerId ? { ownerId } : {}),
    };
    if (lead) update.mutate({ id: lead.id, body }, { onSuccess: () => (toast.success("Saved"), onClose()) });
    else
      create.mutate(body as SalesBody<"sales_leads_create">, {
        onSuccess: (l) => {
          toast.success("Lead created");
          onClose();
          onCreated?.(l);
        },
      });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={lead ? "Edit lead" : "New lead"}
      width={560}
      footer={<Footer onCancel={onClose} label={lead ? "Save" : "Create"} busy={m.isPending} disabled={badValue || (!companyName.trim() && !contactName.trim())} onSubmit={submit} />}
    >
      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <Field label="Company" error={errs.companyName ?? errs.companyId}>
          <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} autoFocus />
        </Field>
        <Field label="Contact name" error={errs.contactName}>
          <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="Phone" error={errs.phone}>
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Email" error={errs.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Select label="Source" value={source} onChange={setSource} options={LEAD_SOURCES} />
        <Select label="Product" value={productId} onChange={setProductId} options={[{ value: "", label: "No product" }, ...products.map((p) => ({ value: p.id, label: p.name }))]} />
        <Field label="Estimated value (ETB)" error={badValue ? "Enter an amount like 250000.50" : errs.estimatedValue}>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
        </Field>
        {editableStatus && (
          <Select
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "new", label: "New" },
              { value: "contacted", label: "Contacted" },
            ]}
          />
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-meta font-medium text-fg-2">Owner</span>
          <OwnerPicker code="sales.lead.assign" value={ownerId} onChange={setOwnerId} />
          {errs.ownerId && <span className="text-meta text-danger">{errs.ownerId}</span>}
        </div>
        <Field label="Notes" error={errs.notes} className="col-span-full">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function DisqualifyDialog({ lead, onClose }: { lead: SalesLead; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const dq = useDisqualifyLead();
  const errs = fieldErr(dq.error);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Disqualify lead"
      description={lead.displayName}
      footer={
        <Footer
          onCancel={onClose}
          label="Disqualify"
          busy={dq.isPending}
          disabled={!reason.trim()}
          onSubmit={() => dq.mutate({ id: lead.id, reason: reason.trim() }, { onSuccess: () => (toast.success("Lead disqualified"), onClose()) })}
        />
      }
    >
      <Field label="Reason" error={errs.reason}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
      </Field>
    </Modal>
  );
}

/**
 * Convert: link an existing company or create one (the duplicate check warns while typing), optionally a contact,
 * and the opportunity's title / value / close date. `onDone` gets the result (the screen navigates to the deal).
 */
export function ConvertDialog({ lead, onClose, onDone }: { lead: SalesLead; onClose: () => void; onDone: (r: SalesLeadConvertResult) => void }) {
  const [mode, setMode] = useState<"existing" | "new">(lead.companyId ? "existing" : "new");
  const [companyId, setCompanyId] = useState(lead.companyId ?? "");
  const companies = pageItems(useCompanies({ limit: 100 }).data);
  const [name, setName] = useState(lead.companyName || lead.displayName);
  const [phone, setPhone] = useState(lead.phone);
  const dName = useDeferredValue(name.trim());
  const dPhone = useDeferredValue(phone.trim());
  const dup = useDuplicateCheck({ name: mode === "new" ? dName : "", phone: mode === "new" ? dPhone : "" });
  const [withContact, setWithContact] = useState(Boolean(lead.contactName));
  const [contactName, setContactName] = useState(lead.contactName);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState(lead.estimatedValue ?? "");
  const [close, setClose] = useState("");
  const convert = useConvertLead();
  const errs = fieldErr(convert.error);
  const badValue = value.trim() !== "" && !isMoney(value);
  const submit = () => {
    const body: SalesBody<"sales_leads_convert"> = {
      ...(mode === "existing" ? { companyId } : { company: { name: name.trim(), phone: phone.trim() || undefined, email: lead.email || undefined } }),
      ...(withContact && contactName.trim() && !lead.contactId ? { contact: { name: contactName.trim(), phone: lead.phone || undefined, email: lead.email || undefined } } : {}),
      opportunity: { ...(title.trim() ? { title: title.trim() } : {}), ...(value.trim() ? { expectedValue: value.trim() } : {}), ...(close ? { expectedCloseDate: close } : {}) },
    };
    convert.mutate({ id: lead.id, body }, { onSuccess: (r) => (toast.success("Lead converted"), onClose(), onDone(r)) });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Convert lead"
      description="Creates an opportunity in the first open stage, owned by the lead's owner."
      width={520}
      footer={<Footer onCancel={onClose} label="Convert" busy={convert.isPending} disabled={badValue || (mode === "existing" ? !companyId : !name.trim())} onSubmit={submit} />}
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label="Company"
          value={mode}
          onChange={setMode}
          options={[
            { value: "existing", label: "Link existing company" },
            { value: "new", label: "Create new company" },
          ]}
        />
        {mode === "existing" ? (
          <div className="flex flex-col gap-1">
            <Select label="Company" value={companyId || null} onChange={setCompanyId} options={companies.map((c) => ({ value: c.id, label: c.name }))} placeholder="Pick a company" />
            {errs.companyId && <span className="text-meta text-danger">{errs.companyId}</span>}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
              <Field label="Company name" error={errs.company ?? errs["company.name"]}>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Phone" error={errs["company.phone"]}>
                <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
            </div>
            {dup.data?.exists && (
              <p role="status" className="m-0 flex items-start gap-2 rounded-md bg-warn-s px-3 py-2 text-[12px] text-warn">
                <AlertTriangle size={14} aria-hidden className="mt-0.5 flex-none" />
                <span>
                  A company with this name or phone already exists{dup.data.ownerName ? ` (owner ${dup.data.ownerName})` : ""}. Link it instead to avoid a duplicate.
                </span>
              </p>
            )}
          </>
        )}
        {!lead.contactId && (
          <>
            <Checkbox label="Create a contact" checked={withContact} onChange={(e) => setWithContact(e.target.checked)} />
            {withContact && (
              <Field label="Contact name" error={errs["contact.name"] ?? errs.contact}>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
              </Field>
            )}
          </>
        )}
        <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
          <Field label="Opportunity title" hint="Default: company – product" error={errs["opportunity.title"]} className="col-span-full">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Expected value (ETB)" error={badValue ? "Enter an amount like 250000.50" : errs["opportunity.expectedValue"]}>
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Expected close" error={errs["opportunity.expectedCloseDate"]}>
            <Input type="date" value={close} onChange={(e) => setClose(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
