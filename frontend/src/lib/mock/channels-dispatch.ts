import { holds, windowEnd } from "@/features/notifications/channels/quiet";
import type { ExternalChannel, NotificationEvent, QuietHours } from "@/lib/api/types";
import { uid } from "./db";
import type { ChannelDeliveryRec, MockDB } from "./db-types";

/*
 * The mock's board 38 dispatcher (spec §6.2, §6.6), applied when a notification is created:
 *
 * - a channel is wanted when the event's preference is on; then the target must be usable
 *   (Telegram / SMS active, one row per active push subscription), SMS needs the workspace policy and
 *   the daily caps;
 * - during quiet hours a row is "deferred" to the end of the window, unless the task is Urgent and the
 *   bypass is on;
 * - releaseDue() sends what is due: one row as it is, two or more for the same target as one "summary"
 *   (the originals become "coalesced"), and anything older than 24 h is skipped as "stale".
 *
 * Nothing is really sent: "sent" rows are the log the backend keeps. No end-user UI shows it (§6.8);
 * C1's `sms.sentToday` counts it.
 */

export const SMS_USER_DAILY_CAP = 10;
export const SMS_GLOBAL_DAILY_CAP = 300;
const LOG_LIMIT = 400;
const STALE_MS = 24 * 3600_000;

const startOfUtcDay = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** Notification SMS sent today (UTC) for the caps and C1; a summary counts once, tests count (§7.5). */
export function smsSentToday(db: MockDB, userId: string | null, now = new Date()): number {
  const from = startOfUtcDay(now);
  return (db.channelDeliveries ?? []).filter(
    (d) => d.channel === "sms" && d.status === "sent" && (userId === null || d.userId === userId) && Date.parse(d.sentAt ?? d.createdAt) >= from,
  ).length;
}

function log(db: MockDB, row: ChannelDeliveryRec) {
  db.channelDeliveries ??= [];
  db.channelDeliveries.unshift(row);
  if (db.channelDeliveries.length > LOG_LIMIT) db.channelDeliveries.length = LOG_LIMIT;
  return row;
}

export function newDelivery(input: Omit<ChannelDeliveryRec, "id" | "createdAt" | "sentAt" | "summaryId" | "nextAttemptAt" | "skipReason"> & Partial<ChannelDeliveryRec>, now = new Date()): ChannelDeliveryRec {
  return {
    id: uid("cd"),
    createdAt: now.toISOString(),
    sentAt: input.status === "sent" ? now.toISOString() : null,
    summaryId: null,
    nextAttemptAt: now.toISOString(),
    skipReason: null,
    ...input,
  };
}

export function recordDelivery(db: MockDB, row: ChannelDeliveryRec) {
  return log(db, row);
}

type Target = { channel: ExternalChannel; target: string } | { channel: ExternalChannel; skip: string; target: string };

function targetsFor(db: MockDB, userId: string, channel: ExternalChannel, workspaceId: string | null, now: Date): Target[] {
  const conns = db.channelConnections ?? [];
  if (channel === "telegram") {
    const c = conns.find((x) => x.channel === "telegram" && x.userId === userId);
    if (!c) return [];
    return c.status === "active" ? [{ channel, target: c.id }] : [{ channel, target: c.id, skip: "blocked" }];
  }
  if (channel === "sms") {
    const c = conns.find((x) => x.channel === "sms" && x.userId === userId);
    if (!c) return [];
    if (c.status !== "active") return [{ channel, target: c.id, skip: c.status === "opted_out" ? "opted_out" : "blocked" }];
    const ws = workspaceId ? db.workspaces.find((w) => w.id === workspaceId) : null;
    if (ws && ws.smsEnabled === false) return [{ channel, target: c.id, skip: "policy" }];
    if (smsSentToday(db, null, now) >= SMS_GLOBAL_DAILY_CAP) return [{ channel, target: c.id, skip: "global_cap" }];
    if (smsSentToday(db, userId, now) >= SMS_USER_DAILY_CAP) return [{ channel, target: c.id, skip: "cap" }];
    return [{ channel, target: c.id }];
  }
  return (db.pushDevices ?? []).filter((d) => d.userId === userId && d.status === "active").map((d) => ({ channel, target: d.id }));
}

/**
 * Fans one event out to the recipient's external channels. Returns the rows written. `urgent` is the
 * task's priority 4 at enqueue (events without a task are never urgent).
 */
export function fanOut(
  db: MockDB,
  recipientId: string,
  event: NotificationEvent,
  opts: { workspaceId: string | null; notificationId: string | null; taskKey: string | null; urgent: boolean; now?: Date },
): ChannelDeliveryRec[] {
  const now = opts.now ?? new Date();
  const prefs = db.prefs.find((p) => p.userId === recipientId)?.prefs;
  if (!prefs) return [];
  releaseDue(db, now);
  const row = prefs.events[event];
  const quiet: QuietHours | undefined = prefs.quietHours;
  const out: ChannelDeliveryRec[] = [];
  for (const channel of ["telegram", "sms", "push"] as const) {
    if (!row?.[channel]) continue;
    for (const t of targetsFor(db, recipientId, channel, opts.workspaceId, now)) {
      const base = { userId: recipientId, workspaceId: opts.workspaceId, channel, kind: "event" as const, event, target: t.target, notificationId: opts.notificationId, taskKey: opts.taskKey, urgent: opts.urgent };
      if ("skip" in t) {
        out.push(log(db, newDelivery({ ...base, status: "skipped", skipReason: t.skip }, now)));
        continue;
      }
      const end = quiet && holds(quiet, now, opts.urgent) ? windowEnd(quiet, now) : null;
      out.push(log(db, end ? newDelivery({ ...base, status: "deferred", nextAttemptAt: end.toISOString() }, now) : newDelivery({ ...base, status: "sent" }, now)));
    }
  }
  return out;
}

/** Sends every deferred row that is due: one as it is, several per target as one summary. */
export function releaseDue(db: MockDB, now = new Date()): ChannelDeliveryRec[] {
  const due = (db.channelDeliveries ?? []).filter((d) => d.status === "deferred" && Date.parse(d.nextAttemptAt) <= now.getTime());
  const groups = new Map<string, ChannelDeliveryRec[]>();
  for (const d of due) {
    if (now.getTime() - Date.parse(d.createdAt) > STALE_MS) {
      d.status = "skipped";
      d.skipReason = "stale";
      continue;
    }
    const k = `${d.userId}|${d.channel}|${d.target}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const summaries: ChannelDeliveryRec[] = [];
  for (const rows of groups.values()) {
    if (rows.length === 1) {
      rows[0]!.status = "sent";
      rows[0]!.sentAt = now.toISOString();
      continue;
    }
    const first = rows[0]!;
    const summary = log(
      db,
      newDelivery({ userId: first.userId, workspaceId: first.workspaceId, channel: first.channel, kind: "summary", event: "summary", target: first.target, notificationId: null, taskKey: null, urgent: false, status: "sent" }, now),
    );
    for (const r of rows) {
      r.status = "coalesced";
      r.summaryId = summary.id;
    }
    summaries.push(summary);
  }
  return summaries;
}

/** Saving quiet hours re-times the user's deferred rows (§6.6): off → due now, else the new window's end. */
export function retimeDeferred(db: MockDB, userId: string, q: QuietHours, now = new Date()) {
  for (const d of db.channelDeliveries ?? []) {
    if (d.userId !== userId || d.status !== "deferred") continue;
    const end = holds(q, now, d.urgent) ? windowEnd(q, now) : null;
    d.nextAttemptAt = (end ?? now).toISOString();
  }
}
