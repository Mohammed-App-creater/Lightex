import type { AuditEntry } from "@/lib/api/types";

/*
 * Audit vocabulary shared by the audit screen and the mock backend (board 31).
 * Actions on the wire are "<entity>.<verb>" (e.g. "task.status_changed"); the UI groups them into
 * eight action kinds and eight entity types for filtering.
 */

export const AUDIT_ACTION_KINDS = ["created", "updated", "status", "assigned", "commented", "deleted", "role", "invited"] as const;
export type AuditActionKind = (typeof AUDIT_ACTION_KINDS)[number];

export const AUDIT_ENTITY_TYPES = ["task", "project", "sprint", "comment", "member", "view", "role", "workspace"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_RANGES = [
  { id: "1d", label: "Last 24 hours", minutes: 1440 },
  { id: "7d", label: "Last 7 days", minutes: 10080 },
  { id: "30d", label: "Last 30 days", minutes: 43200 },
  { id: "90d", label: "Last 90 days", minutes: 129600 },
] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number]["id"];

export function auditEntity(e: Pick<AuditEntry, "action" | "entityType">): AuditEntityType {
  const t = e.entityType ?? e.action.split(".")[0];
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(t ?? "") ? (t as AuditEntityType) : "workspace";
}

export function auditActionKind(e: Pick<AuditEntry, "action" | "entityType">): AuditActionKind {
  const verb = e.action.split(".").pop() ?? "";
  switch (verb) {
    case "status_changed":
      return "status";
    case "assigned":
    case "unassigned":
      return "assigned";
    case "role_changed":
      return "role";
    case "invited":
      return "invited";
    case "removed":
    case "deleted":
      return "deleted";
    case "commented":
      return "commented";
    case "created":
      return auditEntity(e) === "comment" ? "commented" : "created";
    // Board 40: task.imported → created; project.import_started / import_completed fall through to "updated".
    case "imported":
      return "created";
    default:
      // Board 39: custom_field_created → created; *_deleted (custom_field_deleted, time_entry_deleted) → deleted.
      if (verb.endsWith("_created")) return "created";
      if (verb.endsWith("_deleted")) return "deleted";
      return "updated";
  }
}

/** ISO timestamp for the start of a range, relative to `now`. */
export function rangeSince(range: AuditRange, now = Date.now()) {
  const r = AUDIT_RANGES.find((x) => x.id === range) ?? AUDIT_RANGES[2];
  return new Date(now - r.minutes * 60_000).toISOString();
}
