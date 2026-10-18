import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { setTransport } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { RequestOptions } from "@/api/transport";
import type { SalesOpportunity, SalesPipeline, Workspace } from "@/api/types";
import { WorkspaceScope } from "@/platform/roles/can";
import { sk } from "./keys";
import { useMoveOpportunity } from "./mutations";

vi.mock("@/ui/toast", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

const stage = (id: string, order: number) => ({ id, name: id, order, category: "open" as const, defaultProbability: 10 * order, isSystem: false });
const opp = { id: "o1", title: "Deal", stageId: "s1", stage: { id: "s1", name: "s1", category: "open" }, expectedValue: "1000.50", weightedValue: "100.05", version: 3 } as SalesOpportunity;
const board = (): SalesPipeline => ({
  stages: [
    { stage: stage("s1", 1), count: 1, value: "1000.50", weightedValue: "100.05", opportunities: [opp], nextCursor: null },
    { stage: stage("s2", 2), count: 0, value: "0.00", weightedValue: "0.00", opportunities: [], nextCursor: null },
  ],
  count: 1,
  value: "1000.50",
  weightedValue: "100.05",
  leadCount: null,
});

function setup(answer: (o: RequestOptions) => Promise<unknown>) {
  const calls: RequestOptions[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  setTransport({ request: async <T,>(o: RequestOptions) => (calls.push(o), await gate, (await answer(o)) as T) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const key = sk.list("acme", "pipeline", {});
  qc.setQueryData(key, board());
  const ws = { slug: "acme", my_permissions: [], myDataScopes: {} } as unknown as Workspace;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <WorkspaceScope workspace={ws}>{children}</WorkspaceScope>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useMoveOpportunity(), { wrapper });
  return { qc, key, calls, release, hook };
}

describe("useMoveOpportunity", () => {
  it("moves the card optimistically and sends the version", async () => {
    const { qc, key, calls, release, hook } = setup(async () => ({ ...opp, stageId: "s2", version: 4 }));
    act(() => hook.result.current.mutate({ opp, stageId: "s2" }));
    await waitFor(() => expect(qc.getQueryData<SalesPipeline>(key)!.stages[1]!.opportunities.map((o) => o.id)).toEqual(["o1"]));
    const b = qc.getQueryData<SalesPipeline>(key)!;
    expect(b.stages[0]).toMatchObject({ count: 0, value: "0.00", weightedValue: "0.00" });
    expect(b.stages[1]).toMatchObject({ count: 1, value: "1000.50", weightedValue: "100.05" });
    release();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ method: "POST", path: "/sales/opportunities/o1/move", body: { stageId: "s2", version: 3 } });
  });

  it("rolls back and takes details.current on 409 version_conflict", async () => {
    const current = { ...opp, version: 5 };
    const { qc, key, release, hook } = setup(async () => {
      throw new ApiError({ code: "version_conflict", message: "Conflict", status: 409, details: { current } });
    });
    act(() => hook.result.current.mutate({ opp, stageId: "s2" }));
    release();
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(qc.getQueryData<SalesPipeline>(key)!.stages[0]!.opportunities.map((o) => o.id)).toEqual(["o1"]);
    expect(qc.getQueryData(sk.one("acme", "opportunities", "o1"))).toEqual(current);
    const { toast } = await import("@/ui/toast");
    expect(toast.error).toHaveBeenCalledWith("Someone else changed this card");
  });
});
