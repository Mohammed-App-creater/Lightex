"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Button } from "./button";
import { ErrorGlyph } from "./glyphs";

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cn("skeleton h-2.5", className)} style={style} />;
}

/** Rows of skeleton list items (board 06 "skeleton to content"). */
export function SkeletonRows({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  const widths = [52, 64, 44, 58, 70, 48];
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-0.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-3">
          <Skeleton className="size-3.5 rounded-full" />
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5" style={{ width: `${widths[i % widths.length]}%` }} />
          <Skeleton className="ml-auto size-5 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Empty state (board 06): dashed 44px icon tile, 16px title, 13px body, actions. */
export function EmptyState({
  icon,
  title,
  body,
  actions,
  className,
  align = "start",
}: {
  icon: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  className?: string;
  align?: "start" | "center";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 py-2",
        align === "center" ? "items-center text-center" : "items-start",
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-[10px] border border-dashed border-line-2 bg-bg text-fg-2">
        {icon}
      </div>
      <h3 className="m-0 text-[16px] font-semibold leading-6">{title}</h3>
      {body && <p className="m-0 max-w-[320px] text-[13px] leading-5 text-fg-2">{body}</p>}
      {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
    </div>
  );
}

/** Inline error card (board 06 "Couldn't load tasks"): glyph, title, body, Retry R, ref id. */
export function ErrorState({
  title = "Couldn’t load this",
  body = "The request failed. Your changes are safe.",
  refId,
  onRetry,
  retrying,
  className,
}: {
  title?: ReactNode;
  body?: ReactNode;
  refId?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex flex-col gap-3 rounded-[10px] border border-line bg-bg p-5", className)}
    >
      <div className="flex items-center gap-2.5">
        <ErrorGlyph />
        <span className="text-[14px] font-semibold">{title}</span>
      </div>
      {body && <p className="m-0 text-[13px] leading-5 text-fg-2">{body}</p>}
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="secondary" kbd="R" onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        )}
        {refId && <CopyRef value={refId} />}
      </div>
    </div>
  );
}

export function CopyRef({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-fg-3">
      ref {value}
      <button
        type="button"
        aria-label="Copy reference id"
        onClick={() => {
          void navigator.clipboard?.writeText(value).catch(() => undefined);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }}
        className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-hover hover:text-fg"
      >
        {done ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
      </button>
    </span>
  );
}

/** Counts a number up over 700ms (board 06 "numbers count up"). Final value under reduced motion. */
export function useCountUp(target: number, { duration = 700, decimals = 0 } = {}) {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = reduce ? 1 : Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      const v = start + (target - start) * e;
      setValue(Number(v.toFixed(decimals)));
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, decimals]);
  return value;
}

export function CountUp({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const v = useCountUp(value, { decimals });
  return (
    <span className="tabular">
      {decimals ? v.toFixed(decimals) : v}
      {suffix}
    </span>
  );
}

/**
 * Progress ring (board 06): track --raised, round cap, fills over 700ms from 0.
 * Sizes used by the design: 84 (stats), 40 (objectives), 30 (sidebar sprint), 24 (rail), 14 (cards).
 */
export function ProgressRing({
  value,
  size = 84,
  stroke,
  color = "var(--accent)",
  track = "var(--raised)",
  label,
  showValue,
  className,
  animate = true,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  label: string;
  showValue?: boolean;
  className?: string;
  animate?: boolean;
}) {
  const sw = stroke ?? (size >= 80 ? 7 : size >= 40 ? 4 : size >= 24 ? 3.5 : 2);
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  const [drawn, setDrawn] = useState(animate ? 0 : pct);
  useEffect(() => {
    if (!animate) return;
    const id = requestAnimationFrame(() => setDrawn(pct));
    return () => cancelAnimationFrame(id);
  }, [pct, animate]);
  const shown = animate ? drawn : pct;
  return (
    <span
      className={cn("relative inline-flex flex-none", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label} ${Math.round(pct)} percent`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={sw} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: animate ? "stroke-dashoffset 700ms var(--ease)" : undefined }}
        />
      </svg>
      {showValue && (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center font-semibold",
            size >= 80 ? "text-[16px]" : "text-[11px]",
          )}
        >
          <CountUp value={Math.round(pct)} suffix="%" />
        </span>
      )}
    </span>
  );
}

/** Progress bar (board 06 .bar): 6px, --raised track with --line border, fills over 700ms. */
export function ProgressBar({
  value,
  label,
  color = "var(--text-2)",
  className,
  height = 6,
  marker,
}: {
  value: number;
  label: string;
  color?: string;
  className?: string;
  height?: number;
  /** Optional "expected today" tick (percent). */
  marker?: number;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("relative overflow-visible rounded-full border border-line bg-raised", className)}
      style={{ height }}
    >
      <span className="block h-full overflow-hidden rounded-full">
        <span
          className="block h-full origin-left rounded-full"
          style={{
            background: color,
            transform: `scaleX(${drawn / 100})`,
            transition: "transform 700ms var(--ease)",
          }}
        />
      </span>
      {marker !== undefined && (
        <span
          aria-hidden
          className="absolute -bottom-1 -top-1 w-0.5 rounded-[1px] bg-fg shadow-[0_0_0_1px_var(--surface)]"
          style={{ left: `calc(${Math.max(0, Math.min(100, marker))}% - 1px)` }}
        />
      )}
    </div>
  );
}
