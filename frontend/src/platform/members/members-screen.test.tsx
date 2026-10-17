import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";
import { setTransport } from "@/api/client";
import type { User, Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { getDB, mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";
import { MembersScreen } from "./members-screen";

/* Sales S0: members hold several workspace roles; the picker and the invite dialog are multi-selects. */

vi.mock("@/lib/hooks/lazy-with-preload", () => ({ lazyWithPreload: () => ({ Component: () => null, preload: () => {} }), whenIdle: () => () => {} }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
let me: User;
vi.mock("@/platform/auth/session", () => ({ useMe: () => me }));

const transport = new MockTransport();
const R = (key: string) => `ws_platform-role-${key}`;
const rolesOf = (userId: string) => getDB().wsMembers.find((m) => m.userId === userId && m.workspaceId === "ws_platform")!.roleIds;

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

async function mount(user: "u_alex" | "u_jordan" | "u_sam") {
  mockSession.set("u_alex");
  // Sales on: the module contributes Sales Admin, CEO / GM, Sales Manager and Salesperson.
  await transport.request({ method: "PUT", path: "/workspaces/platform/modules/sales", body: { enabled: true } });
  mockSession.set(user);
  me = getDB().users.find((u) => u.id === user)! as User;
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>
          <MembersScreen />
        </WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("MembersScreen roles", () => {
  it("adds a second role from the multi-select and sends roleIds", async () => {
    await mount("u_alex");
    await userEvent.click(await screen.findByRole("button", { name: "Roles for Sam Patel: Member" }));
    const menu = await screen.findByRole("menu");
    // Owner isn't offered to someone who doesn't hold it; Member is the last role, so it's locked.
    expect(within(menu).queryByRole("menuitemcheckbox", { name: /^Owner/ })).not.toBeInTheDocument();
    const memberItem = within(menu).getByRole("menuitemcheckbox", { name: /^Member/ });
    expect(memberItem).toHaveAttribute("aria-checked", "true");
    expect(memberItem).toHaveAttribute("aria-disabled", "true");
    expect(memberItem).toHaveTextContent("Keep at least one role");

    // CEO / GM: Owner lacks `sales.dailyreport.submit`, so no-escalation refuses the roles that grant it.
    await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /^CEO \/ GM/ }));
    await waitFor(() => expect(rolesOf("u_sam")).toEqual([R("member"), R("sales_ceo")]));
    // The menu stays open, and Member can be removed again.
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name: /^Member/ })).not.toHaveAttribute("aria-disabled"));
    // The member's chips show both roles.
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("button", { name: "Roles for Sam Patel: Member + CEO / GM" })).toBeInTheDocument();
  });

  it("locks the Owner role and hides Remove for an owner when the viewer is an Admin", async () => {
    await mount("u_jordan");
    await userEvent.click(await screen.findByRole("button", { name: "Roles for Alex Kim: Owner" }));
    const owner = within(await screen.findByRole("menu")).getByRole("menuitemcheckbox", { name: /^Owner/ });
    expect(owner).toHaveAttribute("aria-checked", "true");
    expect(owner).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for Alex Kim" }));
    const actions = await screen.findByRole("menu");
    expect(within(actions).getByRole("menuitem", { name: "Change roles" })).toBeInTheDocument();
    expect(within(actions).queryByRole("menuitem", { name: "Remove from workspace" })).not.toBeInTheDocument();
  });

  it("shows a read-only member every role as chips", async () => {
    getDB().wsMembers.find((m) => m.userId === "u_taylor" && m.workspaceId === "ws_platform")!.roleIds = [R("member"), R("admin")];
    await mount("u_sam");
    const row = (await screen.findByText("Taylor Ng")).closest("[role=row]") as HTMLElement;
    expect(within(row).getByText("Admin")).toBeInTheDocument();
    expect(within(row).getByText("Member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Roles for/ })).not.toBeInTheDocument();
  });

  it("invites with several roles", async () => {
    await mount("u_alex");
    await userEvent.click(await screen.findByRole("button", { name: /Invite/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Emails"), "drew@x.dev,");
    await userEvent.click(within(dialog).getByRole("button", { name: /Roles/ }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemcheckbox", { name: /^CEO \/ GM/ }));
    await userEvent.keyboard("{Escape}");
    expect(within(dialog).getByRole("button", { name: /Member \+ CEO \/ GM/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(getDB().invites.find((i) => i.email === "drew@x.dev")?.roleIds).toEqual([R("member"), R("sales_ceo")]));
  });
});
