"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { SavedView, SavedViewInput } from "@/lib/api/types";
import { POLL_MS } from "@/features/workspace/queries";
import { useLiveInterval } from "@/lib/realtime/status-store";

/* Saved views (board 30): list, create, edit, pin, reorder, delete with Undo. */

export function useViews(slug: string) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({ queryKey: qk.views(slug), queryFn: () => api.views.list(slug), staleTime: 15_000, refetchInterval: interval });
}

export const pinnedOf = (views: SavedView[]) => views.filter((v) => v.pinned).sort((a, b) => a.position - b.position);

export function useCreateView(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SavedViewInput) => api.views.create(slug, body),
    onSuccess: (v) => qc.setQueryData<SavedView[]>(qk.views(slug), (l) => [...(l ?? []), v]),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.views(slug) }),
  });
}

/** Optimistic patch (rename, pin/unpin) with rollback + toast. */
export function useUpdateView(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.views.update>[1] }) => api.views.update(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.views(slug) });
      const prev = qc.getQueryData<SavedView[]>(qk.views(slug));
      const pos = Math.max(-1, ...(prev ?? []).filter((v) => v.pinned).map((v) => v.position)) + 1;
      qc.setQueryData<SavedView[]>(qk.views(slug), (l) =>
        l?.map((v) => (v.id === id ? { ...v, ...patch, position: patch.pinned && !v.pinned ? pos : v.position } : v)),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      qc.setQueryData(qk.views(slug), ctx?.prev);
      toast.error("Couldn’t update the view", { body: `${errorMessage(e)} Reverted.` });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.views(slug) }),
  });
}

export function useReorderViews(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.views.reorder(slug, ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.views(slug) });
      const prev = qc.getQueryData<SavedView[]>(qk.views(slug));
      qc.setQueryData<SavedView[]>(qk.views(slug), (l) => l?.map((v) => (ids.includes(v.id) ? { ...v, position: ids.indexOf(v.id) } : v)));
      return { prev };
    },
    onError: (e, _ids, ctx) => {
      qc.setQueryData(qk.views(slug), ctx?.prev);
      toast.error("Couldn’t reorder views", { body: `${errorMessage(e)} Reverted.` });
    },
  });
}

const pendingDeletes = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();

if (typeof window !== "undefined") {
  // Commit any delete still waiting on its Undo window before the page goes away.
  window.addEventListener("pagehide", () => pendingDeletes.forEach((p) => p.run()));
}

/**
 * Delete with Undo: hides the view at once and sends DELETE after the toast's Undo window.
 * Undo cancels the request, so nothing needs restoring server-side.
 */
export function useDeleteView(slug: string) {
  const qc = useQueryClient();
  return (view: SavedView, after?: () => void) => {
    const prev = qc.getQueryData<SavedView[]>(qk.views(slug));
    qc.setQueryData<SavedView[]>(qk.views(slug), (l) => l?.filter((v) => v.id !== view.id));
    const run = () => {
      const p = pendingDeletes.get(view.id);
      if (!p) return;
      clearTimeout(p.timer);
      pendingDeletes.delete(view.id);
      api.views
        .remove(view.id)
        .catch((e) => {
          qc.setQueryData(qk.views(slug), prev);
          toast.error(`Couldn’t delete ${view.name}`, { body: `${errorMessage(e)} Restored.` });
        })
        .finally(() => void qc.invalidateQueries({ queryKey: qk.views(slug) }));
    };
    pendingDeletes.set(view.id, { timer: setTimeout(run, 5200), run });
    after?.();
    toast({
      tone: "info",
      title: `${view.name} deleted`,
      duration: 5000,
      action: {
        label: "Undo",
        key: "Z",
        onClick: () => {
          const p = pendingDeletes.get(view.id);
          if (!p) return;
          clearTimeout(p.timer);
          pendingDeletes.delete(view.id);
          qc.setQueryData<SavedView[]>(qk.views(slug), (l) => (l?.some((v) => v.id === view.id) ? l : [...(l ?? []), view]));
          toast.success(`${view.name} restored`);
        },
      },
    });
  };
}
