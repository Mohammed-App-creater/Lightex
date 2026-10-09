import type { RealtimeEnvelope } from "@/lib/realtime/events";
import type { RealtimeSource, RunOptions, RunOutcome } from "@/lib/realtime/source";
import { getDB, mockSession, nowISO } from "./db";
import type { MockDB, TaskRec } from "./db-types";
import { mockControls } from "./controls";
import { projectPermissions, wsMembership } from "./derive";

/*
 * The mock's realtime backend (spec §7.10), in-process: no network.
 *
 * mockBus mirrors the server's publish(): handlers publish inside a request; the transport
 * commits the batch when the handler succeeds (transaction.on_commit) and drops it when it throws.
 * Durable events get increasing ids at commit time and the last 500 are kept for replay.
 *
 * MockRealtimeSource plays the stream for the signed-in user: hello, replay after Last-Event-ID
 * (an id older than the buffer → reset), live events filtered to the user's projects and
 * user-targeted events, a ping every 15 s, and `reconnect` after 5 minutes. Mock controls:
 * offline → a network error; errorRate → a failed connect; realtime "polling" → unavailable.
 */

export type BusEvent = RealtimeEnvelope & { /** user-targeted events (inbox, access) */ userId?: string | null };

const REPLAY_LIMIT = 500;
export const MOCK_PING_MS = 15_000;
export const MOCK_LIFETIME_MS = 300_000;

type PublishInput = {
  workspaceId: string;
  projectId?: string | null;
  actorId?: string | null;
  userId?: string | null;
  data: unknown;
  durable?: boolean;
};

class MockBus {
  private seq = 0;
  private buffer: BusEvent[] = [];
  private listeners = new Set<(e: BusEvent) => void>();
  /** The batch of the request whose handler is running synchronously right now. */
  private current: BusEvent[] | null = null;

  /** The transport opens a batch around each handler call… */
  begin(): BusEvent[] {
    const batch: BusEvent[] = [];
    this.current = batch;
    return batch;
  }
  /** …stops collecting as soon as the handler returns (async continuations publish directly)… */
  release(batch: BusEvent[]) {
    if (this.current === batch) this.current = null;
  }
  /** …emits it when the handler succeeded (transaction.on_commit)… */
  commit(batch: BusEvent[]) {
    this.release(batch);
    batch.splice(0).forEach((e) => this.emit(e));
  }
  /** …and drops it when the handler threw. */
  rollback(batch: BusEvent[]) {
    this.release(batch);
    batch.length = 0;
  }

  publish(type: string, input: PublishInput) {
    const e: BusEvent = {
      v: 1,
      type,
      ws: input.workspaceId,
      projectId: input.projectId ?? null,
      actorId: input.actorId ?? null,
      at: nowISO(),
      data: input.data,
      userId: input.userId ?? null,
      ...(input.durable === false ? {} : { id: "pending" }),
    };
    if (this.current) this.current.push(e);
    else this.emit(e);
  }

  private emit(e: BusEvent) {
    if (e.id) {
      e.id = String(++this.seq);
      this.buffer.push(e);
      if (this.buffer.length > REPLAY_LIMIT) this.buffer.splice(0, this.buffer.length - REPLAY_LIMIT);
    }
    this.listeners.forEach((l) => l(e));
  }

  subscribe(fn: (e: BusEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Durable events after `lastId`, or `reset` when the cursor is unknown or older than the buffer. */
  since(lastId: string): { events: BusEvent[] } | { reset: "unknown_cursor" } {
    if (!/^\d+$/.test(lastId)) return { reset: "unknown_cursor" };
    const n = Number(lastId);
    if (n > this.seq) return { reset: "unknown_cursor" };
    const oldest = this.buffer[0] ? Number(this.buffer[0].id) : this.seq + 1;
    if (n < oldest - 1) return { reset: "unknown_cursor" };
    return { events: this.buffer.filter((e) => Number(e.id) > n) };
  }

  lastId() {
    return this.seq;
  }

  /** Tests. */
  resetForTests() {
    this.seq = 0;
    this.buffer = [];
    this.current = null;
  }
}

export const mockBus = new MockBus();

/* ───────── publishing helpers (spec §6.2) ───────── */

const wsOf = (db: MockDB, projectId: string) => db.projects.find((p) => p.id === projectId)?.workspaceId ?? "";

export function publishTask(db: MockDB, actorId: string | null, t: TaskRec, op: "created" | "updated" | "moved" | "deleted" | "restored", fields: string[] = []) {
  mockBus.publish("task.changed", {
    workspaceId: wsOf(db, t.projectId),
    projectId: t.projectId,
    actorId,
    data: { taskId: t.id, key: t.key, op, version: op === "deleted" ? null : t.version, fields },
  });
}

export function publishBulk(db: MockDB, actorId: string | null, projectId: string, taskIds: string[] | null, op: "updated" | "deleted" | "restored" | "created") {
  mockBus.publish("tasks.bulk_changed", {
    workspaceId: wsOf(db, projectId),
    projectId,
    actorId,
    data: { taskIds: taskIds && taskIds.length <= 200 ? taskIds : null, op },
  });
}

export function publishComment(db: MockDB, actorId: string | null, t: TaskRec, commentId: string, op: "created" | "updated" | "deleted") {
  mockBus.publish("comment.changed", { workspaceId: wsOf(db, t.projectId), projectId: t.projectId, actorId, data: { taskId: t.id, key: t.key, commentId, op } });
}

export function publishAttachment(db: MockDB, actorId: string | null, t: TaskRec, op: "created" | "deleted") {
  mockBus.publish("attachment.changed", { workspaceId: wsOf(db, t.projectId), projectId: t.projectId, actorId, data: { taskId: t.id, key: t.key, op } });
}

export function publishProject(db: MockDB, actorId: string | null, projectId: string, areas: string[]) {
  mockBus.publish("project.changed", { workspaceId: wsOf(db, projectId), projectId, actorId, data: { areas } });
}

export function publishDashboard(db: MockDB, actorId: string | null, d: { id: string; projectId: string; visibility: string; ownerId: string; version: number }, op: "created" | "updated" | "layout" | "deleted") {
  mockBus.publish("dashboard.changed", {
    workspaceId: wsOf(db, d.projectId),
    projectId: d.visibility === "shared" ? d.projectId : null,
    // Personal dashboards: the owner only.
    userId: d.visibility === "personal" ? d.ownerId : null,
    actorId,
    data: { dashboardId: d.id, op, version: op === "deleted" ? null : d.version },
  });
}

/** inbox.changed to one user, with their new unread count (all workspaces). */
export function publishInbox(db: MockDB, userId: string, workspaceId?: string) {
  const unread = db.notifications.filter((n) => n.recipientId === userId && !n.readAt).length;
  const wsIds = workspaceId ? [workspaceId] : db.wsMembers.filter((m) => m.userId === userId).map((m) => m.workspaceId);
  for (const ws of wsIds) mockBus.publish("inbox.changed", { workspaceId: ws, userId, actorId: null, data: { unread } });
}

/** access.changed to the affected user (the stream then ends with `reconnect`), plus project.changed ["members"]. */
export function publishAccess(db: MockDB, actorId: string | null, userId: string, projectId: string | null) {
  const ws = projectId ? wsOf(db, projectId) : db.wsMembers.find((m) => m.userId === userId)?.workspaceId ?? "";
  mockBus.publish("access.changed", { workspaceId: ws, userId, actorId, data: { projectId } });
  if (projectId) publishProject(db, actorId, projectId, ["members"]);
}

/* ───────── the simulated stream ───────── */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });

let connSeq = 0;

export class MockRealtimeSource implements RealtimeSource {
  /** End a backoff wait when the realtime / offline controls change. */
  subscribeWake(fn: () => void) {
    let prev = mockControls.get();
    return mockControls.subscribe(() => {
      const c = mockControls.get();
      if (c.realtime !== prev.realtime || c.offline !== prev.offline) fn();
      prev = c;
    });
  }

  async refresh() {
    return Boolean(mockSession.get());
  }

  async run(o: RunOptions): Promise<RunOutcome> {
    const c0 = mockControls.get();
    await sleep(Math.min(150, c0.latencyMin + Math.random() * Math.max(0, c0.latencyMax - c0.latencyMin)), o.signal);
    if (o.signal.aborted) return { kind: "aborted" };
    const c = mockControls.get();
    if (c.offline) return { kind: "failed", retryAfterMs: null };
    if (c.realtime === "polling") return { kind: "unavailable", retryAfterMs: 300_000, code: "realtime_unavailable" };
    if (Math.random() < c.errorRate) return { kind: "failed", retryAfterMs: null };

    const db = getDB();
    const me = mockSession.get();
    if (!me) return { kind: "unauthorized" };
    const ws = db.workspaces.find((w) => w.slug === o.slug && !w.deletedAt);
    if (!ws || !wsMembership(db, me, ws.id)) return { kind: "unavailable", retryAfterMs: null, code: "not_found" };
    const projects = new Set(
      db.projects.filter((p) => p.workspaceId === ws.id && projectPermissions(db, me, p.id).includes("project.view")).map((p) => p.id),
    );
    const visible = (e: BusEvent) => e.ws === ws.id && ((e.userId ? e.userId === me : false) || (!e.userId && !!e.projectId && projects.has(e.projectId)));

    let replay: BusEvent[] = [];
    let reset = false;
    if (o.lastEventId) {
      const r = mockBus.since(o.lastEventId);
      if ("reset" in r) reset = true;
      else replay = r.events.filter(visible);
    }
    const send = (e: RealtimeEnvelope) => {
      o.onActivity();
      const { userId: _u, ...env } = e as BusEvent;
      o.onEvent(env);
    };
    send({
      v: 1,
      type: "hello",
      data: { connectionId: `c_${(++connSeq).toString(36)}`, serverTime: nowISO(), heartbeatSec: 15, maxLifetimeSec: 300, projects: [...projects], replayed: replay.length },
    });
    if (reset) send({ v: 1, type: "reset", data: { reason: "unknown_cursor" } });
    replay.forEach(send);

    return new Promise<RunOutcome>((resolve) => {
      let done = false;
      const finish = (out: RunOutcome) => {
        if (done) return;
        done = true;
        unsub();
        unControls();
        clearInterval(ping);
        clearTimeout(life);
        resolve(out);
      };
      const unsub = mockBus.subscribe((e) => {
        if (!visible(e)) return;
        // Delivered on the next task, like a network hop (after the request that caused it resolves).
        setTimeout(() => {
          if (done) return;
          send(e);
          if (e.type === "access.changed" && e.userId === me) {
            send({ v: 1, type: "reconnect", data: { reason: "access_changed", retryMs: 500 } });
            finish({ kind: "ended" });
          }
        }, 0);
      });
      const unControls = mockControls.subscribe(() => {
        const now = mockControls.get();
        if (now.offline) finish({ kind: "failed", retryAfterMs: null });
        else if (now.realtime === "polling") finish({ kind: "unavailable", retryAfterMs: 300_000, code: "realtime_unavailable" });
      });
      const ping = setInterval(() => o.onActivity(), MOCK_PING_MS);
      const life = setTimeout(() => {
        send({ v: 1, type: "reconnect", data: { reason: "lifetime", retryMs: 500 } });
        finish({ kind: "ended" });
      }, MOCK_LIFETIME_MS);
      o.signal.addEventListener("abort", () => finish({ kind: "aborted" }), { once: true });
    });
  }
}
