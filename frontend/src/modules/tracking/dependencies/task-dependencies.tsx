"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { StatusGlyph } from "@/components/ui/glyphs";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { DependencyItem, DependencyRelation, Task, TaskDetail } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { DependencyPicker } from "./dependency-picker";

/**
 * Task panel "Dependencies" (board 39): Blocked by / Blocks groups with a task picker and remove
 * buttons. Data arrives inside TaskDetail. Writes don't bump task versions; both tasks, the board,
 * the list and saved-view counts are refetched.
 */
export function TaskDependencies({ task, canEdit, wide }: { task: TaskDetail; canEdit: boolean; /** Full page: groups side by side. */ wide?: boolean }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const router = useRouter();
  const deps = task.dependencies;
  const count = deps.blockedBy.length + deps.blocks.length;
  const detailKey = qk.task(ws.slug, task.key);

  const refresh = (otherKey?: string) => {
    void qc.invalidateQueries({ queryKey: detailKey });
    if (otherKey) void qc.invalidateQueries({ queryKey: qk.task(ws.slug, otherKey) });
    void qc.invalidateQueries({ queryKey: qk.scope(task.projectId) });
    void qc.invalidateQueries({ queryKey: qk.views(ws.slug) });
    void qc.invalidateQueries({ queryKey: ["workspace"], predicate: (q) => q.queryKey.includes("my-tasks") });
  };

  const add = useMutation({
    mutationFn: ({ relation, other }: { relation: DependencyRelation; other: Task }) => api.dependencies.add(task.id, relation, other.id),
    onSuccess: (next, { other }) => {
      qc.setQueryData<TaskDetail>(detailKey, (old) => (old ? { ...old, dependencies: next, isBlocked: next.isBlocked } : old));
      refresh(other.key);
    },
    onError: (e, { other }) => {
      const loop = isApiError(e) && e.code === "dependency_cycle";
      toast.error(loop ? "That would create a loop" : `Couldn’t link ${other.key}`, { body: errorMessage(e) });
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (item: DependencyItem) => api.dependencies.remove(task.id, item.id),
    onMutate: async (item) => {
      await qc.cancelQueries({ queryKey: detailKey });
      const prev = qc.getQueryData<TaskDetail>(detailKey);
      qc.setQueryData<TaskDetail>(detailKey, (old) =>
        old ? { ...old, dependencies: { ...old.dependencies, blockedBy: old.dependencies.blockedBy.filter((x) => x.id !== item.id), blocks: old.dependencies.blocks.filter((x) => x.id !== item.id) } } : old,
      );
      return { prev };
    },
    onError: (e, item, ctx) => {
      if (ctx?.prev) qc.setQueryData(detailKey, ctx.prev);
      toast.error(`Couldn’t remove ${item.task.key}`, { body: `${errorMessage(e)} Reverted.` });
    },
    onSettled: (_d, _e, item) => refresh(item.task.key),
  });

  if (count === 0 && !canEdit) return null;

  // Self, parent and sub-tasks can't be linked; neither can tasks already linked either way.
  const exclude = new Set<string>([task.id, ...task.subtasks.map((s) => s.id), ...deps.blockedBy.map((d) => d.task.id), ...deps.blocks.map((d) => d.task.id)]);
  if (task.parentId) exclude.add(task.parentId);

  const open = (key: string) => router.push(`${routes.project(ws.slug, task.project.key, "board")}?task=${key}`);

  const group = (label: string, relation: DependencyRelation, items: DependencyItem[]) => (
    <div className="min-w-0 rounded-[10px] border border-line bg-bg px-3.5 pb-2 pt-1.5">
      <div className="flex h-[30px] items-center gap-2 text-[12px] font-semibold text-fg-2">
        {label}
        <span className="flex-1 font-mono text-[11px] font-medium text-fg-3">{items.length}</span>
        {canEdit && <DependencyPicker label={label} projectId={task.projectId} exclude={exclude} onPick={(other) => add.mutate({ relation, other })} />}
      </div>
      {items.length === 0 ? (
        <p className="m-0 py-1.5 text-[11px] text-fg-3">None</p>
      ) : (
        <ul className="m-0 list-none p-0" aria-label={label}>
          {items.map((d) => {
            const closed = d.task.status.category === "done";
            return (
              <li key={d.id} title={d.task.status.name} className="group/dep -mx-2 flex min-h-8 items-center gap-2 rounded-sm px-2 hover:bg-hover max-[760px]:min-h-11">
                <StatusGlyph kind={d.task.status.glyph} label={d.task.status.name} />
                <span className="w-[52px] flex-none font-mono text-[11px] font-medium text-fg-3">{d.task.key}</span>
                <button type="button" onClick={() => open(d.task.key)} className={cn("min-w-0 flex-1 truncate text-left text-[13px] hover:underline", closed ? "text-fg-3" : "text-fg")}>
                  {d.task.title}
                </button>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Remove ${d.task.key}`}
                    onClick={() => remove.mutate(d)}
                    className="flex size-[22px] flex-none items-center justify-center rounded-[5px] text-fg-3 opacity-0 transition-opacity duration-[var(--dur-fast)] hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover/dep:opacity-100 max-[760px]:size-9 max-[760px]:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <X size={12} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <section aria-label="Dependencies">
      <div className="mb-2 flex items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold">Dependencies</h3>
        <span className="font-mono text-[11px] font-medium text-fg-3">{count}</span>
      </div>
      <div className={cn("grid grid-cols-1 gap-3", wide && "grid-cols-2 max-[760px]:grid-cols-1")}>
        {group("Blocked by", "blocked_by", deps.blockedBy)}
        {group("Blocks", "blocks", deps.blocks)}
      </div>
    </section>
  );
}
