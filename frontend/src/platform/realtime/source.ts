import { apiMode, apiUrl } from "@/lib/env";
import type { RealtimeEnvelope } from "./events";

/*
 * Where the stream's messages come from (spec §7.7). Live: HttpRealtimeSource (fetch + SSE parser).
 * Mock: MockRealtimeSource from @/lib/mock/realtime, loaded lazily like getTransport(), so live
 * builds never download the mock and mock mode never opens a network stream.
 */

export type RunOptions = {
  slug: string;
  /** The last durable id applied (sent as Last-Event-ID). */
  lastEventId: string | null;
  signal: AbortSignal;
  onEvent: (ev: RealtimeEnvelope) => void;
  /** Any bytes received, pings included (feeds the 45 s watchdog). */
  onActivity: () => void;
};

/**
 * - `ended`: the stream closed (after a `reconnect` event, or the connection simply ended).
 * - `unauthorized`: 401 even after one refresh.
 * - `unavailable`: realtime is off or full (503 realtime_unavailable / realtime_busy), the route is
 *   missing (404, an older backend) or the mock control says "polling": go to polling at once.
 * - `failed`: network error, 5xx or 429; counts towards the 3 failures.
 * - `aborted`: the caller aborted (watchdog, hidden tabs, offline, stop).
 */
export type RunOutcome =
  | { kind: "ended" }
  | { kind: "unauthorized" }
  | { kind: "unavailable"; retryAfterMs: number | null; code?: string }
  | { kind: "failed"; retryAfterMs: number | null }
  | { kind: "aborted" };

export interface RealtimeSource {
  run(opts: RunOptions): Promise<RunOutcome>;
  /** Refresh the access token before reconnecting after `reconnect` (token_expiry). */
  refresh?(): Promise<boolean>;
  /** Mock only: called when something outside the loop should end a backoff wait (a control changed). */
  subscribeWake?(fn: () => void): () => void;
}

let sourcePromise: Promise<RealtimeSource> | null = null;

export function getRealtimeSource(): Promise<RealtimeSource> {
  sourcePromise ??=
    apiMode === "live"
      ? import("./http-source").then((m) => new m.HttpRealtimeSource(apiUrl))
      : import("@/lib/mock/realtime").then((m) => new m.MockRealtimeSource());
  return sourcePromise;
}

/** The build flag `NEXT_PUBLIC_REALTIME=off` keeps every client on v1 polling without trying. */
export const realtimeDisabledByBuild = process.env.NEXT_PUBLIC_REALTIME === "off";
