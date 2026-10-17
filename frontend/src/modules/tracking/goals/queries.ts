"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Milestone, Objective, Status, Task } from "@/lib/api/types";
import { progressOf } from "@/lib/domain/progress";

/** Every live task in the project (link picker, grouping, milestone task lists). */
export function useProjectTasks(projectId: string | undefined) {
  return useQuery({
    queryKey: [...qk.taskList(projectId ?? ""), "all"],
    queryFn: async () => (await api.tasks.list(projectId!, { limit: 500 })).data,
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}

/** Objectives, milestones and everything derived from them (tasks, board, reports). */
function invalidateGoals(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: qk.objectives(projectId) });
  void qc.invalidateQueries({ queryKey: qk.milestones(projectId) });
  void qc.invalidateQueries({ queryKey: qk.scope(projectId) });
}

const LINK_KEY = ["goals", "link"] as const;

/** Live link / unlink of one task to an objective. Optimistic, with rollback + toast. */
export function useToggleObjectiveTask(projectId: string, tasks: Task[], statuses: Status[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: LINK_KEY,
    mutationFn: ({ objectiveId, taskId, link }: { objectiveId: string; taskId: string; link: boolean }) =>
      link ? api.planning.linkTasks(objectiveId, [taskId]) : api.planning.unlinkTask(objectiveId, taskId),
    onMutate: async ({ objectiveId, taskId, link }) => {
      await qc.cancelQueries({ queryKey: qk.objectives(projectId) });
      const prev = qc.getQueryData<Objective[]>(qk.objectives(projectId));
      qc.setQueryData<Objective[]>(qk.objectives(projectId), (list) =>
        list?.map((o) => {
          if (o.id !== objectiveId) return o;
          const ids = link ? [...new Set([...o.taskIds, taskId])] : o.taskIds.filter((x) => x !== taskId);
          const linked = tasks.filter((t) => ids.includes(t.id));
          return { ...o, taskIds: ids, progress: progressOf(linked, statuses) };
        }),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.objectives(projectId), ctx.prev);
      toast.error("Couldn’t update linked tasks", { body: errorMessage(e) });
    },
    onSettled: () => {
      // Only refetch once the last toggle in a burst has settled, so later optimistic
      // states are not overwritten by an earlier response.
      if (qc.isMutating({ mutationKey: LINK_KEY }) <= 1) invalidateGoals(qc, projectId);
    },
  });
}

/** Mark complete / reopen. Optimistic: the milestone flips to done (100%) immediately. */
export function useCompleteMilestone(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) => api.planning.updateMilestone(id, { completed }),
    onMutate: async ({ id, completed }) => {
      await qc.cancelQueries({ queryKey: qk.milestones(projectId) });
      const prev = qc.getQueryData<Milestone[]>(qk.milestones(projectId));
      qc.setQueryData<Milestone[]>(qk.milestones(projectId), (list) =>
        list?.map((m) => {
          if (m.id !== id) return m;
          const base = m.progress.total ? Math.round((m.progress.done / m.progress.total) * 100) : 0;
          const percent = completed ? 100 : base;
          return {
            ...m,
            completedAt: completed ? new Date().toISOString() : null,
            progress: { ...m.progress, percent, atRisk: !completed && percent < m.progress.expected },
          };
        }),
      );
      return { prev };
    },
    onError: (e, v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.milestones(projectId), ctx.prev);
      toast.error(v.completed ? "Couldn’t complete the milestone" : "Couldn’t reopen the milestone", { body: errorMessage(e) });
    },
    onSettled: () => invalidateGoals(qc, projectId),
  });
}

export type ObjectiveInput = { title: string; ownerId: string | null; dueDate: string; description: string };
export type MilestoneInput = { name: string; ownerId: string | null; dueDate: string; description: string; taskIds: string[] };

export function useSaveObjective(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ObjectiveInput }) =>
      id ? api.planning.updateObjective(id, body) : api.planning.createObjective(projectId, body),
    onSuccess: (saved) => {
      qc.setQueryData<Objective[]>(qk.objectives(projectId), (list) => {
        if (!list) return list;
        return list.some((o) => o.id === saved.id) ? list.map((o) => (o.id === saved.id ? saved : o)) : [...list, saved];
      });
      invalidateGoals(qc, projectId);
    },
  });
}

export function useSaveMilestone(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: MilestoneInput }) =>
      id ? api.planning.updateMilestone(id, body) : api.planning.createMilestone(projectId, body),
    onSuccess: (saved) => {
      qc.setQueryData<Milestone[]>(qk.milestones(projectId), (list) => {
        if (!list) return list;
        const next = list.some((m) => m.id === saved.id) ? list.map((m) => (m.id === saved.id ? saved : m)) : [...list, saved];
        return next.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      });
      invalidateGoals(qc, projectId);
    },
  });
}
