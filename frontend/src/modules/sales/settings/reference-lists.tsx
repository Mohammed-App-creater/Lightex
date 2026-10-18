"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ApiError } from "@/api/errors";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { Switch } from "@/ui/choice";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Field, Input } from "@/ui/input";
import { ConfirmDialog, Modal } from "@/ui/modal";
import { toast } from "@/ui/toast";
import {
  isValidation,
  useCreateLostReason,
  useCreateProduct,
  useDeleteLostReason,
  useDeleteProduct,
  useLostReasons,
  useProducts,
  useUpdateLostReason,
  useUpdateProduct,
} from "../api";

type Row = { id: string; name: string; isActive: boolean; code?: string; category?: string };
type Body = { name: string; code?: string; category?: string; isActive?: boolean };
type FieldKey = "name" | "code" | "category";

type Mut<V> = { mutate: (v: V, o?: { onSuccess?: () => void }) => void; isPending: boolean; error: unknown };

interface ListProps {
  title: string;
  noun: string;
  fields: { key: FieldKey; label: string }[];
  canManage: boolean;
  query: { isPending: boolean; isError: boolean; isFetching: boolean; data?: Row[]; refetch: () => unknown };
  create: Mut<Body>;
  update: Mut<{ id: string; body: Body }>;
  remove: Mut<string>;
}

/** Products and lost reasons share one CRUD list (api.md §5.3–5.4); 409 `*_in_use` / `name_taken` are toasted. */
function RefList({ title, noun, fields, canManage, query, create, update, remove }: ListProps) {
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  if (query.isPending) return <SkeletonRows rows={4} label={`Loading ${title.toLowerCase()}`} />;
  if (query.isError) return <ErrorState title={`Couldn’t load ${title.toLowerCase()}`} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const rows = query.data ?? [];
  return (
    <Panel
      title={title}
      actions={
        canManage && (
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus size={14} aria-hidden /> Add {noun}
          </Button>
        )
      }
    >
      {rows.length === 0 ? (
        <EmptyState title={`No ${title.toLowerCase()} yet`} />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {rows.map((r) => (
            <li key={r.id} className="flex min-h-11 flex-wrap items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">{r.name}</span>
                {fields.length > 1 && (
                  <span className="block truncate text-meta text-fg-3">{fields.slice(1).map((f) => r[f.key] || "—").join(" · ")}</span>
                )}
              </span>
              <Switch
                aria-label={`${r.name} active`}
                checked={r.isActive}
                disabled={!canManage}
                onChange={(e) => update.mutate({ id: r.id, body: { name: r.name, isActive: e.target.checked } })}
              />
              {canManage && (
                <span className="flex gap-0.5">
                  <Button icon size="sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <Pencil size={14} />
                  </Button>
                  <Button icon size="sm" variant="danger-ghost" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EditDialog
          noun={noun}
          fields={fields}
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          create={create}
          update={update}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? noun}?`}
        description={`A ${noun} in use can’t be deleted; turn it off instead.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => {
          const r = deleting!;
          remove.mutate(r.id, { onSuccess: () => toast.success(`Deleted ${r.name}`) });
        }}
      />
    </Panel>
  );
}

function EditDialog({
  noun,
  fields,
  row,
  onClose,
  create,
  update,
}: {
  noun: string;
  fields: ListProps["fields"];
  row: Row | null;
  onClose: () => void;
  create: ListProps["create"];
  update: ListProps["update"];
}) {
  const [v, setV] = useState<Record<FieldKey, string>>({ name: row?.name ?? "", code: row?.code ?? "", category: row?.category ?? "" });
  const [local, setLocal] = useState<string | null>(null);
  const mut = row ? update : create;
  const server = mut.error && isValidation(mut.error) ? (mut.error as ApiError).fieldErrors : {};
  const save = () => {
    if (!v.name.trim()) return setLocal("Enter a name");
    setLocal(null);
    const body = { name: v.name.trim(), ...Object.fromEntries(fields.slice(1).map((f) => [f.key, v[f.key].trim()])) } as Body;
    const done = () => {
      toast.success(row ? "Saved" : `Added ${body.name}`);
      onClose();
    };
    if (row) update.mutate({ id: row.id, body }, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${noun}` : `Add ${noun}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={mut.isPending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {fields.map((f) => (
          <Field key={f.key} label={f.label} error={(f.key === "name" ? local : null) ?? server[f.key]}>
            <Input value={v[f.key]} autoFocus={f.key === "name"} onChange={(e) => setV((x) => ({ ...x, [f.key]: e.target.value }))} />
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function ProductsSettings({ canManage }: { canManage: boolean }) {
  return (
    <RefList
      title="Products"
      noun="product"
      fields={[
        { key: "name", label: "Name" },
        { key: "code", label: "Code" },
        { key: "category", label: "Category" },
      ]}
      canManage={canManage}
      query={useProducts()}
      create={useCreateProduct()}
      update={useUpdateProduct()}
      remove={useDeleteProduct()}
    />
  );
}

export function LostReasonsSettings({ canManage }: { canManage: boolean }) {
  return (
    <RefList
      title="Lost reasons"
      noun="lost reason"
      fields={[{ key: "name", label: "Name" }]}
      canManage={canManage}
      query={useLostReasons()}
      create={useCreateLostReason()}
      update={useUpdateLostReason()}
      remove={useDeleteLostReason()}
    />
  );
}
