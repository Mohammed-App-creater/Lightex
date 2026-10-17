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
import { GeneralScreen } from "./general-screen";

/* Sales S0: Settings → General shows and edits the workspace time zone. */

vi.mock("@/lib/hooks/lazy-with-preload", () => ({ lazyWithPreload: () => ({ Component: () => null, preload: () => {} }), whenIdle: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
let me: User;
vi.mock("@/platform/auth/session", () => ({ useMe: () => me }));

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
  me = getDB().users.find((u) => u.id === user)! as User;
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>
          <GeneralScreen />
        </WorkspaceScope>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("GeneralScreen time zone", () => {
  it("searches, picks and saves an IANA time zone", async () => {
    await mount("u_alex");
    const trigger = await screen.findByRole("button", { name: /Time zone/ });
    expect(trigger).toHaveTextContent("Africa/Addis Ababa");
    await userEvent.click(trigger);
    const box = await screen.findByRole("combobox", { name: "Search time zones" });
    await userEvent.type(box, "tokyo");
    const list = screen.getByRole("listbox", { name: "Time zones" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Asia/Tokyo")]);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /Time zone/ })).toHaveTextContent("Asia/Tokyo");

    await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(getDB().workspaces.find((w) => w.id === "ws_platform")!.timezone).toBe("Asia/Tokyo"));
  });

  it("shows the time zone read-only to a member", async () => {
    await mount("u_sam");
    expect(await screen.findByText("Time zone")).toBeInTheDocument();
    expect(screen.getByText("Africa/Addis Ababa")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Time zone/ })).not.toBeInTheDocument();
  });
});
