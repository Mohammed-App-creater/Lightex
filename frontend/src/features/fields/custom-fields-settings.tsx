"use client";

import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { CF_TYPE_ICON } from "@/features/filters/filter-bar";
import { PanelHeader } from "@/features/settings/project-parts";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { CustomField, CustomFieldInput, Project } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { CustomFieldDialog } from "./custom-field-dialog";
import { DeleteFieldDialog, pendingFieldIds, usePendingFieldDelete } from "./delete-field-dialog";
import { FIELD_TYPES, TYPE_LABEL, tasksText } from "./field-lib";
import { useCustomFields } from "./queries";

const GRID = "grid grid-cols-[28px_minmax(0,1fr)_110px_120px_36px] items-center gap-2.5 px-2.5 max-[760px]:grid-cols-[24px_minmax(0,1fr)_64px_36px]";
const GRID_RO = "grid grid-cols-[minmax(0,1fr)_110px_120px] items-center gap-2.5 px-3.5 max-[760px]:grid-cols-[minmax(0,1fr)_64px]";

/**
 * Project settings → Custom fields (board 39 .cf-list): list with drag / Alt+↑↓ reorder, create
 * and edit dialog, delete confirm with a 5 s Undo. Read-only without field.manage (the parent
 * renders the ReadOnlyNote): no handle, no delete, no New field, rows not clickable.
 */
export function CustomFieldsPanel({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const fieldsQ = useCustomFields(project.id);
  const key = qk.customFields(project.id);
  const list = fieldsQ.data ?? [];
  const [live, setLive] = useState("");
  const [dialog, setDialog] = useState<{ field: CustomField | null } | null>(null);
  const [removing, setRemoving] = useState<CustomField | null>(null);
  const [drag, setDrag] = useState<{ id: string; dy: number; order: string[] } | null>(null);
  const dragStart = useRef<{ y: number; from: number; step: number } | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const removeField = usePendingFieldDelete(project.id, setLive);

  const order = drag?.order ?? list.map((f) => f.id);
  const rows = order.map((id) => list.find((f) => f.id === id)).filter((f): f is CustomField => Boolean(f));

  const reorder = async (ids: string[], moved: CustomField) => {
    const prev = qc.getQueryData<CustomField[]>(key);
    qc.setQueryData<CustomField[]>(key, (l) => l && ids.map((id, i) => ({ ...l.find((f) => f.id === id)!, position: i })));
    setLive(`${moved.name} moved to position ${ids.indexOf(moved.id) + 1} of ${ids.length}`);
    try {
      // Fields whose delete is still pending (Undo window) are still on the server: keep them last.
      await api.customFields.reorder(project.id, [...ids, ...pendingFieldIds(project.id)]);
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      toast.error("Couldn’t reorder fields", { body: `${errorMessage(e)} Reverted.` });
    } finally {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: qk.scope(project.id), predicate: (q) => q.queryKey[2] !== "custom-fields" });
    }
  };

  const move = (f: CustomField, dir: -1 | 1) => {
    const ids = list.map((x) => x.id);
    const from = ids.indexOf(f.id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    void reorder(ids, f);
    requestAnimationFrame(() => handles.current.get(f.id)?.focus());
  };
  const onHandleKey = (f: CustomField) => (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();
    move(f, e.key === "ArrowUp" ? -1 : 1);
  };
  const onDown = (f: CustomField) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const row = e.currentTarget.closest<HTMLElement>("[data-cf-row]");
    dragStart.current = { y: e.clientY, from: order.indexOf(f.id), step: row?.offsetHeight ?? 48 };
    setDrag({ id: f.id, dy: 0, order: list.map((x) => x.id) });
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const s = dragStart.current;
    if (!s || !drag) return;
    const raw = e.clientY - s.y;
    const to = Math.max(0, Math.min(list.length - 1, s.from + Math.round(raw / s.step)));
    const next = list.map((x) => x.id).filter((id) => id !== drag.id);
    next.splice(to, 0, drag.id);
    setDrag({ id: drag.id, dy: raw - (to - s.from) * s.step, order: next });
  };
  const onUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const moved = drag.order.join() !== list.map((x) => x.id).join();
    const f = list.find((x) => x.id === drag.id);
    dragStart.current = null;
    setDrag(null);
    if (moved && f) void reorder(drag.order, f);
  };

  const submit = async (body: CustomFieldInput) => {
    const editing = dialog?.field;
    const saved = editing ? await api.customFields.update(editing.id, { name: body.name, required: body.required, options: body.options }) : await api.customFields.create(project.id, body);
    qc.setQueryData<CustomField[]>(key, (l) => (l ? (editing ? l.map((f) => (f.id === saved.id ? saved : f)) : [...l, saved]) : l));
    void qc.invalidateQueries({ queryKey: key });
    // Values may have been cleared (removed options); task payloads change.
    void qc.invalidateQueries({ queryKey: qk.scope(project.id), predicate: (q) => q.queryKey[2] !== "custom-fields" });
    void qc.invalidateQueries({ queryKey: ["task"] });
    setLive(editing ? `${saved.name} saved` : `${saved.name} created`);
    toast.success(editing ? `Saved “${saved.name}”` : `Created “${saved.name}”`);
    setDialog(null);
  };

  const newButton = canEdit && (
    <Button variant="primary" size="sm" onClick={() => setDialog({ field: null })}>
      <Plus size={12} aria-hidden /> New field
    </Button>
  );

  return (
    <div className="flex flex-col">
      <span className="sr-only" role="status" aria-live="polite">
        {live}
      </span>
      <PanelHeader title="Custom fields" count={fieldsQ.data ? list.length : undefined}>
        {list.length > 0 && newButton}
      </PanelHeader>

      {fieldsQ.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading custom fields" className="rounded-[10px] border border-line bg-surface">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={cn(GRID, "h-12 border-b border-line last:border-b-0")}>
              <Skeleton className="mx-auto h-3.5 w-2.5" />
              <span className="flex items-center gap-2.5">
                <Skeleton className="size-3.5 rounded-sm" />
                <Skeleton className="h-2.5" style={{ width: 80 + ((i * 31) % 70) }} />
              </span>
              <Skeleton className="h-2.5 w-14 max-[760px]:hidden" />
              <Skeleton className="h-2.5 w-12" />
              <span />
            </div>
          ))}
        </div>
      ) : fieldsQ.isError ? (
        <ErrorState
          title="Couldn’t load fields"
          body={<span className="font-mono text-[12px]">{`${isApiError(fieldsQ.error) ? fieldsQ.error.status : "network"} · request ${(isApiError(fieldsQ.error) && fieldsQ.error.ref) || "—"}`}</span>}
          onRetry={() => void fieldsQ.refetch()}
          retrying={fieldsQ.isRefetching}
        />
      ) : list.length === 0 ? (
        <div className="flex min-h-[260px] flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-line-2 p-6 text-center">
          <span className="flex gap-2 text-fg-3" aria-hidden>
            {FIELD_TYPES.map((t) => (
              <span key={t} className="inline-flex size-[30px] items-center justify-center rounded-md border border-line bg-surface [&_svg]:size-3.5">
                {CF_TYPE_ICON[t]}
              </span>
            ))}
          </span>
          <h3 className="m-0 mt-1 text-[14px] font-semibold">No custom fields yet</h3>
          <span className="text-[12.5px] text-fg-3">Text, number, select, date, person</span>
          {canEdit && (
            <Button variant="primary" size="sm" className="mt-1" onClick={() => setDialog({ field: null })}>
              <Plus size={12} aria-hidden /> Create a field
            </Button>
          )}
        </div>
      ) : (
        <>
          <div role="table" aria-label="Custom fields" className="relative rounded-[10px] border border-line bg-surface">
            <div role="row" className={cn(canEdit ? GRID : GRID_RO, "h-[34px] border-b border-line font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-fg-3 max-[760px]:hidden")}>
              {canEdit && (
                <span role="columnheader">
                  <span className="sr-only">Reorder</span>
                </span>
              )}
              <span role="columnheader">Field</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Used in</span>
              {canEdit && (
                <span role="columnheader">
                  <span className="sr-only">Actions</span>
                </span>
              )}
            </div>
            {rows.map((f, i) => {
              const dragging = drag?.id === f.id;
              const name = (
                <span className="flex min-w-0 items-center gap-2.5 font-medium [&_svg]:size-3.5 [&_svg]:flex-none [&_svg]:text-fg-3">
                  {CF_TYPE_ICON[f.type]}
                  <span className="truncate">{f.name}</span>
                  {f.required && <span className="inline-flex h-5 flex-none items-center rounded-[5px] border border-line-2 px-1.5 font-mono text-[10.5px] font-medium text-fg-3">Required</span>}
                </span>
              );
              return (
                <div
                  key={f.id}
                  role="row"
                  data-cf-row
                  onClick={canEdit ? (e) => !(e.target as HTMLElement).closest("button") && setDialog({ field: f }) : undefined}
                  className={cn(
                    canEdit ? GRID : GRID_RO,
                    "relative h-12 bg-surface transition-[background-color,box-shadow] duration-150 [&+&]:shadow-[inset_0_1px_0_var(--line)] max-[760px]:h-14",
                    canEdit && "cursor-pointer hover:bg-hover",
                    dragging && "z-[3] rounded-md bg-raised shadow-pop transition-none [&+&]:shadow-pop",
                  )}
                  style={dragging ? { transform: `translateY(${Math.round(drag.dy)}px)` } : undefined}
                >
                  {canEdit && (
                    <span role="cell">
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) handles.current.set(f.id, el);
                          else handles.current.delete(f.id);
                        }}
                        aria-label={`Reorder ${f.name}, ${i + 1} of ${rows.length}`}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        title="Drag · Alt+↑↓"
                        onPointerDown={onDown(f)}
                        onPointerMove={onMove}
                        onPointerUp={onUp}
                        onPointerCancel={onUp}
                        onKeyDown={onHandleKey(f)}
                        className={cn("flex h-7 w-6 touch-none cursor-grab items-center justify-center rounded-[5px] text-fg-3 hover:bg-raised hover:text-fg max-[760px]:h-11", dragging && "cursor-grabbing text-fg")}
                      >
                        <GripVertical size={14} aria-hidden />
                      </button>
                    </span>
                  )}
                  <span role="cell" className="min-w-0">
                    {canEdit ? (
                      <button type="button" aria-label={`Edit ${f.name}`} onClick={() => setDialog({ field: f })} className="flex w-full min-w-0 text-left">
                        {name}
                      </button>
                    ) : (
                      name
                    )}
                  </span>
                  <span role="cell" className="text-[12px] text-fg-2 max-[760px]:hidden">
                    {TYPE_LABEL[f.type]}
                  </span>
                  <span role="cell" className="font-mono text-[11.5px] font-medium tabular-nums text-fg-3">
                    {tasksText(f.taskCount)}
                  </span>
                  {canEdit && (
                    <span role="cell" className="flex justify-center">
                      <Button variant="ghost" icon size="sm" aria-label={`Delete ${f.name}`} tooltip="Delete" className="hover:text-danger max-[760px]:size-10" onClick={() => setRemoving(f)}>
                        <Trash2 size={14} aria-hidden />
                      </Button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {canEdit && list.length > 1 && (
            <p className="m-0 mt-2.5 flex items-center gap-2 text-[12px] text-fg-3">
              <GripVertical size={12} aria-hidden /> Alt ↑ ↓ or drag the handle
            </p>
          )}
        </>
      )}

      <CustomFieldDialog open={Boolean(dialog)} onOpenChange={(o) => !o && setDialog(null)} field={dialog?.field ?? null} fields={list} onSubmit={submit} />
      <DeleteFieldDialog field={removing} onOpenChange={(o) => !o && setRemoving(null)} onConfirm={removeField} />
    </div>
  );
}
