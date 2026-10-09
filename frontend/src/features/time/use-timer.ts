"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { RunningTimer, TimeEntry } from "@/lib/api/types";
import { todayISO } from "@/lib/utils/dates";
import { formatMinutes } from "./duration";

/* The signed-in user's running timer (one per user, board 39 R1–R3). */

export function useMyTimer() {
  return useQuery({
    queryKey: qk.myTimer(),
    queryFn: () => api.time.timer(),
    select: (r) => r.timer,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** Date.now(), re-read every second while `active` and the tab is visible; otherwise frozen. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(id);
      id = setInterval(() => setNow(Date.now()), 1000);
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") return clearInterval(id);
      setNow(Date.now());
      start();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active]);
  return now;
}

/** Elapsed ms of a running timer (0 when none). */
export const elapsed = (timer: RunningTimer | null | undefined, now: number) => (timer ? Math.max(0, now - new Date(timer.startedAt).getTime()) : 0);

/** Time writes change entries, loggedMinutes on task payloads, the timer and the timesheet. */
export function invalidateTime(qc: QueryClient, taskIds: (string | undefined)[]) {
  for (const id of taskIds) if (id) void qc.invalidateQueries({ queryKey: qk.timeEntries(id) });
  void qc.invalidateQueries({ queryKey: ["task"] });
  void qc.invalidateQueries({ queryKey: qk.myTimer() });
  void qc.invalidateQueries({ queryKey: ["workspace"], predicate: (q) => q.queryKey.includes("timesheet") });
}

const loggedToast = (e: TimeEntry, key: string) => toast.success(`Logged ${formatMinutes(e.minutes)} on ${key}`);

export function useStartTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task: { id: string; key: string }) => api.time.startTimer(task.id, todayISO()),
    onMutate: async (task) => {
      await qc.cancelQueries({ queryKey: qk.myTimer() });
      const prev = qc.getQueryData<{ timer: RunningTimer | null }>(qk.myTimer());
      return { prev, previousKey: prev?.timer?.taskKey, previousId: prev?.timer?.taskId, task };
    },
    onSuccess: (res, task, ctx) => {
      qc.setQueryData(qk.myTimer(), { timer: res.timer });
      if (res.stopped) loggedToast(res.stopped, ctx?.previousKey ?? "the previous task");
      invalidateTime(qc, [task.id, res.stopped?.taskId]);
    },
    onError: (e, task) => {
      toast.error(`Couldn’t start the timer on ${task.key}`, { body: errorMessage(e) });
      invalidateTime(qc, [task.id]);
    },
  });
}

export function useStopTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (_timer: RunningTimer) => api.time.stopTimer(todayISO()),
    onSuccess: ({ entry }, timer) => {
      qc.setQueryData(qk.myTimer(), { timer: null });
      loggedToast(entry, timer.taskKey);
      invalidateTime(qc, [timer.taskId]);
    },
    onError: (e, timer) => {
      const discarded = isApiError(e) && (e.status === 403 || e.status === 409);
      toast.error(discarded ? "Timer discarded" : "Couldn’t stop the timer", { body: errorMessage(e) });
      invalidateTime(qc, [timer.taskId]);
    },
  });
}
