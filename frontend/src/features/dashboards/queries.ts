"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { POLL_MS } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError, isNotFound } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Dashboard, DashboardSummary, DashboardTemplate, DashboardVisibility, DashboardWidgetInput, WidgetConfigMap } from "@/lib/api/types";
import { useLiveInterval } from "@/lib/realtime/status-store";

/*
 * Dashboards (board 33): the list, one dashboard, its mutations, and one query per widget. Widget
 * queries poll every 30 s while visible in polling mode and not at all while live (events
 * invalidate them). They share Reports' cache keys (qk.reports).
 */

export function useDashboards(projectId: string) {
  return useQuery({ queryKey: qk.dashboards(projectId), queryFn: () => api.dashboards.list(projectId) });
}

export function useDashboard(id: string) {
  return useQuery({
    queryKey: qk.dashboard(id),
    queryFn: () => api.dashboards.get(id),
    retry: (n, e) => !isNotFound(e) && n < 1,
  });
}

const summaryOf = (d: Dashboard): DashboardSummary => ({
  id: d.id,
  projectId: d.projectId,
  name: d.name,
  visibility: d.visibility,
  ownerId: d.ownerId,
  widgetCount: d.widgets.length,
  updatedAt: d.updatedAt,
});

function upsertSummary(list: DashboardSummary[] | undefined, d: Dashboard) {
  const s = summaryOf(d);
  const base = (list ?? []).filter((x) => x.id !== d.id);
  return [...base, s];
}

export function useCreateDashboard(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; visibility: DashboardVisibility; template: DashboardTemplate }) => api.dashboards.create(projectId, body),
    onSuccess: (d) => {
      qc.setQueryData(qk.dashboard(d.id), d);
      qc.setQueryData<DashboardSummary[]>(qk.dashboards(projectId), (l) => upsertSummary(l, d));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.dashboards(projectId) }),
  });
}

export function useUpdateDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ d, patch }: { d: Dashboard; patch: { name?: string; visibility?: DashboardVisibility } }) => api.dashboards.update(d.id, { ...patch, version: d.version }),
    onSuccess: (d) => {
      qc.setQueryData(qk.dashboard(d.id), d);
      qc.setQueryData<DashboardSummary[]>(qk.dashboards(d.projectId), (l) => upsertSummary(l, d));
    },
    onError: (e, v) => {
      // 409: take the server's copy (details.current) so the next try sends the right version.
      const current = isApiError(e) && e.code === "version_conflict" ? (e.details?.current as Dashboard | undefined) : undefined;
      if (current) qc.setQueryData(qk.dashboard(v.d.id), current);
    },
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: qk.dashboards(v.d.projectId) }),
  });
}

export function useSaveLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version, widgets }: { id: string; projectId: string; version: number; widgets: DashboardWidgetInput[] }) => api.dashboards.saveLayout(id, version, widgets),
    onSuccess: (d) => {
      qc.setQueryData(qk.dashboard(d.id), d);
      qc.setQueryData<DashboardSummary[]>(qk.dashboards(d.projectId), (l) => upsertSummary(l, d));
    },
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: qk.dashboards(v.projectId) }),
  });
}

/* ───────── pending delete (v1 pattern: Undo for 5 s, DELETE when the toast expires) ───────── */

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
if (typeof window !== "undefined") window.addEventListener("pagehide", () => pending.forEach((p) => p.run()));

export const isPendingDelete = (id: string) => pending.has(id);

export function usePendingDashboardDelete(onUndo?: (d: Dashboard) => void) {
  const qc = useQueryClient();
  return (d: Dashboard) => {
    const key = qk.dashboards(d.projectId);
    const prev = qc.getQueryData<DashboardSummary[]>(key);
    qc.setQueryData<DashboardSummary[]>(key, (l) => l?.filter((x) => x.id !== d.id));
    const run = () => {
      const p = pending.get(d.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(d.id);
      api.dashboards
        .remove(d.id)
        .then(() => qc.removeQueries({ queryKey: qk.dashboard(d.id) }))
        .catch((e) => {
          if (prev) qc.setQueryData(key, prev);
          toast.error(`Couldn’t delete “${d.name}”`, { body: `${errorMessage(e)} Restored.` });
        })
        .finally(() => void qc.invalidateQueries({ queryKey: key }));
    };
    pending.set(d.id, { timer: setTimeout(run, 5200), run });
    toast({
      tone: "info",
      title: `Deleted “${d.name}”`,
      duration: 5000,
      action: {
        label: "Undo",
        key: "Z",
        onClick: () => {
          const p = pending.get(d.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(d.id);
          qc.setQueryData<DashboardSummary[]>(key, (l) => (l?.some((x) => x.id === d.id) ? l : [...(l ?? []), summaryOf(d)]));
          onUndo?.(d);
        },
      },
    });
  };
}

/* ───────── widget data ───────── */

export function useBurndownWidget(projectId: string, sprintId: string | null, enabled = true) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: sprintId ? qk.reports(projectId, "burndown", sprintId) : qk.reports(projectId, "burndown"),
    queryFn: () => api.reports.burndown(projectId, sprintId ?? undefined),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useVelocityWidget(projectId: string, range: WidgetConfigMap["velocity"]["range"], enabled = true) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: qk.reports(projectId, "velocity", range),
    queryFn: () => api.reports.velocity(projectId, range),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useProgressWidget(projectId: string, enabled = true) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: qk.reports(projectId, "progress"),
    queryFn: () => api.reports.progress(projectId),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useWorkloadWidget(projectId: string, c: WidgetConfigMap["workload"], enabled = true) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: qk.reports(projectId, "workload", c.sprintId ?? "active", c.unit, c.personField ?? "assignee"),
    queryFn: () => api.reports.workload(projectId, { sprintId: c.sprintId, unit: c.unit, person: c.personField }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/** My tasks in this project: by due date (no date last), up to 50. */
export function useMyTasksWidget(projectId: string, enabled = true) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: qk.myProjectTasks(projectId),
    queryFn: () => api.tasks.list(projectId, { filter: { assignee: "me" }, sort: "dueDate", limit: 50 }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/** The last 10 project activity entries (nested under qk.activity, so task writes invalidate it). */
export function useActivityWidget(projectId: string, enabled = true) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: [...qk.activity(projectId), "widget"],
    queryFn: () => api.projects.activity(projectId, { limit: 10 }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/* ───────── last opened dashboard per project (localStorage, §1.2) ───────── */

const LAST_KEY = "lightex-last-dashboard";

export function lastDashboard(projectId: string): string | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? ((JSON.parse(raw) as Record<string, string>)[projectId] ?? null) : null;
  } catch {
    return null;
  }
}

export function rememberDashboard(projectId: string, id: string | null) {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (id) map[projectId] = id;
    else delete map[projectId];
    localStorage.setItem(LAST_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable: the index falls back to the first dashboard */
  }
}
