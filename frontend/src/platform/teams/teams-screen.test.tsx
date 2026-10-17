import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";
import { setTransport } from "@/api/client";
import type { Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { getDB, mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";
import { NO_TEAMS_PERMISSION, TeamsScreen } from "./teams-screen";

/* Settings → Teams (platform Stage 4): readable by members, writes gated by core.teams.manage. */

vi.mock("@/lib/hooks/lazy-with-preload", () => ({ lazyWithPreload: () => ({ Component: () => null, preload: () => {} }), whenIdle: () => () => {} }));

const transport = new MockTransport();

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
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
          <TeamsScreen />
        </WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const expectBlocked = (el: HTMLElement) => {
  expect(el).toHaveAttribute("aria-disabled", "true");
  expect(el).toHaveAccessibleDescription(NO_TEAMS_PERMISSION);
};

describe("TeamsScreen", () => {
  it("lets a member read teams but blocks writes with a disabledReason", async () => {
    await mount("u_sam");
    const nav = await screen.findByRole("navigation", { name: "Teams" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Backend3", "Frontend3", "Infrastructure2"]);
    // The first team opens with its members; leads show as a badge.
    const panel = await screen.findByRole("region", { name: "Backend team" });
    expect(await within(panel).findByText("Jordan Lee")).toBeInTheDocument();
    expect(within(panel).getByText("Lead")).toBeInTheDocument();

    expectBlocked(screen.getByRole("button", { name: /New team/ }));
    expectBlocked(within(panel).getByRole("button", { name: "Edit team" }));
    expectBlocked(within(panel).getByRole("button", { name: "Delete team" }));
    expectBlocked(within(panel).getByRole("button", { name: /Add member/ }));
    // Per-member controls aren't rendered.
    expect(within(panel).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();

    // Clicking a blocked button opens nothing.
    await userEvent.click(screen.getByRole("button", { name: /New team/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a team for a manager and shows team_name_taken on the name field", async () => {
    await mount("u_alex");
    const newTeam = await screen.findByRole("button", { name: /New team/ });
    expect(newTeam).not.toHaveAttribute("aria-disabled");

    await userEvent.click(newTeam);
    let dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Support");
    await userEvent.click(within(dialog).getByRole("button", { name: /Create team/ }));
    expect(await screen.findByText("Created Support")).toBeInTheDocument();
    expect(getDB().teams.some((t) => t.name === "Support")).toBe(true);
    expect(await screen.findByRole("region", { name: "Support team" })).toBeInTheDocument();

    // The server's 409 (the client list is stale here) lands on the field.
    getDB().teams.push({ id: "team_x", workspaceId: "ws_platform", name: "Ops", description: "", createdAt: "2026-10-01T00:00:00Z", deletedAt: null });
    await userEvent.click(screen.getByRole("button", { name: /New team/ }));
    dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "ops");
    await userEvent.click(within(dialog).getByRole("button", { name: /Create team/ }));
    expect(await within(dialog).findByText("A team with this name already exists")).toBeInTheDocument();
  });

  it("toggles a lead and removes a member for a manager", async () => {
    await mount("u_alex");
    const panel = await screen.findByRole("region", { name: "Backend team" });
    const riley = await within(panel).findByRole("switch", { name: "Lead: Riley Chen" });
    expect(riley).not.toBeChecked();
    await userEvent.click(riley);
    await waitFor(() => expect(getDB().teamMembers.find((m) => m.teamId === "team_backend" && m.userId === "u_riley")?.isLead).toBe(true));

    await userEvent.click(within(panel).getByRole("button", { name: "Remove Morgan Diaz" }));
    expect(await screen.findByText("Removed Morgan Diaz from Backend")).toBeInTheDocument();
    expect(getDB().teamMembers.some((m) => m.teamId === "team_backend" && m.userId === "u_morgan")).toBe(false);
  });
});
