"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils/cn";
import { applyDelta, barGeometry, fmtDay, pxToDays, spanDays, spanOf, timelineKey, type Dates, type DragMode, type Span, type Window } from "./schedule-lib";
import { useBarDrag } from "./use-bar-drag";
import { setPreview, usePreview } from "./use-reschedule";

/*
 * One timeline bar (design .tl-bar): epic bar (24 px, % label) or task bar (12 px). Drag the middle to
 * move, an edge to resize; ← / → move, Shift+← / → resize the due edge; Enter opens (epic: toggles);
 * ↑ / ↓ move focus to the previous / next bar. Position is left/width % (never transitioned).
 */

export type BarProps = {
  id: string;
  kind: "task" | "epic";
  span: Span;
  toDates: (span: Span, mode: DragMode) => Dates;
  hue: number | null;
  derived?: boolean;
  fill: number;
  showPct?: boolean;
  label: string;
  suffix?: string;
  editable: boolean;
  win: Window;
  laneWidth: () => number;
  tabbable: boolean;
  pending?: boolean;
  dim?: boolean;
  onOpen: (el: HTMLElement) => void;
  onEnter?: () => void;
  onCommit: (span: Span, mode: DragMode) => void;
  onNudge: (span: Span, mode: DragMode) => void;
  onFlush: () => void;
  onCancel: () => void;
};

export function TimelineBar(p: BarProps) {
  const preview = usePreview(p.id);
  const shown = (preview && spanOf(preview.dates)) || p.span;
  const ref = useRef<HTMLDivElement>(null);
  const next = useRef<{ span: Span; mode: DragMode } | null>(null);
  const [dragging, setDragging] = useState(false);
  // "land" pulse once a pending reschedule settles (state-from-props pattern, no effect).
  const [prevPending, setPrevPending] = useState(Boolean(p.pending));
  const [landed, setLanded] = useState(0);
  if (Boolean(p.pending) !== prevPending) {
    setPrevPending(Boolean(p.pending));
    if (!p.pending) setLanded((n) => n + 1);
  }

  const drag = useBarDrag({
    enabled: p.editable,
    resizable: true,
    onStart: () => setDragging(true),
    onMove: (s) => {
      const span = applyDelta(p.span, s.mode, pxToDays(s.dx, p.laneWidth(), p.win));
      next.current = { span, mode: s.mode };
      setPreview(p.id, { dates: p.toDates(span, s.mode), mode: s.mode, source: "drag" });
    },
    onEnd: (commit) => {
      setDragging(false);
      const n = next.current;
      next.current = null;
      if (commit && n) p.onCommit(n.span, n.mode);
      else setPreview(p.id, null);
    },
    onTap: () => ref.current && (p.onEnter ? p.onEnter() : p.onOpen(ref.current)),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (p.onEnter) p.onEnter();
      else p.onOpen(e.currentTarget);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const root = e.currentTarget.closest("[data-tl-root]");
      const all = root ? Array.from(root.querySelectorAll<HTMLElement>("[data-tl-bar]")) : [];
      const i = all.indexOf(e.currentTarget);
      all[e.key === "ArrowUp" ? i - 1 : i + 1]?.focus();
      return;
    }
    if (e.key === "Escape" && preview) {
      e.preventDefault();
      e.stopPropagation();
      p.onCancel();
      return;
    }
    if (!p.editable || e.altKey || e.metaKey || e.ctrlKey) return;
    const r = timelineKey(shown, e.key, e.shiftKey);
    if (!r) return;
    e.preventDefault();
    p.onNudge(r.span, r.mode);
  };

  const g = barGeometry(shown, p.win);
  const mode = preview?.mode;
  const tip = Boolean(preview);
  const task = p.kind === "task";
  const aria = `${p.label}, ${fmtDay(shown.start)} to ${fmtDay(shown.end)}${p.suffix ?? ""}${p.editable ? ". Arrow keys move, Shift plus arrow resizes" : ""}`;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={p.tabbable ? 0 : -1}
      data-tl-bar=""
      data-kind={p.kind}
      data-editable={p.editable ? "" : undefined}
      data-neutral={p.hue === null ? "" : undefined}
      data-derived={p.derived ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      aria-roledescription={p.editable ? "draggable bar" : "bar"}
      aria-label={aria}
      onKeyDown={onKeyDown}
      onBlur={p.onFlush}
      {...drag}
      className={cn(
        "tl-bar absolute top-1/2 z-[2] min-w-[6px] select-none outline-none",
        task ? "-mt-1.5 h-3 rounded-[4px]" : "-mt-3 h-6 rounded-[6px]",
        p.editable ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-pointer",
        p.dim && !dragging && "opacity-60",
        dragging && "z-[6]",
      )}
      style={{ left: `${g.left}%`, width: `${g.width}%`, "--h": p.hue ?? undefined, touchAction: p.editable ? "pan-y" : undefined } as CSSProperties}
    >
      <span key={landed} className={cn("absolute inset-0 flex items-center overflow-hidden rounded-[inherit]", landed > 0 && "sch-land")}>
        {!p.derived && <span className="tl-fill absolute inset-y-0 left-0" style={{ width: `${p.fill}%` }} />}
        {p.showPct && <span className="relative ml-2 whitespace-nowrap font-mono text-[11px] font-semibold leading-none text-fg">{p.fill}%</span>}
      </span>
      {p.editable && (
        <>
          <span aria-hidden data-on={mode === "start" ? "" : undefined} className="tl-grip absolute inset-y-0 left-0 z-[3] flex w-[9px] cursor-ew-resize items-center justify-center" />
          <span aria-hidden data-on={mode === "end" ? "" : undefined} className="tl-grip absolute inset-y-0 right-0 z-[3] flex w-[9px] cursor-ew-resize items-center justify-center" />
        </>
      )}
      {p.pending && <span aria-hidden className="sch-sync absolute -right-3.5 top-1/2 -mt-[4.5px]" />}
      {tip && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-[7] flex h-[26px] items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-[9px] font-mono text-[11.5px] font-medium text-fg-2 shadow-pop",
            task ? "left-[calc(100%+10px)] top-1/2 -translate-y-1/2" : "bottom-[calc(100%+8px)] -translate-x-1/2",
          )}
          style={task ? undefined : { left: mode === "start" ? "0%" : mode === "end" ? "100%" : "50%" }}
        >
          <span className={cn(mode !== "end" && "font-semibold text-accent-t")}>{fmtDay(shown.start)}</span>→
          <span className={cn(mode !== "start" && "font-semibold text-accent-t")}>{fmtDay(shown.end)}</span>
          <span className="border-l border-line-2 pl-[7px] text-fg-3">{spanDays(shown)}d</span>
        </span>
      )}
    </div>
  );
}
