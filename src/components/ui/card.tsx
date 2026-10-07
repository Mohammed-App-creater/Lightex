import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/** e0 surface card: 1px --line, --surface, radius 12 (board 02 elevation). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-surface", className)} {...props} />;
}

/** Overview panel (board 11 .panel): padding 20, gap 16, with an optional header row. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  as: As = "section",
  ...props
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: "section" | "div";
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <As
      className={cn("flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-5", className)}
      {...props}
    >
      {(title || actions) && (
        <div className="flex items-center gap-2.5">
          {title && <h2 className="m-0 text-[14px] font-semibold">{title}</h2>}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </div>
      )}
      <div className={cn("flex min-w-0 flex-col", bodyClassName)}>{children}</div>
    </As>
  );
}

/** KPI tile (board 06/11 .stat). */
export function StatTile({
  label,
  value,
  sub,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-[18px] py-4", className)}>
      <span className="text-meta text-fg-3">{label}</span>
      <span className="tabular text-[32px] font-semibold leading-10 tracking-[-0.02em]">{value}</span>
      {sub && <span className="text-meta text-fg-3">{sub}</span>}
    </div>
  );
}
