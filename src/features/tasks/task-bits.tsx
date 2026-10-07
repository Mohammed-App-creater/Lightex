"use client";

import { useSyncExternalStore } from "react";
import { Avatar, UnassignedAvatar, type AvatarSize } from "@/components/ui/avatar";
import { StatusGlyph } from "@/components/ui/glyphs";
import type { Status, Task, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { dueTone, shortDate } from "@/lib/utils/dates";
import { sparkStore } from "./task-origin";

/* Small task atoms shared by board cards, list rows, backlog and the panel. */

export function useSparking(taskId: string) {
  return useSyncExternalStore(
    sparkStore.subscribe,
    () => sparkStore.get().has(taskId),
    () => false,
  );
}

export function TaskStatusGlyph({ task, status }: { task: Pick<Task, "id">; status: Status | undefined }) {
  const spark = useSparking(task.id);
  if (!status) return <StatusGlyph kind="todo" />;
  return <StatusGlyph kind={status.glyph} spark={spark} label={status.name} />;
}

export function AssigneeAvatar({ user, size = 20 }: { user: Pick<User, "name" | "hue"> | null | undefined; size?: AvatarSize }) {
  if (!user) return <UnassignedAvatar size={size} />;
  return <Avatar name={user.name} hue={user.hue} size={size} />;
}

export function DueText({ due, done, className }: { due: string | null; done: boolean; className?: string }) {
  const tone = dueTone(due, done);
  if (tone === "none") return null;
  return (
    <span
      className={cn(
        "font-mono text-[11px] font-medium",
        tone === "late" ? "text-danger" : tone === "soon" ? "text-warn" : "text-fg-3",
        className,
      )}
      title={tone === "late" ? "Overdue" : tone === "soon" ? "Due soon" : undefined}
    >
      {shortDate(due)}
    </span>
  );
}

/** Tiny 14px ring for "2/5" sub-task progress (board 04 card). */
export function SubtaskRing({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  const c = 2 * Math.PI * 5;
  return (
    <span className="inline-flex items-center gap-[5px] text-[11px] text-fg-2" aria-label={`${done} of ${total} sub-tasks done`}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <circle cx="7" cy="7" r="5" stroke="var(--line-2)" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r="5"
          stroke="var(--accent-t)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(c * done) / total} ${c}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      {done}/{total}
    </span>
  );
}
