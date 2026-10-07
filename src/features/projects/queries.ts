"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";

export function useProject(slug: string, key: string) {
  return useQuery({ queryKey: qk.project(slug, key), queryFn: () => api.projects.get(slug, key), enabled: Boolean(key) });
}

export function useStatuses(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.statuses(projectId ?? ""),
    queryFn: () => api.projects.statuses(projectId!),
    enabled: Boolean(projectId),
    staleTime: 5 * 60_000,
  });
}

export function useLabels(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.labels(projectId ?? ""),
    queryFn: () => api.projects.labels(projectId!),
    enabled: Boolean(projectId),
    staleTime: 5 * 60_000,
  });
}

export function useProjectMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.members(projectId ?? ""),
    queryFn: () => api.projects.members(projectId!),
    enabled: Boolean(projectId),
    staleTime: 2 * 60_000,
  });
}

export function useEpics(projectId: string | undefined) {
  return useQuery({ queryKey: qk.epics(projectId ?? ""), queryFn: () => api.planning.epics(projectId!), enabled: Boolean(projectId) });
}

export function useSprints(projectId: string | undefined) {
  return useQuery({ queryKey: qk.sprints(projectId ?? ""), queryFn: () => api.planning.sprints(projectId!), enabled: Boolean(projectId) });
}

export function useMilestones(projectId: string | undefined) {
  return useQuery({ queryKey: qk.milestones(projectId ?? ""), queryFn: () => api.planning.milestones(projectId!), enabled: Boolean(projectId) });
}

export function useObjectives(projectId: string | undefined) {
  return useQuery({ queryKey: qk.objectives(projectId ?? ""), queryFn: () => api.planning.objectives(projectId!), enabled: Boolean(projectId) });
}

export function useActiveSprint(projectId: string | undefined) {
  return useQuery({
    queryKey: [...qk.sprints(projectId ?? ""), "active"],
    queryFn: () => api.planning.activeSprint(projectId!),
    enabled: Boolean(projectId),
  });
}
