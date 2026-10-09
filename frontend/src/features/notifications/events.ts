import type { Notification, NotificationEvent, NotificationType, StatusGlyph } from "@/lib/api/types";
import { importNotificationText } from "@/features/import/import-lib";
import { ago, addDaysISO, shortDate, todayISO } from "@/lib/utils/dates";

/*
 * Event registry (design 19 "EV"): pref row name, verb, badge colour and 16-viewBox icon path.
 * Pure helpers used by the inbox, preview and preferences matrix.
 */

export type EventMeta = {
  /** Preferences row name. */
  pref: string;
  /** Verb in the row ("" when the line has no verb). */
  verb: string;
  color: string;
  path: string;
};

export const EVENTS: Record<NotificationType, EventMeta> = {
  assigned: {
    pref: "Assigned to me",
    verb: "assigned you",
    color: "var(--accent-t)",
    path: "M6.5 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2 13.5c.5-2.4 2.2-3.8 4.5-3.8 1 0 1.9.3 2.6.8M10.5 11.5h4M12.8 9.7l1.8 1.8-1.8 1.8",
  },
  mention: {
    pref: "Mentioned",
    verb: "mentioned you",
    color: "var(--info)",
    path: "M10.6 8a2.6 2.6 0 11-5.2 0 2.6 2.6 0 015.2 0zM10.6 8v1.1a1.7 1.7 0 003.4 0V8A6 6 0 108 14c1.1 0 2.1-.3 3-.8",
  },
  status: {
    pref: "Status change on my tasks",
    verb: "moved to",
    color: "var(--text-2)",
    path: "M2.5 5.5h9M9.5 3.5l2 2-2 2M13.5 10.5h-9M6.5 8.5l-2 2 2 2",
  },
  comment: {
    pref: "New comment",
    verb: "commented",
    color: "var(--text-2)",
    path: "M2.5 3.5h11v7.5H7.5L4.5 13.5V11h-2z",
  },
  due: {
    pref: "Due soon",
    verb: "",
    color: "var(--warn)",
    path: "M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5v3.2l2.2 1.4",
  },
  sprint: {
    pref: "Sprint started",
    verb: "started",
    color: "var(--accent-t)",
    path: "M12.5 6.5A4.8 4.8 0 004 5M3.5 9.5A4.8 4.8 0 0012 11M3.8 2.8v2.4h2.4M12.2 13.2v-2.4H9.8",
  },
  access: {
    pref: "Access requests",
    verb: "requested access",
    color: "var(--warn)",
    path: "M5 7.5V5.5a3 3 0 016 0v2M3.5 7.5h9v6h-9zM8 10v1.5",
  },
  // Board 40: system row for a finished import (no preference row, always on).
  import: {
    pref: "Imports",
    verb: "",
    color: "var(--accent-t)",
    path: "M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 11v2.5h11V11",
  },
};

/** Preferences matrix rows, in design order, mapped to the inbox type that carries the icon. */
export const PREF_ROWS: { event: NotificationEvent; type: NotificationType }[] = [
  { event: "assigned", type: "assigned" },
  { event: "mentioned", type: "mention" },
  { event: "status_change", type: "status" },
  { event: "comment", type: "comment" },
  { event: "due_soon", type: "due" },
  { event: "sprint_started", type: "sprint" },
];

/** Is this a system notification (no actor, rendered with a rounded-square tile)? */
export const isSystem = (n: Pick<Notification, "actorId" | "type">) => n.actorId === null || n.type === "due";

/** "Due tomorrow", "Due today", "Due in 3 days", "Overdue". */
export function dueLabel(dueDate: string | undefined, today = todayISO()) {
  if (!dueDate) return "Due soon";
  const d = dueDate.slice(0, 10);
  if (d < today) return "Overdue";
  if (d === today) return "Due today";
  if (d === addDaysISO(today, 1)) return "Due tomorrow";
  for (let i = 2; i <= 14; i++) if (d === addDaysISO(today, i)) return `Due in ${i} days`;
  return `Due ${shortDate(d)}`;
}

/**
 * Line 1 pieces: bold lead (actor name, or the due label for system events) and the verb.
 * Status events end with the target status, rendered separately as a glyph + name.
 */
export function lineParts(n: Notification, actorName: string | null, today = todayISO()) {
  if (n.type === "due") return { lead: dueLabel(n.payload.dueDate, today), verb: "" };
  if (n.type === "import") {
    const t = importNotificationText(n.payload);
    return { lead: t.lead, verb: `· ${t.rest}` };
  }
  // Board 37: an automation's change names the provider ("GitHub moved PRJ-42 to Done").
  const via = n.payload.via === "github" ? "GitHub" : n.payload.via === "gitlab" ? "GitLab" : null;
  const lead = via ?? actorName ?? (n.actorId ? "Someone" : "Lightex");
  if (n.type === "sprint") return { lead, verb: n.payload.sprintName ? `started ${n.payload.sprintName}` : "started a sprint" };
  return { lead, verb: EVENTS[n.type].verb };
}

/** Plain-text version of line 1 ("Riley Chen moved to In review"). */
export function verbText(n: Notification, actorName: string | null, today = todayISO()) {
  const { lead, verb } = lineParts(n, actorName, today);
  const status = n.type === "status" && n.payload.toStatus ? ` ${n.payload.toStatus}` : "";
  return [lead, verb].filter(Boolean).join(" ") + status;
}

/** What line 2 shows: task key + title, or the sprint name for task-less events. */
export function subjectOf(n: Notification) {
  if (n.taskKey) return { key: n.taskKey, title: n.taskTitle ?? "" };
  return { key: null, title: n.payload.sprintName ?? n.projectName };
}

/** Accessible name of a row's hit target (design 1.3). */
export function rowLabel(n: Notification, actorName: string | null, now = Date.now()) {
  const s = subjectOf(n);
  const when = ago(n.createdAt, now);
  const time = when === "just now" || /^[A-Z]/.test(when) ? when : `${when} ago`;
  return `${n.readAt ? "" : "Unread. "}${verbText(n, actorName)}, ${[s.key, s.title].filter(Boolean).join(" ")}, ${time}`;
}

export type Group = { id: "today" | "earlier"; label: string; items: Notification[] };

/** Splits into "Today" and "Earlier" by local calendar day; empty groups are dropped. */
export function groupByDay(items: Notification[], now = new Date()): Group[] {
  const day = now.toDateString();
  const today: Notification[] = [];
  const earlier: Notification[] = [];
  for (const n of items) (new Date(n.createdAt).toDateString() === day ? today : earlier).push(n);
  const groups: Group[] = [
    { id: "today", label: "Today", items: today },
    { id: "earlier", label: "Earlier", items: earlier },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Status glyph for a status *name* carried in a notification payload. */
export function glyphForStatusName(name: string, known?: { name: string; glyph: StatusGlyph }[]): StatusGlyph {
  const hit = known?.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.glyph;
  const x = name.toLowerCase();
  if (x.includes("backlog")) return "backlog";
  if (x.includes("review")) return "review";
  if (x.includes("progress") || x.includes("doing")) return "progress";
  if (x.includes("done") || x.includes("complete")) return "done";
  if (x.includes("cancel")) return "canceled";
  return "todo";
}
