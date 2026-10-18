import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/ui/tooltip";
import { setTransport } from "@/api/client";
import { api } from "@/api/endpoints";
import { mockControls } from "@/api/mock/controls";
import { getDB, mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { modulesFor } from "./logic";
import { Onboarding } from "./onboarding";

/* Onboarding "What do you need?" (platform Stage 3): the choice is sent as `modules` on workspace creation. */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

const transport = new MockTransport();

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  mockSession.set("u_alex");
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Onboarding />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function toModulesStep(name: string) {
  await userEvent.type(screen.getByLabelText("Workspace name"), name);
  await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(await screen.findByRole("heading", { name: "What do you need?" })).toBeInTheDocument();
}

describe("onboarding: What do you need?", () => {
  it("maps the choice to modules", () => {
    expect(modulesFor("tracking")).toEqual([]);
    expect(modulesFor("tracking-sales")).toEqual(["sales"]);
  });

  it("creates the workspace with modules: ['sales'] for Core tracking + Sales", async () => {
    const create = vi.spyOn(api.workspaces, "create");
    mount();
    await toModulesStep("Revenue team");
    // Nothing is created until the modules step is confirmed.
    expect(create).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: /Core tracking \+ Sales/ }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({ name: "Revenue team", slug: "revenue-team", modules: ["sales"] });
    const ws = getDB().workspaces.find((w) => w.slug === "revenue-team")!;
    expect(getDB().workspaceModules.filter((r) => r.workspaceId === ws.id && r.enabled).map((r) => r.moduleKey)).toEqual(["tracking", "sales"]);
  });

  it("sends modules: [] for Core tracking only (the default)", async () => {
    const create = vi.spyOn(api.workspaces, "create");
    mount();
    await toModulesStep("Plain team");
    expect(screen.getByRole("radio", { name: /Core tracking only/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({ name: "Plain team", slug: "plain-team", modules: [] });
  });

  it("Skip for now keeps the typed workspace and marks the optional steps skipped", async () => {
    mount();
    await toModulesStep("Skip team");
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("You’re ready")).toBeInTheDocument();
    expect(getDB().workspaces.some((w) => w.slug === "skip-team")).toBe(true);
    expect(screen.getByText("lightex.app/skip-team")).toBeInTheDocument();
    expect(screen.getAllByText("· skipped")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Open workspace/ })).toBeInTheDocument();
  });
});
