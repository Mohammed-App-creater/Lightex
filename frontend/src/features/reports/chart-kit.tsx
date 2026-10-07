"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils/cn";

/*
 * Card chrome and chart scaffolding shared by every Reports chart (board 17 §2.4).
 * Colours always come from CSS variables so the charts follow the theme.
 */

/* ───────────── card ───────────── */

export function ChartCard({
  title,
  meta,
  toggle,
  legend,
  span2,
  className,
  children,
}: {
  title: string;
  meta?: ReactNode;
  toggle?: ReactNode;
  legend?: ReactNode;
  span2?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-lg border border-line bg-surface px-[18px] py-3.5",
        "@max-[760px]:px-3.5 @max-[760px]:py-3",
        span2 && "col-span-2 @max-[760px]:col-span-1",
        className,
      )}
    >
      <div className="flex min-h-6 items-center gap-2">
        <h2 id={id} className="m-0 whitespace-nowrap text-[13px] font-semibold leading-[18px]">
          {title}
        </h2>
        {meta && <span className="truncate font-mono text-[12px] leading-4 text-fg-3">{meta}</span>}
        <span className="flex-1" />
        {toggle}
      </div>
      {legend}
      {children}
    </section>
  );
}

const TableIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 3.5h11v9h-11zM2.5 7h11M2.5 10h11M6.5 3.5v9" />
  </svg>
);

/** `.rp-tbtn`: "View as table" toggle (aria-pressed). */
export function TableToggle({
  pressed,
  onToggle,
  label,
  ariaLabel,
}: {
  pressed: boolean;
  onToggle: () => void;
  label: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "inline-flex h-6 flex-none items-center gap-1.5 rounded-sm border border-transparent px-2 text-[12px] font-medium text-fg-3",
        "transition-[background-color,color] duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg",
        "aria-pressed:border-line-2 aria-pressed:bg-hover aria-pressed:text-fg max-[1023px]:h-8",
      )}
    >
      <TableIcon />
      {label}
    </button>
  );
}

/* ───────────── legend + keys ───────────── */

export type KeyKind = "line" | "dash" | "rect" | "tick";

/** Tooltip key swatches (`.rp-k`). */
export function TipKey({ kind, color = "var(--c1)" }: { kind: KeyKind; color?: string }) {
  if (kind === "dash") return <span aria-hidden className="h-0 w-3 flex-none border-t-2 border-dashed border-cref" />;
  if (kind === "rect") return <span aria-hidden className="size-2 flex-none rounded-[2px]" style={{ background: color }} />;
  if (kind === "tick") return <span aria-hidden className="h-2.5 w-0.5 flex-none rounded-[1px] bg-fg" />;
  return <span aria-hidden className="h-0.5 w-3 flex-none rounded-[1px]" style={{ background: color }} />;
}

/** Legend keys (`.lk-*`). */
function LegendKey({ kind, color = "var(--c1)" }: { kind: KeyKind; color?: string }) {
  if (kind === "dash") return <span aria-hidden className="h-0 w-3.5 border-t-2 border-dashed border-cref" />;
  if (kind === "rect") return <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: color }} />;
  if (kind === "tick") return <span aria-hidden className="h-3 w-0.5 rounded-[1px] bg-fg" />;
  return <span aria-hidden className="h-0.5 w-3.5 rounded-[1px]" style={{ background: color }} />;
}

export function Legend({ items }: { items: { kind: KeyKind; label: string; color?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-3.5 text-[12px] leading-4 text-fg-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <LegendKey kind={it.kind} color={it.color} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* ───────────── tooltip ───────────── */

export type TipRow = { kind: KeyKind; color?: string; value: ReactNode; label: string };

/** `.rp-tip` card. */
export function TipCard({ head, rows, className }: { head: ReactNode; rows: TipRow[]; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-[128px] flex-col gap-1.5 whitespace-nowrap rounded-md border border-line-2 bg-raised px-2.5 py-2 text-left shadow-pop",
        "pointer-events-none animate-[tip-in_120ms_var(--ease)]",
        className,
      )}
    >
      <span className="font-mono text-[11px] font-medium leading-none text-fg-3">{head}</span>
      {rows.map((r) => (
        <span key={r.label} className="flex items-center gap-2 text-[12px] leading-4 text-fg-2">
          <TipKey kind={r.kind} color={r.color} />
          <b className="tabular min-w-[26px] text-[13px] font-semibold text-fg">{r.value}</b>
          {r.label}
        </span>
      ))}
    </div>
  );
}

/* ───────────── axis ticks ───────────── */

type TickProps = { x?: number | string; y?: number | string; payload?: { value: number | string } };

/** Y labels: mono 10.5px text-3, right-aligned 8px from the plot. */
export function YTick({ x, y, payload }: TickProps) {
  return (
    <text
      x={Number(x)}
      y={Number(y)}
      dy="0.35em"
      textAnchor="end"
      className="fill-fg-3 font-mono text-[10.5px] font-medium tabular-nums"
    >
      {payload?.value}
    </text>
  );
}

/**
 * X labels: mono 10.5px text-3 centred on the slot, 7px below the baseline; "Today" is text-2.
 * Pass as `tick={<XTick format={…} today={…} />}` (Recharts clones it with x / y / payload).
 */
export function XTick({
  x,
  y,
  payload,
  format = (v) => String(v),
  today,
}: TickProps & { format?: (v: number | string) => string; today?: number | string }) {
  const v = payload?.value ?? "";
  const isToday = today !== undefined && v === today;
  return (
    <text
      x={Number(x)}
      y={Number(y)}
      dy="0.75em"
      textAnchor="middle"
      className={cn("font-mono text-[10.5px] font-medium", isToday ? "fill-fg-2" : "fill-fg-3")}
    >
      {format(v)}
    </text>
  );
}

/** Shared Recharts props: 28px y column, 20px x row, no axis lines, horizontal gridlines only. */
export const Y_AXIS = { width: 28, tickSize: 0, tickMargin: 8, axisLine: false, tickLine: false, allowDecimals: false } as const;
export const X_AXIS = { height: 20, tickSize: 0, tickMargin: 7, axisLine: false, tickLine: false } as const;
export const MARGIN = { top: 8, right: 6, bottom: 0, left: 0 };
export const HOVER_FILL = "rgba(128,140,170,.07)";
/** Hovered bar brightens (darkens in the light theme). */
export const ACTIVE_BAR_CLASS = "[filter:brightness(1.18)] [[data-theme=light]_&]:[filter:brightness(.88)]";

/** Chart box: plot aspect ratio from the design + 28px y column + 20px x row. */
export function chartStyle(w: number, h: number) {
  return { width: "100%", aspectRatio: `${w + 28} / ${h + 20}`, maxHeight: h + 60 } as const;
}

/* ───────────── table view ───────────── */

export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="max-h-[236px] overflow-auto rounded-md border border-line" tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "sticky top-0 bg-raised px-2.5 py-[7px] font-medium text-fg-2",
                  i === 0 ? "text-left" : "text-right",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) =>
                ci === 0 ? (
                  <th key={ci} scope="row" className="border-t border-line px-2.5 py-1.5 text-left font-normal">
                    {cell}
                  </th>
                ) : (
                  <td key={ci} className="tabular border-t border-line px-2.5 py-1.5 text-right">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────── empty / loading ───────────── */

export const BarsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 13V8M6.5 13V4M10 13V9.5M13.5 13V6" />
  </svg>
);
export const TrendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 12l3.5-4 3 2.5 4.5-6" />
  </svg>
);
export const TargetIcon = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z" />
  </svg>
);

/** `.rp-empty`: dashed box, icon, title, mono caption and optional mini progress. */
export function ChartEmpty({
  icon,
  title,
  caption,
  progress,
  children,
}: {
  icon: ReactNode;
  title: string;
  caption?: ReactNode;
  /** 0–1, renders the 96×4 `.rp-need` bar. */
  progress?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[190px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-2 p-4 text-center">
      <span className="text-fg-3">{icon}</span>
      <b className="text-[13px] font-semibold">{title}</b>
      {caption && <span className="font-mono text-[12px] leading-4 text-fg-3">{caption}</span>}
      {progress !== undefined && (
        <span
          role="progressbar"
          aria-label={typeof caption === "string" ? caption : title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="block h-1 w-24 overflow-hidden rounded-[2px] bg-raised"
        >
          <span className="block h-full rounded-[2px] bg-fg-3" style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} />
        </span>
      )}
      {children}
    </div>
  );
}

/** "Not enough data yet" for charts that need 3 completed sprints. */
export function NotEnoughData({ icon, completed, need = 3 }: { icon: ReactNode; completed: number; need?: number }) {
  // Only shown while the API says the data is insufficient, so never claim the target is met.
  const n = Math.max(0, Math.min(need - 1, completed));
  return (
    <ChartEmpty icon={icon} title="Not enough data yet" caption={`${n} of ${need} sprints`} progress={n / need} />
  );
}

/** Card body skeleton (chart area). */
export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return <Skeleton className="w-full rounded-md" style={{ height }} />;
}

/** Inline per-card failure with Retry (the page-level card covers KPI failures). */
export function ChartError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="flex min-h-[190px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-2 p-4 text-center">
      <span aria-hidden className="inline-flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-bold leading-none text-bg">
        !
      </span>
      <b className="text-[13px] font-semibold">Couldn’t load this chart</b>
      <Button variant="secondary" size="sm" loading={retrying} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Bar width from the measured slot width: `clamp(min, fraction × slot, 24px)` like the design's
 * CSS bars (Recharts' percentage gaps don't resolve reliably with `responsive`).
 */
export function useBarSize(slots: number, fraction: number, min: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plot = Math.max(0, width - 28 - MARGIN.left - MARGIN.right);
  const slot = slots > 0 ? plot / slots : 0;
  return [ref, Math.round(Math.max(min, Math.min(24, slot * fraction)))] as const;
}
