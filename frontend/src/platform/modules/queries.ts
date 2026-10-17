"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { qk } from "@/api/query-keys";
import type { WorkspaceModule } from "@/api/types";

/** The workspace's modules (Stage 3). Any member may read them. */
export function useModules(slug: string, enabled = true) {
  return useQuery({ queryKey: qk.modules(slug), queryFn: () => api.modules.list(slug), enabled, staleTime: 60_000 });
}

/**
 * Turns a module on or off. Optimistic on the modules list, rolled back on error. Settling refreshes the whole
 * workspace (enabledModules, my_permissions, roles, projects), since a toggle changes what everyone can see.
 */
export function useSetModule(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => api.modules.set(slug, key, enabled),
    onMutate: async ({ key, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.modules(slug) });
      const prev = qc.getQueryData<WorkspaceModule[]>(qk.modules(slug));
      qc.setQueryData<WorkspaceModule[]>(qk.modules(slug), (list) => list?.map((m) => (m.key === key ? { ...m, enabled } : m)));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.modules(slug), ctx.prev);
    },
    onSuccess: (mod) => {
      qc.setQueryData<WorkspaceModule[]>(qk.modules(slug), (list) => list?.map((m) => (m.key === mod.key ? mod : m)));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.workspace(slug) });
      void qc.invalidateQueries({ queryKey: qk.workspaces() });
    },
  });
}
