import { nextDelay, STABLE_AFTER_MS } from "./backoff";
import { DURABLE_TYPES, type RealtimeEnvelope, type RealtimeStatus, type ReconnectEvent } from "./events";
import type { RealtimeSource, RunOutcome } from "./source";

/*
 * The stream loop (spec §2.5, §2.6, §2.10, §7.7). It runs in the leader tab only.
 *
 *   while (!stopped) {
 *     outcome = await source.run({ lastEventId, onEvent, onActivity: kickWatchdog })
 *     unauthorized → "off" + expired · unavailable or 3 failures → "polling" · hello → "live"
 *     await sleep(nextDelay(...))     // woken early by visibility / online
 *   }
 *
 * - Watchdog: no bytes for 45 s → abort and reconnect (a failure). Twice within 2 min → polling.
 * - `setActive(false)` (every tab hidden ≥ 2 min) aborts the stream; the status stays as it was.
 *   `setActive(true)` reconnects at once with Last-Event-ID.
 * - `setOnline(false)` aborts; `setOnline(true)` reconnects without backoff.
 * - `hello` after "connecting" or "polling", and every `reset`, ask for one blanket invalidation.
 */

export const WATCHDOG_MS = 45_000;
export const WATCHDOG_WINDOW_MS = 120_000;
export const FAILURES_TO_POLL = 3;

export type LoopOptions = {
  slug: string;
  source: RealtimeSource;
  lastEventId?: string | null;
  /** Every non-control event, plus hello / reset (the applier ignores control types). */
  onEvent: (ev: RealtimeEnvelope) => void;
  /** Refetch every active query of the workspace once (hello after connecting/polling, reset). */
  onInvalidateAll: () => void;
  onStatus: (s: RealtimeStatus) => void;
  onLastEventId?: (id: string) => void;
  /** 401 after one refresh: v1 re-auth modal. */
  onExpired: () => void;
  /** `NEXT_PUBLIC_REALTIME=off`: polling without trying. */
  forcePolling?: boolean;
  now?: () => number;
  random?: () => number;
};

type AbortReason = "watchdog" | "inactive" | "offline" | "stop";

export class RealtimeLoop {
  private status: RealtimeStatus = "connecting";
  private failures = 0;
  private lastEventId: string | null;
  private lastReconnect: ReconnectEvent["data"] | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private watchdogFires: number[] = [];
  private active = true;
  private online = true;
  private stopped = false;
  private ac: AbortController | null = null;
  private abortReason: AbortReason | null = null;
  private wakeFn: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private unsubWake: (() => void) | undefined;
  /** For tests and the dev pill. */
  connects = 0;

  constructor(private readonly o: LoopOptions) {
    this.lastEventId = o.lastEventId ?? null;
  }

  private get now() {
    return this.o.now?.() ?? Date.now();
  }

  getStatus() {
    return this.status;
  }
  getLastEventId() {
    return this.lastEventId;
  }

  private setStatus(s: RealtimeStatus) {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus(s);
  }

  start() {
    if (this.running) return this.running;
    this.unsubWake = this.o.source.subscribeWake?.(() => this.wake());
    this.running = this.loop();
    return this.running;
  }

  stop() {
    this.stopped = true;
    this.clearWatchdog();
    this.abort("stop");
    this.wake();
    this.unsubWake?.();
  }

  /** Any tab visible now or within the last 2 minutes. */
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.abort("inactive");
    else this.wake();
  }

  setOnline(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    if (!online) this.abort("offline");
    else this.wake();
  }

  private abort(reason: AbortReason) {
    if (!this.ac || this.ac.signal.aborted) return;
    this.abortReason = reason;
    this.ac.abort();
  }

  private wake() {
    const w = this.wakeFn;
    this.wakeFn = null;
    w?.();
  }

  /** Sleeps `ms`, or until wake() (visibility, online, stop, a mock control change). */
  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const id = setTimeout(() => {
        this.wakeFn = null;
        resolve();
      }, ms);
      this.wakeFn = () => {
        clearTimeout(id);
        resolve();
      };
    });
  }

  private waitUntilRunnable() {
    return new Promise<void>((resolve) => {
      this.wakeFn = resolve;
    });
  }

  /** The `reconnect` event of the stream that just ended (set by handle(), read after run()). */
  private reconnectInfo(): ReconnectEvent["data"] | null {
    return this.lastReconnect;
  }

  private kickWatchdog = () => {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.abort("watchdog"), WATCHDOG_MS);
  };

  private clearWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private handle(ev: RealtimeEnvelope, onHello: () => void) {
    switch (ev.type) {
      case "hello": {
        onHello();
        const prev = this.status;
        this.setStatus("live");
        if (prev === "connecting" || prev === "polling") this.o.onInvalidateAll();
        return;
      }
      case "reset":
        this.o.onInvalidateAll();
        return;
      case "reconnect":
        this.lastReconnect = (ev as ReconnectEvent).data;
        return;
      default:
        if (ev.id && DURABLE_TYPES.includes(ev.type as (typeof DURABLE_TYPES)[number])) {
          this.lastEventId = ev.id;
          this.o.onLastEventId?.(ev.id);
        }
        this.o.onEvent(ev);
    }
  }

  private async loop() {
    if (this.o.forcePolling) {
      this.status = "polling";
      this.o.onStatus("polling");
      return;
    }
    this.o.onStatus(this.status);
    while (!this.stopped) {
      if (!this.active || !this.online) {
        await this.waitUntilRunnable();
        continue;
      }
      const ac = new AbortController();
      this.ac = ac;
      this.abortReason = null;
      if (this.lastReconnect?.reason === "token_expiry") await this.o.source.refresh?.();
      this.lastReconnect = null;
      const startedAt = this.now;
      let gotHello = false;
      this.connects += 1;
      this.kickWatchdog();
      let outcome: RunOutcome;
      try {
        outcome = await this.o.source.run({
          slug: this.o.slug,
          lastEventId: this.lastEventId,
          signal: ac.signal,
          onEvent: (ev) => this.handle(ev, () => (gotHello = true)),
          onActivity: this.kickWatchdog,
        });
      } catch {
        outcome = ac.signal.aborted ? { kind: "aborted" } : { kind: "failed", retryAfterMs: null };
      }
      this.clearWatchdog();
      this.ac = null;
      if (this.stopped) break;
      if (gotHello && this.now - startedAt >= STABLE_AFTER_MS) this.failures = 0;
      const reason = ac.signal.aborted ? this.abortReason : null;

      if (outcome.kind === "unauthorized") {
        this.setStatus("off");
        this.o.onExpired();
        return;
      }
      // Hidden tabs, offline: wait (status unchanged) and reconnect with Last-Event-ID when runnable.
      if (reason === "inactive" || reason === "offline") continue;

      let delay: number;
      if (reason === "watchdog") {
        this.failures += 1;
        const t = this.now;
        this.watchdogFires = [...this.watchdogFires.filter((x) => t - x < WATCHDOG_WINDOW_MS), t];
        if (this.watchdogFires.length >= 2 || this.failures >= FAILURES_TO_POLL) this.setStatus("polling");
        delay = nextDelay({ kind: "error", failures: this.failures }, this.o.random);
      } else if (outcome.kind === "unavailable") {
        this.failures += 1;
        this.setStatus("polling");
        delay = outcome.retryAfterMs ?? nextDelay({ kind: "error", failures: this.failures }, this.o.random);
      } else if (outcome.kind === "ended" && this.reconnectInfo()) {
        delay = nextDelay({ kind: "reconnect", retryMs: this.reconnectInfo()!.retryMs }, this.o.random);
      } else {
        // failed, or the connection ended without saying goodbye.
        this.failures += 1;
        if (this.failures >= FAILURES_TO_POLL) this.setStatus("polling");
        const ra = outcome.kind === "failed" ? outcome.retryAfterMs : null;
        delay = ra ?? nextDelay({ kind: "error", failures: this.failures }, this.o.random);
      }
      await this.sleep(delay);
    }
  }
}
