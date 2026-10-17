import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { insertTask } from "./optimistic";
import { qk } from "./query-keys";
import type { Task } from "./types";

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t_new",
    projectId: "p1",
    key: "PRJ-9",
    number: 9,
    title: "First task",
    statusId: "s_todo",
    sprintId: null,
    parentId: null,
    version: 1,
    ...over,
  }) as Task;

describe("insertTask", () => {
  it("adds a created task to the list, board and backlog caches at once", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.taskList("p1"), { data: [], total: 0 });
    qc.setQueryData([...qk.taskList("p1"), "overview"], { data: [] });
    qc.setQueryData(qk.board("p1"), { statuses: [{ id: "s_todo", category: "todo" }], tasks: [], sprintId: null });
    qc.setQueryData(qk.backlog("p1"), { sprints: [{ sprintId: "sp1", tasks: [] }], backlog: [] });
    qc.setQueryData(qk.board("p2"), { statuses: [], tasks: [], sprintId: null });

    insertTask(qc, task());

    expect(qc.getQueryData(qk.taskList("p1"))).toMatchObject({ data: [{ id: "t_new" }], total: 1 });
    expect(qc.getQueryData([...qk.taskList("p1"), "overview"])).toMatchObject({ data: [{ id: "t_new" }] });
    expect(qc.getQueryData(qk.board("p1"))).toMatchObject({ tasks: [{ id: "t_new" }] });
    expect(qc.getQueryData(qk.backlog("p1"))).toMatchObject({ backlog: [{ id: "t_new" }] });
    expect(qc.getQueryData(qk.board("p2"))).toMatchObject({ tasks: [] });
  });

  it("respects the board's sprint and backlog statuses, and never duplicates", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.board("p1", "sp1"), { statuses: [{ id: "s_todo", category: "todo" }], tasks: [], sprintId: "sp1" });
    qc.setQueryData(qk.board("p1"), { statuses: [{ id: "s_bl", category: "backlog" }], tasks: [], sprintId: null });
    qc.setQueryData(qk.backlog("p1"), { sprints: [{ sprintId: "sp1", tasks: [] }], backlog: [] });
    qc.setQueryData(qk.taskList("p1"), { data: [task()] });

    insertTask(qc, task({ sprintId: "sp1", statusId: "s_bl" }));

    expect(qc.getQueryData(qk.board("p1", "sp1"))).toMatchObject({ tasks: [{ id: "t_new" }] });
    expect(qc.getQueryData(qk.board("p1"))).toMatchObject({ tasks: [] });
    expect(qc.getQueryData(qk.backlog("p1"))).toMatchObject({ sprints: [{ sprintId: "sp1", tasks: [{ id: "t_new" }] }], backlog: [] });
    expect((qc.getQueryData(qk.taskList("p1")) as { data: Task[] }).data).toHaveLength(1);
  });

  it("leaves sub-tasks to the parent's refetch", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.taskList("p1"), { data: [] });
    insertTask(qc, task({ parentId: "t_parent" }));
    expect(qc.getQueryData(qk.taskList("p1"))).toMatchObject({ data: [] });
  });
});
