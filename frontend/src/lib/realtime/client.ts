import type { QueryClient } from "@tanstack/react-query";
import { authEvents } from "@/lib/api/session";
import { createEventApplier, type EventApplier, type Scheduler } from "./apply-event";
import type { RealtimeEnvelope } from "./events";
import { joinTabs, type TabMessage, type TabsEnv } from "./leader";
import { RealtimeLoop } from "./loop";
import { onScreen } from "./screen-registry";
import { getRealtimeSource, realtimeDisabledByBuild, type RealtimeSource } from "./source";
import { realtimeStatus } from "./status-store";

/*
 * The realtime client for one workspace in one tab (spec §7.7), without React so it can be tested
 * with simulated tabs. The leader runs the loop and forwards everything to the other tabs; every
 * tab applies events to its own QueryClient.
 */

export const HIDDEN_CLOSE_MS = 120_000;
export const VISIBLE_PING_MS = 20_000;
const ACTIVE_CHECK_MS = 15_000;

export type RealtimeOptions = {
  slug: string;
  qc: QueryClient;
  meId: string;
  workspaceId?: string;
  env?: TabsEnv;
  getSource?: () => Promise<RealtimeSource>;
  isVisible?: () => boolean;
  now?: () => number;
  schedule?: Scheduler;
  forcePolling?: boolean;
};

export type RealtimeHandle = {
  applier: EventApplier;
  isLeader: () => boolean;
  /** The leader's loop (tests, dev tools). */
  loop: () => RealtimeLoop | null;
  stop: () => void;
};

export function startRealtime(o: RealtimeOptions): RealtimeHandle {
  const now = o.now ?? Date.now;
  const visible = o.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const applier = createEventApplier(
    o.qc,
    {
      slug: o.slug,
      workspaceId: o.workspaceId,
      meId: o.meId,
      openTaskId: () => onScreen.taskId,
      openDashboardId: () => onScreen.dashboard?.id ?? null,
      onOpenDashboardDeleted: () => onScreen.dashboard?.onDeleted(),
    },
    o.schedule,
  );
  let lastEventId: string | null = null;
  let loop: RealtimeLoop | null = null;
  let lastVisibleAt = now();
  const cleanups: (() => void)[] = [];
  const name = `lightex-rt:${o.slug}`;

  const tabs = joinTabs(
    name,
    {
      onLeader: () => startLeader(),
      onMessage: (m: TabMessage) => {
        switch (m.t) {
          case "event":
            if (m.ev.id) lastEventId = m.ev.id;
            applier.apply(m.ev);
            return;
          case "invalidate-all":
            applier.invalidateAll();
            return;
          case "status":
            if (!tabs.isLeader()) {
              realtimeStatus.set(m.status);
              if (m.lastEventId) lastEventId = m.lastEventId;
            }
            return;
          case "visible":
            if (tabs.isLeader()) {
              lastVisibleAt = now();
              loop?.setActive(true);
            }
            return;
          case "sync":
            if (tabs.isLeader() && loop) tabs.broadcast({ t: "status", status: loop.getStatus(), lastEventId: loop.getLastEventId() });
            return;
        }
      },
    },
    o.env,
  );

  function startLeader() {
    let stopped = false;
    const local: (() => void)[] = [];
    void (o.getSource ?? getRealtimeSource)().then((source) => {
      if (stopped) return;
      const l = new RealtimeLoop({
        slug: o.slug,
        source,
        lastEventId,
        forcePolling: o.forcePolling ?? realtimeDisabledByBuild,
        now,
        onEvent: (ev: RealtimeEnvelope) => {
          applier.apply(ev);
          tabs.broadcast({ t: "event", ev });
        },
        onInvalidateAll: () => {
          applier.invalidateAll();
          tabs.broadcast({ t: "invalidate-all" });
        },
        onStatus: (s) => {
          realtimeStatus.set(s);
          tabs.broadcast({ t: "status", status: s, lastEventId: l.getLastEventId() });
        },
        onLastEventId: (id) => {
          lastEventId = id;
        },
        onExpired: () => authEvents.emit("expired"),
      });
      loop = l;
      // Close the stream when every tab of the workspace has been hidden for 2 minutes.
      const check = () => {
        if (visible()) lastVisibleAt = now();
        l.setActive(visible() || now() - lastVisibleAt < HIDDEN_CLOSE_MS);
      };
      const timer = setInterval(check, ACTIVE_CHECK_MS);
      local.push(() => clearInterval(timer));
      if (typeof document !== "undefined") {
        const onVis = () => check();
        document.addEventListener("visibilitychange", onVis);
        local.push(() => document.removeEventListener("visibilitychange", onVis));
      }
      if (typeof window !== "undefined") {
        const on = () => l.setOnline(true);
        const off = () => l.setOnline(false);
        window.addEventListener("online", on);
        window.addEventListener("offline", off);
        local.push(() => {
          window.removeEventListener("online", on);
          window.removeEventListener("offline", off);
        });
      }
      void l.start();
    });
    return () => {
      stopped = true;
      local.forEach((f) => f());
      loop?.stop();
      loop = null;
    };
  }

  // Followers: say "visible" every 20 s while visible, at once when the tab becomes visible, and
  // ask the leader for its status on arrival.
  const ping = () => {
    if (!tabs.isLeader() && visible()) tabs.toLeader({ t: "visible" });
  };
  const pingTimer = setInterval(ping, VISIBLE_PING_MS);
  cleanups.push(() => clearInterval(pingTimer));
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", ping);
    cleanups.push(() => document.removeEventListener("visibilitychange", ping));
  }
  tabs.toLeader({ t: "sync" });

  return {
    applier,
    isLeader: tabs.isLeader,
    loop: () => loop,
    stop: () => {
      cleanups.forEach((f) => f());
      tabs.close();
    },
  };
}
