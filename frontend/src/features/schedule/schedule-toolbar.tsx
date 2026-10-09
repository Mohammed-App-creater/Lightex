"use client";

import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/choice";
import { FilterBar } from "@/features/filters/filter-bar";
import type { FilterOptions } from "@/features/filters/use-filters";
import type { FilterRule } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";

/*
 * Board 32 toolbar (design .tc-top): ‹ period › Today │ zoom / mode segmented │ extras │ Unscheduled N │
 * filters. Rendered through the v1 FilterBar (no "Save view": §9 #3). "New task" lives in TopBarActions.
 */

export function ScheduleToolbar<T extends string>({
  onPrev,
  onNext,
  onToday,
  period,
  periodSuffix,
  seg,
  extras,
  tray,
  rules,
  setRules,
  opts,
  count,
}: {
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Calendar period label ("October 2026"); timeline has none (the axis says it). */
  period?: string;
  periodSuffix?: string;
  seg: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void };
  extras?: ReactNode;
  tray?: { count: number | null; more: boolean; open: boolean; onToggle: () => void };
  rules: FilterRule[];
  setRules: (r: FilterRule[]) => void;
  opts: FilterOptions;
  count: number | null;
}) {
  const leading = (
    <>
      <Button variant="ghost" size="sm" icon aria-label="Earlier" onClick={onPrev}>
        <ChevronLeft size={15} aria-hidden />
      </Button>
      {period !== undefined && (
        <span aria-live="polite" className="min-w-[96px] whitespace-nowrap text-center text-[13px] font-semibold">
          {period}
          {periodSuffix && <span className="font-normal text-fg-3"> {periodSuffix}</span>}
        </span>
      )}
      <Button variant="ghost" size="sm" icon aria-label="Later" onClick={onNext}>
        <ChevronRight size={15} aria-hidden />
      </Button>
      <Button size="sm" variant="secondary" onClick={onToday}>
        Today
      </Button>
      <span aria-hidden className="mx-1 h-5 w-px flex-none bg-line" />
      <Segmented label={seg.label} value={seg.value} onChange={seg.onChange} options={seg.options} />
      {extras}
      {tray && (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={tray.open}
          onClick={tray.onToggle}
          className={cn("max-[760px]:hidden", tray.open && "bg-hover text-fg")}
        >
          <Inbox size={13} aria-hidden /> Unscheduled
          {tray.count !== null && <span className="font-mono text-[11px] text-fg-3">{tray.more ? "200+" : tray.count}</span>}
        </Button>
      )}
      <span aria-hidden className="mx-1 h-5 w-px flex-none bg-line max-[760px]:hidden" />
    </>
  );
  return <FilterBar rules={rules} onChange={setRules} opts={opts} count={count} leading={leading} className="px-5 max-[760px]:px-3" />;
}
