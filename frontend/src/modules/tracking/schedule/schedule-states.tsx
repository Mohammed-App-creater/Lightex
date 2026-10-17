"use client";

import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils/cn";
import { useAnnouncement } from "./use-reschedule";

/* Board 32 states (§1.8): skeletons, empty, filtered-to-nothing, error, truncated banner, live region. */

/** Timeline lines icon (design view-switcher "timeline" path). */
export function TimelineIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden>
      <path d="M2.5 4h6M5 8h8M3.5 12h5" />
    </svg>
  );
}

const SK_ROWS = [
  { lw: 96, l: 4, w: 46 },
  { lw: 120, l: 22, w: 52 },
  { lw: 84, l: 0, w: 66 },
  { lw: 72, l: 2, w: 88 },
  { lw: 104, l: 30, w: 40 },
];

/** Design skeleton: axis label bars + 5 lane rows with a skeleton bar each. */
export function TimelineSkeleton({ labelWidth }: { labelWidth: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading timeline" className="flex min-h-0 flex-1 flex-col">
      <div className="grid flex-none border-b border-line" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
        <div className="flex items-end border-r border-line px-3 pb-[9px]">
          <Skeleton className="w-12" />
        </div>
        <div className="flex h-[52px] items-center gap-10 px-3">
          <Skeleton className="w-11" />
          <Skeleton className="w-11" />
          <Skeleton className="w-11" />
        </div>
      </div>
      {SK_ROWS.map((r, i) => (
        <div key={i} className="grid h-11 border-b border-line" style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr)` }}>
          <div className="flex items-center gap-2 border-r border-line px-3">
            <Skeleton className="size-2.5 rounded-[3px]" />
            <Skeleton style={{ width: Math.min(r.lw, labelWidth - 40) }} />
          </div>
          <div className="relative">
            <Skeleton className="absolute top-1/2 -mt-2.5 h-5 rounded-[6px]" style={{ left: `${r.l}%`, width: `${r.w}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Calendar skeleton: the grid with day numbers and 0–2 skeleton chips per cell. */
export function CalendarSkeleton({ days, rows }: { days: { n: string; weekend: boolean }[]; rows: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading calendar" className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "repeat(7,minmax(0,1fr))", gridTemplateRows: `repeat(${rows},minmax(0,1fr))` }}>
      {days.map((d, i) => (
        <div key={i} className={cn("flex min-h-[72px] flex-col gap-1 border-b border-r border-line p-1.5 [&:nth-child(7n)]:border-r-0", d.weekend && "bg-fg-3/[0.06]")}>
          <span className="px-1 font-mono text-[11.5px] text-fg-3">{d.n}</span>
          {Array.from({ length: (i * 7) % 3 }, (_, j) => (
            <Skeleton key={j} className="h-[18px] w-[85%] rounded-[5px]" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Error meta `<status> · request <ref>` (design "503 · PRJ timeline"). */
export function ScheduleError({ title, error, onRetry, retrying }: { title: string; error: unknown; onRetry: () => void; retrying?: boolean }) {
  const status = isApiError(error) ? error.status || "—" : "—";
  const ref = isApiError(error) ? error.ref : undefined;
  return (
    <div className="flex flex-1 items-start justify-center px-6 py-16">
      <ErrorState
        className="w-[420px] max-w-full"
        title={title}
        body={<span className="font-mono text-[11.5px] text-fg-3">{`${status} · request ${ref ?? "—"}`}</span>}
        refId={ref}
        onRetry={onRetry}
        retrying={retrying}
      />
    </div>
  );
}

export function FilteredEmpty({ onClear, banner }: { onClear: () => void; banner?: boolean }) {
  if (banner) {
    return (
      <div role="status" className="flex flex-none items-center gap-2 border-b border-line bg-raised px-5 py-2 text-[13px] text-fg-2 max-[760px]:px-3">
        <Filter size={13} aria-hidden className="text-fg-3" />
        No tasks match these filters
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-start justify-center px-6 py-16">
      <EmptyState
        align="center"
        icon={<Filter size={20} aria-hidden />}
        title="No tasks match these filters"
        body="Nothing in this range matches the current filters."
        actions={
          <Button kbd="⇧F" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    </div>
  );
}

export function TruncatedBanner() {
  return (
    <div role="status" className="flex-none border-b border-line bg-warn-s px-5 py-2 text-[12.5px] text-fg max-[760px]:px-3">
      Showing the first 2,000 tasks in this range. Zoom in or filter to see the rest.
    </div>
  );
}

/** 2 px indeterminate bar under the toolbar while an uncached range loads (transform only). */
export function RangeProgress({ on }: { on: boolean }) {
  return (
    <div aria-hidden className="relative h-0.5 flex-none overflow-hidden">
      {on && <span className="sch-progress absolute inset-y-0 left-0 w-2/5 rounded-full bg-accent" />}
    </div>
  );
}

/** Visually hidden polite live region for reschedule announcements. */
export function LiveRegion() {
  const a = useAnnouncement();
  return (
    <span className="sr-only" aria-live="polite" aria-atomic="true">
      {a.msg}
    </span>
  );
}
