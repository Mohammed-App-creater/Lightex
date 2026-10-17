import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { PushDevice, PushSubscriptionInput } from "@/lib/api/types";
import { bytesToUrlB64, checkAgain, enablePush, fakePushPlatform, logoutPush, syncPush, turnOffPush, urlB64ToUint8Array } from "./push";

/* Board 38 §8.6: the push flows over a scripted platform, and public/sw.js's handlers. */

const device: PushDevice = { id: "pd", label: "Chrome on macOS", endpointHash: "x", status: "active", createdAt: "", lastSeenAt: "", lastSuccessAt: null };

function fakeApi(opts: { saveFails?: unknown; removeFails?: boolean; key?: string } = {}) {
  const calls: string[] = [];
  const saved: PushSubscriptionInput[] = [];
  return {
    calls,
    saved,
    api: {
      savePush: vi.fn(async (body: PushSubscriptionInput) => {
        calls.push(`savePush:${body.mode}`);
        saved.push(body);
        if (opts.saveFails) throw opts.saveFails;
        return device;
      }),
      removePushByEndpoint: vi.fn(async (endpoint: string) => {
        calls.push(`remove:${endpoint}`);
        if (opts.removeFails) throw new Error("offline");
      }),
      vapidKey: vi.fn(async () => {
        calls.push("vapidKey");
        return { publicKey: opts.key ?? "KEY" };
      }),
    },
  };
}

describe("push flows", () => {
  it("default → granted → subscribe → C11 subscribe", async () => {
    const f = fakePushPlatform({ answer: "granted" });
    const a = fakeApi();
    expect(await enablePush(f.platform, "KEY", a.api)).toBe("on");
    expect(f.state.calls).toEqual(["requestPermission", "subscribe"]);
    expect(a.saved[0]).toMatchObject({ mode: "subscribe", subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/fake-1" } });
  });

  it("denied → blocked, dismissed → off, nothing subscribed", async () => {
    const denied = fakePushPlatform({ answer: "denied" });
    expect(await enablePush(denied.platform, "KEY", fakeApi().api)).toBe("blocked");
    const dismissed = fakePushPlatform({ answer: "default" });
    expect(await enablePush(dismissed.platform, "KEY", fakeApi().api)).toBe("off");
    expect(denied.state.calls).not.toContain("subscribe");
  });

  it("drops the browser subscription when C11 fails", async () => {
    const f = fakePushPlatform({ answer: "granted" });
    await expect(enablePush(f.platform, "KEY", fakeApi({ saveFails: new Error("422") }).api)).rejects.toThrow("422");
    expect(f.state.calls).toEqual(["requestPermission", "subscribe", "unsubscribe"]);
    expect(f.state.sub).toBeNull();
  });

  it("Check again re-reads the permission", async () => {
    expect(await checkAgain(fakePushPlatform({ permission: "denied" }).platform, "KEY", fakeApi().api)).toBe("blocked");
    expect(await checkAgain(fakePushPlatform({ permission: "default" }).platform, "KEY", fakeApi().api)).toBe("off");
    expect(await checkAgain(fakePushPlatform({ permission: "granted" }).platform, "KEY", fakeApi().api)).toBe("on");
  });

  it("Turn off calls C12 then unsubscribes, locally even when C12 fails", async () => {
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/e1", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
    const f = fakePushPlatform({ permission: "granted", sub, key: "KEY" });
    const a = fakeApi({ removeFails: true });
    expect(await turnOffPush(f.platform, a.api)).toBe(false);
    expect(a.calls).toEqual(["remove:https://fcm.googleapis.com/fcm/send/e1"]);
    expect(f.state.sub).toBeNull();
  });

  it("syncs: nothing without permission, refresh normally, re-subscribe on key rotation, drop on 404", async () => {
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/e1", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
    expect(await syncPush(fakePushPlatform({ permission: "default", sub }).platform, fakeApi().api)).toBe("none");
    expect(await syncPush(fakePushPlatform({ permission: "granted" }).platform, fakeApi().api)).toBe("none");

    const same = fakeApi();
    expect(await syncPush(fakePushPlatform({ permission: "granted", sub, key: "KEY" }).platform, same.api)).toBe("refreshed");
    expect(same.calls).toEqual(["vapidKey", "savePush:refresh"]);

    const rotated = fakePushPlatform({ permission: "granted", sub, key: "OLD" });
    const r = fakeApi({ key: "NEW" });
    expect(await syncPush(rotated.platform, r.api)).toBe("resubscribed");
    expect(rotated.state.calls).toEqual(["unsubscribe", "subscribe"]);
    expect(rotated.state.key).toBe("NEW");
    expect(r.calls).toEqual(["vapidKey", "savePush:subscribe"]);

    const gone = fakePushPlatform({ permission: "granted", sub, key: "KEY" });
    expect(await syncPush(gone.platform, fakeApi({ saveFails: new ApiError({ status: 404, code: "not_found", message: "x" }) }).api, "KEY")).toBe("dropped");
    expect(gone.state.sub).toBeNull();
  });

  it("logout: C12 before unsubscribe, never longer than the cap, errors ignored", async () => {
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/e1", expirationTime: null, keys: { p256dh: "p", auth: "a" } };
    const f = fakePushPlatform({ permission: "granted", sub });
    const order: string[] = [];
    await logoutPush(f.platform, {
      savePush: vi.fn(),
      vapidKey: vi.fn(),
      removePushByEndpoint: vi.fn(async () => {
        order.push("C12");
        throw new Error("down");
      }),
    } as never);
    order.push(...f.state.calls);
    expect(order).toEqual(["C12", "unsubscribe"]);

    vi.useFakeTimers();
    try {
      const slow = fakePushPlatform({ permission: "granted", sub });
      let done = false;
      const p = logoutPush(slow.platform, { removePushByEndpoint: () => new Promise(() => undefined) } as never, 1500).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1499);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("round-trips base64url", () => {
    const bytes = urlB64ToUint8Array("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U");
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(bytesToUrlB64(bytes)).toBe("BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U");
  });
});

/* ───────── public/sw.js ───────── */

type Listener = (e: Record<string, unknown>) => void;

function loadWorker(windows: { url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[] = []) {
  const listeners: Record<string, Listener> = {};
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://app.lightex.dev" },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(async (title: string, opts: Record<string, unknown>) => void shown.push({ title, opts })) },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async (u: string) => void opened.push(u)),
    },
  };
  const src = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", src)(self);
  const fire = async (type: string, extra: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...extra, waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
  };
  return { listeners, self, shown, opened, fire };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) } });

describe("public/sw.js", () => {
  it("registers install / activate / push / notificationclick / pushsubscriptionchange and no fetch listener", () => {
    const w = loadWorker();
    expect(Object.keys(w.listeners).sort()).toEqual(["activate", "install", "notificationclick", "push", "pushsubscriptionchange"]);
  });

  it("shows the payload, truncated, with a same-origin URL", async () => {
    const w = loadWorker();
    await w.fire("push", pushEvent({ v: 1, title: "PRJ-42 assigned to you".padEnd(100, "!"), body: "b".repeat(300), url: "https://app.lightex.dev/platform/tasks/PRJ-42", tag: "task:1", ts: "2026-10-09T09:15:03Z" }));
    const n = w.shown[0]!;
    expect(n.title).toHaveLength(80);
    expect(n.opts.body).toHaveLength(200);
    expect(n.opts).toMatchObject({ tag: "task:1", renotify: true, icon: "/icon-512.png", badge: "/push-badge.png", timestamp: Date.parse("2026-10-09T09:15:03Z"), data: { url: "https://app.lightex.dev/platform/tasks/PRJ-42" } });
  });

  it("still shows something for a malformed or empty push, and never opens another origin", async () => {
    const w = loadWorker();
    await w.fire("push", pushEvent("{not json"));
    expect(w.shown[0]).toMatchObject({ title: "Lightex", opts: { body: "", data: { url: "/" } } });
    await w.fire("push", { data: null });
    expect(w.shown[1]!.title).toBe("Lightex");
    await w.fire("push", pushEvent({ title: "x", url: "https://evil.example/phish" }));
    expect(w.shown[2]!.opts.data).toEqual({ url: "/" });
    expect(w.shown[2]!.opts.renotify).toBe(false);
  });

  it("a click focuses an open app window and asks it to navigate; otherwise opens one", async () => {
    const win = { url: "https://app.lightex.dev/platform/inbox", focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    const other = { url: "https://elsewhere.dev/", focus: vi.fn(), postMessage: vi.fn() };
    const w = loadWorker([other, win]);
    const close = vi.fn();
    await w.fire("notificationclick", { notification: { close, data: { url: "https://app.lightex.dev/platform/tasks/PRJ-42" } } });
    expect(close).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.postMessage).toHaveBeenCalledWith({ type: "lightex:navigate", url: "https://app.lightex.dev/platform/tasks/PRJ-42" });
    expect(other.postMessage).not.toHaveBeenCalled();

    const none = loadWorker([]);
    await none.fire("notificationclick", { notification: { close: vi.fn(), data: null } });
    expect(none.opened).toEqual(["/"]);
  });

  it("pushsubscriptionchange asks open tabs to re-sync", async () => {
    const win = { url: "https://app.lightex.dev/", focus: vi.fn(), postMessage: vi.fn() };
    const w = loadWorker([win]);
    await w.fire("pushsubscriptionchange", {});
    expect(win.postMessage).toHaveBeenCalledWith({ type: "lightex:push-resync" });
  });
});
