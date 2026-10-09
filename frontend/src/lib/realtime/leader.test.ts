import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import { startRealtime, type RealtimeHandle } from "./client";
import type { RealtimeEnvelope } from "./events";
import type { ChannelLike, LockManagerLike, TabsEnv } from "./leader";
import type { RealtimeSource, RunOptions, RunOutcome } from "./source";

/*
 * One stream per browser per workspace (spec §7.7, §8.2): two simulated tabs share an in-memory
 * BroadcastChannel and Web Locks. Only the leader opens the stream; both caches get the events;
 * when the leader closes, the other tab takes over with the last durable id.
 */

class FakeBroadcast {
  private channels = new Set<ChannelLike & { name: string }>();
  create = (name: string): ChannelLike => {
    const ch: ChannelLike & { name: string } = {
      name,
      onmessage: null,
      postMessage: (m: unknown) => {
        for (const other of this.channels) {
          if (other !== ch && other.name === name) queueMicrotask(() => other.onmessage?.({ data: structuredClone(m) }));
        }
      },
      close: () => {
        this.channels.delete(ch);
      },
    };
    this.channels.add(ch);
    return ch;
  };
}

class FakeLocks implements LockManagerLike {
  private held = new Set<string>();
  private queue = new Map<string, (() => void)[]>();
  request(name: string, opts: { signal?: AbortSignal }, cb: () => Promise<void>) {
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        this.held.add(name);
        void cb().then(() => {
          this.held.delete(name);
          resolve(undefined);
          this.queue.get(name)?.shift()?.();
        });
      };
      if (!this.held.has(name)) return grant();
      const list = this.queue.get(name) ?? [];
      list.push(grant);
      this.queue.set(name, list);
      opts.signal?.addEventListener("abort", () => {
        const i = list.indexOf(grant);
        if (i >= 0) list.splice(i, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}

class StreamSource implements RealtimeSource {
  runs: RunOptions[] = [];
  async run(o: RunOptions): Promise<RunOutcome> {
    this.runs.push(o);
    o.onEvent({ v: 1, type: "hello", data: { connectionId: "c", serverTime: "", heartbeatSec: 15, maxLifetimeSec: 300, projects: ["p1"], replayed: 0 } });
    return new Promise((resolve) => o.signal.addEventListener("abort", () => resolve({ kind: "aborted" })));
  }
  emit(ev: RealtimeEnvelope) {
    this.runs[this.runs.length - 1]!.onEvent(ev);
  }
}

const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.board("p1", "active"), { statuses: [], tasks: [], sprintId: null });
  qc.setQueryData(qk.task("platform", "PRJ-1"), { id: "t1", key: "PRJ-1" });
  return qc;
}

const handles: RealtimeHandle[] = [];
afterEach(() => {
  handles.splice(0).forEach((h) => h.stop());
  vi.restoreAllMocks();
});

describe("leader election across tabs", () => {
  it("opens one stream for two tabs, applies events in both, and hands over with Last-Event-ID", async () => {
    const env: TabsEnv = { locks: new FakeLocks(), createChannel: new FakeBroadcast().create };
    const source = new StreamSource();
    const qcA = seeded();
    const qcB = seeded();
    const common = { slug: "platform", meId: "u_me", env, getSource: async () => source, isVisible: () => true, schedule: (fn: () => void) => fn() };
    const a = startRealtime({ ...common, qc: qcA });
    const b = startRealtime({ ...common, qc: qcB });
    handles.push(a, b);
    await tick();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(source.runs).toHaveLength(1);

    // Reset the invalidation the first hello caused, then send one task event.
    qcA.setQueryData(qk.board("p1", "active"), { statuses: [], tasks: [], sprintId: null });
    qcB.setQueryData(qk.board("p1", "active"), { statuses: [], tasks: [], sprintId: null });
    source.emit({ v: 1, type: "task.changed", id: "5", ws: "w", projectId: "p1", actorId: "u_other", data: { taskId: "t1", key: "PRJ-1", op: "updated", version: 3, fields: ["dueDate"] } });
    await tick();
    expect(qcA.getQueryState(qk.board("p1", "active"))?.isInvalidated).toBe(true);
    expect(qcB.getQueryState(qk.board("p1", "active"))?.isInvalidated).toBe(true);
    expect(qcB.getQueryState(qk.task("platform", "PRJ-1"))?.isInvalidated).toBe(true);

    // The leader tab closes: the other tab takes the lock and reconnects from id 5.
    a.stop();
    await tick(10);
    expect(b.isLeader()).toBe(true);
    expect(source.runs).toHaveLength(2);
    expect(source.runs[1]!.lastEventId).toBe("5");
  });

  it("runs a stream in every tab without Web Locks or BroadcastChannel", async () => {
    const source = new StreamSource();
    const common = { slug: "platform", meId: "u_me", env: {}, getSource: async () => source, isVisible: () => true, schedule: (fn: () => void) => fn() };
    const a = startRealtime({ ...common, qc: seeded() });
    const b = startRealtime({ ...common, qc: seeded() });
    handles.push(a, b);
    await tick();
    expect(a.isLeader() && b.isLeader()).toBe(true);
    expect(source.runs).toHaveLength(2);
  });
});
