import { describe, expect, it } from "vitest";
import { BACKOFF_CAPS_MS, backoffCap, nextDelay, parseRetryAfter } from "./backoff";
import { liveInterval } from "./status-store";

describe("reconnect backoff (spec §2.6)", () => {
  it("caps full-jitter exponential backoff at 1, 2, 4, 8, 16, then 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffCap)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(BACKOFF_CAPS_MS).toHaveLength(6);
  });

  it("draws the error delay uniformly below the cap (full jitter)", () => {
    expect(nextDelay({ kind: "error", failures: 3 }, () => 0)).toBe(0);
    expect(nextDelay({ kind: "error", failures: 3 }, () => 0.5)).toBe(2000);
    expect(nextDelay({ kind: "error", failures: 9 }, () => 0.999)).toBe(29970);
  });

  it("waits retryMs plus 0–2 s jitter after a reconnect event", () => {
    expect(nextDelay({ kind: "reconnect", retryMs: 500 }, () => 0)).toBe(500);
    expect(nextDelay({ kind: "reconnect", retryMs: 500 }, () => 0.75)).toBe(2000);
  });

  it("honours Retry-After (seconds or an HTTP date)", () => {
    expect(nextDelay({ kind: "retry-after", ms: 300_000 })).toBe(300_000);
    expect(parseRetryAfter("300")).toBe(300_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-10-09T09:00:00Z");
    expect(parseRetryAfter("Fri, 09 Oct 2026 09:01:00 GMT", now)).toBe(60_000);
  });
});

describe("useLiveInterval", () => {
  it("returns no interval while live and v1's interval otherwise", () => {
    expect(liveInterval("live", 30_000)).toBe(false);
    expect(liveInterval("polling", 30_000)).toBe(30_000);
    expect(liveInterval("connecting", 30_000)).toBe(30_000);
    expect(liveInterval("off", 30_000)).toBe(30_000);
  });
});
