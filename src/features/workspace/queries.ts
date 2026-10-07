"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";

/** 30s polling while the tab is visible (TanStack pauses intervals in background tabs). */
export const POLL_MS = 30_000;

export function useWorkspaces(enabled = true) {
  return useQuery({ queryKey: qk.workspaces(), queryFn: api.workspaces.list, enabled });
}

export function useWorkspace(slug: string) {
  return useQuery({ queryKey: qk.workspace(slug), queryFn: () => api.workspaces.get(slug) });
}

export function useProjects(slug: string) {
  return useQuery({ queryKey: qk.projects(slug), queryFn: () => api.projects.list(slug) });
}

export function useWsMembers(slug: string) {
  return useQuery({
    queryKey: qk.wsMembers(slug),
    queryFn: () => api.workspaces.members(slug, { limit: 200 }),
    select: (r) => r.data,
  });
}

export function useRoles(slug: string) {
  return useQuery({ queryKey: qk.roles(slug), queryFn: () => api.roles.list(slug) });
}

export function useUnreadCount(workspaceId: string | undefined) {
  return useQuery({
    queryKey: qk.unread(workspaceId),
    queryFn: () => api.notifications.unreadCount(workspaceId),
    enabled: Boolean(workspaceId),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    select: (r) => r.count,
  });
}

export function useMyTasks(slug: string) {
  return useQuery({ queryKey: qk.myTasks(slug), queryFn: () => api.workspaces.myTasks(slug), select: (r) => r.data });
}
