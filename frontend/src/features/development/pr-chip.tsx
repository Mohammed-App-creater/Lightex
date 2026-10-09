"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { DEV_ICON, DevGlyph } from "@/features/integrations/icons";
import { prChip, type ChipVariant } from "@/features/integrations/lib/dev-lib";
import type { TaskDevSummary } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

const TONE: Record<ChipVariant, string> = {
  failing: "text-danger",
  open: "text-ok",
  draft: "text-fg-3",
  merged: "text-info",
  closed: "text-danger",
};
const ICON: Record<ChipVariant, string> = {
  failing: DEV_ICON.prOpen,
  open: DEV_ICON.prOpen,
  draft: DEV_ICON.prOpen,
  merged: DEV_ICON.prMerged,
  closed: DEV_ICON.prClosed,
};

/**
 * The board card's PR indicator (design `.pr-ind`, §9.5): icon by state, the ref, and the state,
 * with the design's tooltip ("#214 · 2 of 3 checks failing") and aria-label. Draft = the muted open
 * chip (§11 #22). Also used in the list's key column.
 */
export function PrChip({ pr, className, compact }: { pr: NonNullable<TaskDevSummary["pr"]>; className?: string; /** List key column: the icon only (tooltip and aria unchanged). */ compact?: boolean }) {
  const c = prChip(pr);
  if (compact) {
    return (
      <Tooltip content={c.tooltip}>
        <span
          tabIndex={0}
          aria-label={c.aria}
          className={cn("inline-flex size-[18px] flex-none items-center justify-center rounded-[5px] outline-none focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)]", TONE[c.variant], className)}
        >
          <DevGlyph d={ICON[c.variant]} size={12} dashed={c.variant === "draft"} />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={c.tooltip}>
      <span
        tabIndex={0}
        aria-label={c.aria}
        data-card-action
        className={cn(
          "inline-flex h-[22px] flex-none cursor-default items-center gap-[5px] rounded-[6px] border border-line-2 bg-surface pl-1.5 pr-[7px] text-[11.5px] font-medium outline-none focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--ring)]",
          TONE[c.variant],
          className,
        )}
      >
        <DevGlyph d={ICON[c.variant]} size={12} dashed={c.variant === "draft"} />
        <span className="font-mono text-[11px] text-fg-2">{pr.ref}</span>
        <span className="ml-px inline-flex items-center gap-1 border-l border-line-2 pl-1.5 font-semibold">
          {c.variant === "failing" && <DevGlyph d={DEV_ICON.x} size={10} strokeWidth={2.2} />}
          {c.label}
        </span>
      </span>
    </Tooltip>
  );
}
