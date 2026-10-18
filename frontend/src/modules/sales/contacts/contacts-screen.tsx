"use client";

import { Mail, Phone, Plus, Search, Star, Users } from "lucide-react";
import { useState } from "react";
import { isNotFound } from "@/api/errors";
import type { SalesContact } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/feedback";
import { Input } from "@/ui/input";
import { ConfirmDialog, Modal } from "@/ui/modal";
import { FilterPills } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { useDebounced } from "../activities/form-dialog";
import { useUrlState } from "../activities/url-state";
import { pageItems, useContact, useContacts, useDeleteContact } from "../api";
import { EntityLink } from "../shared/entity-link";
import { QuickActionsMenu, useQuickActions } from "../shared/quick-actions";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { ContactDialog } from "./contact-dialog";

type Primary = "all" | "true" | "false";

/** Contacts list (`/[ws]/sales/contacts`); `?contact=<id>` opens one, `?new=1` the create dialog. */
export function ContactsScreen() {
  return (
    <SalesGate permission="sales.contact.view" name="Contacts">
      <Contacts />
    </SalesGate>
  );
}

function Contacts() {
  const url = useUrlState();
  const canCreate = useCan("sales.contact.create");
  const { beyondOwn } = useSalesScope("sales.contact.view");
  const [q, setQ] = useState(url.get("q"));
  const dq = useDebounced(q.trim());
  const primary = (url.get("primary") || "all") as Primary;
  const owner = url.get("owner");
  const company = url.get("company");
  const openId = url.get("contact");
  const editing = url.get("edit") === "1";

  const list = useContacts({
    q: dq || undefined,
    filter: { primary: primary === "all" ? undefined : primary, owner: owner || undefined, company: company || undefined },
  });
  const rows = pageItems(list.data);
  const filtered = Boolean(dq || primary !== "all" || owner || company);

  return (
    <SalesPageFrame
      title="Contacts"
      actions={
        <>
          <QuickActionsMenu className="max-[1023px]:hidden" />
          {canCreate && (
            <Button variant="primary" size="sm" onClick={() => url.set({ new: "1" })}>
              <Plus size={14} aria-hidden /> New contact
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search contacts"
          placeholder="Search name, phone, email, company…"
          leading={<Search size={14} />}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            url.set({ q: e.target.value.trim() || null });
          }}
          className="w-[300px] max-[760px]:w-full"
        />
        <FilterPills
          label="Primary"
          value={primary}
          onChange={(v) => url.set({ primary: v === "all" ? null : v })}
          items={[
            { value: "all", label: "All" },
            { value: "true", label: "Primary" },
            { value: "false", label: "Others" },
          ]}
        />
        {beyondOwn && <UserPicker value={owner || null} onChange={(id) => url.set({ owner: id })} label="Owner" noneLabel="Any owner" />}
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQ("");
              url.set({ q: null, primary: null, owner: null, company: null });
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {list.isPending ? (
        <SkeletonRows rows={6} label="Loading contacts" />
      ) : list.isError ? (
        <ErrorState title="Couldn’t load contacts" onRetry={() => void list.refetch()} retrying={list.isRefetching} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users size={18} />}
          title={filtered ? "No contacts match" : "No contacts yet"}
          body={filtered ? "Try other filters." : "Add the people you talk to at each company."}
          actions={
            canCreate && !filtered ? (
              <Button variant="primary" onClick={() => url.set({ new: "1" })}>
                <Plus size={14} aria-hidden /> New contact
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col">
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((c) => (
              <ContactRow key={c.id} c={c} onOpen={() => url.set({ contact: c.id })} />
            ))}
          </ul>
          {list.hasNextPage && (
            <Button className="mt-3 self-center" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Load more
            </Button>
          )}
        </div>
      )}

      {url.get("new") === "1" && <ContactDialog onClose={() => url.set({ new: null })} />}
      {openId && <ContactDetail id={openId} editing={editing} onEdit={(on) => url.set({ edit: on ? "1" : null })} onClose={() => url.set({ contact: null, edit: null })} />}
    </SalesPageFrame>
  );
}

function ContactRow({ c, onOpen }: { c: SalesContact; onOpen: () => void }) {
  return (
    <li className="border-b border-line">
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-[13px] hover:bg-hover">
        <Avatar name={c.name} size={28} decorative />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-fg">{c.name}</span>
            {c.isPrimary && <Star size={12} aria-label="Primary contact" className="flex-none fill-current text-warn" />}
          </span>
          <span className="truncate text-meta text-fg-3">{[c.jobTitle, c.company?.name].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="hidden min-w-0 flex-col items-end text-meta text-fg-2 min-[760px]:flex">
          {c.phone && <span className="truncate">{c.phone}</span>}
          {c.email && <span className="truncate text-fg-3">{c.email}</span>}
        </span>
      </button>
    </li>
  );
}

/** One contact (`?contact=<id>`): details plus edit, log activity and delete (by the record's hints). */
export function ContactDetail({ id, editing, onEdit, onClose }: { id: string; editing: boolean; onEdit: (on: boolean) => void; onClose: () => void }) {
  const q = useContact(id);
  const quick = useQuickActions();
  const canLog = useCan("sales.activity.create");
  const del = useDeleteContact();
  const [confirm, setConfirm] = useState(false);
  const c = q.data;
  if (c && editing && c.canEdit) return <ContactDialog contact={c} onClose={() => onEdit(false)} />;
  return (
    <>
      <Modal open={!confirm} onOpenChange={(o) => !o && onClose()} title={c?.name ?? (q.isError ? "Contact" : "Loading…")} width={480}>
        {q.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : q.isError || !c ? (
          isNotFound(q.error) ? (
            <EmptyState title="Contact not found" body="It was deleted, or you can’t see it." />
          ) : (
            <ErrorState onRetry={() => void q.refetch()} />
          )
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2 text-fg-2">
              {c.jobTitle && <span>{c.jobTitle}</span>}
              {c.jobTitle && <span className="text-fg-3">at</span>}
              <EntityLink kind="company" id={c.companyId} name={c.company?.name ?? "Company"} />
              {c.isPrimary && (
                <span className="inline-flex items-center gap-1 text-meta text-fg-3">
                  <Star size={12} aria-hidden className="fill-current text-warn" /> Primary
                </span>
              )}
            </div>
            {c.phone && (
              <a href={`tel:${c.phone}`} className="inline-flex items-center gap-2 text-fg hover:underline">
                <Phone size={14} aria-hidden className="text-fg-3" /> {c.phone}
              </a>
            )}
            {c.email && (
              <a href={`mailto:${c.email}`} className="inline-flex items-center gap-2 text-fg hover:underline">
                <Mail size={14} aria-hidden className="text-fg-3" /> {c.email}
              </a>
            )}
            {c.notes && <p className="m-0 whitespace-pre-wrap text-fg-2">{c.notes}</p>}
            <p className="m-0 text-meta text-fg-3">Owner: {c.owner?.name ?? "—"}</p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {c.canDelete && (
                <Button variant="danger-ghost" size="sm" onClick={() => setConfirm(true)}>
                  Delete
                </Button>
              )}
              {canLog && (
                <Button size="sm" onClick={() => quick.open("log-call", { targetType: "sales.contact", targetId: c.id, name: c.name })}>
                  <Phone size={14} aria-hidden /> Log call
                </Button>
              )}
              {c.canEdit && (
                <Button size="sm" variant="primary" onClick={() => onEdit(true)}>
                  Edit
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${c?.name ?? "contact"}?`}
        description="It goes to the trash; an admin can restore it."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() =>
          del
            .mutateAsync(id)
            .then(() => {
              toast.success("Contact deleted");
              onClose();
            })
            .catch(() => undefined)
        }
      />
    </>
  );
}
