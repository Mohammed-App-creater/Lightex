"use client";

import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, Lock, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ApiError } from "@/api/errors";
import type { SalesStage } from "@/api/types";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { ErrorState, SkeletonRows } from "@/ui/feedback";
import { Field, Input } from "@/ui/input";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/utils/cn";
import { isValidation, sk, useCreateStage, useDeleteStage, useReorderStages, useSlug, useStages, useUpdateStage } from "../api";

const validPct = (v: string) => /^\d+$/.test(v) && Number(v) <= 100;

/**
 * Pipeline stages (api.md §5.2): open stages are renamed, re-weighted and reordered (drag, or the arrow buttons);
 * Won and Lost are locked at the end. Deleting a stage in use answers 409 with the server's message (toasted).
 */
export function StagesSettings({ canManage }: { canManage: boolean }) {
  const q = useStages();
  const slug = useSlug();
  const qc = useQueryClient();
  const reorder = useReorderStages();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [pending, setPending] = useState<string[] | null>(null);

  if (q.isPending) return <SkeletonRows rows={5} label="Loading stages" />;
  if (q.isError) return <ErrorState title="Couldn’t load the stages" onRetry={() => void q.refetch()} retrying={q.isFetching} />;

  const open = q.data.filter((s) => s.category === "open");
  const closed = q.data.filter((s) => s.category !== "open");
  const byId = new Map(open.map((s) => [s.id, s]));
  const order = (pending ?? open.map((s) => s.id)).filter((id) => byId.has(id));
  const shown = order.map((id) => byId.get(id)!);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const ids = arrayMove(order, from, to);
    setPending(ids);
    reorder.mutate(ids, {
      onSuccess: (r) => qc.setQueryData(sk.list(slug, "stages", {}), r),
      onSettled: () => setPending(null),
    });
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    move(order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
  };

  return (
    <Panel title="Pipeline stages" actions={<span className="text-meta text-fg-3">{open.length} open · max 20</span>}>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Stages">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            {shown.map((s, i) => (
              <StageRow key={s.id} stage={s} canManage={canManage} index={i} count={shown.length} onMove={move} />
            ))}
          </SortableContext>
        </DndContext>
        {closed.map((s) => (
          <StageRow key={s.id} stage={s} canManage={canManage} />
        ))}
      </ul>
      {canManage && <AddStage />}
    </Panel>
  );
}

function StageRow({
  stage,
  canManage,
  index,
  count,
  onMove,
}: {
  stage: SalesStage;
  canManage: boolean;
  index?: number;
  count?: number;
  onMove?: (from: number, to: number) => void;
}) {
  const sortable = stage.category === "open";
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: stage.id, disabled: !sortable || !canManage });
  const update = useUpdateStage();
  const del = useDeleteStage();
  const [name, setName] = useState(stage.name);
  const [pct, setPct] = useState(String(stage.defaultProbability));
  const locked = stage.category !== "open";

  const saveName = () => {
    const n = name.trim();
    if (!n || n === stage.name) return setName(stage.name);
    update.mutate({ id: stage.id, body: { name: n } }, { onError: () => setName(stage.name) });
  };
  const savePct = () => {
    if (!validPct(pct)) return setPct(String(stage.defaultProbability));
    if (Number(pct) === stage.defaultProbability) return;
    update.mutate({ id: stage.id, body: { defaultProbability: Number(pct) } }, { onError: () => setPct(String(stage.defaultProbability)) });
  };

  return (
    <li
      ref={sortable ? setNodeRef : undefined}
      style={sortable ? { transform: CSS.Translate.toString(transform), transition } : undefined}
      className={cn("flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5", isDragging && "relative z-10 opacity-80 shadow-modal")}
    >
      {locked ? (
        <span className="flex size-7 items-center justify-center text-fg-3" title="Won and Lost always come last">
          <Lock size={14} aria-label="Locked" />
        </span>
      ) : canManage ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Drag ${stage.name}`}
          className="flex size-7 cursor-grab items-center justify-center rounded-sm text-fg-3 hover:bg-hover active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} aria-hidden />
        </button>
      ) : (
        <span className="w-7 text-center text-meta tabular text-fg-3">{(index ?? 0) + 1}</span>
      )}
      <Input
        aria-label="Stage name"
        className="min-w-[140px] flex-1"
        value={name}
        disabled={!canManage}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span className="flex items-center gap-1">
        <Input
          aria-label={`${stage.name} probability`}
          className="w-[64px] text-right"
          inputMode="numeric"
          value={pct}
          disabled={!canManage || locked}
          title={locked ? "Won is always 100% and Lost 0%" : undefined}
          onChange={(e) => setPct(e.target.value)}
          onBlur={savePct}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className="text-meta text-fg-3">%</span>
      </span>
      {locked && <span className="text-meta capitalize text-fg-3">{stage.category}</span>}
      {canManage && !locked && onMove && index !== undefined && count !== undefined && (
        <span className="ml-auto flex items-center gap-0.5">
          <Button icon size="sm" variant="ghost" aria-label={`Move ${stage.name} up`} disabled={index === 0} onClick={() => onMove(index, index - 1)}>
            <ArrowUp size={14} />
          </Button>
          <Button icon size="sm" variant="ghost" aria-label={`Move ${stage.name} down`} disabled={index === count - 1} onClick={() => onMove(index, index + 1)}>
            <ArrowDown size={14} />
          </Button>
          <Button
            icon
            size="sm"
            variant="danger-ghost"
            aria-label={`Delete ${stage.name}`}
            loading={del.isPending}
            onClick={() => del.mutate(stage.id, { onSuccess: () => toast.success(`Deleted ${stage.name}`) })}
          >
            <Trash2 size={14} />
          </Button>
        </span>
      )}
    </li>
  );
}

function AddStage() {
  const create = useCreateStage();
  const [name, setName] = useState("");
  const [pct, setPct] = useState("50");
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = create.error && isValidation(create.error) ? (create.error as ApiError).fieldErrors : {};
  const errs = { ...server, ...local };
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const l: Record<string, string> = {};
        if (!name.trim()) l.name = "Name the stage";
        if (!validPct(pct)) l.defaultProbability = "0–100";
        setLocal(l);
        if (Object.keys(l).length) return;
        create.mutate(
          { name: name.trim(), defaultProbability: Number(pct) },
          {
            onSuccess: (s) => {
              toast.success(`Added ${s.name}`);
              setName("");
            },
          },
        );
      }}
    >
      <Field label="New stage" error={errs.name} className="min-w-[180px] flex-1">
        <Input value={name} placeholder="e.g. Proposal" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Probability %" error={errs.defaultProbability} className="w-[110px]">
        <Input inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" loading={create.isPending}>
        Add stage
      </Button>
    </form>
  );
}
