import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/api/types";
import { bucketTasks } from "./home-screen";

const t = (id: string, dueDate: string | null) => ({ id, dueDate }) as Task;

describe("bucketTasks", () => {
  it("groups by due date relative to today and drops empty buckets", () => {
    const b = bucketTasks([t("a", "2026-10-01"), t("b", "2026-10-07"), t("c", "2026-10-12"), t("d", "2026-11-30"), t("e", null)], "2026-10-07");
    expect(b.map((x) => [x.id, x.tasks.map((y) => y.id)])).toEqual([
      ["overdue", ["a"]],
      ["today", ["b"]],
      ["week", ["c"]],
      ["later", ["d"]],
      ["none", ["e"]],
    ]);
    expect(bucketTasks([t("x", null)], "2026-10-07").map((x) => x.id)).toEqual(["none"]);
  });
});
