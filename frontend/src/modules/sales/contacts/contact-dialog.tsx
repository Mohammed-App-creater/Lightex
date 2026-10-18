"use client";

import { useState } from "react";
import type { SalesContact } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { Field, Input, Textarea } from "@/ui/input";
import { toast } from "@/ui/toast";
import { FormDialog, fieldErrorsOf } from "../activities/form-dialog";
import { TargetPicker } from "../activities/target-picker";
import { useCreateContact, useUpdateContact } from "../api";
import type { QuickActionTarget } from "../shared/quick-actions";
import { OwnerPicker } from "../shared/user-picker";

/** Create or edit a contact: company picker, primary flag (one per company; the server clears the others). */
export function ContactDialog({
  contact,
  company,
  onClose,
}: {
  contact?: SalesContact;
  /** Preselect the company (from the company page). */
  company?: { id: string; name: string };
  onClose: () => void;
}) {
  const { user } = useSession();
  const create = useCreateContact();
  const update = useUpdateContact();
  const m = contact ? update : create;
  const initialCo = contact?.company ?? company;
  const [co, setCo] = useState<QuickActionTarget | null>(initialCo ? { targetType: "sales.company", targetId: initialCo.id, name: initialCo.name } : null);
  const [f, setF] = useState({
    name: contact?.name ?? "",
    jobTitle: contact?.jobTitle ?? "",
    phone: contact?.phone ?? "",
    email: contact?.email ?? "",
    notes: contact?.notes ?? "",
  });
  const [isPrimary, setPrimary] = useState(contact?.isPrimary ?? false);
  const [ownerId, setOwnerId] = useState<string | null>(contact ? contact.ownerId : (user?.id ?? null));
  const [local, setLocal] = useState<Record<string, string>>({});
  const errs = { ...fieldErrorsOf(m.error), ...local };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = "Name is required";
    if (!co) e.companyId = "Pick a company";
    setLocal(e);
    if (Object.keys(e).length || !co) return;
    const ownerChanged = contact ? ownerId !== contact.ownerId : ownerId !== user?.id;
    const body = { ...f, name: f.name.trim(), companyId: co.targetId, isPrimary, ownerId: ownerChanged && ownerId ? ownerId : undefined };
    const done = (msg: string) => () => {
      toast.success(msg);
      onClose();
    };
    if (contact) update.mutate({ id: contact.id, body }, { onSuccess: done("Contact saved") });
    else create.mutate(body, { onSuccess: done("Contact added") });
  };

  return (
    <FormDialog
      title={contact ? "Edit contact" : "New contact"}
      onOpenChange={(o) => !o && onClose()}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={m.isPending}>
            {contact ? "Save" : "Add contact"}
          </Button>
        </>
      }
    >
      <Field label="Name" error={errs.name}>
        <Input autoFocus maxLength={120} value={f.name} onChange={set("name")} />
      </Field>
      <TargetPicker label="Company" value={co} onChange={setCo} types={["sales.company"]} error={errs.companyId} />
      <Field label="Job title" error={errs.jobTitle}>
        <Input maxLength={120} value={f.jobTitle} onChange={set("jobTitle")} />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <Field label="Phone" error={errs.phone}>
          <Input type="tel" maxLength={40} value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Email" error={errs.email}>
          <Input type="email" maxLength={254} value={f.email} onChange={set("email")} />
        </Field>
      </div>
      <Checkbox label="Primary contact for this company" checked={isPrimary} onChange={(e) => setPrimary(e.target.checked)} />
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-medium text-fg-2">Owner</span>
        <OwnerPicker code="sales.contact.edit" value={ownerId} onChange={setOwnerId} />
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
