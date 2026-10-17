"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { DialogClose, DialogShell, Sheet } from "@/components/ui/modal";
import type { WidgetType } from "@/lib/api/types";
import { DEFAULT_SIZE, WIDGET_NAME, WIDGET_TYPES } from "@/lib/domain/dashboards";
import { cn } from "@/lib/utils/cn";

/*
 * Add widget gallery (spec §1.4): a dialog on desktop, a sheet on phones. One tile per type the
 * viewer can read, with the design's mini preview, name and default size; types already present
 * show "✓ Added" and are aria-disabled. The first free tile takes focus; Esc closes.
 */

const PREVIEW: Record<WidgetType, ReactNode> = {
  burndown: (
    <svg viewBox="0 0 160 64" aria-hidden className="size-full">
      <path d="M14 52H150M14 34H150M14 16H150" stroke="var(--line)" strokeWidth="1" />
      <path d="M18 12L146 54" stroke="var(--cref)" strokeWidth="1.5" strokeDasharray="4 4" fill="none" />
      <path d="M18 12L36 15L54 15L72 24L90 30L108 33" stroke="var(--c1)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="108" cy="33" r="3.5" fill="var(--c1)" />
    </svg>
  ),
  my_tasks: (
    <svg viewBox="0 0 160 64" aria-hidden className="size-full">
      <g fill="none" strokeWidth="1.5">
        <circle cx="24" cy="16" r="4.5" stroke="var(--warn)" />
        <circle cx="24" cy="32" r="4.5" stroke="var(--todo)" />
        <circle cx="24" cy="48" r="4.5" fill="var(--ok)" stroke="var(--ok)" />
      </g>
      <g fill="var(--line-2)">
        <rect x="36" y="13" width="70" height="6" rx="3" />
        <rect x="36" y="29" width="88" height="6" rx="3" />
        <rect x="36" y="45" width="56" height="6" rx="3" />
      </g>
      <g fill="var(--text-3)" opacity=".5">
        <rect x="128" y="13" width="18" height="6" rx="3" />
        <rect x="128" y="29" width="18" height="6" rx="3" />
        <rect x="128" y="45" width="18" height="6" rx="3" />
      </g>
    </svg>
  ),
  objectives: (
    <svg viewBox="0 0 160 64" aria-hidden className="size-full">
      <g fill="var(--c1-t)">
        <rect x="16" y="12" width="128" height="7" rx="3.5" />
        <rect x="16" y="29" width="128" height="7" rx="3.5" />
        <rect x="16" y="46" width="128" height="7" rx="3.5" />
      </g>
      <g fill="var(--c1)">
        <rect x="16" y="12" width="80" height="7" rx="3.5" />
        <rect x="16" y="29" width="108" height="7" rx="3.5" />
        <rect x="16" y="46" width="50" height="7" rx="3.5" />
      </g>
      <g fill="var(--text)">
        <rect x="104" y="9" width="2" height="13" rx="1" />
        <rect x="112" y="26" width="2" height="13" rx="1" />
        <rect x="84" y="43" width="2" height="13" rx="1" />
      </g>
    </svg>
  ),
  workload: (
    <svg viewBox="0 0 160 64" aria-hidden className="size-full">
      <g fill="var(--raised)">
        <rect x="40" y="10" width="104" height="8" rx="4" />
        <rect x="40" y="28" width="104" height="8" rx="4" />
        <rect x="40" y="46" width="104" height="8" rx="4" />
      </g>
      <g fill="var(--c1)">
        <rect x="40" y="10" width="40" height="8" rx="4" />
        <rect x="40" y="28" width="58" height="8" rx="4" />
        <rect x="40" y="46" width="22" height="8" rx="4" />
      </g>
      <g fill="var(--c2)">
        <rect x="78" y="10" width="44" height="8" rx="2" />
        <rect x="96" y="28" width="22" height="8" rx="2" />
        <rect x="60" y="46" width="40" height="8" rx="2" />
      </g>
      <g fill="var(--line-2)">
        <circle cx="24" cy="14" r="6" />
        <circle cx="24" cy="32" r="6" />
        <circle cx="24" cy="50" r="6" />
      </g>
    </svg>
  ),
  velocity: (
    <svg viewBox="0 0 160 64" aria-hidden className="size-full">
      <path d="M14 56H150" stroke="var(--line-2)" strokeWidth="1" />
      <g fill="var(--c2)">
        <rect x="24" y="22" width="9" height="34" rx="2" />
        <rect x="52" y="16" width="9" height="40" rx="2" />
        <rect x="80" y="19" width="9" height="37" rx="2" />
        <rect x="108" y="12" width="9" height="44" rx="2" />
      </g>
      <g fill="var(--c1)">
        <rect x="35" y="27" width="9" height="29" rx="2" />
        <rect x="63" y="20" width="9" height="36" rx="2" />
        <rect x="91" y="19" width="9" height="37" rx="2" />
        <rect x="119" y="16" width="9" height="40" rx="2" />
      </g>
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 160 64" aria-hidden className="size-full">
      <g fill="var(--line-2)">
        <circle cx="22" cy="16" r="6" />
        <circle cx="22" cy="32" r="6" />
        <circle cx="22" cy="48" r="6" />
        <rect x="36" y="13" width="84" height="6" rx="3" />
        <rect x="36" y="29" width="64" height="6" rx="3" />
        <rect x="36" y="45" width="92" height="6" rx="3" />
      </g>
      <g fill="var(--text-3)" opacity=".5">
        <rect x="132" y="13" width="14" height="6" rx="3" />
        <rect x="132" y="29" width="14" height="6" rx="3" />
        <rect x="132" y="45" width="14" height="6" rx="3" />
      </g>
    </svg>
  ),
};

export function WidgetGallery({
  open,
  onOpenChange,
  present,
  readable,
  onAdd,
  mobile,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Types already on the dashboard (draft). */
  present: ReadonlySet<WidgetType>;
  readable: (t: WidgetType) => boolean;
  onAdd: (t: WidgetType) => void;
  mobile: boolean;
}) {
  const types = WIDGET_TYPES.filter(readable);
  const firstFree = types.find((t) => !present.has(t));
  const count = `${WIDGET_TYPES.filter((t) => present.has(t)).length} of 6 added`;
  const grid = (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2.5 overflow-y-auto p-3.5">
      {types.map((t) => {
        const added = present.has(t);
        const { w, h } = DEFAULT_SIZE[t];
        return (
          <button
            key={t}
            type="button"
            autoFocus={t === firstFree}
            aria-disabled={added || undefined}
            aria-label={`${WIDGET_NAME[t]}${added ? ", already on dashboard" : `, ${w} by ${h}`}`}
            onClick={() => !added && onAdd(t)}
            className={cn(
              "flex flex-col gap-[9px] rounded-[10px] border border-line bg-surface p-2.5 text-left text-fg transition-[border-color,transform] duration-150 ease-out",
              added ? "cursor-default" : "hover:-translate-y-px hover:border-control motion-reduce:hover:translate-y-0",
            )}
          >
            <span className="flex h-16 items-center justify-center overflow-hidden rounded-[7px] border border-line bg-bg">{PREVIEW[t]}</span>
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              {WIDGET_NAME[t]}
              {added ? (
                <span className="ml-auto inline-flex items-center gap-[5px] whitespace-nowrap font-mono text-[11px] font-medium text-ok">
                  <Check size={12} strokeWidth={2} aria-hidden />
                  Added
                </span>
              ) : (
                <span className="ml-auto whitespace-nowrap font-mono text-[11px] font-medium text-fg-3">
                  {w} × {h}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title="Add widget">
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-2">
          <h2 className="m-0 flex-1 text-[15px] font-semibold">Add widget</h2>
          <span className="font-mono text-[11px] text-fg-3">{count}</span>
        </div>
        {grid}
      </Sheet>
    );
  }
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} title="Add widget" width={640} className="h-auto">
      <div className="flex items-center gap-2.5 border-b border-line py-3 pl-[18px] pr-3.5">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">Add widget</h2>
        <span className="font-mono text-[11px] text-fg-3">{count}</span>
        <DialogClose />
      </div>
      {grid}
    </DialogShell>
  );
}
