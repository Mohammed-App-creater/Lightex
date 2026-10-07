/* Pure helpers for the workspace Trash (board 29). */

import type { Project, TrashItem, TrashKind, TrashRef, WorkspacePermission } from "@/lib/api/types";

export const RETENTION_DAYS = 30;
/** Rows at or below this many days left are flagged (board 29 `warn`). */
export const WARN_DAYS = 3;

export type TrashTab = "all" | TrashKind;

const DAY = 86_400_000;

/** Whole days until the item is purged, never below 0 (ceil, so "0.2 days" reads as 1 day left). */
export function daysLeft(purgeAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(purgeAt).getTime() - now) / DAY));
}

export function leftLabel(days: number): string {
  if (days <= 0) return "Today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/** "2h ago", "1d ago", "just now". */
export function agoLabel(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Accessible / dialog label: "PRJ-88 Remove legacy…", "comment on PRJ-112", "Legacy API". */
export function itemLabel(it: Pick<TrashItem, "kind" | "key" | "title" | "parentKey">): string {
  if (it.kind === "task") return `${it.key ?? ""} ${it.title}`.trim();
  if (it.kind === "comment") return `comment on ${it.parentKey ?? "a task"}`;
  return it.title;
}

/** Second line under the title (board 29 `.s`). */
export function itemSub(it: Pick<TrashItem, "kind" | "parentKey" | "taskCount">): string {
  if (it.kind === "comment") return `on ${it.parentKey ?? "a task"}`;
  if (it.kind === "project") return `${it.taskCount ?? 0} ${it.taskCount === 1 ? "task" : "tasks"}`;
  return "Task";
}

export function refOf(it: TrashRef): TrashRef {
  return { kind: it.kind, id: it.id };
}

export const refKey = (r: TrashRef) => `${r.kind}:${r.id}`;

export function countByKind(items: readonly TrashItem[]): Record<TrashTab, number> {
  return {
    all: items.length,
    task: items.filter((i) => i.kind === "task").length,
    comment: items.filter((i) => i.kind === "comment").length,
    project: items.filter((i) => i.kind === "project").length,
  };
}

export function filterByTab(items: readonly TrashItem[], tab: TrashTab): TrashItem[] {
  return tab === "all" ? [...items] : items.filter((i) => i.kind === tab);
}

/** Header checkbox state for the visible rows. */
export function selectionState(visible: readonly TrashItem[], selected: ReadonlySet<string>): "none" | "some" | "all" {
  const n = visible.filter((i) => selected.has(refKey(i))).length;
  if (!n) return "none";
  return n === visible.length ? "all" : "some";
}

/** Drops selections that are no longer visible (tab switch, restore, purge). */
export function pruneSelection(selected: ReadonlySet<string>, visible: readonly TrashItem[]): Set<string> {
  const keys = new Set(visible.map(refKey));
  return new Set([...selected].filter((k) => keys.has(k)));
}

export function restoredMessage(items: readonly TrashItem[]): string {
  if (items.length !== 1) return `Restored ${items.length} items`;
  const it = items[0]!;
  return `Restored ${it.kind === "task" ? it.key : it.kind === "comment" ? "comment" : it.title}`;
}

export function purgeWarning(items: readonly Pick<TrashItem, "kind">[]): string {
  return items.some((i) => i.kind === "project") ? "Can’t be undone · includes its tasks" : "Can’t be undone";
}

/**
 * Who may open the Trash (mirrors the mock/server rule in handlers/trash.ts): anyone who can delete
 * tasks, delete any comment, delete their own comments, or delete projects in some project, plus
 * workspace admins (project.assign_admin). Project viewers get "No access to Trash".
 */
export function canOpenTrash(wsPerms: readonly WorkspacePermission[], projects: readonly Pick<Project, "my_permissions">[]): boolean {
  if (wsPerms.includes("project.assign_admin")) return true;
  return projects.some((p) =>
    p.my_permissions.some((x) => x === "task.delete" || x === "comment.delete_any" || x === "comment.edit_own" || x === "project.delete"),
  );
}
