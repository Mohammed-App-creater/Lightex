/*
 * Reconnect delays (spec §2.6). Pure, so the schedule is unit-tested without timers.
 *
 * - After an error: full-jitter exponential backoff with caps 1, 2, 4, 8, 16, then 30 s.
 * - After a `reconnect` event: its `retryMs` plus 0–2 s jitter.
 * - After a 503 or 429: the server's Retry-After.
 * - The failure count resets once a stream stays up for 60 s (the loop's job).
 */

export const BACKOFF_CAPS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const STABLE_AFTER_MS = 60_000;
export const RECONNECT_JITTER_MS = 2000;

/** The upper bound of the n-th consecutive failure's delay (n ≥ 1). */
export function backoffCap(failures: number): number {
  const i = Math.max(0, Math.min(BACKOFF_CAPS_MS.length - 1, failures - 1));
  return BACKOFF_CAPS_MS[i]!;
}

export type DelayInput =
  | { kind: "error"; failures: number }
  | { kind: "reconnect"; retryMs: number }
  | { kind: "retry-after"; ms: number };

/** `random` is injectable for tests (0 ≤ random() < 1). */
export function nextDelay(input: DelayInput, random: () => number = Math.random): number {
  switch (input.kind) {
    case "error":
      return Math.floor(random() * backoffCap(input.failures));
    case "reconnect":
      return Math.max(0, input.retryMs) + Math.floor(random() * RECONNECT_JITTER_MS);
    case "retry-after":
      return Math.max(0, input.ms);
  }
}

/** Retry-After: delta-seconds or an HTTP date. Returns ms, or null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}
