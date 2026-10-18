"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { isApiError } from "@/api/errors";
import type { SalesQuotation, SalesQuotationStatus } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { useCan } from "@/platform/roles/can";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Field, Input, Textarea } from "@/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { Modal } from "@/ui/modal";
import { toast } from "@/ui/toast";
import { pageItems, useAcceptQuotation, useCreateQuotation, useQuotations, useRejectQuotation, useSendQuotation } from "../api";
import { formatMoney, isMoney } from "../shared/money";
import { formatDay, isoDay } from "../pipeline/url-state";

/* Quotations of one opportunity (docs/sales/api.md §11): list, create, send / accept / reject. */

const TONE: Record<SalesQuotationStatus, string> = {
  draft: "bg-raised text-fg-2",
  sent: "bg-warn-s text-warn",
  accepted: "bg-ok-s text-ok",
  rejected: "bg-danger-s text-danger",
  expired: "bg-raised text-fg-3",
};
const LABEL: Record<SalesQuotationStatus, string> = { draft: "Draft", sent: "Sent", accepted: "Accepted", rejected: "Rejected", expired: "Expired" };

export function QuotationStatus({ status }: { status: SalesQuotationStatus }) {
  return <span className={cn("inline-flex h-[20px] items-center rounded-sm px-1.5 text-[11px] font-medium", TONE[status])}>{LABEL[status]}</span>;
}

export function QuotationsPanel({ opportunityId, defaultAmount }: { opportunityId: string; defaultAmount: string }) {
  const q = useQuotations({ filter: { opportunity: opportunityId }, limit: 50 });
  const canCreate = useCan("sales.quotation.create");
  const [creating, setCreating] = useState(false);
  const items = pageItems(q.data);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[14px] font-semibold">Quotations</h2>
        {canCreate && (
          <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden /> New quotation
          </Button>
        )}
      </div>
      {q.isPending ? (
        <SkeletonRows rows={2} />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState title="No quotations" body="Draft a quotation, then send it to the customer." />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {items.map((x) => (
            <QuotationRow key={x.id} q={x} />
          ))}
        </ul>
      )}
      {creating && <CreateQuotationDialog opportunityId={opportunityId} defaultAmount={defaultAmount} onClose={() => setCreating(false)} />}
    </section>
  );
}

function QuotationRow({ q }: { q: SalesQuotation }) {
  const send = useSendQuotation();
  const accept = useAcceptQuotation();
  const reject = useRejectQuotation();
  const busy = send.isPending || accept.isPending || reject.isPending;
  const actions = q.canEdit && (q.status === "draft" || q.status === "sent");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <span className="font-mono text-[12px] text-fg-2">{q.number}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{q.title}</span>
      <span className="tabular font-mono text-[13px]">{formatMoney(q.amount)}</span>
      <QuotationStatus status={q.status} />
      <span className="w-28 text-[12px] text-fg-3 max-[560px]:w-auto">{q.validUntil ? `Valid to ${formatDay(q.validUntil)}` : ""}</span>
      {actions ? (
        <Menu>
          <MenuTrigger aria-label={`Actions for ${q.number}`} disabled={busy} className="rounded-sm p-1 text-fg-2 hover:bg-hover">
            <MoreHorizontal size={14} aria-hidden />
          </MenuTrigger>
          <MenuContent align="end" width={160}>
            {q.status === "draft" && <MenuItem onSelect={() => send.mutate({ id: q.id, body: {} }, { onSuccess: () => toast.success(`${q.number} sent`) })}>Send</MenuItem>}
            {q.status === "sent" && <MenuItem onSelect={() => accept.mutate(q.id, { onSuccess: () => toast.success(`${q.number} accepted`) })}>Mark accepted</MenuItem>}
            {q.status === "sent" && <MenuItem onSelect={() => reject.mutate(q.id, { onSuccess: () => toast.success(`${q.number} rejected`) })}>Mark rejected</MenuItem>}
          </MenuContent>
        </Menu>
      ) : (
        <span className="w-6" />
      )}
    </li>
  );
}

function CreateQuotationDialog({ opportunityId, defaultAmount, onClose }: { opportunityId: string; defaultAmount: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState(defaultAmount);
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const create = useCreateQuotation();
  const errs = isApiError(create.error) ? create.error.fieldErrors : {};
  const bad = !isMoney(amount);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New quotation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!title.trim() || bad}
            onClick={() =>
              create.mutate(
                { opportunityId, title: title.trim(), amount: amount.trim(), validUntil: validUntil || null, notes },
                { onSuccess: (r) => (toast.success(`${r.number} created`), onClose()) },
              )
            }
          >
            Create draft
          </Button>
        </>
      }
    >
      <Field label="Title" error={errs.title}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Amount (ETB)" error={bad ? "Enter an amount like 250000.50" : errs.amount}>
        <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Valid until" hint="Empty = the workspace default when sent" error={errs.validUntil}>
        <Input type="date" min={isoDay()} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
      </Field>
      <Field label="Notes" error={errs.notes}>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}
