"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "@/lib/utils/store";
import type { RealtimeStatus } from "./events";

/*
 * One realtime status per tab (spec §2.10). The leader tab's loop sets it and broadcasts it, so
 * every tab of the workspace shows the same mode. Outside a workspace (no provider) it stays
 * "polling", which keeps v1's 30 s intervals.
 */

export const realtimeStatus = createStore<RealtimeStatus>("polling");

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(realtimeStatus.subscribe, realtimeStatus.get, () => "polling" as const);
}

/** `false` (no interval: events invalidate) while live, otherwise `ms` (v1 polling). */
export function liveInterval(status: RealtimeStatus, ms: number): number | false {
  return status === "live" ? false : ms;
}

export function useLiveInterval(ms: number): number | false {
  return liveInterval(useRealtimeStatus(), ms);
}

/** Typing rows, flashes, "Updated just now" toasts and the activity widget's "live" meta: live only. */
export const useIsLive = () => useRealtimeStatus() === "live";
