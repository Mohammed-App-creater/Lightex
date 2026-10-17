"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { isForbidden, isNotFound } from "@/api/errors";
import { qk } from "@/api/query-keys";

/** The task a notification points at (inbox preview). A module's target preview reads the same query. */
export function usePreviewTask(slug: string, key: string | null) {
  return useQuery({
    queryKey: qk.task(slug, key ?? ""),
    queryFn: () => api.tasks.get(slug, key!),
    enabled: Boolean(key),
    retry: (count, err) => !isNotFound(err) && !isForbidden(err) && count < 2,
  });
}
