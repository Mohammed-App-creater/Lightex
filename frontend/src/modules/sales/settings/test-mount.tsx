import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { setTransport } from "@/api/client";
import type { Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { SessionProvider } from "@/platform/auth/session";
import { WorkspaceScope } from "@/platform/roles/can";
import { TooltipProvider } from "@/ui/tooltip";

/* Test helper for the sales settings / targets / daily-report screens: a fresh mock DB, signed in as `userId`. */
export const transport = new MockTransport();

export function resetMock(userId: string) {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  mockSession.set(userId);
}

export async function mountSales(ui: ReactNode) {
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SessionProvider>
        <TooltipProvider>
          <WorkspaceScope workspace={ws}>{ui}</WorkspaceScope>
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}
