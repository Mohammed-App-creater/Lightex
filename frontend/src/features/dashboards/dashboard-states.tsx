"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/feedback";
import { useIsMobile } from "@/lib/hooks/use-media-query";

/* Dashboard-level states (spec §1.7): skeleton cards and the grid-icon state panels (design `.db-state`). */

export const GridIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 3h4.5v4.5H2.5zM9 3h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />
  </svg>
);

export function DashboardState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 animate-[fade-in_180ms_var(--ease)] flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="inline-flex size-11 items-center justify-center rounded-lg border border-line bg-surface text-fg-3">
        <GridIcon />
      </span>
      <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export const MonoNote = ({ children }: { children: ReactNode }) => <span className="font-mono text-[11px] font-medium text-fg-3">{children}</span>;

/** Skeleton cards: desktop 2 columns (150, 150, 110 spanning 2); phones stacked (120, 90). */
export function DashboardSkeleton() {
  const mobile = useIsMobile();
  const cards = mobile
    ? [
        { h: 120, span: 1, tw: 90 },
        { h: 90, span: 1, tw: 70 },
      ]
    : [
        { h: 150, span: 1, tw: 90 },
        { h: 150, span: 1, tw: 64 },
        { h: 110, span: 2, tw: 110 },
      ];
  return (
    <div aria-busy="true" aria-label="Loading dashboard" className="px-5 pb-6 pt-3.5 max-[760px]:px-3">
      <div className="mb-3.5 flex h-[30px] items-center gap-2">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-2.5 w-28" />
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${mobile ? 1 : 2}, minmax(0, 1fr))` }}>
        {cards.map((c, i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3" style={{ height: c.h, gridColumn: `span ${c.span}` }}>
            <Skeleton className="h-2.5" style={{ width: c.tw }} />
            <Skeleton className="w-full flex-1 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
