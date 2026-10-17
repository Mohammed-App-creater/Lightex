"use client";

import type { ReactNode } from "react";
import { UnassignedAvatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/feedback";
import { PriorityIcon, StatusGlyph, glyphColor, priorityMeta } from "@/ui/glyphs";
import { isForbidden, isNotFound } from "@/api/errors";
import { cn } from "@/lib/utils/cn";
import { dueTone, shortDate } from "@/lib/utils/dates";
import { usePreviewTask } from "@/platform/notifications/preview-task";
import type { TargetPreviewProps } from "@/registry";
import { useStatuses } from "../projects/queries";
import { AssigneeAvatars, assigneeNames, assigneesOf } from "./task-bits";

/*
 * Tracking's target preview for task notifications in the inbox (platform Stage 3 registry slot): status,
 * priority, assignee and due chips. It shares the platform preview's task query (same key), so nothing refetches.
 */

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[26px] items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-[9px] text-[12px] font-medium text-fg",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function TaskNotificationPreview({ n, slug, members }: TargetPreviewProps) {
  const taskQ = usePreviewTask(slug, n.taskKey);
  const task = taskQ.data;
  const statuses = useStatuses(task?.projectId);
  const gone = taskQ.isError && (isNotFound(taskQ.error) || isForbidden(taskQ.error));
  const status = task ? statuses.data?.find((s) => s.id === task.statusId) : undefined;
  const assignees = task ? assigneesOf(task.assigneeIds, members) : [];
  const tone = task ? dueTone(task.dueDate, status?.category === "done") : "none";
  if (!n.taskKey) return null;

  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Task details" role="group">
      {taskQ.isPending ? (
        <>
          <Skeleton className="h-[26px] w-24 rounded-[7px]" />
          <Skeleton className="h-[26px] w-20 rounded-[7px]" />
          <Skeleton className="h-[26px] w-24 rounded-[7px]" />
          <Skeleton className="h-[26px] w-[72px] rounded-[7px]" />
        </>
      ) : gone ? (
        <p role="status" className="m-0 rounded-[10px] border border-dashed border-line-2 px-3 py-2.5 text-[12.5px] leading-5 text-fg-2">
          This task was deleted or you no longer have access to it.
        </p>
      ) : taskQ.isError ? (
        <p role="status" className="m-0 flex items-center gap-2 text-[12.5px] text-fg-2">
          Couldn’t load task details.
          <Button variant="ghost" size="sm" onClick={() => void taskQ.refetch()}>
            Retry
          </Button>
        </p>
      ) : task ? (
        <>
          {status && (
            <Chip>
              <StatusGlyph kind={status.glyph} className="size-3" color={glyphColor[status.glyph]} />
              {status.name}
            </Chip>
          )}
          <Chip>
            <PriorityIcon level={task.priority} bars />
            {priorityMeta[task.priority].label}
          </Chip>
          <Chip>
            {assignees.length ? <AssigneeAvatars users={assignees} size={20} max={2} /> : <UnassignedAvatar size={20} label="" />}
            <span className="max-w-[220px] truncate">{assignees.length === 1 ? assignees[0]!.name : assigneeNames(assignees, 2)}</span>
          </Chip>
          {task.dueDate && (
            <Chip className={cn("font-mono", tone === "soon" || tone === "late" ? "text-warn" : "text-fg-2")}>Due {shortDate(task.dueDate)}</Chip>
          )}
        </>
      ) : null}
    </div>
  );
}
