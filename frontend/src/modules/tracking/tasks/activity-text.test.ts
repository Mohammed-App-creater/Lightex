import { describe, expect, it } from "vitest";
import type { ActivityEntry, AuditEntry } from "@/api/types";
import { auditActionKind } from "@/lib/audit";
import { DEFAULT_ROLES } from "@/platform/roles/catalogue";
import { activityText } from "./activity-text";

/* Board 39 vocabulary: audit kinds, activity verbs and the new default-role grants. */

const row = (action: string): AuditEntry => ({ id: "a", actorId: "u", action, target: "T", createdAt: "", actorName: null, actorKind: "user", entityType: "", module: null, targetType: "", targetId: null, entityKey: null, source: "web", requestId: null, changes: [] });
const act = (verb: ActivityEntry["verb"], data: ActivityEntry["data"]): ActivityEntry => ({ id: "a", actorId: "u", verb, projectId: "p", taskId: "t", taskKey: "PRJ-42", taskTitle: "T", data, createdAt: "", actorName: null, actorKind: "user" });

describe("board 39 vocabulary", () => {
  it("maps the new audit actions to kinds", () => {
    expect(auditActionKind(row("tracking.project.custom_field_created"))).toBe("created");
    expect(auditActionKind(row("tracking.project.custom_field_deleted"))).toBe("deleted");
    expect(auditActionKind(row("tracking.task.time_entry_deleted"))).toBe("deleted");
    expect(auditActionKind(row("tracking.project.custom_field_updated"))).toBe("updated");
    expect(auditActionKind(row("tracking.project.custom_fields_reordered"))).toBe("updated");
    expect(auditActionKind(row("tracking.task.dependency_added"))).toBe("updated");
    expect(auditActionKind(row("tracking.task.dependency_removed"))).toBe("updated");
    expect(auditActionKind(row("tracking.task.time_logged"))).toBe("updated");
  });

  it("writes the dependency activity lines", () => {
    expect(activityText(act("dependency_added", { relation: "blocked_by", otherKey: "PRJ-48" }))).toBe("marked this blocked by PRJ-48");
    expect(activityText(act("dependency_added", { relation: "blocks", otherKey: "PRJ-47" }))).toBe("marked this as blocking PRJ-47");
    expect(activityText(act("dependency_removed", { relation: "blocks", otherKey: "PRJ-48" }))).toBe("removed the dependency on PRJ-48");
  });

  it("grants tracking.field.manage, tracking.time.log and tracking.time.delete_any per §3.2", () => {
    const grants = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, ["tracking.field.manage", "tracking.time.log", "tracking.time.delete_any"].filter((p) => (r.permissions as string[]).includes(p))]));
    expect(grants).toEqual({
      owner: [],
      admin: [],
      member: [],
      project_admin: ["tracking.field.manage", "tracking.time.log", "tracking.time.delete_any"],
      manager: ["tracking.field.manage", "tracking.time.log", "tracking.time.delete_any"],
      project_member: ["tracking.time.log"],
      viewer: [],
    });
  });
});
