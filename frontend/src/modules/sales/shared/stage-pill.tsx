import type { SalesStageCategory } from "@/api/types";
import { cn } from "@/lib/utils/cn";

const TONE: Record<SalesStageCategory, string> = {
  open: "bg-raised text-fg-2",
  won: "bg-ok-s text-ok",
  lost: "bg-danger-s text-danger",
};

/** A pipeline stage chip (open stages neutral, Won green, Lost red). */
export function StagePill({ stage, className }: { stage: { name: string; category: SalesStageCategory }; className?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] max-w-full items-center whitespace-nowrap rounded-sm px-2 text-[12px] font-medium", TONE[stage.category], className)}>
      <span className="truncate">{stage.name}</span>
    </span>
  );
}

/** Win probability 0–100 (an override is marked with a dot). */
export function ProbabilityBadge({ value, overridden, className }: { value: number | null | undefined; overridden?: boolean; className?: string }) {
  if (value == null) return null;
  const tone = value >= 70 ? "text-ok" : value >= 40 ? "text-warn" : "text-fg-2";
  return (
    <span
      title={overridden ? "Probability set on this deal" : "Stage default probability"}
      className={cn("tabular inline-flex h-[22px] items-center gap-1 rounded-sm border border-line-2 px-1.5 font-mono text-[11px] font-medium", tone, className)}
    >
      {value}%{overridden && <span aria-label="overridden" className="size-1 rounded-full bg-current" />}
    </span>
  );
}
