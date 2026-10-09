import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "@/lib/api/types";
import { PROJECT_PERMISSIONS } from "@/lib/api/types";
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
      <WorkspaceScope workspace={ws(["workspace.view", "project.create"])}>
        <ProjectScope project={prj(["project.view"])}>
          <Probe p="project.create" />
          <Probe p="task.create" />
        </ProjectScope>
      </WorkspaceScope>,
    );
    expect(screen.getAllByText(/yes|no/).map((e) => e.textContent)).toEqual(["yes", "no"]);
  });

  it("never lets workspace permissions leak into project scope", () => {
    // A workspace owner without project membership: empty project permissions.
    render(
      <WorkspaceScope workspace={ws(["workspace.view", "workspace.update", "workspace.manage_roles", "project.create"])}>
        <ProjectScope project={prj([])}>
          <Can permission="task.delete">
            <button>Delete task</button>
          </Can>
          <Can permission="project.create">
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
      <ProjectScope project={prj(["project.view"])}>
        <Can permission={["task.create", "task.assign"]} fallback={<span>read only</span>}>
          <button>New task</button>
        </Can>
      </ProjectScope>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("read only")).toBeInTheDocument();
  });

  it("applies edit_own only to the user's tasks", () => {
    const task = { assigneeId: "u1", reporterId: "u2" };
    expect(canEditTask(task, ["task.edit_own"], "u1")).toBe(true);
    expect(canEditTask(task, ["task.edit_own"], "u3")).toBe(false);
    expect(canEditTask(task, ["task.edit_any"], "u3")).toBe(true);
  });
});

describe("board 33: dashboard permissions", () => {
  it("places dashboard.create and dashboard.manage right before report.view (spec §4.4)", () => {
    const order = [...PROJECT_PERMISSIONS];
    expect(order.slice(-3)).toEqual(["dashboard.create", "dashboard.manage", "report.view"]);
    expect(order.indexOf("dashboard.create")).toBe(order.indexOf("attachment.delete_any") + 1);
    const cat = PERMISSION_CATALOGUE.filter((p) => p.group === "Reports" && p.scope === "project").map((p) => p.key);
    expect(cat).toEqual(["dashboard.create", "dashboard.manage", "report.view"]);
  });

  it("grants both keys per §4.2 for all 7 default roles", () => {
    const grant = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, [r.permissions.includes("dashboard.create"), r.permissions.includes("dashboard.manage")]]));
    expect(grant).toEqual({
      owner: [false, false],
      admin: [false, false],
      member: [false, false],
      project_admin: [true, true],
      manager: [true, true],
      project_member: [true, false],
      viewer: [false, false],
    });
    // Sam's example (§4.4): the project Member list, in order.
    expect(DEFAULT_ROLES.find((r) => r.key === "project_member")!.permissions).toEqual([
      "project.view", "task.create", "task.edit_own", "task.assign", "task.move", "project.import", "time.log",
      "comment.create", "comment.edit_own", "attachment.upload", "dashboard.create", "report.view",
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
      const perms = [create && "dashboard.create", manage && "dashboard.manage"].filter(Boolean) as string[];
      const d = { ownerId: owner ? "me" : "other", visibility };
      expect([canEditDashboard(d, perms, "me"), canChangeVisibility(d, perms, "me")], JSON.stringify({ owner, create, manage, visibility })).toEqual([edit, vis]);
    }
    expect(canEditDashboard({ ownerId: "me", visibility: "personal" }, ["dashboard.create"], undefined)).toBe(false);
  });
});
