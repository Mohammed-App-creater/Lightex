"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { RangeState } from "./lib";

const args = (r: RangeState) => [r.range, r.from, r.to] as const;

export function useReportKpis(projectId: string) {
  return useQuery({ queryKey: qk.reports(projectId, "kpis"), queryFn: () => api.reports.kpis(projectId) });
}

export function useBurndown(projectId: string) {
  return useQuery({ queryKey: qk.reports(projectId, "burndown"), queryFn: () => api.reports.burndown(projectId) });
}

export function useVelocity(projectId: string, r: RangeState) {
  return useQuery({
    queryKey: qk.reports(projectId, "velocity", ...args(r)),
    queryFn: () => api.reports.velocity(projectId, ...args(r)),
  });
}

export function useCycleTime(projectId: string, r: RangeState) {
  return useQuery({
    queryKey: qk.reports(projectId, "cycle-time", ...args(r)),
    queryFn: () => api.reports.cycleTime(projectId, ...args(r)),
  });
}

export function useThroughput(projectId: string, r: RangeState) {
  return useQuery({
    queryKey: qk.reports(projectId, "throughput", ...args(r)),
    queryFn: () => api.reports.throughput(projectId, ...args(r)),
  });
}

export function useProgressReport(projectId: string) {
  return useQuery({ queryKey: qk.reports(projectId, "progress"), queryFn: () => api.reports.progress(projectId) });
}

export type ReportQueries = {
  kpis: ReturnType<typeof useReportKpis>;
  burndown: ReturnType<typeof useBurndown>;
  velocity: ReturnType<typeof useVelocity>;
  cycle: ReturnType<typeof useCycleTime>;
  throughput: ReturnType<typeof useThroughput>;
  progress: ReturnType<typeof useProgressReport>;
};

export function useReportQueries(projectId: string, r: RangeState): ReportQueries {
  return {
    kpis: useReportKpis(projectId),
    burndown: useBurndown(projectId),
    velocity: useVelocity(projectId, r),
    cycle: useCycleTime(projectId, r),
    throughput: useThroughput(projectId, r),
    progress: useProgressReport(projectId),
  };
}
