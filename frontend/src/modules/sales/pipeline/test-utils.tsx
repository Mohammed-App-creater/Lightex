import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { setTransport } from "@/api/client";
import type { RequestOptions } from "@/api/transport";
import type { Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";
import { TooltipProvider } from "@/ui/tooltip";

/* Mock-backed render for the sales B2 screens (pipeline, opportunities, leads). Records every request. */

export const transport = new MockTransport();
export const calls: RequestOptions[] = [];

export function resetMock(user = "u_alex") {
  resetDB();
  calls.length = 0;
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport({ request: <T,>(o: RequestOptions) => (calls.push(o), transport.request<T>(o)) });
  mockSession.set(user);
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}

export async function mountSales(ui: ReactNode) {
  await transport.request({ method: "PUT", path: "/workspaces/platform/modules/sales", body: { enabled: true } });
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  calls.length = 0;
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WorkspaceScope workspace={ws}>{ui}</WorkspaceScope>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
