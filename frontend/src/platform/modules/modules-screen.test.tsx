import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";
import { setTransport } from "@/api/client";
import { api } from "@/api/endpoints";
import { ApiError } from "@/api/errors";
import type { Workspace, WorkspaceModule } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { getDB, mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";
import { moduleToggleError } from "./lib";
import { ModulesScreen } from "./modules-screen";

/* Settings → Modules (platform Stage 3): toggle cards, the disable confirmation and the error toasts. */

vi.mock("@/lib/hooks/lazy-with-preload", () => ({ lazyWithPreload: () => ({ Component: () => null, preload: () => {} }), whenIdle: () => () => {} }));

const transport = new MockTransport();
const salesRow = () => getDB().workspaceModules.find((r) => r.workspaceId === "ws_platform" && r.moduleKey === "sales");

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount(user: "u_alex" | "u_sam") {
  mockSession.set(user);
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>
          <ModulesScreen />
        </WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const salesSwitch = () => screen.findByRole("switch", { name: "Sales" });

describe("ModulesScreen", () => {
  it("shows core and tracking as always on and turns Sales on without confirmation", async () => {
    await mount("u_alex");
    const sw = await salesSwitch();
    expect(sw).not.toBeChecked();
    // Only Sales is toggleable.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getAllByText("Always on")).toHaveLength(2);
    await userEvent.click(sw);
    expect(await screen.findByText("Sales turned on")).toBeInTheDocument();
    expect(salesRow()?.enabled).toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks before turning a module off, saying its data is kept", async () => {
    await transport.request({ method: "PUT", path: "/workspaces/platform/modules/sales", body: { enabled: true } });
    await mount("u_alex");
    const sw = await salesSwitch();
    await waitFor(() => expect(sw).toBeChecked());

    await userEvent.click(sw);
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Turn off Sales?")).toBeInTheDocument();
    expect(within(dialog).getByText(/data and role settings are kept/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    expect(salesRow()?.enabled).toBe(true);

    await userEvent.click(sw);
    dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Turn off/ }));
    expect(await screen.findByText("Sales turned off")).toBeInTheDocument();
    expect(salesRow()?.enabled).toBe(false);
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it("toasts module_dependency and rolls the switch back", async () => {
    vi.spyOn(api.modules, "set").mockRejectedValueOnce(
      new ApiError({ status: 400, code: "module_dependency", message: "Turn on Tracking first.", details: { modules: ["tracking"] } }),
    );
    await mount("u_alex");
    const sw = await salesSwitch();
    await userEvent.click(sw);
    expect(await screen.findByText("Turn on Tracking first")).toBeInTheDocument();
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it("toasts module_not_toggleable", async () => {
    vi.spyOn(api.modules, "set").mockRejectedValueOnce(new ApiError({ status: 400, code: "module_not_toggleable", message: "Sales is always on." }));
    await mount("u_alex");
    await userEvent.click(await salesSwitch());
    expect(await screen.findByText("Sales is always on")).toBeInTheDocument();
    expect(screen.getByText("It can’t be turned off for a workspace.")).toBeInTheDocument();
  });

  it("is closed to people without core.modules.manage", async () => {
    await mount("u_sam");
    expect(screen.getByText("Only owners and admins can manage modules")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});

describe("moduleToggleError", () => {
  const list = [
    { key: "sales", name: "Sales" },
    { key: "crm", name: "CRM" },
    { key: "mail", name: "Mail" },
  ] as WorkspaceModule[];
  const dep = (modules: string[]) => new ApiError({ status: 400, code: "module_dependency", message: "", details: { modules } });

  it("names the modules in the way, for enabling and disabling", () => {
    expect(moduleToggleError(dep(["sales"]), list[1]!, true, list)).toEqual({ title: "Turn on Sales first", body: "CRM needs it to work." });
    expect(moduleToggleError(dep(["crm", "mail"]), list[0]!, false, list)).toEqual({ title: "CRM and Mail need Sales", body: "Turn off CRM and Mail first." });
  });

  it("falls back to the server message for other errors", () => {
    const e = new ApiError({ status: 503, code: "server_error", message: "The server had a hiccup." });
    expect(moduleToggleError(e, list[0]!, true, list)).toEqual({ title: "Couldn’t turn Sales on", body: "The server had a hiccup." });
  });
});
