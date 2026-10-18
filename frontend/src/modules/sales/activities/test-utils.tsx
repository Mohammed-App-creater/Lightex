/* Test-only: mounts a sales screen on the in-browser mock as `u_alex` (Owner: every sales code, scope all). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { setTransport } from "@/api/client";
import type { Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";
import { TooltipProvider } from "@/ui/tooltip";
import { QuickActionsProvider } from "../shared/quick-actions";

export const transport = new MockTransport();

export function resetMock() {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  mockSession.set("u_alex");
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}

export async function mountSales(ui: ReactNode) {
  await transport.request({ method: "PUT", path: "/workspaces/platform/modules/sales", body: { enabled: true } });
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>
          <QuickActionsProvider>{ui}</QuickActionsProvider>
        </WorkspaceScope>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
