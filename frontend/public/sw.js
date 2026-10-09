// Lightex service worker: Web Push only (board 38, docs/v2/38-telegram-sms-push.md §8.6).
// A plain static file served at /sw.js with scope "/". No imports, no fetch listener (no caching, no
// offline behaviour), so it can never interfere with the app or the mock API.
// const SW_VERSION = "38.2"; bump on every change.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    /* malformed: a push must still show something */
  }
  if (!d || typeof d !== "object") d = {};
  const title = typeof d.title === "string" ? d.title.slice(0, 80) : "Lightex";
  e.waitUntil(
    self.registration.showNotification(title, {
      body: typeof d.body === "string" ? d.body.slice(0, 200) : "",
      icon: "/icon-512.png",
      badge: "/push-badge.png",
      tag: typeof d.tag === "string" && d.tag ? d.tag : undefined,
      renotify: Boolean(d.tag),
      timestamp: d.ts ? Date.parse(d.ts) : Date.now(),
      data: { url: safeUrl(d.url) },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        same.postMessage({ type: "lightex:navigate", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (e) => {
  // No token here: ask an open tab to re-sync; otherwise the next app load does.
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((ws) => ws.forEach((w) => w.postMessage({ type: "lightex:push-resync" }))),
  );
});

// Same-origin URLs only, so a payload can't become an open redirect.
function safeUrl(u) {
  // A missing url would otherwise resolve to "/undefined".
  if (typeof u !== "string" || !u) return "/";
  try {
    const x = new URL(u, self.location.origin);
    return x.origin === self.location.origin ? x.href : "/";
  } catch {
    return "/";
  }
}
