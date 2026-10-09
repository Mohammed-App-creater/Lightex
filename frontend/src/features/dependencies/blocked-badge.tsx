import { Ban } from "lucide-react";
import type { Task } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/* "Blocked" chip (panel header) and badge (board card), board 39. Title text from openBlockers. */

/** "Blocked by PRJ-48 Token refresh race on cold start, PRJ-50 …". `withTitles` adds titles (card tooltip). */
export function blockedTitle(task: Pick<Task, "openBlockers">, withTitles = false) {
  const parts = task.openBlockers.map((b) => (withTitles ? `${b.key} ${b.title.length > 32 ? `${b.title.slice(0, 31)}…` : b.title}` : b.key));
  return `Blocked by ${parts.join(", ")}`;
}

const danger = "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger";

export function BlockedChip({ task }: { task: Pick<Task, "isBlocked" | "openBlockers"> }) {
  if (!task.isBlocked) return null;
  return (
    <span
      role="status"
      title={blockedTitle(task)}
      className={cn(
        "inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] px-2.5 text-[12px] font-semibold max-[760px]:h-9",
        danger,
      )}
    >
      <Ban size={12} strokeWidth={2} aria-hidden />
      Blocked
    </span>
  );
}

export function BlockedBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] flex-none items-center gap-[5px] rounded-[6px] px-[7px] text-[11.5px] font-semibold", danger, className)}>
      <Ban size={11} strokeWidth={2} aria-hidden />
      Blocked
    </span>
  );
}
