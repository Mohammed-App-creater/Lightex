"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProgressRow } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ChartCard, ChartEmpty, ChartError, ChartSkeleton, Legend, TargetIcon, TipCard } from "./chart-kit";
import { shortDate } from "./lib";

/*
 * Chart 5 · Objectives & milestones progress (bullet bars, board 17 §2.4).
 * c1 fill on a c1-t track, "expected today" tick, tooltip above the row on hover / focus.
 */

type QueryLike<T> = { data: T | undefined; isPending: boolean; isError: boolean; isRefetching: boolean; refetch: () => unknown };

export function ProgressCard({
  q,
  reduce,
  mobile,
  goalsHref,
}: {
  q: QueryLike<ProgressRow[]>;
  reduce: boolean;
  mobile: boolean;
  goalsHref: string;
}) {
  const rows = q.data ?? [];
  const objectives = rows.filter((r) => r.kind === "objective");
  const milestones = rows.filter((r) => r.kind === "milestone");
  const ready = rows.length > 0;

  let body;
  if (q.isPending) body = <ChartSkeleton height={200} />;
  else if (q.isError) body = <ChartError onRetry={() => q.refetch()} retrying={q.isRefetching} />;
  else if (!ready)
    body = (
      <ChartEmpty icon={<TargetIcon />} title="No objectives linked" caption="0 objectives · 0 milestones">
        <Link href={goalsHref} className="text-[12px] font-medium text-accent-t hover:underline">
          Go to objectives
        </Link>
      </ChartEmpty>
    );
  else
    body = (
      <div className="flex flex-col">
        <Group title="Objectives" rows={objectives} reduce={reduce} offset={0} />
        {!mobile && <Group title="Milestones" rows={milestones} reduce={reduce} offset={objectives.length} />}
      </div>
    );

  return (
    <ChartCard
      title="Objectives & milestones"
      legend={
        ready ? (
          <Legend
            items={[
              { kind: "rect", label: "Progress" },
              { kind: "tick", label: "Expected today" },
            ]}
          />
        ) : undefined
      }
    >
      {body}
    </ChartCard>
  );
}

function Group({ title, rows, reduce, offset }: { title: string; rows: ProgressRow[]; reduce: boolean; offset: number }) {
  const [active, setActive] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(reduce);
  useEffect(() => {
    if (reduce) return;
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [reduce]);
  if (!rows.length) return null;
  return (
    <>
      <h3 className="m-0 mb-0.5 mt-1 font-mono text-[11px] font-medium uppercase leading-none tracking-[0.06em] text-fg-3">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col p-0" aria-label={title}>
        {rows.map((r, i) => {
          const pct = Math.max(0, Math.min(100, Math.round(r.percent)));
          const exp = r.expected == null ? null : Math.max(0, Math.min(100, Math.round(r.expected)));
          const diff = exp == null ? 0 : pct - exp;
          const verdict =
            exp == null ? "" : `, expected ${exp} percent, ${diff < 0 ? `behind by ${-diff}` : diff > 0 ? `ahead by ${diff}` : "on track"}`;
          const due = r.dueDate ? ` · due ${shortDate(r.dueDate)}` : "";
          const on = active === r.id;
          return (
            <li
              key={r.id}
              tabIndex={0}
              aria-label={`${r.name}: ${pct} percent${verdict}${r.dueDate ? `, due ${shortDate(r.dueDate)}` : ""}`}
              onMouseEnter={() => setActive(r.id)}
              onMouseLeave={() => setActive((a) => (a === r.id ? null : a))}
              onFocus={() => setActive(r.id)}
              onBlur={() => setActive((a) => (a === r.id ? null : a))}
              onKeyDown={(e) => {
                if (e.key === "Escape") setActive(null);
              }}
              className={cn(
                "relative -mx-1.5 grid h-7 w-[calc(100%+12px)] grid-cols-[minmax(0,1fr)_42%_34px] items-center gap-2.5 rounded-sm px-1.5 text-[12.5px]",
                "hover:bg-hover max-[1023px]:h-9",
                on && "bg-hover",
              )}
            >
              <span className="truncate">{r.name}</span>
              <span className="relative h-2 rounded-[4px] bg-c1-t">
                <span
                  className="absolute inset-y-0 left-0 origin-left rounded-[4px] bg-c1"
                  style={{
                    width: `${pct}%`,
                    transform: drawn ? "none" : "scaleX(0)",
                    transition: reduce ? "none" : `transform 700ms var(--ease) ${(offset + i) * 50}ms`,
                  }}
                />
                {exp != null && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -top-1 -ml-px w-0.5 rounded-[1px] bg-fg shadow-[0_0_0_1px_var(--surface)]"
                    style={{ left: `${exp}%` }}
                  />
                )}
              </span>
              <span className="tabular text-right font-mono text-[11.5px] font-medium text-fg-2">{pct}%</span>
              {on && (
                <TipCard
                  className="absolute bottom-[calc(100%+2px)] right-11 z-[6]"
                  head={r.name}
                  rows={[
                    { kind: "rect", value: `${pct}%`, label: "complete" },
                    ...(exp != null ? [{ kind: "tick" as const, value: `${exp}%`, label: `expected today${due}` }] : []),
                  ]}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
