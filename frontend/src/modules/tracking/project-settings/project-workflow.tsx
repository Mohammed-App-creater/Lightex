"use client";

import {
  closestCenter,
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, Lock, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { glyphColor, StatusGlyph } from "@/components/ui/glyphs";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useStatuses } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project, Status, StatusCategory } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ColorPicker, FactChips } from "./project-parts";
import { defaultMoveTarget, groupStatuses, nameTaken, reorderInCategory, STATUS_GROUPS, STATUS_NAME_MAX, tasksLabel } from "./project-lib";

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

type Editing = { kind: "rename"; id: string; value: string } | { kind: "new"; id: "new"; category: StatusCategory; value: string } | null;

/** Workflow tab (board 28): statuses grouped by category; drag ⠿ or Alt+↑↓ to reorder. */
export function WorkflowPanel({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const statuses = useStatuses(project.id);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Status | null>(null);
  const [live, setLive] = useState("");
  const hintId = `wf-hint-${project.id}`;

  const key = qk.statuses(project.id);
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["p", project.id, "board"] })]);

  /** Optimistic status write with rollback. */
  const write = async (optimistic: Status[] | null, call: () => Promise<unknown>, failMsg: string) => {
    const prev = qc.getQueryData<Status[]>(key);
    if (optimistic) qc.setQueryData(key, optimistic);
    try {
      await call();
      return true;
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      toast.error(failMsg, { body: errorMessage(e) });
      return false;
    } finally {
      void refresh();
    }
  };

  const list = statuses.data ?? [];
  const groups = groupStatuses(list);

  const move = (s: Status, to: number) => {
    const r = reorderInCategory(list, s.id, to);
    if (!r) return;
    const n = groups[s.category].length;
    setLive(`${s.name} moved to ${Math.min(n, Math.max(1, to + 1))} of ${n}`);
    void write(r.list, () => api.projects.updateStatus(project.id, s.id, { position: r.position }), "Couldn’t reorder");
  };

  const commitEdit = async () => {
    const ed = editing;
    if (!ed) return;
    const name = ed.value.trim();
    setEditing(null);
    if (ed.kind === "new") {
      if (!name || nameTaken(name, list)) return;
      const ok = await write(null, () => api.projects.createStatus(project.id, { name, category: ed.category }), "Couldn’t add status");
      if (ok) setLive(`Added ${name}`);
      return;
    }
    const s = list.find((x) => x.id === ed.id);
    if (!s || !name || name === s.name || nameTaken(name, list, s.id)) return;
    const ok = await write(
      list.map((x) => (x.id === s.id ? { ...x, name } : x)),
      () => api.projects.updateStatus(project.id, s.id, { name }),
      "Couldn’t rename status",
    );
    if (ok) setLive(`Renamed ${name}`);
  };

  const recolor = (s: Status, color: string) =>
    void write(
      list.map((x) => (x.id === s.id ? { ...x, color } : x)),
      () => api.projects.updateStatus(project.id, s.id, { color }),
      "Couldn’t change color",
    );

  if (statuses.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading statuses" className="flex flex-col gap-3.5">
        {[2, 2, 2].map((n, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface">
            <div className="flex h-11 items-center gap-2.5 border-b border-line px-3.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="h-2.5 w-20" />
            </div>
            <div className="flex flex-col gap-1 p-2">
              {Array.from({ length: n }, (_, j) => (
                <Skeleton key={j} className="h-8 w-full rounded-md" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (statuses.isError) {
    return <ErrorState title="Couldn’t load statuses" body={errorMessage(statuses.error)} onRetry={() => void statuses.refetch()} />;
  }

  return (
    <div className="flex flex-col">
      {STATUS_GROUPS.map((g) => {
        const rows = groups[g.category];
        const adding = editing?.kind === "new" && editing.category === g.category;
        return (
          <section key={g.category} aria-labelledby={`wf-${g.category}`} className="mb-3.5 rounded-lg border border-line bg-surface">
            <div className="flex h-11 items-center gap-2.5 border-b border-line pl-3.5 pr-2">
              <StatusGlyph kind={g.glyph} color="var(--text-3)" />
              <h3 id={`wf-${g.category}`} className="m-0 text-[13px] font-semibold">
                {g.label}
              </h3>
              <span className="font-mono text-[11px] font-medium text-fg-3">{rows.length}</span>
              <span className="flex-1" />
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Add status to ${g.label}`}
                  className="max-[760px]:h-10"
                  onClick={() => setEditing({ kind: "new", id: "new", category: g.category, value: "" })}
                >
                  <Plus size={12} aria-hidden /> Add
                </Button>
              )}
            </div>
            <StatusList
              rows={rows}
              canEdit={canEdit}
              hintId={hintId}
              onMove={move}
              renderRow={(s, _i, handle) => (
                <StatusRow
                  status={s}
                  canEdit={canEdit}
                  handle={handle}
                  editing={editing && editing.id === s.id ? editing.value : null}
                  editError={editing && editing.id === s.id && nameTaken(editing.value, list, s.id) ? "Already exists" : null}
                  onStartEdit={() => setEditing({ kind: "rename", id: s.id, value: s.name })}
                  onEdit={(value) => setEditing({ kind: "rename", id: s.id, value })}
                  onCommit={() => void commitEdit()}
                  onCancel={() => setEditing(null)}
                  onColor={(c) => recolor(s, c)}
                  onDelete={() => setRemoving(s)}
                  canDelete={rows.length > 1}
                />
              )}
            />
            {adding && editing?.kind === "new" && (
              <div className="px-1 pb-1">
                <div className="flex h-10 items-center gap-2 rounded-md px-3 max-[760px]:h-12">
                  <StatusGlyph kind={g.glyph} />
                  <NameInput
                    value={editing.value}
                    label="New status name"
                    placeholder="Status name"
                    error={nameTaken(editing.value, list) ? "Already exists" : null}
                    onChange={(value) => setEditing({ kind: "new", id: "new", category: g.category, value })}
                    onCommit={() => void commitEdit()}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              </div>
            )}
          </section>
        );
      })}
      <span id={hintId} className="sr-only">
        Drag, or Alt plus Arrow keys to reorder
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {live}
      </span>
      {removing && (
        <DeleteStatusDialog
          project={project}
          status={removing}
          statuses={list}
          onClose={() => setRemoving(null)}
          onDone={(msg) => {
            setRemoving(null);
            toast.success(msg);
            void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
          }}
        />
      )}
    </div>
  );
}

/** Alt+↑/↓ on a drag handle moves the status one slot inside its group. */
function handleKey(e: KeyboardEvent, s: Status, index: number, total: number, onMove: (s: Status, to: number) => void) {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  const to = index + (e.key === "ArrowUp" ? -1 : 1);
  if (to < 0 || to >= total) return;
  onMove(s, to);
  // Keep focus on the handle after the row re-renders in its new place.
  requestAnimationFrame(() => document.getElementById(`wf-h-${s.id}`)?.focus());
}

function StatusList({
  rows,
  canEdit,
  hintId,
  onMove,
  renderRow,
}: {
  rows: Status[];
  canEdit: boolean;
  hintId: string;
  onMove: (s: Status, to: number) => void;
  renderRow: (s: Status, i: number, handle: ReactNode) => ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const s = rows.find((x) => x.id === e.active.id);
    const to = rows.findIndex((x) => x.id === e.over!.id);
    if (s && to >= 0) onMove(s, to);
  };
  if (!canEdit) {
    return (
      <ul role="list" aria-label="Statuses" className="m-0 list-none p-1">
        {rows.map((s, i) => (
          <li key={s.id}>{renderRow(s, i, null)}</li>
        ))}
      </ul>
    );
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onDragEnd} accessibility={{ screenReaderInstructions: { draggable: "" } }}>
      <SortableContext items={rows.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <ul role="list" aria-label="Statuses" aria-describedby={hintId} className="m-0 list-none p-1">
          {rows.map((s, i) => (
            <SortableItem key={s.id} status={s} index={i} total={rows.length} onMove={onMove}>
              {(handle) => renderRow(s, i, handle)}
            </SortableItem>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableItem({
  status: s,
  index,
  total,
  onMove,
  children,
}: {
  status: Status;
  index: number;
  total: number;
  onMove: (s: Status, to: number) => void;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const handle = (
    <button
      id={`wf-h-${s.id}`}
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${s.name}, ${index + 1} of ${total}`}
      aria-roledescription="sortable"
      aria-describedby={`wf-hint-${s.projectId}`}
      onKeyDown={(e) => handleKey(e, s, index, total, onMove)}
      className="inline-flex h-7 w-6 flex-none cursor-grab touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-raised hover:text-fg active:cursor-grabbing max-[760px]:h-11 max-[760px]:w-9"
    >
      <GripVertical size={14} aria-hidden />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative rounded-md", isDragging && "z-10 bg-raised shadow-pop ring-1 ring-line-2")}
    >
      {children(handle)}
    </li>
  );
}

function StatusRow({
  status: s,
  canEdit,
  handle,
  editing,
  editError,
  onStartEdit,
  onEdit,
  onCommit,
  onCancel,
  onColor,
  onDelete,
  canDelete,
}: {
  status: Status;
  canEdit: boolean;
  handle: ReactNode;
  editing: string | null;
  editError: string | null;
  onStartEdit: () => void;
  onEdit: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onColor: (c: string) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const count = s.taskCount ?? 0;
  return (
    <div className={cn("group flex h-10 items-center gap-2 rounded-md pr-1.5 hover:bg-hover max-[760px]:h-12", canEdit ? "pl-0.5" : "pl-3")}>
      {canEdit && handle}
      <StatusGlyph kind={s.glyph} color={s.color ?? undefined} />
      {editing !== null ? (
        <NameInput value={editing} label="Status name" error={editError} onChange={onEdit} onCommit={onCommit} onCancel={onCancel} />
      ) : canEdit ? (
        <button
          type="button"
          aria-label={`Rename ${s.name}`}
          onClick={onStartEdit}
          className="flex h-7 min-w-0 flex-1 cursor-text items-center truncate rounded-sm px-1.5 text-left text-[13px] font-medium hover:bg-raised"
        >
          <span className="truncate">{s.name}</span>
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate px-1.5 text-[13px] font-medium">{s.name}</span>
      )}
      <span className="min-w-16 flex-none text-right font-mono text-[11.5px] font-medium text-fg-3 max-[760px]:min-w-7">
        <span className="max-[760px]:hidden">{tasksLabel(count)}</span>
        <span className="hidden max-[760px]:inline" aria-label={tasksLabel(count)}>
          {count}
        </span>
      </span>
      {canEdit && (
        <>
          <ColorPicker value={s.color ?? null} fallback={glyphColor[s.glyph]} label={`Color for ${s.name}`} onChange={onColor} />
          {canDelete ? (
            <Button variant="ghost" icon size="sm" aria-label={`Delete ${s.name}`} tooltip="Delete" className="hover:text-danger max-[760px]:size-10" onClick={onDelete}>
              <Trash2 size={14} aria-hidden />
            </Button>
          ) : (
            <Button
              variant="ghost"
              icon
              size="sm"
              aria-label={`Can’t delete ${s.name}`}
              disabledReason="Each group needs one status"
              className="aria-disabled:border-transparent aria-disabled:bg-transparent max-[760px]:size-10"
            >
              <Lock size={13} aria-hidden />
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** Inline name editor (board 28 .wf-in): Enter saves, Esc cancels, blur saves when valid. */
export function NameInput({
  value,
  label,
  placeholder,
  error,
  max = STATUS_NAME_MAX,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  placeholder?: string;
  error: string | null;
  max?: number;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <input
        autoFocus
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        maxLength={max}
        onChange={(e) => onChange(e.target.value.slice(0, max))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!error) onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => (error ? onCancel() : onCommit())}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-sm border border-accent bg-bg px-1.5 text-[13px] font-medium text-fg shadow-[0_0_0_3px_var(--accent-s)] outline-none placeholder:text-fg-3 max-[760px]:h-[38px] max-[760px]:text-[15px]",
          error && "border-danger shadow-[0_0_0_3px_var(--danger-s)]",
        )}
      />
      {error && (
        <span role="alert" className="flex-none whitespace-nowrap text-[12px] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

function DeleteStatusDialog({
  project,
  status,
  statuses,
  onClose,
  onDone,
}: {
  project: Project;
  status: Status;
  statuses: Status[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const count = status.taskCount ?? 0;
  const targets = [...statuses].sort((a, b) => a.position - b.position).filter((s) => s.id !== status.id);
  const [to, setTo] = useState(defaultMoveTarget(statuses, status)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const catName = (c: StatusCategory) => STATUS_GROUPS.find((g) => g.category === c)!.label;

  const confirm = async () => {
    setBusy(true);
    try {
      await api.projects.removeStatus(project.id, status.id, count ? to : undefined);
      const target = targets.find((s) => s.id === to);
      onDone(`Deleted ${status.name}${count && target ? ` · ${count} → ${target.name}` : ""}`);
    } catch (e) {
      toast.error("Couldn’t delete status", { body: errorMessage(e) });
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      role="alertdialog"
      width={420}
      title={
        <span className="flex items-center gap-2.5">
          <StatusGlyph kind={status.glyph} color={status.color ?? undefined} />
          Delete {status.name}?
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} autoFocus={!count} onClick={() => void confirm()}>
            {count ? "Delete & move" : "Delete status"}
          </Button>
        </>
      }
    >
      {count ? (
        <>
          <div id="sd-move" className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <b className="font-mono font-semibold text-fg">{tasksLabel(count)}</b> move to
          </div>
          <div role="radiogroup" aria-labelledby="sd-move" className="flex max-h-[232px] flex-col gap-1 overflow-y-auto p-0.5">
            {targets.map((t, i) => {
              const on = t.id === to;
              return (
                <button
                  key={t.id}
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  autoFocus={on}
                  onClick={() => setTo(t.id)}
                  onKeyDown={(e) => {
                    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const n = (i + step + targets.length) % targets.length;
                    setTo(targets[n]!.id);
                    refs.current[n]?.focus();
                  }}
                  className={cn(
                    "flex h-9 flex-none items-center gap-2.5 rounded-md border border-line bg-bg px-2.5 text-left text-[13px] font-medium hover:border-line-2 max-[760px]:h-11",
                    on && "border-accent bg-accent-s hover:border-accent",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("grid size-3.5 flex-none place-content-center rounded-full border-[1.5px] border-control", on && "border-accent-t")}
                  >
                    {on && <span className="size-1.5 rounded-full bg-accent-t" />}
                  </span>
                  <StatusGlyph kind={t.glyph} color={t.color ?? undefined} />
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-fg-3">{catName(t.category)}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <FactChips items={["0 tasks"]} />
      )}
    </Modal>
  );
}
