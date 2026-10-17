"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";

/** Custom-field definitions of a project (board 39), ordered by position. */
export function useCustomFields(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.customFields(projectId ?? ""),
    queryFn: () => api.customFields.list(projectId!),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });
}
