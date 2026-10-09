import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { PresenceLocation, PresenceUpdate } from "@/lib/api/types";
import { mergeRoster, type CachedRoster } from "./roster";

/*
 * Tab presence (spec §2.8). Each browser tab reports one location. Screens *claim* a location
 * (board, dashboard, task); the most specific claim wins (a task panel open over the board reports
 * the task). One engine per tab sends:
 * - PUT /workspaces/:slug/presence/:sessionId every 20 s while the tab is visible, and 300 ms
 *   (debounced) after the location, state, field or typing changes; its roster goes into
 *   qk.presence, which keeps presence fresh in polling mode;
 * - typing re-sent every 4 s while keys keep coming (touch());
 * - DELETE after 30 s hidden, on pagehide (fetch keepalive + bearer header), or with no claim.
 * The session id is crypto.randomUUID() per tab, in memory only.
 */

export const HEARTBEAT_MS = 20_000;
export const DEBOUNCE_MS = 300;
export const HIDDEN_LEAVE_MS = 30_000;

export type PresenceClaim = PresenceUpdate & {
  projectId: string;
  /** Mock teammate simulator hint: the comment composer is on screen. Never sent. */
  composer?: boolean;
};

const PRIORITY: Record<PresenceLocation["kind"], number> = { board: 1, dashboard: 2, task: 3 };

type Entry = PresenceClaim & { seq: number };
const claims = new Map<number, Entry>();
const listeners = new Set<() => void>();
let seq = 0;
let nextId = 0;
let sessionId: string | null = null;

function emit() {
  listeners.forEach((l) => l());
}

export function tabSessionId() {
  sessionId ??= typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return sessionId;
}

export const presenceClaims = {
  newId: () => ++nextId,
  set(id: number, claim: PresenceClaim) {
    const prev = claims.get(id);
    claims.set(id, { ...claim, seq: prev && sameLocation(prev, claim) ? prev.seq : ++seq });
    emit();
  },
  remove(id: number) {
    if (claims.delete(id)) emit();
  },
  /** The claim this tab reports: highest priority, then the latest. */
  active(): PresenceClaim | null {
    let best: Entry | null = null;
    for (const c of claims.values()) {
      if (!best || PRIORITY[c.location.kind] > PRIORITY[best.location.kind] || (PRIORITY[c.location.kind] === PRIORITY[best.location.kind] && c.seq > best.seq)) best = c;
    }
    if (!best) return null;
    const { seq: _s, ...rest } = best;
    return rest;
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Typing keep-alive: re-send even though nothing changed (at most every 4 s, the caller's rule). */
  touch() {
    touchListeners.forEach((l) => l());
  },
  /** Tests. */
  reset() {
    claims.clear();
    sessionId = null;
    emit();
  },
};
const touchListeners = new Set<() => void>();

function sameLocation(a: PresenceClaim, b: PresenceClaim) {
  return a.location.kind === b.location.kind && a.location.id === b.location.id;
}

const wire = (c: PresenceClaim): PresenceUpdate => ({
  location: c.location,
  state: c.state,
  field: c.state === "editing" ? c.field : null,
  typing: c.typing && (c.field === "comment" || c.field === "description"),
});

export type PresenceEngineOptions = {
  slug: string;
  qc: QueryClient;
  isVisible?: () => boolean;
};

export function startPresenceEngine(o: PresenceEngineOptions) {
  const visible = o.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const sid = tabSessionId();
  let sentKey: string | null = null;
  let sentProject: string | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const put = async (force = false) => {
    if (stopped) return;
    const c = presenceClaims.active();
    if (!c) {
      if (sentKey) await leave();
      return;
    }
    const body = wire(c);
    const key = JSON.stringify(body);
    if (!force && key === sentKey) return;
    sentKey = key;
    sentProject = c.projectId;
    try {
      const res = await api.presence.put(o.slug, sid, body);
      if (stopped) return;
      o.qc.setQueryData<CachedRoster>(qk.presence(o.slug, res.roster.projectId), (old) => mergeRoster(old, res.roster));
    } catch {
      // Best effort: the next heartbeat retries. A failed PUT must never bother the user.
      sentKey = null;
    }
  };

  const leave = async (keepalive = false) => {
    if (!sentKey) return;
    sentKey = null;
    try {
      await api.presence.leave(o.slug, sid, { keepalive });
    } catch {
      /* the 45 s TTL removes the row */
    }
  };

  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void put(), DEBOUNCE_MS);
  };
  const unsub = presenceClaims.subscribe(schedule);
  const onTouch = () => void put(true);
  touchListeners.add(onTouch);

  const beat = setInterval(() => {
    if (visible()) void put(true);
  }, HEARTBEAT_MS);

  const onVisibility = () => {
    clearTimeout(hiddenTimer);
    if (visible()) void put(true);
    else hiddenTimer = setTimeout(() => void leave(), HIDDEN_LEAVE_MS);
  };
  const onPageHide = () => void leave(true);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  schedule();

  return {
    sessionId: sid,
    projectId: () => sentProject,
    stop() {
      stopped = true;
      clearTimeout(debounce);
      clearTimeout(hiddenTimer);
      clearInterval(beat);
      unsub();
      touchListeners.delete(onTouch);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      if (sentKey) {
        sentKey = null;
        void api.presence.leave(o.slug, sid).catch(() => undefined);
      }
    },
  };
}
