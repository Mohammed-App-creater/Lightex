"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { qk } from "@/api/query-keys";
import type { TeamDetail } from "@/api/types";

/* Platform Stage 4: teams. Reads are open to every workspace member; the server checks core.teams.manage on writes. */

export function useTeams(slug: string) {
  return useQuery({ queryKey: qk.teams(slug), queryFn: () => api.teams.list(slug), staleTime: 30_000 });
}

export function useTeam(slug: string, id: string | null) {
  return useQuery({
    queryKey: qk.team(slug, id ?? ""),
    queryFn: () => api.teams.get(id!),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/** Every team write refreshes the list and the details under it (counts and lead ids move with members). */
function useTeamMutation<V, R>(slug: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: qk.teams(slug) }),
  });
}

export const useCreateTeam = (slug: string) =>
  useTeamMutation(slug, (body: { name: string; description: string }) => api.teams.create(slug, body));

export const useUpdateTeam = (slug: string) =>
  useTeamMutation(slug, ({ id, ...body }: { id: string; name: string; description: string }) => api.teams.update(id, body));

export const useDeleteTeam = (slug: string) => useTeamMutation(slug, (id: string) => api.teams.remove(id));

export const useAddTeamMember = (slug: string) =>
  useTeamMutation(slug, ({ id, userId }: { id: string; userId: string }) => api.teams.addMember(id, { userId }));

export const useRemoveTeamMember = (slug: string) =>
  useTeamMutation(slug, ({ id, userId }: { id: string; userId: string }) => api.teams.removeMember(id, userId));

/** Toggling a lead is optimistic on the team's detail, rolled back on error. */
export function useSetTeamLead(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId, isLead }: { id: string; userId: string; isLead: boolean }) => api.teams.updateMember(id, userId, { isLead }),
    onMutate: async ({ id, userId, isLead }) => {
      const key = qk.team(slug, id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TeamDetail>(key);
      qc.setQueryData<TeamDetail>(key, (t) => t && { ...t, members: t.members.map((m) => (m.userId === userId ? { ...m, isLead } : m)) });
      return { prev };
    },
    onError: (_e, { id }, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.team(slug, id), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.teams(slug) }),
  });
}
