"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { ISODate, Status, Task } from "@/lib/api/types";
import { inRange } from "./schedule-lib";

/*
 * Board 32 queries (§6.5). The caches hold `{ data, nextCursor, truncated }`, a shape `mapTasksIn`
 * already walks, so patchTasks / commitTask / insertTask reach them. insertTask appends new tasks
 * to any `{ data }` list in the project, so every consumer re-applies its own predicate in `select`.
 */

export const MAX_PAGES = 4;
export const PAGE = 500;

export type ScheduleData = { data: Task[]; nextCursor: string | null; truncated: boolean };

const isCanceled = (t: Task, statuses: Status[] | undefined) => statuses?.find((s) => s.id === t.statusId)?.glyph === "canceled";

/** Fetches a window, following nextCursor for up to 4 pages (2,000 tasks). */
export async function fetchRange(projectId: string, from: ISODate, to: ISODate): Promise<ScheduleData> {
  const data: Task[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await api.tasks.range(projectId, from, to, cursor);
    data.push(...r.data);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return { data, nextCursor: null, truncated: Boolean(cursor) };
}

/** Live, not canceled tasks overlapping [from, to]. The previous window stays on screen while a new one loads. */
export function useScheduleTasks(projectId: string, from: ISODate, to: ISODate, statuses: Status[] | undefined) {
  return useQuery({
    queryKey: qk.schedule(projectId, from, to),
    queryFn: () => fetchRange(projectId, from, to),
    placeholderData: keepPreviousData,
    select: (r: ScheduleData) => ({
      ...r,
      data: r.data.filter((t) => !t.deletedAt && !isCanceled(t, statuses) && inRange(t, from, to)),
    }),
  });
}

/** Unscheduled tray: open tasks with neither date, highest priority first. Only while the tray is open. */
export function useUnscheduled(projectId: string, statuses: Status[] | undefined, enabled: boolean) {
  const open = (statuses ?? []).filter((s) => s.category !== "done").map((s) => s.id);
  return useQuery({
    queryKey: qk.unscheduled(projectId),
    queryFn: async () => {
      const r = await api.tasks.unscheduled(projectId, open);
      return { data: r.data, nextCursor: r.nextCursor };
    },
    enabled: enabled && open.length > 0,
    select: (r: { data: Task[]; nextCursor: string | null }) => ({
      more: Boolean(r.nextCursor),
      data: r.data
        .filter((t) => !t.deletedAt && !t.startDate && !t.dueDate && open.includes(t.statusId))
        .sort((a, b) => b.priority - a.priority || a.number - b.number),
    }),
  });
}
