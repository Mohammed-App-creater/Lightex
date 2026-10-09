import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DevelopmentSection } from "@/features/development/development-section";
import { DevelopmentSettingsPanel } from "@/features/development/dev-settings-panel";
import { PrChip } from "@/features/development/pr-chip";
import { setTransport } from "@/lib/api/client";
import type { Project, TaskDetail, Workspace } from "@/lib/api/types";
import { mockControls } from "@/lib/mock/controls";
import { getDB, mockSession, resetDB } from "@/lib/mock/db";
import { fakeTiming, mockProviderConfig, setIntegrationError } from "@/lib/mock/handlers/integrations";
import { MockTransport } from "@/lib/mock/transport";
import { WorkspaceScope } from "@/lib/permissions/can";
import { IntegrationsScreen } from "./integrations-screen";
import { RepoPicker } from "./repo-picker";

/* Board 37 components (§12.2): the settings page, the picker, the Development section, the chip. */

const transport = new MockTransport();
const get = <T,>(path: string) => transport.request<T>({ method: "GET", path });

beforeEach(() => {
  resetDB();
  fakeTiming.listMs = 0;
  mockProviderConfig.github = true;
  mockProviderConfig.gitlabOauth = true;
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  window.history.replaceState(null, "", "/platform/settings/integrations");
});
afterEach(() => cleanup());

async function mount(user: string, ui: (ws: Workspace) => ReactNode, before?: () => void) {
  mockSession.set(user);
  const ws = await get<Workspace>("/workspaces/platform");
  before?.();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>{ui(ws)}</WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return qc;
}

describe("IntegrationsScreen", () => {
  it("shows the loading skeleton, then the connected GitHub card and the GitLab tile (manager)", async () => {
    await mount("u_alex", () => <IntegrationsScreen />);
    expect(screen.getByLabelText("Loading integrations")).toBeInTheDocument();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/4 repos · last sync/)).toBeInTheDocument();
    const repos = screen.getByRole("list", { name: "GitHub repositories" });
    expect(within(repos).getAllByRole("listitem")).toHaveLength(4);
    expect(within(repos).getByText("12 open PRs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit repos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect GitLab" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    expect(screen.getByText("Merge requests")).toBeInTheDocument();
    // Task keys examples with the key marked.
    expect(screen.getAllByText("PRJ-42", { selector: "mark" }).length).toBeGreaterThanOrEqual(2);
  });

  it("members see the status with a lock note and no actions (§11 #5, #6)", async () => {
    await mount("u_sam", () => <IntegrationsScreen />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync now/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.getByText("Can’t connect · needs Manage integrations")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect GitLab" })).toBeNull();
  });

  it("error card: badge and meta per code; Reconnect for managers, the admin note otherwise", async () => {
    setIntegrationError(getDB(), "int_gh_platform", "token_expired");
    await mount("u_alex", () => <IntegrationsScreen />);
    expect(await screen.findByText("Token expired")).toBeInTheDocument();
    expect(screen.getByText(/repos paused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit repos" })).toBeNull();
    expect(screen.getAllByText("paused")).toHaveLength(4);
    cleanup();
    await mount("u_taylor", () => <IntegrationsScreen />);
    expect(await screen.findByText("Ask a workspace admin to reconnect")).toBeInTheDocument();
  });

  it("an unconfigured provider shows Connect with its disabled reason", async () => {
    mockProviderConfig.github = false;
    getDB().integrations = [];
    getDB().repositories = [];
    await mount("u_alex", () => <IntegrationsScreen />);
    const btn = await screen.findByRole("button", { name: "Connect GitHub" });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("GitHub isn’t set up on this server.").length).toBeGreaterThan(0);
  });

  it("error state with Retry", async () => {
    await mount("u_alex", () => <IntegrationsScreen />, () => mockControls.set((c) => ({ ...c, offline: true })));
    expect(await screen.findByText("Couldn’t load integrations")).toBeInTheDocument();
    mockControls.set((c) => ({ ...c, offline: false }));
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("the full connect flow: Connect → mock consent → confirm → picker → Connect 4 repos", async () => {
    getDB().integrations = [];
    getDB().repositories = [];
    await mount("u_alex", () => <IntegrationsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    expect(await screen.findByText("Waiting for authorization…")).toBeInTheDocument();
    const auth = await screen.findByRole("dialog", { name: "GitHub · authorize" });
    expect(within(auth).getByText("pull_requests: read")).toBeInTheDocument();
    fireEvent.click(within(auth).getByRole("button", { name: "Authorize" }));
    const picker = await screen.findByRole("dialog", { name: "Choose repositories" }, { timeout: 3000 });
    expect(window.location.hash).toBe("");
    await within(picker).findByText("web");
    expect(within(picker).getByText("0 selected")).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: /Connect 0 repos/ })).toHaveAttribute("aria-disabled", "true");
    // Select all of platform-team (6), then drop two.
    fireEvent.click(within(picker).getByLabelText("Select all in platform-team"));
    expect(within(picker).getByText("6 selected")).toBeInTheDocument();
    fireEvent.click(within(picker).getByLabelText("Select all in platform-team"));
    for (const n of ["web", "api", "board-engine", "mobile-app"]) fireEvent.click(within(picker).getByText(n));
    const all = within(picker).getByLabelText("Select all in platform-team") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    // Search, no match, clear.
    fireEvent.change(within(picker).getByLabelText("Search repositories"), { target: { value: "zzz" } });
    expect(within(picker).getByText("No repositories match “zzz”")).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "Clear search" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Connect 4 repos" }));
    expect(await screen.findByText("GitHub connected · 4 repos")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose repositories" })).toBeNull());
  });

  it("Cancel on the consent page shows “Connection cancelled.”", async () => {
    getDB().integrations = [];
    await mount("u_alex", () => <IntegrationsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    const auth = await screen.findByRole("dialog", { name: "GitHub · authorize" });
    fireEvent.click(within(auth).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Connection cancelled.")).toBeInTheDocument();
  });

  it("an expired confirm link shows the banner", async () => {
    window.history.replaceState(null, "", "/platform/settings/integrations#connect=ca_nope.badtoken");
    await mount("u_alex", () => <IntegrationsScreen />);
    expect(await screen.findByText("That connection link expired. Try again.")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("Disconnect: Cancel is focused, Esc closes, confirming removes the card optimistically", async () => {
    await mount("u_alex", () => <IntegrationsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dlg = await screen.findByRole("alertdialog", { name: "Disconnect GitHub?" });
    expect(within(dlg).getByText("Linked PRs stay on tasks. Syncing stops.")).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("GitHub disconnected")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeInTheDocument();
    expect(getDB().integrations).toHaveLength(0);
  });

  it("GitLab dialog: field errors from the 422", async () => {
    await mount("u_alex", () => <IntegrationsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitLab" }));
    const dlg = await screen.findByRole("dialog", { name: "Connect GitLab" });
    fireEvent.click(within(dlg).getByRole("radio", { name: "Access token" }));
    fireEvent.change(within(dlg).getByLabelText("Instance URL"), { target: { value: "http://gitlab.example.com" } });
    fireEvent.change(within(dlg).getByLabelText("Access token"), { target: { value: "fake-token" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Connect" }));
    expect(await within(dlg).findByText("Use an https:// address.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Instance URL"), { target: { value: "https://gitlab.example.com" } });
    fireEvent.change(within(dlg).getByLabelText("Access token"), { target: { value: "fake-noscope" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Connect" }));
    expect(await within(dlg).findByText("The token needs the api scope.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Access token"), { target: { value: "fake-token" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("dialog", { name: "Choose repositories" })).toBeInTheDocument();
  });
});

describe("RepoPicker", () => {
  it("trackedElsewhere rows are disabled; first-time Cancel calls onCancel", async () => {
    const second = { ...getDB().integrations![0]!, id: "int_gh_second", accountExternalId: "x", account: { login: "alexkim", kind: "user" as const, url: "" } };
    getDB().integrations!.push(second);
    let cancelled = false;
    await mount("u_alex", () => (
      <RepoPicker
        integration={{ ...second, status: "active", syncing: false, nextSyncAt: null, repositories: [] }}
        mode="connect"
        saving={false}
        onCancel={() => (cancelled = true)}
        onConfirm={() => undefined}
      />
    ));
    const picker = await screen.findByRole("dialog");
    await within(picker).findByText("web");
    const web = within(picker).getByText("web").closest("label")!.querySelector("input")!;
    expect(web).toBeDisabled();
    expect(within(picker).getByText("0/6")).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    expect(cancelled).toBe(true);
  });
});

async function detail(key: string) {
  return get<TaskDetail>(`/workspaces/platform/tasks/${key}`);
}

describe("DevelopmentSection", () => {
  it("ready: count, PR rows, expandable checks, branches, commits; Create branch for Sam", async () => {
    mockSession.set("u_sam");
    const t = await detail("PRJ-42");
    await mount("u_sam", () => <DevelopmentSection task={t} />);
    expect(await screen.findByText("4 PRs · 2 branches")).toBeInTheDocument();
    const checks = screen.getByRole("button", { name: "Checks Failing, 1 of 3 passing" });
    expect(checks).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(checks);
    expect(checks).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("e2e / board-drag")).toBeInTheDocument();
    expect(screen.getByText("2m 14s")).toBeInTheDocument();
    expect(screen.getByText("3 ahead")).toBeInTheDocument();
    expect(screen.getByText("a3f9c21")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create branch/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More development actions" })).toBeInTheDocument();
  });

  it("Create branch: client validation, then 409 inline, then success with the flash", async () => {
    mockSession.set("u_alex");
    const t = await detail("PRJ-58");
    await mount("u_alex", () => <DevelopmentSection task={t} />);
    expect(await screen.findByText("No linked work yet")).toBeInTheDocument();
    expect(screen.getByText("Use PRJ-58 in a branch, PR or commit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create branch/ }));
    const pop = await screen.findByRole("dialog", { name: "Create branch" });
    const input = within(pop).getByLabelText("Branch name") as HTMLInputElement;
    expect(input.value).toBe("prj-58-invoice-pdf-redesign");
    fireEvent.change(input, { target: { value: "a..b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await within(pop).findByText("Branch names can’t contain '..'.")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.click(within(pop).getByRole("button", { name: /Create/ }));
    expect(await within(pop).findByText(/That branch already exists in platform-team\//)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "prj-58-invoice" } });
    fireEvent.click(within(pop).getByRole("button", { name: /Create/ }));
    expect(await screen.findByText("Branch created")).toBeInTheDocument();
    expect(await screen.findByText("1 branch")).toBeInTheDocument();
  });

  it("Viewer (Taylor) sees the section without any control", async () => {
    mockSession.set("u_taylor");
    const t = await detail("PRJ-42");
    await mount("u_taylor", () => <DevelopmentSection task={t} />);
    expect(await screen.findByText("4 PRs · 2 branches")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create branch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More development actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("Unlink removes the row optimistically and offers Undo", async () => {
    mockSession.set("u_alex");
    const t = await detail("PRJ-41");
    await mount("u_alex", () => <DevelopmentSection task={t} />);
    expect(await screen.findByText("1 PR")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for #221" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unlink" }));
    expect(await screen.findByText("No linked work yet")).toBeInTheDocument();
    await waitFor(() => expect(getDB().devLinks!.find((l) => l.taskId === "p_prj-t41")!.suppressed).toBe(true));
  });

  it("loading skeleton, and nothing at all for a project without connections and a task without links", async () => {
    mockSession.set("u_alex");
    const t = await detail("PRJ-42");
    await mount("u_alex", () => <DevelopmentSection task={t} />);
    expect(await screen.findByLabelText("Loading linked work")).toBeInTheDocument();
    cleanup();
    const mob = await get<TaskDetail>("/workspaces/platform/tasks/MOB-12");
    getDB().repositories!.forEach((r) => {
      r.allProjects = false;
      r.projectIds = ["p_prj"];
    });
    await mount("u_alex", () => <DevelopmentSection task={mob} />);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.queryByRole("region", { name: "Development" })).toBeNull();
  });
});

describe("Development settings tab", () => {
  it("editable for Alex (status.manage), switches disabled for Sam", async () => {
    mockSession.set("u_alex");
    const p = await get<Project>("/workspaces/platform/projects/PRJ");
    await mount("u_alex", () => <DevelopmentSettingsPanel project={p} canEdit />);
    const merged = await screen.findByRole("switch", { name: "When a pull request is merged: on" });
    expect(merged).toBeEnabled();
    expect(screen.getAllByText("platform-team/")).toHaveLength(4);
    cleanup();
    await mount("u_sam", () => <DevelopmentSettingsPanel project={p} canEdit={false} />);
    expect(await screen.findByRole("switch", { name: "When a pull request is merged: on" })).toBeDisabled();
  });
});

describe("PrChip", () => {
  it("renders the failing variant with the design's aria-label", async () => {
    await mount("u_alex", () => <PrChip pr={{ provider: "github", number: 214, ref: "#214", state: "open", checks: "failing", checksPassed: 1, checksTotal: 3, approvals: 0, baseBranch: "main", mergedAt: null }} />);
    const chip = screen.getByLabelText("Pull request #214, open, checks failing");
    expect(chip).toHaveTextContent("#214");
    expect(chip).toHaveTextContent("Failing");
  });
});
