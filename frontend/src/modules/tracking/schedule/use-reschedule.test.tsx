import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "@/components/ui/toast";
import { setTransport } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { RequestOptions, Transport } from "@/lib/api/transport";
import type { Task } from "@/lib/api/types";
import { BURST_MS, useReschedule } from "./use-reschedule";

/* Board 32 §6.6: optimistic reschedule, ordered commits with the fresh version, rollback, Undo window. */

const base = (over: Partial<Task> = {}): Task =>
  ({
    id: "t34",
    projectId: "p1",
    key: "PRJ-34",
    number: 34,
    title: "Session timeout modal",
    statusId: "s_todo",
    startDate: "2026-10-06",
    dueDate: "2026-10-10",
    version: 4,
    openBlockers: [],
    ...over,
  }) as Task;

type Call = { body: Record<string, unknown>; resolve: (t: Task) => void; reject: (e: unknown) => void };

function fakeTransport() {
  const calls: Call[] = [];
  const t: Transport = {
    request<T>(o: RequestOptions) {
      if (o.method !== "PATCH") return Promise.resolve(undefined as T);
      return new Promise<T>((resolve, reject) => calls.push({ body: o.body as Record<string, unknown>, resolve: (x) => resolve(x as T), reject }));
    },
  };
  setTransport(t);
  return calls;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  qc.setQueryData(qk.schedule("p1", "2026-09-01", "2026-11-30"), { data: [base()], nextCursor: null, truncated: false });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => ({ rs: useReschedule("p1"), toasts: useToasts() }), { wrapper });
  const cached = () => (qc.getQueryData(qk.schedule("p1", "2026-09-01", "2026-11-30")) as { data: Task[] }).data[0]!;
  return { qc, hook, cached };
}

const opts = { toast: "PRJ-34", announce: "moved" };

afterEach(() => vi.useRealTimers());

describe("useReschedule", () => {
  it("patches the cache at once, then commits the server copy", async () => {
    const calls = fakeTransport();
    const { hook, cached } = setup();
    act(() => hook.result.current.rs.commit(base(), { startDate: "2026-10-08", dueDate: "2026-10-12" }, opts));
    await waitFor(() => expect(cached().startDate).toBe("2026-10-08"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ startDate: "2026-10-08", dueDate: "2026-10-12", version: 4 });
    await act(async () => calls[0]!.resolve(base({ startDate: "2026-10-08", dueDate: "2026-10-12", version: 5 })));
    await waitFor(() => expect(cached().version).toBe(5));
  });

  it("sends only the changed key and nothing when the dates are unchanged", async () => {
    const calls = fakeTransport();
    const { hook } = setup();
    act(() => hook.result.current.rs.commit(base(), { startDate: "2026-10-06", dueDate: "2026-10-10" }, opts));
    act(() => hook.result.current.rs.commit(base(), { startDate: "2026-10-03", dueDate: "2026-10-10" }, opts));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ startDate: "2026-10-03", version: 4 });
  });

  it("runs two quick commits in order; the second carries the version the first returned", async () => {
    const calls = fakeTransport();
    const { hook, cached } = setup();
    act(() => hook.result.current.rs.commit(base(), { startDate: "2026-10-07", dueDate: "2026-10-11" }, opts));
    act(() => hook.result.current.rs.commit(base(), { startDate: "2026-10-08", dueDate: "2026-10-12" }, opts));
    await waitFor(() => expect(calls).toHaveLength(1));
    // The queued commit's optimistic dates are already on screen.
    expect(cached().startDate).toBe("2026-10-08");
    await act(async () => calls[0]!.resolve(base({ startDate: "2026-10-07", dueDate: "2026-10-11", version: 5 })));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(cached().startDate).toBe("2026-10-08");
    expect(calls[1]!.body.version).toBe(5);
    await act(async () => calls[1]!.resolve(base({ startDate: "2026-10-08", dueDate: "2026-10-12", version: 6 })));
    await waitFor(() => expect(cached().version).toBe(6));
  });

  it("rolls back on 422 with the field message", async () => {
    const calls = fakeTransport();
    const { hook, cached } = setup();
    act(() => hook.result.current.rs.commit(base(), { startDate: "2026-10-11", dueDate: "2026-10-10" }, opts));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () =>
      calls[0]!.reject(new ApiError({ status: 422, code: "validation_failed", message: "Some fields need fixing.", details: { fields: { startDate: "Start date must be on or before the due date" } } })),
    );
    await waitFor(() => expect(cached().startDate).toBe("2026-10-06"));
    expect(hook.result.current.toasts.some((t) => String(t.body).includes("Start date must be on or before the due date"))).toBe(true);
  });

  it("keyboard burst: one PATCH after 600 ms; Undo inside the window sends nothing", async () => {
    const calls = fakeTransport();
    const { hook } = setup();
    vi.useFakeTimers();
    act(() => hook.result.current.rs.nudge(base(), { startDate: "2026-10-07", dueDate: "2026-10-11" }, "move", opts));
    act(() => hook.result.current.rs.nudge(base(), { startDate: "2026-10-08", dueDate: "2026-10-12" }, "move", opts));
    const undo = hook.result.current.toasts.find((t) => t.id === "resched-t34")!.action!.onClick;
    act(() => undo());
    await act(async () => vi.advanceTimersByTime(BURST_MS + 50));
    vi.useRealTimers();
    expect(calls).toHaveLength(0);

    act(() => hook.result.current.rs.nudge(base(), { startDate: "2026-10-07", dueDate: "2026-10-11" }, "move", opts));
    act(() => hook.result.current.rs.flush("t34"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ startDate: "2026-10-07", dueDate: "2026-10-11", version: 4 });
  });
});
