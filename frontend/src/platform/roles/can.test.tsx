import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "@/api/types";
import { PROJECT_PERMISSIONS } from "@/api/types";
import { Can, ProjectScope, WorkspaceScope, canChangeVisibility, canEditDashboard, canEditTask, useCan } from "./can";
import { DEFAULT_ROLES, PERMISSION_CATALOGUE } from "./catalogue";

const ws = (perms: Workspace["my_permissions"]) => ({ my_permissions: perms }) as Workspace;
const prj = (perms: Project["my_permissions"]) => ({ my_permissions: perms }) as Project;

function Probe({ p }: { p: Parameters<typeof useCan>[0] }) {
  return <span>{useCan(p) ? "yes" : "no"}</span>;
}

describe("useCan / <Can>", () => {
  it("reads workspace permissions for workspace keys and project permissions for project keys", () => {
    render(
      <WorkspaceScope workspace={ws(["core.workspace.view", "tracking.project.create"])}>
        <ProjectScope project={prj(["tracking.project.view"])}>
          <Probe p="tracking.project.create" />
          <Probe p="tracking.task.create" />
        </ProjectScope>
      </WorkspaceScope>,
    );
    expect(screen.getAllByText(/yes|no/).map((e) => e.textContent)).toEqual(["yes", "no"]);
  });

  it("never lets workspace permissions leak into project scope", () => {
    // A workspace owner without project membership: empty project permissions.
    render(
      <WorkspaceScope workspace={ws(["core.workspace.view", "core.workspace.update", "core.roles.manage", "tracking.project.create"])}>
        <ProjectScope project={prj([])}>
          <Can permission="tracking.task.delete">
            <button>Delete task</button>
          </Can>
          <Can permission="tracking.project.create">
            <button>New project</button>
          </Can>
        </ProjectScope>
      </WorkspaceScope>,
    );
    expect(screen.queryByRole("button", { name: "Delete task" })).toBeNull();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
  });

  it("hidden means not rendered; fallback is opt-in", () => {
    render(
      <ProjectScope project={prj(["tracking.project.view"])}>
        <Can permission={["tracking.task.create", "tracking.task.assign"]} fallback={<span>read only</span>}>
          <button>New task</button>
        </Can>
      </ProjectScope>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("read only")).toBeInTheDocument();
  });

  it("applies edit_own only to the user's tasks", () => {
    const task = { assigneeIds: ["u4", "u1"], reporterId: "u2" };
    expect(canEditTask(task, ["tracking.task.edit_own"], "u1")).toBe(true);
    expect(canEditTask(task, ["tracking.task.edit_own"], "u3")).toBe(false);
    expect(canEditTask(task, ["tracking.task.edit_any"], "u3")).toBe(true);
  });
});

describe("board 33: dashboard permissions", () => {
  it("places tracking.dashboard.create and tracking.dashboard.manage right before tracking.report.view (spec §4.4)", () => {
    const order = [...PROJECT_PERMISSIONS];
    expect(order.slice(-3)).toEqual(["tracking.dashboard.create", "tracking.dashboard.manage", "tracking.report.view"]);
    expect(order.indexOf("tracking.dashboard.create")).toBe(order.indexOf("tracking.attachment.delete_any") + 1);
    const cat = PERMISSION_CATALOGUE.filter((p) => p.group === "Reports" && p.scope === "project").map((p) => p.key);
    expect(cat).toEqual(["tracking.dashboard.create", "tracking.dashboard.manage", "tracking.report.view"]);
  });

  it("grants both keys per §4.2 for all 7 default roles", () => {
    const grant = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, [r.permissions.includes("tracking.dashboard.create"), r.permissions.includes("tracking.dashboard.manage")]]));
    expect(grant).toEqual({
      owner: [false, false],
      admin: [false, false],
      member: [false, false],
      project_admin: [true, true],
      manager: [true, true],
      project_member: [true, false],
      viewer: [false, false],
    });
    // Sam's example (board 37 §4.3, which adds tracking.development.link): the project Member list, in order.
    expect(DEFAULT_ROLES.find((r) => r.key === "project_member")!.permissions).toEqual([
      "tracking.project.view", "tracking.task.create", "tracking.task.edit_own", "tracking.task.assign", "tracking.task.move", "tracking.project.import", "tracking.development.link", "tracking.time.log",
      "tracking.comment.create", "tracking.comment.edit_own", "tracking.attachment.upload", "tracking.dashboard.create", "tracking.report.view",
    ]);
  });

  it("follows the §4.3 truth table (owner/non-owner × create/manage × shared/personal)", () => {
    const rows: [owner: boolean, create: boolean, manage: boolean, vis: "shared" | "personal", edit: boolean, visibility: boolean][] = [
      [true, true, false, "shared", true, true],
      [true, true, false, "personal", true, true],
      [true, false, false, "shared", false, false],
      [true, false, false, "personal", false, false],
      [true, false, true, "shared", true, false],
      [true, false, true, "personal", false, false],
      [false, true, false, "shared", false, false],
      [false, true, false, "personal", false, false],
      [false, false, true, "shared", true, false],
      [false, false, true, "personal", false, false],
      [false, true, true, "shared", true, false],
      [false, false, false, "shared", false, false],
    ];
    for (const [owner, create, manage, visibility, edit, vis] of rows) {
      const perms = [create && "tracking.dashboard.create", manage && "tracking.dashboard.manage"].filter(Boolean) as string[];
      const d = { ownerId: owner ? "me" : "other", visibility };
      expect([canEditDashboard(d, perms, "me"), canChangeVisibility(d, perms, "me")], JSON.stringify({ owner, create, manage, visibility })).toEqual([edit, vis]);
    }
    expect(canEditDashboard({ ownerId: "me", visibility: "personal" }, ["tracking.dashboard.create"], undefined)).toBe(false);
  });
});
