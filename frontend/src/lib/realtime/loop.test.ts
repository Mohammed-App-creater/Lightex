import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEnvelope, RealtimeStatus } from "./events";
import { RealtimeLoop, WATCHDOG_MS } from "./loop";
import type { RealtimeSource, RunOptions, RunOutcome } from "./source";
import { liveInterval } from "./status-store";

/* The realtime loop against a scripted fake source (spec §8.2 "Realtime loop"). */

type Script = (o: RunOptions) => Promise<RunOutcome> | RunOutcome;

const hello: RealtimeEnvelope = { v: 1, type: "hello", data: { connectionId: "c1", serverTime: "", heartbeatSec: 15, maxLifetimeSec: 300, projects: ["p1"], replayed: 0 } };
const durable = (id: string): RealtimeEnvelope => ({ v: 1, type: "task.changed", id, projectId: "p1", actorId: "u2", data: { taskId: "t1", key: "PRJ-1", op: "updated", version: 2, fields: [] } });
const presence: RealtimeEnvelope = { v: 1, type: "presence.updated", projectId: "p1", data: { location: { kind: "board", id: "p1" }, people: [], at: "" } };

const hang: Script = (o) =>
  new Promise((resolve) => {
    if (o.signal.aborted) return resolve({ kind: "aborted" });
    o.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
  });
const fail: Script = () => ({ kind: "failed", retryAfterMs: null });
const unavailable = (ms: number | null): Script => () => ({ kind: "unavailable", retryAfterMs: ms, code: "realtime_unavailable" });
const helloThen =
  (next: Script, ...events: RealtimeEnvelope[]): Script =>
  (o) => {
    o.onEvent(hello);
    events.forEach((e) => o.onEvent(e));
    return next(o);
  };
const reconnectEnd =
  (reason: string, retryMs = 500): Script =>
  (o) => {
    o.onEvent({ v: 1, type: "reconnect", data: { reason, retryMs } });
    return { kind: "ended" };
  };

class FakeSource implements RealtimeSource {
  calls: { lastEventId: string | null }[] = [];
  order: string[] = [];
  refresh = vi.fn(async () => {
    this.order.push("refresh");
    return true;
  });
  constructor(private scripts: Script[]) {}
  async run(o: RunOptions) {
    this.calls.push({ lastEventId: o.lastEventId });
    this.order.push("run");
    return (this.scripts.shift() ?? hang)(o);
  }
}

function setup(scripts: Script[], extra: { forcePolling?: boolean } = {}) {
  const source = new FakeSource(scripts);
  const statuses: RealtimeStatus[] = [];
  const events: string[] = [];
  const onInvalidateAll = vi.fn();
  const onExpired = vi.fn();
  const loop = new RealtimeLoop({
    slug: "platform",
    source,
    onEvent: (e) => events.push(e.type),
    onInvalidateAll,
    onStatus: (s) => statuses.push(s),
    onExpired,
    random: () => 0,
    forcePolling: extra.forcePolling,
  });
  void loop.start();
  return { loop, source, statuses, events, onInvalidateAll, onExpired };
}

/** Lets zero-delay retries chain (each needs a timer tick plus promise turns). */
async function flush(n = 10) {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeLoop", () => {
  it("goes live on hello, with one blanket invalidation after connecting", async () => {
    const t = setup([helloThen(hang)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.statuses).toEqual(["connecting", "live"]);
    expect(t.onInvalidateAll).toHaveBeenCalledTimes(1);
    expect(liveInterval(t.loop.getStatus(), 30_000)).toBe(false);
    t.loop.stop();
  });

  it("falls back to polling after 3 failed connects (30 s intervals), and recovers to live with one invalidation", async () => {
    const t = setup([fail, fail, fail, unavailable(10), helloThen(hang)]);
    await flush(3);
    expect(t.statuses).toEqual(["connecting", "polling"]);
    expect(liveInterval(t.loop.getStatus(), 30_000)).toBe(30_000);
    expect(t.onInvalidateAll).not.toHaveBeenCalled();
    await flush(20);
    expect(t.statuses).toEqual(["connecting", "polling", "live"]);
    expect(t.onInvalidateAll).toHaveBeenCalledTimes(1);
    expect(t.source.calls).toHaveLength(5);
    t.loop.stop();
  });

  it("goes to polling at once when realtime is unavailable, and retries after Retry-After", async () => {
    const t = setup([unavailable(300_000), helloThen(hang)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loop.getStatus()).toBe("polling");
    await vi.advanceTimersByTimeAsync(299_000);
    expect(t.source.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.source.calls).toHaveLength(2);
    expect(t.loop.getStatus()).toBe("live");
    t.loop.stop();
  });

  it("remembers the last durable id (not volatile events) and sends it on reconnect", async () => {
    const t = setup([helloThen(reconnectEnd("lifetime", 500), durable("41"), presence, durable("42"), presence), helloThen(hang)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toEqual(["task.changed", "presence.updated", "task.changed", "presence.updated"]);
    expect(t.loop.getLastEventId()).toBe("42");
    await vi.advanceTimersByTimeAsync(499);
    expect(t.source.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.source.calls.map((c) => c.lastEventId)).toEqual([null, "42"]);
    // A lifetime reconnect while live is not a recovery: no second blanket invalidation.
    expect(t.onInvalidateAll).toHaveBeenCalledTimes(1);
    t.loop.stop();
  });

  it("refreshes the token before reconnecting after reconnect(token_expiry)", async () => {
    const t = setup([helloThen(reconnectEnd("token_expiry", 0)), helloThen(hang)]);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.source.order).toEqual(["run", "refresh", "run"]);
    t.loop.stop();
  });

  it("turns off and emits expired on unauthorized (401 after one refresh)", async () => {
    const t = setup([() => ({ kind: "unauthorized" })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loop.getStatus()).toBe("off");
    expect(t.onExpired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.source.calls).toHaveLength(1);
  });

  it("aborts after 45 s without bytes and reconnects; twice within 2 minutes → polling", async () => {
    const t = setup([helloThen(hang), helloThen(hang), hang]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.loop.getStatus()).toBe("live");
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1);
    expect(t.source.calls).toHaveLength(1);
    await flush();
    expect(t.source.calls).toHaveLength(2);
    expect(t.loop.getStatus()).toBe("live");
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
    await flush();
    expect(t.loop.getStatus()).toBe("polling");
    t.loop.stop();
  });

  it("pings keep the stream alive", async () => {
    let ping: () => void = () => undefined;
    const t = setup([
      (o) => {
        o.onEvent(hello);
        ping = o.onActivity;
        return hang(o);
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      ping();
    }
    expect(t.source.calls).toHaveLength(1);
    t.loop.stop();
  });

  it("closes the stream when every tab is hidden for 2 min and reconnects with Last-Event-ID when visible", async () => {
    const t = setup([helloThen(hang, durable("7")), helloThen(hang)]);
    await vi.advanceTimersByTimeAsync(0);
    t.loop.setActive(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.source.calls).toHaveLength(1);
    expect(t.loop.getStatus()).toBe("live"); // the status stays as it was
    t.loop.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.source.calls.map((c) => c.lastEventId)).toEqual([null, "7"]);
    t.loop.stop();
  });

  it("offline aborts; online reconnects at once without backoff", async () => {
    const t = setup([helloThen(hang), helloThen(hang)]);
    await vi.advanceTimersByTimeAsync(0);
    t.loop.setOnline(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.source.calls).toHaveLength(1);
    t.loop.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.source.calls).toHaveLength(2);
    t.loop.stop();
  });

  it("NEXT_PUBLIC_REALTIME=off polls without trying", async () => {
    const t = setup([helloThen(hang)], { forcePolling: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.statuses).toEqual(["polling"]);
    expect(t.source.calls).toHaveLength(0);
  });

  it("resets the failure count once a stream stayed up for 60 s", async () => {
    const longStream: Script = (o) => {
      o.onEvent(hello);
      const iv = setInterval(o.onActivity, 10_000);
      return new Promise<RunOutcome>((r) =>
        setTimeout(() => {
          clearInterval(iv);
          r({ kind: "failed", retryAfterMs: null });
        }, 61_000),
      );
    };
    const t = setup([fail, fail, longStream, fail, hang]);
    await flush();
    expect(t.loop.getStatus()).toBe("live");
    await vi.advanceTimersByTimeAsync(61_000);
    await flush();
    // The 2 earlier failures were forgotten: two more (the long stream's end + one) aren't 3.
    expect(t.source.calls).toHaveLength(5);
    expect(t.loop.getStatus()).toBe("live");
    t.loop.stop();
  });
});
