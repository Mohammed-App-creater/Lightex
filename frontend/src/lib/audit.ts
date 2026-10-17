import type { AuditEntry } from "@/api/types";

/*
 * Audit vocabulary shared by the audit screen and the mock backend (board 31).
 * Actions on the wire are "<module>.<entity>.<verb>" (e.g. "tracking.task.status_changed",
 * "core.member.invited"); the UI groups them into eight action kinds and eight entity types for filtering.
 */

/** The entity part of an action: "tracking.task.status_changed" → "task" (any module prefix). */
export function actionEntity(action: string): string {
  const parts = action.split(".");
  return (parts.length >= 3 ? parts[1] : parts[0]) ?? "";
}

/** The module part of an action: "tracking.task.created" → "tracking"; null for a bare legacy action. */
export function actionModule(action: string): string | null {
  const parts = action.split(".");
  return parts.length >= 3 ? parts[0]! : null;
}

/** Platform Stage 2 target type of an action: "tracking.task.created" → "tracking.task". */
export function actionTargetType(action: string): string {
  const mod = actionModule(action);
  return mod ? `${mod}.${actionEntity(action)}` : actionEntity(action);
}

/** The namespaced entity / target fields of an audit row written for `action` (mock backend, platform Stage 2). */
export const auditTargetFields = (action: string) => ({
  entityType: actionTargetType(action),
  module: actionModule(action) ?? "core",
  targetType: actionTargetType(action),
});

/** "tracking.task" → "task"; bare values pass through. */
export const bareEntity = (type: string) => (type.includes(".") ? type.slice(type.lastIndexOf(".") + 1) : type);

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

/**
 * Platform Stage 2: the server's audit filter groups (`filter[entity]`, registered by core and modules). Target types
 * in no group fall under "workspace"; bare legacy values map to themselves.
 */
export const AUDIT_GROUPS: Record<string, AuditEntityType> = {
  "tracking.task": "task",
  "core.attachment": "task",
  "core.comment": "comment",
  "core.member": "member",
  "core.role": "role",
  /* Platform Stage 4: team changes file under members. */
  "core.team": "member",
  "tracking.project": "project",
  "tracking.status": "project",
  "tracking.label": "project",
  "tracking.objective": "project",
  "tracking.milestone": "project",
  "tracking.epic": "project",
  "tracking.sprint": "sprint",
  "tracking.project_member": "member",
  "tracking.view": "view",
};

export function auditEntity(e: Pick<AuditEntry, "action" | "entityType" | "targetType">): AuditEntityType {
  const full = e.targetType || e.entityType || actionTargetType(e.action);
  if (full.includes(".")) return AUDIT_GROUPS[full] ?? "workspace";
  const t = bareEntity(full);
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(t ?? "") ? (t as AuditEntityType) : "workspace";
}

export function auditActionKind(e: Pick<AuditEntry, "action" | "entityType" | "targetType">): AuditActionKind {
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
    case "purged":
      return "deleted";
    case "commented":
      return "commented";
    case "created":
      return auditEntity(e) === "comment" ? "commented" : "created";
    // Board 40: tracking.task.imported → created; project.import_started / import_completed fall through to "updated".
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
