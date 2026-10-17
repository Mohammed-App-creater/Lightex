"use client";

import { useId } from "react";
import type { Task } from "@/lib/api/types";
import { spanOf, type Window } from "./schedule-lib";
import { buildArrows, type TlRow } from "./timeline-model";
import { usePreviews } from "./use-reschedule";

/*
 * Dependency arrows (board 32 §1.6): an aria-hidden SVG layer under the bars. From each open blocker
 * (board 39 `openBlockers`) to the task it blocks when both bars are on screen; --danger when the
 * blocked task starts on or before the blocker ends. A dragged bar's arrows follow its preview.
 */
export function DependencyArrows({ rows, tops, height, labelWidth, laneWidth, win }: { rows: TlRow[]; tops: number[]; height: number; labelWidth: number; laneWidth: number; win: Window }) {
  const previews = usePreviews();
  const id = `arr${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const spanFor = (t: Task) => {
    const p = previews[t.id];
    return (p && spanOf(p.dates)) || spanOf(t);
  };
  const arrows = buildArrows(rows, tops, laneWidth, win, spanFor);
  if (!arrows.length) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute top-0 right-0 z-[1] overflow-hidden" style={{ left: labelWidth, height }}>
    <svg className="block" width={laneWidth} height={height}>
      <defs>
        <marker id={`${id}-n`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8z" fill="var(--text-3)" />
        </marker>
        <marker id={`${id}-d`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8z" fill="var(--danger)" />
        </marker>
      </defs>
      {arrows.map((a) => (
        <path
          key={a.id}
          data-arrow={a.id}
          data-conflict={a.conflict ? "" : undefined}
          d={a.d}
          fill="none"
          stroke={a.conflict ? "var(--danger)" : "var(--text-3)"}
          strokeWidth={1.5}
          strokeLinejoin="round"
          markerEnd={`url(#${id}-${a.conflict ? "d" : "n"})`}
        />
      ))}
    </svg>
    </div>
  );
}
