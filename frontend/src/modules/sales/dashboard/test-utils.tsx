import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { setTransport } from "@/api/client";
import type { Workspace } from "@/api/types";
import { mockControls } from "@/api/mock/controls";
import { mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { WorkspaceScope } from "@/platform/roles/can";

/* Test helpers for the B1 screens: a fresh mock DB, a signed-in seed user and the workspace scope. */

export const transport = new MockTransport();

export function resetMock() {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
}

/** Render `ui` as `userId` inside the Platform workspace (the seed has sales on there). */
export async function mountAs(userId: string, ui: ReactNode) {
  mockSession.set(userId);
  const ws = await transport.request<Workspace>({ method: "GET", path: "/workspaces/platform" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceScope workspace={ws}>{ui}</WorkspaceScope>
    </QueryClientProvider>,
  );
}
