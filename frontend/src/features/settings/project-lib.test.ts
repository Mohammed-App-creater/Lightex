import { describe, expect, it } from "vitest";
import type { Label, ProjectMember, Role, Status } from "@/lib/api/types";
import {
  colorName,
  defaultMoveTarget,
  groupStatuses,
  hueName,
  isOnlyAdmin,
  labelNameError,
  nameTaken,
  nextFreeColor,
  projectKeyError,
  projectNameError,
  reorderInCategory,
  sanitizeKey,
} from "./project-lib";

const st = (id: string, category: Status["category"], position: number): Status => ({
  id,
  projectId: "p",
  name: id.toUpperCase(),
  category,
  glyph: "todo",
  position,
});

const statuses = [st("backlog", "todo", 0), st("todo", "todo", 1), st("prog", "in_progress", 2), st("rev", "in_progress", 3), st("done", "done", 4)];

describe("project settings lib", () => {
  it("validates name and key", () => {
    expect(projectNameError("")).toBe("Required");
    expect(projectNameError("A")).toBe("At least 2 characters");
    expect(projectNameError("x".repeat(41))).toBe("Max 40 characters");
    expect(projectNameError("Platform")).toBeNull();
    expect(projectKeyError("")).toBe("Required");
    expect(projectKeyError("P")).toBe("2–5 letters");
    expect(projectKeyError("PRJ")).toBeNull();
    expect(sanitizeKey("pr-j9xyzw")).toBe("PRJXY");
  });

  it("groups and reorders statuses inside a category", () => {
    const g = groupStatuses(statuses);
    expect(g.todo.map((s) => s.id)).toEqual(["backlog", "todo"]);
    expect(g.in_progress.map((s) => s.id)).toEqual(["prog", "rev"]);
    const r = reorderInCategory(statuses, "rev", 0)!;
    expect(r.list.map((s) => s.id)).toEqual(["backlog", "todo", "rev", "prog", "done"]);
    expect(r.position).toBe(2);
    expect(r.list.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
    expect(reorderInCategory(statuses, "rev", 1)).toBeNull();
    // Clamped to the group.
    expect(reorderInCategory(statuses, "backlog", 9)!.list.map((s) => s.id)).toEqual(["todo", "backlog", "prog", "rev", "done"]);
  });

  it("picks a move target in the same group first", () => {
    expect(defaultMoveTarget(statuses, statuses[3]!)!.id).toBe("prog");
    expect(defaultMoveTarget(statuses, statuses[4]!)!.id).toBe("backlog");
  });

  it("checks duplicate names case-insensitively", () => {
    expect(nameTaken(" todo ", statuses)).toBe(true);
    expect(nameTaken("TODO", statuses, "todo")).toBe(false);
    expect(nameTaken("", statuses)).toBe(false);
  });

  it("labels: next free colour and name errors", () => {
    const labels: Label[] = [
      { id: "a", projectId: "p", name: "bug", color: "var(--text-3)" },
      { id: "b", projectId: "p", name: "feature", color: "var(--todo)" },
    ];
    expect(nextFreeColor(labels)).toBe("var(--accent-t)");
    expect(labelNameError("Bug", labels)).toBe("Already exists");
    expect(labelNameError("Bug", labels, "a")).toBeNull();
    expect(labelNameError("", labels)).toBeNull();
    expect(labelNameError("", labels, undefined, true)).toBe("Required");
    expect(colorName("var(--danger)")).toBe("Red");
    expect(colorName(null)).toBe("Default");
    expect(hueName(255)).toBe("Blue");
    expect(hueName(1)).toBe("Custom");
  });

  it("detects the only project admin", () => {
    const roles = [
      { id: "admin", permissions: ["project.manage_members"] },
      { id: "member", permissions: ["task.create"] },
    ] as Role[];
    const m = (userId: string, roleId: string) => ({ projectId: "p", userId, roleId }) as ProjectMember;
    const one = [m("a", "admin"), m("b", "member")];
    expect(isOnlyAdmin(one[0]!, one, roles)).toBe(true);
    expect(isOnlyAdmin(one[1]!, one, roles)).toBe(false);
    const two = [...one, m("c", "admin")];
    expect(isOnlyAdmin(two[0]!, two, roles)).toBe(false);
  });
});
