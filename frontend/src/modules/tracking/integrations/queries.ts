"use client";

import { useQuery } from "@tanstack/react-query";
import { useProjects } from "@/platform/workspace/queries";
import { api } from "@/api/endpoints";
import { qk } from "@/api/query-keys";
import type { IntegrationsOverview } from "@/api/types";

/** G1. Polls every 1.5 s only while a sync / backfill runs (the "synced" event ends it sooner when live). */
export function useIntegrations(slug: string) {
  return useQuery({
    queryKey: qk.integrations(slug),
    queryFn: () => api.integrations.overview(slug),
    refetchInterval: (q) => ((q.state.data as IntegrationsOverview | undefined)?.integrations.some((i) => i.syncing) ? 1500 : false),
  });
}

/** G8 (managers, picker open). */
export function useAvailableRepos(integrationId: string | null, q: string) {
  return useQuery({
    queryKey: qk.availableRepos(integrationId ?? "", q),
    queryFn: () => api.integrations.availableRepositories(integrationId!, q || undefined),
    enabled: Boolean(integrationId),
    staleTime: 60_000,
  });
}

/** The workspace's current project keys (for highlighting, §11 #14). */
export function useProjectKeys(slug: string): string[] {
  const { data } = useProjects(slug);
  return (data ?? []).map((p) => p.key);
}

