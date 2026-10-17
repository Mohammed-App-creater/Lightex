import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "@/api/types";
import { ProjectScope, WorkspaceScope, dataScopeOf, useDataScope } from "./can";

/* Platform Stage 4: useDataScope reads myDataScopes (workspace first, a project's identical map otherwise). */

function Probe({ code }: { code: string }) {
  return <span data-testid={code}>{useDataScope(code) ?? "none"}</span>;
}

const ws = (myDataScopes?: Workspace["myDataScopes"]) => ({ my_permissions: [], myDataScopes }) as unknown as Workspace;
const prj = (myDataScopes?: Project["myDataScopes"]) => ({ my_permissions: [], myDataScopes }) as unknown as Project;

describe("useDataScope", () => {
  it("returns the workspace's scope for a held code and null otherwise", () => {
    render(
      <WorkspaceScope workspace={ws({ "fake.widget.view": "team", "fake.report.view": "all" })}>
        <Probe code="fake.widget.view" />
        <Probe code="fake.report.view" />
        <Probe code="fake.other.view" />
      </WorkspaceScope>,
    );
    expect(screen.getByTestId("fake.widget.view")).toHaveTextContent("team");
    expect(screen.getByTestId("fake.report.view")).toHaveTextContent("all");
    expect(screen.getByTestId("fake.other.view")).toHaveTextContent("none");
  });

  it("treats a payload without myDataScopes as no grants", () => {
    render(
      <WorkspaceScope workspace={ws()}>
        <Probe code="fake.widget.view" />
      </WorkspaceScope>,
    );
    expect(screen.getByTestId("fake.widget.view")).toHaveTextContent("none");
  });

  it("falls back to the project's map outside a workspace scope", () => {
    render(
      <ProjectScope project={prj({ "fake.widget.view": "own" })}>
        <Probe code="fake.widget.view" />
      </ProjectScope>,
    );
    expect(screen.getByTestId("fake.widget.view")).toHaveTextContent("own");
  });

  it("dataScopeOf is the pure lookup", () => {
    expect(dataScopeOf("a.b.c", { "a.b.c": "own" })).toBe("own");
    expect(dataScopeOf("a.b.c", {})).toBeNull();
    expect(dataScopeOf("a.b.c", undefined)).toBeNull();
  });
});
