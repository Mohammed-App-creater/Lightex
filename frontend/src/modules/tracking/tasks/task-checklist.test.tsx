import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toaster } from "@/ui/toast";
import { TooltipProvider } from "@/ui/tooltip";
import { api } from "@/api/endpoints";
import { setTransport } from "@/api/client";
import { qk } from "@/api/query-keys";
import { mockControls } from "@/api/mock/controls";
import { getDB, mockSession, resetDB } from "@/api/mock/db";
import { MockTransport } from "@/api/mock/transport";
import { canEditTask } from "@/platform/roles/can";
import { reorderPosition, TaskChecklist } from "./task-checklist";

/* The task panel's Checklist section on the mock API (docs/tracking/checklist-assignees.md §2). */

const transport = new MockTransport();
const items = () => getDB().checklist!.filter((c) => c.taskId === "p_prj-t42");

function Harness({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: qk.task("platform", "PRJ-42"), queryFn: () => api.tasks.get("platform", "PRJ-42") });
  if (!q.data) return <p>Loading</p>;
  return <TaskChecklist task={q.data} canEdit={canEditTask(q.data, q.data.project.my_permissions, userId)} />;
}

function mount(userId: string) {
  mockSession.set(userId);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Harness userId={userId} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  setTransport(transport);
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => cleanup());

describe("TaskChecklist", () => {
  it("shows progress and checks an item optimistically", async () => {
    mount("u_alex");
    const section = await screen.findByRole("region", { name: "Checklist" });
    expect(within(section).getByText("2/5")).toBeInTheDocument();
    expect(within(section).getByRole("progressbar", { name: "Checklist progress" })).toHaveAttribute("aria-valuenow", "40");
    await userEvent.click(within(section).getByRole("checkbox", { name: "Check “Debounce reflow on sidebar toggle”" }));
    expect(within(section).getByText("3/5")).toBeInTheDocument();
    await waitFor(() => expect(items().find((i) => i.text === "Debounce reflow on sidebar toggle")?.done).toBe(true));
  });

  it("keeps the add input open for rapid entry and appends in order", async () => {
    mount("u_alex");
    const section = await screen.findByRole("region", { name: "Checklist" });
    await userEvent.click(within(section).getByRole("button", { name: /Add an item/ }));
    const input = within(section).getByRole("textbox", { name: "New checklist item" });
    await userEvent.type(input, "Write the changelog{Enter}");
    await userEvent.type(within(section).getByRole("textbox", { name: "New checklist item" }), "Tell support{Enter}");
    expect(within(section).getByRole("textbox", { name: "New checklist item" })).toHaveFocus();
    await waitFor(() => expect(items().map((i) => i.text).slice(-2)).toEqual(["Write the changelog", "Tell support"]));
    expect(within(section).getByText("2/7")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(within(section).queryByRole("textbox", { name: "New checklist item" })).not.toBeInTheDocument();
  });

  it("renames with Enter, cancels with Escape, and deletes", async () => {
    mount("u_alex");
    const section = await screen.findByRole("region", { name: "Checklist" });
    await userEvent.click(within(section).getByRole("button", { name: /^Checklist item: Check Safari and Firefox/ }));
    const edit = within(section).getByRole("textbox", { name: "Checklist item" });
    await userEvent.clear(edit);
    await userEvent.type(edit, "Check Safari{Enter}");
    await waitFor(() => expect(items().some((i) => i.text === "Check Safari")).toBe(true));
    await userEvent.click(within(section).getByRole("button", { name: /^Checklist item: Check Safari\./ }));
    await userEvent.type(within(section).getByRole("textbox", { name: "Checklist item" }), " nope{Escape}");
    expect(items().some((i) => i.text === "Check Safari")).toBe(true);
    await userEvent.click(within(section).getByRole("button", { name: "Delete “Check Safari”" }));
    await waitFor(() => expect(items()).toHaveLength(4));
  });

  it("hides checked items on request", async () => {
    mount("u_alex");
    const section = await screen.findByRole("region", { name: "Checklist" });
    await userEvent.click(within(section).getByRole("button", { name: "Hide checked" }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(within(section).getByRole("button", { name: "Show checked (2)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is read-only for a viewer", async () => {
    mount("u_taylor");
    const section = await screen.findByRole("region", { name: "Checklist" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(5);
    expect(within(section).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /Add an item|Delete|Reorder/ })).not.toBeInTheDocument();
  });

  it("explains a full checklist with a disabled reason", async () => {
    const db = getDB();
    for (let i = 5; i < 100; i++) {
      db.checklist!.push({ id: `cl_f${i}`, taskId: "p_prj-t42", text: `Item ${i}`, done: false, position: `z${String(i).padStart(3, "1")}`, doneAt: null, doneById: null, createdAt: "", createdById: null });
    }
    mount("u_alex");
    const section = await screen.findByRole("region", { name: "Checklist" });
    const add = within(section).getByRole("button", { name: /Add an item/ });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(section).toHaveTextContent("A checklist can have up to 100 items.");
  });
});

describe("reorderPosition", () => {
  it("lands between the new neighbours", () => {
    const list = [
      { id: "a", position: "a0V" },
      { id: "b", position: "a1" },
      { id: "c", position: "a2" },
    ];
    const toEnd = reorderPosition(list, "a", 2);
    expect(toEnd > "a2").toBe(true);
    const toStart = reorderPosition(list, "c", 0);
    expect(toStart < "a0V").toBe(true);
    const middle = reorderPosition(list, "c", 1);
    expect(middle > "a0V" && middle < "a1").toBe(true);
  });
});
