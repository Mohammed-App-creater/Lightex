import { api } from "@/lib/api/endpoints";
import { isApiError } from "@/lib/api/errors";
import type { PushDevice, PushSubscriptionInput } from "@/lib/api/types";
import { apiMode } from "@/lib/env";
import { browserTimeZone } from "./quiet";

/*
 * Web Push in the browser (board 38, spec §8.6). The service worker is the static file public/sw.js
 * (scope "/", no fetch listener). Everything that touches the browser goes through a PushPlatform, so
 * the flows below are testable with fakePushPlatform():
 *
 * - enablePush: permission inside the click → subscribe → C11 "subscribe" (unsubscribes again if C11 fails);
 * - turnOffPush: C12 with the endpoint, then unsubscribe (locally even if C12 fails);
 * - checkAgain: re-read the permission;
 * - syncPush (once per tab session): key rotation → re-subscribe; else C11 "refresh", 404 → drop locally;
 * - logoutPush: C12 + unsubscribe before the anonymous logout call, never waiting more than 1.5 s.
 */

export type PushSupport = "supported" | "unsupported" | "ios-needs-install";
export type PushSub = PushSubscriptionInput["subscription"];

export interface PushPlatform {
  support(): PushSupport;
  permission(): NotificationPermission;
  /** Must run inside the user's click. */
  requestPermission(): Promise<NotificationPermission>;
  /** This browser's subscription. */
  current(): Promise<PushSub | null>;
  /** base64url of the current subscription's applicationServerKey (key-rotation check). */
  currentKey(): Promise<string | null>;
  subscribe(vapidKey: string): Promise<PushSub>;
  unsubscribe(): Promise<void>;
  /** A local notification through the registered service worker (mock tests). */
  showLocal(title: string, body: string): Promise<void>;
}

/* ───────── base64url ───────── */

export function urlB64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToUrlB64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ───────── support ───────── */

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Mac; touch points give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

export function detectSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const standalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  if (isIos() && !standalone) return "ios-needs-install";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window ? "supported" : "unsupported";
}

const readPermission = (): NotificationPermission => (typeof Notification === "undefined" ? "default" : Notification.permission);

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration("/");
}

const toSub = (s: PushSubscription): PushSub => {
  const j = s.toJSON();
  return { endpoint: j.endpoint ?? s.endpoint, expirationTime: j.expirationTime ?? null, keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" } };
};

async function showViaWorker(title: string, body: string) {
  if (readPermission() !== "granted") return;
  const reg = await existingRegistration().catch(() => undefined);
  const opts: NotificationOptions = { body, icon: "/icon-512.png", badge: "/push-badge.png", tag: "lightex-test" };
  if (reg) await reg.showNotification(title, opts);
  else new Notification(title, opts);
}

/** The real browser: a real subscription with the push service. */
export const browserPushPlatform: PushPlatform = {
  support: detectSupport,
  permission: readPermission,
  requestPermission: () => Notification.requestPermission(),
  async current() {
    const reg = await existingRegistration();
    const s = await reg?.pushManager.getSubscription();
    return s ? toSub(s) : null;
  },
  async currentKey() {
    const reg = await existingRegistration();
    const key = (await reg?.pushManager.getSubscription())?.options.applicationServerKey;
    return key ? bytesToUrlB64(key) : null;
  },
  async subscribe(vapidKey) {
    const reg = await registration();
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidKey) });
    return toSub(s);
  },
  async unsubscribe() {
    const reg = await existingRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  },
  showLocal: showViaWorker,
};

/* ───────── mock (§8.8): real permission + SW, fake subscription; never contacts a push service ───────── */

const MOCK_SUB_KEY = "lightex-mock-push-sub";

function randomB64(bytes: number, first?: number) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  if (first !== undefined) b[0] = first;
  return bytesToUrlB64(b);
}

function readMockSub(): (PushSub & { key: string }) | null {
  try {
    const raw = localStorage.getItem(MOCK_SUB_KEY);
    return raw ? (JSON.parse(raw) as PushSub & { key: string }) : null;
  } catch {
    return null;
  }
}

export const mockPushPlatform: PushPlatform = {
  support: detectSupport,
  permission: readPermission,
  requestPermission: () => Notification.requestPermission(),
  async current() {
    const s = readMockSub();
    return s ? { endpoint: s.endpoint, expirationTime: s.expirationTime, keys: s.keys } : null;
  },
  async currentKey() {
    return readMockSub()?.key ?? null;
  },
  async subscribe(vapidKey) {
    // A real registration (so showLocal works), but no pushManager.subscribe.
    await registration().catch(() => undefined);
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomB64(16);
    const sub: PushSub = {
      endpoint: `https://fcm.googleapis.com/fcm/send/mock-${id}`,
      expirationTime: null,
      keys: { p256dh: randomB64(65, 0x04), auth: randomB64(16) },
    };
    try {
      localStorage.setItem(MOCK_SUB_KEY, JSON.stringify({ ...sub, key: vapidKey }));
    } catch {
      /* storage unavailable: this tab only */
    }
    return sub;
  },
  async unsubscribe() {
    try {
      localStorage.removeItem(MOCK_SUB_KEY);
    } catch {
      /* ignore */
    }
  },
  showLocal: showViaWorker,
};

let platform: PushPlatform | null = null;
export const getPushPlatform = (): PushPlatform => platform ?? (apiMode === "mock" ? mockPushPlatform : browserPushPlatform);
/** Tests and e2e inject a scripted platform. */
export function setPushPlatform(p: PushPlatform | null) {
  platform = p;
}

/** A scripted platform for jsdom tests: `answer` is what the permission prompt returns. */
export function fakePushPlatform(opts: { support?: PushSupport; permission?: NotificationPermission; answer?: NotificationPermission; sub?: PushSub | null; key?: string | null } = {}) {
  const state = {
    support: opts.support ?? ("supported" as PushSupport),
    permission: opts.permission ?? ("default" as NotificationPermission),
    answer: opts.answer ?? ("granted" as NotificationPermission),
    sub: opts.sub ?? null,
    key: opts.key ?? null,
    calls: [] as string[],
    shown: [] as { title: string; body: string }[],
  };
  let n = 0;
  const p: PushPlatform = {
    support: () => state.support,
    permission: () => state.permission,
    async requestPermission() {
      state.calls.push("requestPermission");
      state.permission = state.answer;
      return state.answer;
    },
    async current() {
      return state.sub;
    },
    async currentKey() {
      return state.sub ? state.key : null;
    },
    async subscribe(key) {
      state.calls.push("subscribe");
      n += 1;
      state.sub = { endpoint: `https://fcm.googleapis.com/fcm/send/fake-${n}`, expirationTime: null, keys: { p256dh: `B${"A".repeat(86)}`, auth: "AAAAAAAAAAAAAAAAAAAAAA" } };
      state.key = key;
      return state.sub;
    },
    async unsubscribe() {
      state.calls.push("unsubscribe");
      state.sub = null;
      state.key = null;
    },
    async showLocal(title, body) {
      state.shown.push({ title, body });
    },
  };
  return { platform: p, state };
}

/* ───────── flows ───────── */

type PushApi = Pick<typeof api.channels, "savePush" | "removePushByEndpoint" | "vapidKey">;
const defaultApi = (): PushApi => api.channels;

export type PushOutcome = "on" | "off" | "blocked";

/** Subscribe this browser and save it (C11 subscribe). If C11 fails, the browser subscription is dropped again. */
export async function subscribeAndSave(p: PushPlatform, vapidKey: string, deps: PushApi = defaultApi()): Promise<PushDevice> {
  const sub = await p.subscribe(vapidKey);
  try {
    return await deps.savePush({ mode: "subscribe", subscription: sub, timezone: browserTimeZone() });
  } catch (e) {
    await p.unsubscribe().catch(() => undefined);
    throw e;
  }
}

/** Enable (a click): the browser prompt → subscribe → save. "off" when the prompt was dismissed. */
export async function enablePush(p: PushPlatform, vapidKey: string, deps: PushApi = defaultApi()): Promise<PushOutcome> {
  const answer = p.permission() === "granted" ? "granted" : await p.requestPermission();
  if (answer === "denied") return "blocked";
  if (answer !== "granted") return "off";
  await subscribeAndSave(p, vapidKey, deps);
  return "on";
}

/** Check again (Blocked state): denied stays blocked, default → Off, granted → subscribe now. */
export async function checkAgain(p: PushPlatform, vapidKey: string, deps: PushApi = defaultApi()): Promise<PushOutcome> {
  const now = p.permission();
  if (now === "denied") return "blocked";
  if (now === "default") return "off";
  await subscribeAndSave(p, vapidKey, deps);
  return "on";
}

/**
 * Turn off: C12, then the local unsubscribe, which happens even when C12 fails (the server row then
 * expires at its next send). Resolves false when only the local half worked.
 */
export async function turnOffPush(p: PushPlatform, deps: PushApi = defaultApi()): Promise<boolean> {
  const sub = await p.current();
  let removed = true;
  try {
    if (sub) await deps.removePushByEndpoint(sub.endpoint);
  } catch {
    removed = false;
  }
  await p.unsubscribe();
  return removed;
}

export type SyncResult = "none" | "refreshed" | "resubscribed" | "dropped";

/** App-load sync (§8.6). Only does anything when permission is granted and a subscription exists. */
export async function syncPush(p: PushPlatform, deps: PushApi = defaultApi(), serverKey?: string | null): Promise<SyncResult> {
  if (p.support() !== "supported" || p.permission() !== "granted") return "none";
  const sub = await p.current();
  if (!sub) return "none";
  const key = serverKey ?? (await deps.vapidKey()).publicKey;
  const mine = await p.currentKey();
  if (mine && key && mine !== key) {
    await p.unsubscribe();
    await subscribeAndSave(p, key, deps);
    return "resubscribed";
  }
  try {
    await deps.savePush({ mode: "refresh", subscription: sub, timezone: browserTimeZone() });
    return "refreshed";
  } catch (e) {
    if (isApiError(e) && e.status === 404) {
      // This browser belongs to another account, or was turned off elsewhere.
      await p.unsubscribe();
      return "dropped";
    }
    throw e;
  }
}

/** Logout clean-up: C12 + unsubscribe, errors ignored, at most `timeoutMs`. */
export async function logoutPush(p: PushPlatform = getPushPlatform(), deps: PushApi = defaultApi(), timeoutMs = 1500): Promise<void> {
  const work = (async () => {
    if (p.support() !== "supported") return;
    const sub = await p.current();
    if (!sub) return;
    try {
      await deps.removePushByEndpoint(sub.endpoint);
    } finally {
      await p.unsubscribe();
    }
  })().catch(() => undefined);
  await Promise.race([work, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}
