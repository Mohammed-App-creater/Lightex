"use client";

import { useState } from "react";
import { isApiError } from "@/api/errors";
import type { SalesBody, SalesOpportunity } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/input";
import { Modal } from "@/ui/modal";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import {
  pageItems,
  useCompanies,
  useCreateOpportunity,
  useLoseOpportunity,
  useLostReasons,
  useProducts,
  useReopenOpportunity,
  useStages,
  useUpdateOpportunity,
  useWinOpportunity,
} from "../api";
import { formatMoney, isMoney } from "../shared/money";
import { useSalesScope } from "../shared/scope";
import { OwnerPicker } from "../shared/user-picker";
import { isoDay } from "../pipeline/url-state";

/* Opportunity dialogs: create / edit, won, lost, reopen (docs/sales/api.md §10). */

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

/** Create (no `opp`) or edit an opportunity. `onCreated` gets the new record. */
export function OpportunityFormDialog({
  opp,
  defaultStageId,
  onClose,
  onCreated,
}: {
  opp?: SalesOpportunity;
  defaultStageId?: string;
  onClose: () => void;
  onCreated?: (o: SalesOpportunity) => void;
}) {
  const { user } = useSession();
  const companies = pageItems(useCompanies({ limit: 100 }).data);
  const products = (useProducts().data ?? []).filter((p) => p.isActive || p.id === opp?.productId);
  const stages = (useStages().data ?? []).filter((s) => s.category === "open");
  const [title, setTitle] = useState(opp?.title ?? "");
  const [companyId, setCompanyId] = useState(opp?.companyId ?? "");
  const [productId, setProductId] = useState(opp?.productId ?? "");
  const [stageId, setStageId] = useState(defaultStageId ?? "");
  const [value, setValue] = useState(opp?.expectedValue ?? "");
  const [prob, setProb] = useState(opp?.probabilityOverride == null ? "" : String(opp.probabilityOverride));
  const [close, setClose] = useState(opp?.expectedCloseDate ?? "");
  const [nextAction, setNextAction] = useState(opp?.nextAction ?? "");
  const [notes, setNotes] = useState(opp?.notes ?? "");
  const [ownerId, setOwnerId] = useState<string | null>(opp?.ownerId ?? user?.id ?? null);
  const create = useCreateOpportunity();
  const update = useUpdateOpportunity();
  const m = opp ? update : create;
  const errs = fieldErr(m.error);
  const badValue = value.trim() !== "" && !isMoney(value);
  const submit = () => {
    const common = {
      title: title.trim(),
      companyId,
      productId: productId || null,
      expectedValue: value.trim() || "0",
      probabilityOverride: prob === "" ? null : Number(prob),
      expectedCloseDate: close || null,
      nextAction: nextAction.trim(),
      notes,
      ...(ownerId && ownerId !== opp?.ownerId ? { ownerId } : {}),
    };
    if (opp) {
      update.mutate({ id: opp.id, body: { ...common, version: opp.version } }, { onSuccess: () => (toast.success("Saved"), onClose()) });
    } else {
      create.mutate({ ...common, ...(stageId ? { stageId } : {}) } as SalesBody<"sales_opportunities_create">, {
        onSuccess: (o) => {
          toast.success("Opportunity created");
          onClose();
          onCreated?.(o);
        },
      });
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={opp ? "Edit opportunity" : "New opportunity"}
      width={560}
      footer={<Footer onCancel={onClose} label={opp ? "Save" : "Create"} busy={m.isPending} disabled={!title.trim() || !companyId || badValue} onSubmit={submit} />}
    >
      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <Field label="Title" error={errs.title} className="col-span-full">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <div className="flex flex-col gap-1">
          <Select label="Company" value={companyId || null} onChange={setCompanyId} options={companies.map((c) => ({ value: c.id, label: c.name }))} placeholder="Pick a company" />
          {errs.companyId && <span className="text-meta text-danger">{errs.companyId}</span>}
        </div>
        <div className="flex flex-col gap-1">
          <Select label="Product" value={productId} onChange={setProductId} options={[{ value: "", label: "No product" }, ...products.map((p) => ({ value: p.id, label: p.name }))]} />
          {errs.productId && <span className="text-meta text-danger">{errs.productId}</span>}
        </div>
        {!opp && (
          <Select label="Stage" value={stageId} onChange={setStageId} options={[{ value: "", label: "First stage" }, ...stages.map((s) => ({ value: s.id, label: s.name }))]} />
        )}
        <Field label="Expected value (ETB)" error={badValue ? "Enter an amount like 250000.50" : errs.expectedValue}>
          <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Probability override (%)" hint="Empty = stage default" error={errs.probabilityOverride}>
          <Input type="number" min={0} max={100} value={prob} onChange={(e) => setProb(e.target.value)} />
        </Field>
        <Field label="Expected close" error={errs.expectedCloseDate}>
          <Input type="date" value={close} onChange={(e) => setClose(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-meta font-medium text-fg-2">Owner</span>
          <OwnerPicker code="sales.opportunity.assign" value={ownerId} onChange={setOwnerId} />
          {errs.ownerId && <span className="text-meta text-danger">{errs.ownerId}</span>}
        </div>
        <Field label="Next action" error={errs.nextAction} className="col-span-full">
          <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
        </Field>
        <Field label="Notes" error={errs.notes} className="col-span-full">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Mark won: value (default expected) and, with a `team` / `all` close scope, a date earlier this month. */
export function WonDialog({ opp, onClose }: { opp: SalesOpportunity; onClose: () => void }) {
  const { beyondOwn } = useSalesScope("sales.opportunity.close");
  const [value, setValue] = useState(opp.expectedValue);
  const today = isoDay();
  const [date, setDate] = useState(today);
  const win = useWinOpportunity();
  const errs = fieldErr(win.error);
  const bad = !isMoney(value);
  const monthStart = `${today.slice(0, 8)}01`;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Mark as won"
      description={opp.title}
      footer={
        <Footer
          onCancel={onClose}
          label="Mark won"
          busy={win.isPending}
          disabled={bad}
          onSubmit={() =>
            win.mutate(
              { id: opp.id, body: { wonValue: value.trim(), ...(beyondOwn && date !== today ? { wonAt: date } : {}), version: opp.version } },
              { onSuccess: () => (toast.success("Deal won"), onClose()) },
            )
          }
        />
      }
    >
      <Field label="Won value (ETB)" hint={`Expected ${formatMoney(opp.expectedValue)}`} error={bad ? "Enter an amount like 250000.50" : errs.wonValue}>
        <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
      {beyondOwn && (
        <Field label="Won on" hint="Today, or an earlier date this month" error={errs.wonAt}>
          <Input type="date" min={monthStart} max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

export function LostDialog({ opp, onClose }: { opp: SalesOpportunity; onClose: () => void }) {
  const reasons = (useLostReasons().data ?? []).filter((r) => (r as { isActive?: boolean }).isActive !== false);
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");
  const lose = useLoseOpportunity();
  const errs = fieldErr(lose.error);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Mark as lost"
      description={opp.title}
      footer={
        <Footer
          onCancel={onClose}
          label="Mark lost"
          busy={lose.isPending}
          disabled={!reasonId}
          onSubmit={() =>
            lose.mutate({ id: opp.id, body: { lostReasonId: reasonId, lostNote: note.trim(), version: opp.version } }, { onSuccess: () => (toast.success("Deal marked lost"), onClose()) })
          }
        />
      }
    >
      <div className="flex flex-col gap-1">
        <Select label="Reason" value={reasonId || null} onChange={setReasonId} options={reasons.map((r) => ({ value: r.id, label: r.name }))} placeholder="Why was it lost?" />
        {errs.lostReasonId && <span className="text-meta text-danger">{errs.lostReasonId}</span>}
      </div>
      <Field label="Note" error={errs.lostNote}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>
    </Modal>
  );
}

export function ReopenDialog({ opp, onClose }: { opp: SalesOpportunity; onClose: () => void }) {
  const stages = (useStages().data ?? []).filter((s) => s.category === "open");
  const [stageId, setStageId] = useState("");
  const reopen = useReopenOpportunity();
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Reopen deal"
      description="Clears the won or lost details and puts the deal back on the board."
      footer={
        <Footer
          onCancel={onClose}
          label="Reopen"
          busy={reopen.isPending}
          onSubmit={() =>
            reopen.mutate({ id: opp.id, body: { ...(stageId ? { stageId } : {}), version: opp.version } }, { onSuccess: () => (toast.success("Deal reopened"), onClose()) })
          }
        />
      }
    >
      <Select label="Stage" value={stageId} onChange={setStageId} options={[{ value: "", label: "First stage" }, ...stages.map((s) => ({ value: s.id, label: s.name }))]} />
    </Modal>
  );
}
