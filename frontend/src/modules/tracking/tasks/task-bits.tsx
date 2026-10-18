"use client";

import { ListChecks } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Avatar, AvatarStack, UnassignedAvatar, type AvatarSize } from "@/ui/avatar";
import { StatusGlyph } from "@/ui/glyphs";
import type { Status, Task, User } from "@/api/types";
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

type Person = Pick<User, "name" | "hue">;

/** The users behind `assigneeIds`, in order (ids the lookup doesn't know are skipped). */
export function assigneesOf<U extends Person>(ids: readonly string[], users: { get(id: string): U | undefined }): U[] {
  return ids.map((id) => users.get(id)).filter((u): u is U => Boolean(u));
}

/** "Alex Kim, Sam Patel and 1 more" (for labels and tooltips). */
export function assigneeNames(users: readonly Pick<User, "name">[], max = 3) {
  if (!users.length) return "Unassigned";
  const shown = users.slice(0, max).map((u) => u.name);
  const rest = users.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]!;
}

/**
 * Multiple assignees: one avatar, or an overlapping stack (up to `max`, then "+N"); the dashed
 * "unassigned" circle when there is nobody (unless `hideEmpty`).
 */
export function AssigneeAvatars({ users, size = 20, max = 3, hideEmpty }: { users: readonly Person[]; size?: AvatarSize; max?: number; hideEmpty?: boolean }) {
  if (!users.length) return hideEmpty ? null : <UnassignedAvatar size={size} />;
  if (users.length === 1) return <Avatar name={users[0]!.name} hue={users[0]!.hue} size={size} />;
  const people = users.map((u, i) => ({ id: `${i}:${u.name}`, name: u.name, hue: u.hue }));
  return <AvatarStack people={people} size={size} max={max} label={`Assignees: ${assigneeNames(users, max)}`} className="flex-none" />;
}

/** "☑ 2/5" checklist progress on cards and rows; nothing when the task has no checklist. */
export function ChecklistBadge({ done, total, className }: { done: number; total: number; className?: string }) {
  if (!total) return null;
  return (
    <span
      className={cn("inline-flex items-center gap-1 font-mono text-[11px] tabular-nums", done === total ? "text-ok" : "text-fg-2", className)}
      aria-label={`${done} of ${total} checklist items done`}
    >
      <ListChecks size={13} strokeWidth={1.8} aria-hidden />
      {done}/{total}
    </span>
  );
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
