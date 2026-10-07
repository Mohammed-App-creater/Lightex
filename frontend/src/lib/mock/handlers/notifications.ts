import type { NotificationPreferences } from "@/lib/api/types";
import { nowISO } from "../db";
import { defaultPrefs } from "../seed";
import { fail, filterValues, invalid, paginate, requireUser, route } from "../router";

export function registerNotifications() {
  route("GET", "/notifications", (ctx) => {
    const userId = requireUser(ctx);
    const tab = filterValues(ctx.query, "tab")[0] ?? "all";
    const unread = filterValues(ctx.query, "unread")[0] === "true";
    const workspaceId = filterValues(ctx.query, "workspace")[0];
    const projectIds = workspaceId ? ctx.db.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id) : null;
    const mine = ctx.db.notifications.filter((n) => n.recipientId === userId && (!projectIds || projectIds.includes(n.projectId)));
    const list = mine
      .filter((n) => tab === "all" || (tab === "mentions" ? n.type === "mention" : n.type === "assigned"))
      .filter((n) => !unread || !n.readAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ recipientId: _r, ...n }) => n);
    return {
      ...paginate(list, ctx.query, 100),
      counts: {
        all: mine.length,
        mentions: mine.filter((n) => n.type === "mention").length,
        assigned: mine.filter((n) => n.type === "assigned").length,
        unread: mine.filter((n) => !n.readAt).length,
      },
    };
  });

  route("GET", "/notifications/unread-count", (ctx) => {
    const userId = requireUser(ctx);
    const workspaceId = filterValues(ctx.query, "workspace")[0];
    const projectIds = workspaceId ? ctx.db.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id) : null;
    return {
      count: ctx.db.notifications.filter((n) => n.recipientId === userId && !n.readAt && (!projectIds || projectIds.includes(n.projectId))).length,
    };
  });

  route("POST", "/notifications/:id/read", (ctx) => {
    const userId = requireUser(ctx);
    const n = ctx.db.notifications.find((x) => x.id === ctx.params.id && x.recipientId === userId);
    if (!n) fail(404, "not_found", "Notification not found.");
    const read = (ctx.body as { read?: boolean })?.read !== false;
    n.readAt = read ? nowISO() : null;
    const { recipientId: _r, ...rest } = n;
    return rest;
  });

  /** Returns the ids it changed so the client can offer Undo (re-mark those unread). */
  route("POST", "/notifications/read-all", (ctx) => {
    const userId = requireUser(ctx);
    const ids = (ctx.body as { ids?: string[] })?.ids;
    const undo = (ctx.body as { unread?: boolean })?.unread === true;
    const changed: string[] = [];
    ctx.db.notifications
      .filter((n) => n.recipientId === userId && (!ids || ids.includes(n.id)))
      .forEach((n) => {
        if (undo && n.readAt) {
          n.readAt = null;
          changed.push(n.id);
        } else if (!undo && !n.readAt) {
          n.readAt = nowISO();
          changed.push(n.id);
        }
      });
    return { ids: changed };
  });

  route("GET", "/notification-preferences", (ctx) => {
    const userId = requireUser(ctx);
    let rec = ctx.db.prefs.find((p) => p.userId === userId);
    if (!rec) {
      rec = { userId, prefs: defaultPrefs() };
      ctx.db.prefs.push(rec);
    }
    return rec.prefs;
  });

  route("PUT", "/notification-preferences", (ctx) => {
    const userId = requireUser(ctx);
    const next = ctx.body as NotificationPreferences;
    if (!next?.events || !["instant", "hourly", "daily"].includes(next.emailDelivery)) invalid({ prefs: "Invalid preferences" });
    const rec = ctx.db.prefs.find((p) => p.userId === userId);
    // Only in-app and email exist in v1; any other channel keys are dropped.
    const clean = Object.fromEntries(
      Object.entries(next.events).map(([k, v]) => [k, { in_app: Boolean(v.in_app), email: Boolean(v.email) }]),
    ) as NotificationPreferences["events"];
    const prefs = { events: clean, emailDelivery: next.emailDelivery };
    if (rec) rec.prefs = prefs;
    else ctx.db.prefs.push({ userId, prefs });
    return prefs;
  });

  route("GET", "/me/recents", (ctx) => {
    const userId = requireUser(ctx);
    return ctx.db.recents.filter((r) => r.userId === userId).slice(0, 8);
  });
}
