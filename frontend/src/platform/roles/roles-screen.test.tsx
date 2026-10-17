import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";
import { setTransport } from "@/api/client";
import { api } from "@/api/endpoints";
import { ApiError } from "@/api/errors";
import type { Permission, PermissionInfo, Role, Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { getDB, mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";
import { PERMISSION_CATALOGUE } from "./catalogue";
import { RolesScreen } from "./roles-screen";

/*
 * Role editor data-scope selector (platform Stage 4). No real module has a scopable permission yet, so a fixture
 * catalogue entry is added for these tests (the mock reads the same catalogue).
 */

vi.mock("@/lib/hooks/lazy-with-preload", () => ({ lazyWithPreload: () => ({ Component: () => null, preload: () => {} }), whenIdle: () => () => {} }));

const CODE = "core.widget.view" as Permission;
const fixture: PermissionInfo = {
  key: CODE,
  module: "core",
  scope: "workspace",
  group: "Reports",
  label: "View widgets",
  description: "Fixture scopable permission",
  scopable: true,
};

const transport = new MockTransport();

beforeEach(() => {
  resetDB();
  PERMISSION_CATALOGUE.push(fixture);
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  PERMISSION_CATALOGUE.splice(PERMISSION_CATALOGUE.indexOf(fixture), 1);
});

async function mount() {
  mockSession.set("u_alex");
  const role = await transport.request<Role>({
    method: "POST",
    path: "/workspaces/platform/roles",
    body: { name: "Auditor", description: "", scope: "workspace", permissions: ["core.workspace.view"] },
  });
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>
          <RolesScreen />
        </WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: /Auditor/ }));
  const editor = await screen.findByRole("region", { name: "Auditor role" });
  return { role, editor };
}

const widgetSwitch = (editor: HTMLElement) => within(editor).getByRole("switch", { name: /View widgets/ });
const selector = () => screen.queryByRole("group", { name: "View widgets data scope" });
const save = () => userEvent.click(screen.getByRole("button", { name: /^Save/ }));

describe("RolesScreen data scope", () => {
  it("shows Own / Team / All only once the scopable permission is granted, and saving sends dataScopes", async () => {
    const update = vi.spyOn(api.roles, "update");
    const { role, editor } = await mount();
    expect(selector()).not.toBeInTheDocument();

    await userEvent.click(widgetSwitch(editor));
    const group = selector()!;
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Own", "Team", "All"]);
    await userEvent.click(within(group).getByRole("button", { name: "Team" }));
    expect(within(group).getByRole("button", { name: "Team" })).toHaveAttribute("aria-pressed", "true");

    await save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]![1]).toMatchObject({ permissions: ["core.workspace.view", CODE], dataScopes: { [CODE]: "team" } });
    expect(await screen.findByText("Saved Auditor")).toBeInTheDocument();
    expect(getDB().roles.find((r) => r.id === role.id)?.dataScopes).toEqual({ [CODE]: "team" });

    // Turning it off hides the selector and drops the scope from the next save.
    await userEvent.click(widgetSwitch(editor));
    expect(selector()).not.toBeInTheDocument();
    await save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![1]).toMatchObject({ permissions: ["core.workspace.view"], dataScopes: {} });
  });

  it("won't save a granted scopable permission without a scope", async () => {
    const update = vi.spyOn(api.roles, "update");
    const { editor } = await mount();
    await userEvent.click(widgetSwitch(editor));
    await save();
    expect(await within(editor).findByText("Choose Own, Team or All")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    // Choosing one clears the error.
    await userEvent.click(within(selector()!).getByRole("button", { name: "Own" }));
    expect(within(editor).queryByText("Choose Own, Team or All")).not.toBeInTheDocument();
  });

  it("shows data_scope_required from the server against the codes it names", async () => {
    vi.spyOn(api.roles, "update").mockRejectedValueOnce(
      new ApiError({ status: 400, code: "data_scope_required", message: "Choose a data scope.", details: { codes: [CODE] } }),
    );
    const { editor } = await mount();
    await userEvent.click(widgetSwitch(editor));
    await userEvent.click(within(selector()!).getByRole("button", { name: "All" }));
    await save();
    expect(await within(editor).findByText("Choose Own, Team or All")).toBeInTheDocument();
    expect(await screen.findByText("Couldn’t save role")).toBeInTheDocument();
  });

  it("shows data_scope_exceeds_own as an error toast naming the permission and both scopes", async () => {
    vi.spyOn(api.roles, "update").mockRejectedValueOnce(
      new ApiError({
        status: 403,
        code: "data_scope_exceeds_own",
        message: "You can’t grant a wider data scope than your own.",
        details: { code: CODE, dataScope: "all", yours: "team" },
      }),
    );
    const { editor } = await mount();
    await userEvent.click(widgetSwitch(editor));
    await userEvent.click(within(selector()!).getByRole("button", { name: "All" }));
    await save();
    // (The toast store outlives a test, so match the body, which only this toast has.)
    expect(await screen.findByText("View widgets: you hold Team, so you can’t grant All. Ask the workspace owner.")).toBeInTheDocument();
    // Not a scope-selection problem: the selector shows no inline error.
    expect(within(editor).queryByText("Choose Own, Team or All")).not.toBeInTheDocument();
  });
});
