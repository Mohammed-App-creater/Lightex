"use client";

import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { ProgressBar } from "@/ui/feedback";
import { StatusGlyph } from "@/ui/glyphs";
import { InlineEditText } from "@/ui/inline-edit";
import type { ChecklistItem, TaskDetail } from "@/api/types";
import { cn } from "@/lib/utils/cn";
import { keyBetween, keyForIndex } from "@/lib/utils/fractional-index";
import { useChecklistMutations } from "./mutations";

/*
 * Task checklist (docs/tracking/checklist-assignees.md §2): up to 100 items of 1–500 characters, ordered by a
 * fractional `position` (the board's scheme). Writes need the task edit rule; anyone else reads the list.
 */

export const CHECKLIST_LIMIT = 100;
export const CHECKLIST_TEXT_MAX = 500;
const LIMIT_REASON = `A checklist can have up to ${CHECKLIST_LIMIT} items.`;

/** Position for moving `id` to `to` within the sorted list (the dragged item excluded, as keyForIndex wants). */
export function reorderPosition(items: readonly Pick<ChecklistItem, "id" | "position">[], id: string, to: number): string {
  const from = items.findIndex((i) => i.id === id);
  const moved = arrayMove([...items], from, to);
  const rest = moved.filter((i) => i.id !== id).map((i) => i.position);
  return keyForIndex(rest, to);
}

export function TaskChecklist({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const items = task.checklist ?? [];
  const { add, update, remove } = useChecklistMutations(task);
  const [hideChecked, setHideChecked] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const total = items.length;
  const done = items.filter((i) => i.done).length;
  if (!total && !canEdit) return null;
  const shown = hideChecked ? items.filter((i) => !i.done) : items;
  const full = total >= CHECKLIST_LIMIT;

  const submit = () => {
    const text = draft.trim().slice(0, CHECKLIST_TEXT_MAX);
    if (!text) return false;
    if (full) return false;
    add.mutate({ tempId: `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, position: keyBetween(items.at(-1)?.position ?? null, null) });
    setDraft("");
    return true;
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const id = String(e.active.id);
    const to = items.findIndex((i) => i.id === e.over!.id);
    const item = items.find((i) => i.id === id);
    if (!item || to < 0) return;
    update.mutate({ item, patch: { position: reorderPosition(items, id, to) } });
  };

  return (
    <section aria-label="Checklist">
      <div className="mb-2 flex items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold">Checklist</h3>
        {total > 0 && (
          <>
            <span className="font-mono text-[11px] font-medium tabular-nums text-fg-3">
              {done}/{total}
            </span>
            <ProgressBar value={(done / total) * 100} label="Checklist progress" color="var(--ok)" className="max-w-[140px] flex-1" />
          </>
        )}
        {done > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto" aria-pressed={hideChecked} onClick={() => setHideChecked((h) => !h)}>
            {hideChecked ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
            {hideChecked ? `Show checked (${done})` : "Hide checked"}
          </Button>
        )}
      </div>

      {shown.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={shown.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ul className="m-0 flex list-none flex-col p-0" aria-label="Checklist items">
              {shown.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  canEdit={canEdit}
                  // Hidden checked items would make drop positions ambiguous, so reordering waits until they show.
                  canReorder={canEdit && !hideChecked && total > 1}
                  onToggle={() => update.mutate({ item, patch: { done: !item.done } })}
                  onRename={(text) => update.mutate({ item, patch: { text } })}
                  onRemove={() => remove.mutate(item)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {hideChecked && shown.length === 0 && <p className="m-0 py-1.5 text-[12.5px] text-fg-3">Everything is checked.</p>}

      {canEdit &&
        (adding && !full ? (
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            maxLength={CHECKLIST_TEXT_MAX}
            placeholder="Add an item"
            aria-label="New checklist item"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              submit();
              setAdding(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // Stays open for rapid entry; an empty Enter closes it.
                if (!submit()) setAdding(false);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDraft("");
                setAdding(false);
              }
            }}
            className="mt-1 h-8 w-full rounded-sm border border-accent bg-surface px-2.5 text-[13px] shadow-[0_0_0_3px_var(--accent-s)] outline-none max-[760px]:h-10"
          />
        ) : (
          <Button variant="ghost" size="sm" className="-ml-2.5 mt-1" disabledReason={full ? LIMIT_REASON : undefined} onClick={() => setAdding(true)}>
            <Plus size={13} aria-hidden /> Add an item
          </Button>
        ))}
    </section>
  );
}

function ChecklistRow({
  item,
  canEdit,
  canReorder,
  onToggle,
  onRename,
  onRemove,
}: {
  item: ChecklistItem;
  canEdit: boolean;
  canReorder: boolean;
  onToggle: () => void;
  onRename: (text: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !canReorder });
  const pending = item.id.startsWith("tmp_");
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group/item -mx-2 flex min-h-[34px] items-center gap-2 rounded-sm px-2 hover:bg-hover max-[760px]:min-h-11",
        isDragging && "relative z-[1] bg-raised shadow-pop",
        pending && "opacity-70",
      )}
    >
      {canReorder && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Reorder “${item.text}”`}
          className="-ml-1 flex size-5 flex-none cursor-grab touch-none items-center justify-center rounded-xs text-fg-3 opacity-0 hover:text-fg focus-visible:opacity-100 group-hover/item:opacity-100 active:cursor-grabbing max-[1023px]:opacity-100"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={13} aria-hidden />
        </button>
      )}
      {canEdit ? (
        <Checkbox checked={item.done} disabled={pending} aria-label={item.done ? `Uncheck “${item.text}”` : `Check “${item.text}”`} onChange={onToggle} />
      ) : (
        <StatusGlyph kind={item.done ? "done" : "todo"} label={item.done ? "Done" : "Open"} />
      )}
      <span className={cn("min-w-0 flex-1 text-[13px]", item.done && "text-fg-3 line-through")}>
        {canEdit && !pending ? (
          <InlineEditText value={item.text} canEdit label="Checklist item" as="span" maxLength={CHECKLIST_TEXT_MAX} onSave={onRename} className="ml-0 py-0.5 text-[13px] leading-5" />
        ) : (
          <span className="block break-words py-0.5 leading-5">{item.text}</span>
        )}
      </span>
      {canEdit && !pending && (
        <button
          type="button"
          aria-label={`Delete “${item.text}”`}
          onClick={onRemove}
          className="flex size-6 flex-none items-center justify-center rounded-xs text-fg-3 opacity-0 hover:bg-hover hover:text-danger focus-visible:opacity-100 group-hover/item:opacity-100 max-[1023px]:size-9 max-[1023px]:opacity-100"
        >
          <Trash2 size={13} aria-hidden />
        </button>
      )}
    </li>
  );
}
