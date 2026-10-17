import { cn } from "@/lib/utils/cn";

/** 14px ring spinner (board 03 .spin). Inherits currentColor. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-block size-3.5 flex-none animate-spin rounded-full border-2 border-current border-r-transparent opacity-80",
        "motion-reduce:animate-none",
        className,
      )}
    />
  );
}
