import type { RealtimeEnvelope, RealtimeStatus } from "./events";

/*
 * One stream per browser per workspace (spec §7.7). Every tab asks for the Web Lock
 * "lightex-rt:<slug>"; the holder is the leader and runs the stream. The browser releases the lock
 * when the leader tab closes, and the next waiting tab takes over. Events, the status and the last
 * durable id go to the other tabs over BroadcastChannel("lightex-rt:<slug>"); followers post
 * `visible` every 20 s while visible (the leader closes the stream when every tab has been hidden
 * for 2 minutes). Without Web Locks or BroadcastChannel, every tab runs its own stream.
 */

export type TabMessage =
  /** leader → followers */
  | { t: "event"; ev: RealtimeEnvelope }
  | { t: "invalidate-all" }
  | { t: "status"; status: RealtimeStatus; lastEventId: string | null }
  /** follower → leader */
  | { t: "visible" }
  /** a new tab asks the leader to repeat its status */
  | { t: "sync" };

export type LockManagerLike = {
  request(name: string, options: { signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown>;
};

export type ChannelLike = {
  postMessage(m: unknown): void;
  close(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
};

export type TabsEnv = {
  locks?: LockManagerLike | null;
  createChannel?: ((name: string) => ChannelLike) | null;
};

export function browserTabsEnv(): TabsEnv {
  if (typeof window === "undefined") return {};
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks ?? null;
  const BC = typeof BroadcastChannel === "function" ? BroadcastChannel : null;
  return { locks, createChannel: BC ? (name) => new BC(name) as unknown as ChannelLike : null };
}

export type TabLink = {
  isLeader: () => boolean;
  /** Leader → followers (no-op without a channel). */
  broadcast: (m: TabMessage) => void;
  /** Follower → leader. */
  toLeader: (m: TabMessage) => void;
  close: () => void;
};

export function joinTabs(
  name: string,
  h: {
    /** Called once when this tab becomes the leader; returns the stop function. */
    onLeader: () => () => void;
    onMessage: (m: TabMessage) => void;
  },
  env: TabsEnv = browserTabsEnv(),
): TabLink {
  let closed = false;
  let leader = false;
  let stopLeading: (() => void) | null = null;
  let release: (() => void) | null = null;
  const abort = new AbortController();
  const channel = env.createChannel?.(name) ?? null;
  if (channel) channel.onmessage = (e) => !closed && h.onMessage(e.data as TabMessage);

  const lead = () => {
    leader = true;
    stopLeading = h.onLeader();
  };

  if (env.locks && channel) {
    env.locks
      .request(name, { signal: abort.signal }, () => {
        if (closed) return Promise.resolve();
        return new Promise<void>((resolve) => {
          release = resolve;
          lead();
        });
      })
      .catch(() => undefined);
  } else {
    lead();
  }

  return {
    isLeader: () => leader,
    broadcast: (m) => {
      if (leader && !closed) channel?.postMessage(m);
    },
    toLeader: (m) => {
      if (!leader && !closed) channel?.postMessage(m);
    },
    close: () => {
      if (closed) return;
      closed = true;
      stopLeading?.();
      stopLeading = null;
      leader = false;
      release?.();
      abort.abort();
      channel?.close();
    },
  };
}
