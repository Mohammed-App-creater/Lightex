"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { FilterPills } from "@/components/ui/tabs";
import { useMe } from "@/features/auth/session";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { addDaysISO, todayISO } from "@/lib/utils/dates";
import { bucketTasks } from "./home-screen";
import { useWsMembers } from "./queries";
import { TaskLine, useStatusMap } from "./task-line";

type View = "open" | "bugs" | "due" | "done";

/** My tasks (and "Showing X's tasks" from the palette), grouped by due date. */
export function MyTasksScreen() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const view = (search.get("view") as View | null) ?? "open";
  const assignee = search.get("assignee") ?? "me";
  const { data: members = [] } = useWsMembers(ws.slug);
  const who = assignee === "me" || assignee === me.id ? null : members.find((m) => m.userId === assignee)?.user;
  const q = useQuery({
    queryKey: assignee === "me" ? qk.myTasks(ws.slug) : [...qk.myTasks(ws.slug), assignee],
    queryFn: () => (assignee === "me" ? api.workspaces.myTasks(ws.slug) : api.workspaces.assignedTasks(ws.slug, assignee)),
    select: (r) => r.data,
  });
  const { statuses, projects } = useStatusMap();
  const weekEnd = addDaysISO(todayISO(), 7);
  const tasks = useMemo(() => {
    const all = q.data ?? [];
    const isDone = (statusId: string) => statuses.get(statusId)?.category === "done";
    if (view === "done") return all.filter((t) => isDone(t.statusId));
    const open = all.filter((t) => !isDone(t.statusId));
    if (view === "bugs") return open.filter((t) => t.type === "bug");
    if (view === "due") return open.filter((t) => t.dueDate && t.dueDate <= weekEnd);
    return open;
  }, [q.data, statuses, view, weekEnd]);
  const setView = (v: View) => {
    const sp = new URLSearchParams(search.toString());
    if (v === "open") sp.delete("view");
    else sp.set("view", v);
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`);
  };
  const buckets = view === "done" ? [{ id: "done", title: "Completed", tasks }] : bucketTasks(tasks);

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 px-8 pb-16 pt-7 max-[760px]:px-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-h3">{who ? `${who.name}’s tasks` : "My tasks"}</h1>
        <span className="flex-1" />
        <FilterPills
          label="Task view"
          value={view}
          onChange={setView}
          items={[
            { value: "open", label: "Open" },
            { value: "due", label: "Due this week" },
            { value: "bugs", label: "Bugs" },
            { value: "done", label: "Done" },
          ]}
        />
      </header>
      {q.isPending ? (
        <SkeletonRows rows={6} label="Loading tasks" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load tasks" onRetry={() => void q.refetch()} />
      ) : tasks.length === 0 ? (
        <EmptyState icon={<CircleCheck size={20} aria-hidden />} title={view === "open" ? "Nothing open" : "No matching tasks"} body={view === "open" ? "Every task assigned here is done." : "Try another view."} />
      ) : (
        buckets.map((b) => (
          <section key={b.id} aria-label={b.title}>
            <h2 className={`eyebrow m-0 mb-1 ${b.id === "overdue" ? "text-danger" : ""}`}>
              {b.title} · {b.tasks.length}
            </h2>
            <ul className="m-0 list-none p-0">
              {b.tasks.map((t) => (
                <TaskLine key={t.id} task={t} status={statuses.get(t.statusId)} project={projects.get(t.projectId)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
