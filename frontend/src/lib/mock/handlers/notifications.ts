import { publishInbox } from "../realtime";
import { CHANNEL_ORDER, withDefaults } from "@/features/notifications/channels/model";
import { isKnownTimeZone, isValidTime } from "@/features/notifications/channels/quiet";
import type { NotificationChannel, NotificationEvent, NotificationPreferences, QuietHours } from "@/lib/api/types";
import { retimeDeferred } from "../channels-dispatch";
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
    publishInbox(ctx.db, userId);
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
    if (changed.length) publishInbox(ctx.db, userId);
    return { ids: changed };
  });

  route("GET", "/notification-preferences", (ctx) => {
    const userId = requireUser(ctx);
    let rec = ctx.db.prefs.find((p) => p.userId === userId);
    if (!rec) {
      rec = { userId, prefs: defaultPrefs() };
      ctx.db.prefs.push(rec);
    }
    // Board 38: a row cached before v2 gains the channel keys and quiet hours.
    rec.prefs = withDefaults(rec.prefs);
    return rec.prefs;
  });

  /*
   * Board 38 (§5.13): per event, only the channel keys present change (a v1 client sending in_app /
   * email keeps telegram / sms / push); quietHours, when present, is validated and replaced whole.
   */
  route("PUT", "/notification-preferences", (ctx) => {
    const userId = requireUser(ctx);
    const next = ctx.body as Partial<NotificationPreferences> | null;
    if (!next?.events || !["instant", "hourly", "daily"].includes(next.emailDelivery ?? "")) invalid({ prefs: "Invalid preferences" });
    let rec = ctx.db.prefs.find((p) => p.userId === userId);
    if (!rec) {
      rec = { userId, prefs: defaultPrefs() };
      ctx.db.prefs.push(rec);
    }
    const cur = withDefaults(rec.prefs);
    let quiet: QuietHours = cur.quietHours;
    if (next.quietHours !== undefined) {
      const q = next.quietHours as Partial<QuietHours> | null;
      const fields: Record<string, string> = {};
      const timeOk = (t: unknown) => typeof t === "string" && isValidTime(t);
      if (!q || typeof q !== "object") fields.quietHours = "Invalid quiet hours";
      else {
        if (!timeOk(q.from)) fields["quietHours.from"] = "Use HH:MM";
        if (!timeOk(q.to)) fields["quietHours.to"] = "Use HH:MM";
        else if (q.from === q.to) fields["quietHours.to"] = "End must differ from start";
        if (q.timezone !== null && (typeof q.timezone !== "string" || !isKnownTimeZone(q.timezone))) fields["quietHours.timezone"] = "Unknown time zone";
        if (!Array.isArray(q.days) || q.days.length !== 7 || q.days.some((d) => typeof d !== "boolean")) fields["quietHours.days"] = "Pick 7 days";
        if (typeof q.enabled !== "boolean") fields["quietHours.enabled"] = "Must be true or false";
        if (typeof q.urgentBypass !== "boolean") fields["quietHours.urgentBypass"] = "Must be true or false";
      }
      if (Object.keys(fields).length) invalid(fields);
      const v = q as QuietHours;
      quiet = { enabled: v.enabled, from: v.from, to: v.to, timezone: v.timezone, days: [...v.days] as QuietHours["days"], urgentBypass: v.urgentBypass };
    }
    const events = { ...cur.events };
    for (const ev of Object.keys(events) as NotificationEvent[]) {
      const incoming = (next.events as Partial<Record<NotificationEvent, Partial<Record<NotificationChannel, boolean>>>>)[ev];
      if (!incoming) continue;
      const row = { ...events[ev] };
      for (const ch of CHANNEL_ORDER) if (ch in incoming) row[ch] = Boolean(incoming[ch]);
      events[ev] = row;
    }
    const prefs: NotificationPreferences = { events, emailDelivery: next.emailDelivery!, quietHours: quiet };
    rec.prefs = prefs;
    if (next.quietHours !== undefined) retimeDeferred(ctx.db, userId, quiet);
    return prefs;
  });

  route("GET", "/me/recents", (ctx) => {
    const userId = requireUser(ctx);
    return ctx.db.recents.filter((r) => r.userId === userId).slice(0, 8);
  });
}
