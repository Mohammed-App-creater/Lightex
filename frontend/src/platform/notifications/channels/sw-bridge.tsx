"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import { pushUrl } from "@/lib/routes";
import { getPushPlatform, syncPush } from "./push";

/*
 * Board 38 (spec §8.6): the page side of public/sw.js.
 * - ServiceWorkerBridge (in Providers): a notification click posts `lightex:navigate`; a same-route
 *   change is a pushUrl, a different route a router.push (the one place that is right: a real route change).
 * - usePushSync (in the workspace shell): once per tab session, and on `lightex:push-resync`.
 */

export function navigateTarget(url: string, here: Location): { kind: "query" | "route"; path: string } | null {
  try {
    const u = new URL(url, here.origin);
    if (u.origin !== here.origin) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    return { kind: u.pathname === here.pathname ? "query" : "route", path };
  } catch {
    return null;
  }
}

export function ServiceWorkerBridge() {
  const router = useRouter();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type !== "lightex:navigate" || typeof d.url !== "string") return;
      const t = navigateTarget(d.url, window.location);
      if (!t) return;
      if (t.kind === "query") pushUrl(t.path);
      else router.push(t.path);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);
  return null;
}

const SYNC_KEY = "lightex-push-synced";

export function usePushSync() {
  const qc = useQueryClient();
  useEffect(() => {
    const run = async (force: boolean) => {
      try {
        if (!force && sessionStorage.getItem(SYNC_KEY)) return;
        sessionStorage.setItem(SYNC_KEY, "1");
      } catch {
        /* storage blocked: sync anyway */
      }
      const p = getPushPlatform();
      if (p.support() !== "supported" || p.permission() !== "granted") return;
      try {
        const out = await syncPush(p, api.channels, qc.getQueryData<{ push: { vapidPublicKey: string | null } }>(qk.channels())?.push.vapidPublicKey);
        if (out === "dropped" || out === "resubscribed") void qc.invalidateQueries({ queryKey: qk.channels() });
      } catch {
        /* best effort: the next load tries again */
      }
    };
    void run(false);
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "lightex:push-resync") void run(true);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [qc]);
}

/** Mount point for the workspace shell. */
export function PushSync() {
  usePushSync();
  return null;
}
