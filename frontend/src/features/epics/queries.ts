"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { patchTasks, restore, snapshotTasks } from "@/lib/api/optimistic";
import { qk } from "@/lib/api/query-keys";
import type { Epic, EpicWrite } from "@/lib/api/types";

/** Create or update an epic. Field errors (422) are rethrown for the form to show. */
export function useSaveEpic(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: EpicWrite & { name: string } }) =>
      id ? api.planning.updateEpic(id, body) : api.planning.createEpic(projectId, body),
    onSuccess: (saved) => {
      qc.setQueryData<Epic[]>(qk.epics(projectId), (list) => {
        if (!list) return list;
        return list.some((e) => e.id === saved.id) ? list.map((e) => (e.id === saved.id ? saved : e)) : [...list, saved];
      });
      void qc.invalidateQueries({ queryKey: qk.epics(projectId) });
    },
  });
}

/** Archive / restore, optimistic with rollback; archive offers Undo. */
export function useArchiveEpic(projectId: string) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ epic, archived }: { epic: Epic; archived: boolean }) => api.planning.updateEpic(epic.id, { archived }),
    onMutate: async ({ epic, archived }) => {
      await qc.cancelQueries({ queryKey: qk.epics(projectId) });
      const prev = qc.getQueryData<Epic[]>(qk.epics(projectId));
      qc.setQueryData<Epic[]>(qk.epics(projectId), (list) =>
        list?.map((e) => (e.id === epic.id ? { ...e, archivedAt: archived ? new Date().toISOString() : null } : e)),
      );
      return { prev };
    },
    onError: (e, { epic, archived }, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.epics(projectId), ctx.prev);
      toast.error(archived ? `Couldn’t archive ${epic.name}` : `Couldn’t restore ${epic.name}`, { body: errorMessage(e) });
    },
    onSuccess: (_s, { epic, archived }) => {
      if (archived) {
        toast({
          tone: "info",
          title: `Archived ${epic.name}`,
          duration: 5000,
          action: { label: "Undo", key: "Z", onClick: () => m.mutate({ epic, archived: false }) },
        });
      } else toast.success(`Restored ${epic.name}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.epics(projectId) }),
  });
  return m;
}

/**
 * Add tasks to / remove a task from an epic via the existing bulk endpoint
 * (POST /projects/:id/tasks/bulk with patch { epicId }). Optimistic across every task cache.
 */
export function useAssignEpic(projectId: string) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ ids, epicId }: { ids: string[]; epicId: string | null; undoOf?: string | null; label?: string }) =>
      api.tasks.bulk(projectId, { ids, patch: { epicId } }),
    onMutate: async ({ ids, epicId }) => {
      const snap = await snapshotTasks(qc, projectId);
      const set = new Set(ids);
      patchTasks(qc, (t) => (set.has(t.id) ? { ...t, epicId } : t), projectId);
      return { snap };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.snap) restore(qc, ctx.snap);
      toast.error("Couldn’t update the epic", { body: errorMessage(e) });
    },
    onSuccess: (_r, { ids, undoOf, label }) => {
      if (!label) return;
      toast({
        tone: "info",
        title: label,
        duration: 5000,
        action: undoOf !== undefined ? { label: "Undo", key: "Z", onClick: () => m.mutate({ ids, epicId: undoOf }) } : undefined,
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.scope(projectId) });
      void qc.invalidateQueries({ queryKey: ["task"] });
    },
  });
  return m;
}
