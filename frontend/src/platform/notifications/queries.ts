"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { api, type NotificationTab } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Notification, NotificationPreferences } from "@/lib/api/types";
import { POLL_MS } from "@/features/workspace/queries";
import { useLiveInterval } from "@/lib/realtime/status-store";

export type InboxPage = Awaited<ReturnType<typeof api.notifications.list>>;

export function useInbox(tab: NotificationTab, workspaceId: string) {
  const interval = useLiveInterval(POLL_MS);
  return useQuery({
    queryKey: qk.notifications(tab, workspaceId),
    queryFn: () => api.notifications.list(tab, workspaceId, { limit: 100 }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
}

/** Prefix that covers every inbox list *and* the sidebar unread badge for this workspace. */
const scopeKey = (workspaceId: string): QueryKey => ["notifications", workspaceId];

type Snapshot = [QueryKey, unknown][];

/** Applies `readAt` changes to every cached inbox list and the unread badge. */
function applyRead(qc: QueryClient, workspaceId: string, changes: Map<string, string | null>) {
  let delta = 0;
  const lists = qc.getQueriesData<InboxPage>({ queryKey: scopeKey(workspaceId) });
  // Work out the unread delta once, from the widest list we have.
  const all = qc.getQueryData<InboxPage>(qk.notifications("all", workspaceId));
  const source = all?.data ?? lists.flatMap(([, d]) => (d && "data" in d ? d.data : []));
  const seen = new Set<string>();
  for (const n of source) {
    if (seen.has(n.id) || !changes.has(n.id)) continue;
    seen.add(n.id);
    const next = changes.get(n.id)!;
    if (!n.readAt && next) delta -= 1;
    if (n.readAt && !next) delta += 1;
  }
  qc.setQueriesData({ queryKey: scopeKey(workspaceId) }, (old: unknown) => {
    if (!old || typeof old !== "object") return old;
    if ("count" in old && typeof (old as { count: unknown }).count === "number") {
      const o = old as { count: number };
      return { ...o, count: Math.max(0, o.count + delta) };
    }
    if ("data" in old && Array.isArray((old as InboxPage).data)) {
      const o = old as InboxPage;
      return {
        ...o,
        data: o.data.map((n) => (changes.has(n.id) ? { ...n, readAt: changes.get(n.id)! } : n)),
        counts: { ...o.counts, unread: Math.max(0, o.counts.unread + delta) },
      };
    }
    return old;
  });
}

async function snapshot(qc: QueryClient, workspaceId: string): Promise<Snapshot> {
  await qc.cancelQueries({ queryKey: scopeKey(workspaceId) });
  return qc.getQueriesData({ queryKey: scopeKey(workspaceId) });
}

function restore(qc: QueryClient, snap: Snapshot) {
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

const READ_KEY = ["notifications", "mutate-read"];

/** Optimistic read/unread toggle for one notification (rollback + toast on failure). */
export function useSetRead(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: READ_KEY,
    mutationFn: ({ id, read }: { id: string; read: boolean }) => api.notifications.setRead(id, read),
    onMutate: async ({ id, read }) => {
      const snap = await snapshot(qc, workspaceId);
      applyRead(qc, workspaceId, new Map([[id, read ? new Date().toISOString() : null]]));
      return { snap };
    },
    onError: (err, vars, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      toast.error(vars.read ? "Couldn’t mark as read" : "Couldn’t mark as unread", { body: errorMessage(err) });
    },
    onSettled: () => {
      // Refetch once the last of a burst of toggles settles, so polling can't flash stale state.
      if (qc.isMutating({ mutationKey: READ_KEY }) <= 1) void qc.invalidateQueries({ queryKey: scopeKey(workspaceId) });
    },
  });
}

/** Mark every given notification read (optimistic). Resolves with the ids the server changed. */
export function useMarkAllRead(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: READ_KEY,
    mutationFn: (ids: string[]) => api.notifications.readAll(ids),
    onMutate: async (ids) => {
      const snap = await snapshot(qc, workspaceId);
      const at = new Date().toISOString();
      applyRead(qc, workspaceId, new Map(ids.map((id) => [id, at])));
      return { snap };
    },
    onError: (err, _ids, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      toast.error("Couldn’t mark all as read", { body: errorMessage(err) });
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: READ_KEY }) <= 1) void qc.invalidateQueries({ queryKey: scopeKey(workspaceId) });
    },
  });
}

/** Undo for Mark all read: re-marks exactly those ids unread. */
export function useUnreadAgain(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: READ_KEY,
    mutationFn: (ids: string[]) => api.notifications.unreadAgain(ids),
    onMutate: async (ids) => {
      const snap = await snapshot(qc, workspaceId);
      applyRead(qc, workspaceId, new Map(ids.map((id) => [id, null])));
      return { snap };
    },
    onError: (err, _ids, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      toast.error("Couldn’t undo", { body: errorMessage(err) });
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: READ_KEY }) <= 1) void qc.invalidateQueries({ queryKey: scopeKey(workspaceId) });
    },
  });
}

/** Unread ids across the whole inbox (the "all" list), fetching it if this tab never loaded it. */
export async function allUnreadIds(qc: QueryClient, workspaceId: string): Promise<string[]> {
  const page = await qc.ensureQueryData({
    queryKey: qk.notifications("all", workspaceId),
    queryFn: () => api.notifications.list("all", workspaceId, { limit: 100 }),
  });
  return page.data.filter((n: Notification) => !n.readAt).map((n) => n.id);
}

/* ───────────── Preferences ───────────── */

export function usePrefs() {
  return useQuery({ queryKey: qk.prefs(), queryFn: api.notifications.preferences });
}

export function useSavePrefs() {
  return useMutation({
    mutationKey: ["notification-prefs", "save"],
    mutationFn: (prefs: NotificationPreferences) => api.notifications.savePreferences(prefs),
  });
}
