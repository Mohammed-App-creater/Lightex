import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "@/lib/api/types";
import { Can, ProjectScope, WorkspaceScope, canEditTask, useCan } from "./can";

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
