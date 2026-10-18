import { cn } from "@/lib/utils/cn";

/** `green` | `yellow` | `red` (the schema types it as a string), or null without a target. */
export type SalesStatus = "green" | "yellow" | "red" | (string & {}) | null | undefined;

const COLOR: Record<string, string> = { green: "bg-ok", yellow: "bg-warn", red: "bg-danger" };
const LABEL: Record<string, string> = { green: "On track", yellow: "At risk", red: "Behind" };

/** Target status (performance §19): green / yellow / red, grey when there is no target. */
export function StatusDot({ status, showLabel, className }: { status: SalesStatus; showLabel?: boolean; className?: string }) {
  const label = status ? LABEL[status] : "No target";
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden={showLabel || undefined} role={showLabel ? undefined : "img"} aria-label={showLabel ? undefined : label} className={cn("size-2 shrink-0 rounded-full", (status && COLOR[status]) || "bg-fg-3")} />
      {showLabel && <span className="text-meta text-fg-2">{label}</span>}
    </span>
  );
}
