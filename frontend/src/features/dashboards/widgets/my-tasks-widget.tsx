"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { StatusGlyph } from "@/components/ui/glyphs";
import { useMe } from "@/features/auth/session";
import { useStatuses } from "@/features/projects/queries";
import { useUpdateTask } from "@/features/tasks/mutations";
import { triggerSpark } from "@/features/tasks/task-origin";
import { useSparking } from "@/features/tasks/task-bits";
import { shortDate } from "@/features/reports/lib";
import type { Status, Task, WidgetConfigMap } from "@/lib/api/types";
import { can, canEditTask } from "@/lib/permissions/can";
import { pushUrl, withTaskParam } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { todayISO } from "@/lib/utils/dates";
import { useMyTasksWidget } from "../queries";
import { useLiveFlash } from "../use-live-flash";
import { WidgetEmpty, WidgetError, WidgetFrame, WidgetLoading } from "../widget-frame";
import { rowsFor } from "../layout-lib";
import { dueSoon, myTaskRows, toggleTargets } from "../widget-lib";
import { useWho, type WidgetProps } from "./common";

/**
 * My tasks (§1.3): open tasks by due date (no date last), then — with showDone — tasks done in the
 * last 7 days (dimmed); as many rows as fit. The glyph completes / reopens through the v1
 * useUpdateTask path (status-only rule); without that permission it is a plain glyph.
 */
export function MyTasksWidget({ project, config, h }: WidgetProps & { config: WidgetConfigMap["my_tasks"] }) {
  const q = useMyTasksWidget(project.id);
  const { data: statuses = [] } = useStatuses(project.id);
  const who = useWho(project.id);
  const tasks = q.data?.data ?? [];
  const { open, done } = myTaskRows(tasks, statuses, config.showDone, todayISO());
  const shown = [...open, ...done].slice(0, rowsFor(h));
  const flash = useLiveFlash({
    scope: `p:${project.id}`,
    rows: tasks,
    dataUpdatedAt: q.dataUpdatedAt,
    rowKey: (t) => t.id,
    rowSig: (t) => `${t.statusId}/${t.dueDate}/${t.title}`,
    label: "My tasks",
    who,
  });

  let body;
  if (q.isPending) body = <WidgetLoading />;
  else if (q.isError) body = <WidgetError onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  else if (!shown.length) body = <WidgetEmpty>Nothing assigned to you</WidgetEmpty>;
  else
    body = (
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-hidden p-0">
        {shown.map((t) => (
          <MyTaskRow key={t.id} task={t} statuses={statuses} perms={project.my_permissions} flash={flash.has(t.id)} />
        ))}
      </ul>
    );
  return <WidgetFrame meta={q.data ? `${open.length} open` : undefined}>{body}</WidgetFrame>;
}

function MyTaskRow({ task, statuses, perms, flash }: { task: Task; statuses: Status[]; perms: readonly string[]; flash: boolean }) {
  const me = useMe();
  const pathname = usePathname();
  const search = useSearchParams();
  const update = useUpdateTask();
  const spark = useSparking(task.id);
  const status = statuses.find((s) => s.id === task.statusId);
  const isDone = status?.category === "done";
  const canToggle = canEditTask(task, perms, me.id) || can("task.move", perms);
  const { complete, reopen } = toggleTargets(statuses);
  const target = isDone ? reopen : complete;
  const soon = dueSoon(task.dueDate, todayISO(), isDone);
  const glyph = <StatusGlyph kind={status?.glyph ?? "todo"} color={status?.color ?? undefined} spark={spark} label={canToggle ? undefined : status?.name} />;
  return (
    <li className={cn("-mx-1.5 flex h-8 min-w-0 flex-none items-center gap-[9px] rounded-sm px-1.5 hover:bg-hover", flash && "hl")}>
      {canToggle && target ? (
        <button
          type="button"
          aria-pressed={isDone}
          aria-label={`${isDone ? "Reopen" : "Complete"} ${task.key}`}
          onClick={() => {
            if (!isDone) triggerSpark(task.id);
            update.mutate({ task, patch: { statusId: target.id }, statuses });
          }}
          className="-mx-1 inline-flex size-[22px] flex-none items-center justify-center rounded-sm hover:bg-raised max-[1023px]:size-8"
        >
          {glyph}
        </button>
      ) : (
        glyph
      )}
      <button
        type="button"
        onClick={() => pushUrl(withTaskParam(pathname, search.toString(), task.key))}
        className="flex min-w-0 flex-1 items-center gap-[9px] text-left"
        aria-label={`Open ${task.key}: ${task.title}`}
      >
        <span className="flex-none font-mono text-[11px] font-medium text-fg-3">{task.key}</span>
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", isDone && "text-fg-3")}>{task.title}</span>
      </button>
      {task.dueDate && <span className={cn("flex-none rounded-xs px-1 py-[3px] font-mono text-[11px] font-medium text-fg-3", soon && "text-warn")}>{shortDate(task.dueDate)}</span>}
    </li>
  );
}
