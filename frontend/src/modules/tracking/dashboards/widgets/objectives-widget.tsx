"use client";

import type { WidgetConfigMap } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { useProgressWidget } from "../queries";
import { useLiveFlash } from "../use-live-flash";
import { WidgetEmpty, WidgetError, WidgetFrame, WidgetLegend, WidgetLoading } from "../widget-frame";
import { behind, objectiveRows } from "../widget-lib";
import { BarRow, BarTrack, useWho, type WidgetProps } from "./common";

/** Objective progress (§1.3): name, bar with the expected tick, `62%` (danger when > 10 behind). */
export function ObjectivesWidget({ project, config }: WidgetProps & { config: WidgetConfigMap["objectives"] }) {
  const q = useProgressWidget(project.id);
  const who = useWho(project.id);
  const rows = objectiveRows(q.data ?? [], config.quarter);
  const flash = useLiveFlash({
    scope: `p:${project.id}`,
    rows,
    dataUpdatedAt: q.dataUpdatedAt,
    rowKey: (r) => r.id,
    rowSig: (r) => `${r.percent}/${r.expected}`,
    label: "Objective progress",
    who,
  });

  let body;
  if (q.isPending) body = <WidgetLoading />;
  else if (q.isError) body = <WidgetError onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  else if (!rows.length) body = <WidgetEmpty>No objectives</WidgetEmpty>;
  else
    body = (
      <>
        <WidgetLegend
          items={[
            { kind: "rect", label: "Progress" },
            { kind: "tick", label: "Expected today" },
          ]}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {rows.map((r) => {
            const late = behind(r);
            return (
              <BarRow
                key={r.id}
                columns="minmax(0,1fr) 38% 40px"
                label={`${r.name}: ${r.percent} percent${r.expected !== null ? `, expected ${r.expected}` : ""}`}
                tipHead={r.name}
                tipRows={[
                  { kind: "rect", value: `${r.percent}%`, label: "progress" },
                  ...(r.expected !== null ? [{ kind: "tick" as const, value: `${r.expected}%`, label: "expected" }] : []),
                ]}
              >
                <span className="min-w-0 truncate">{r.name}</span>
                <BarTrack fills={[{ from: 0, width: r.percent, color: "var(--c1)" }]} tick={r.expected} />
                <span className={cn("rounded-xs px-1 py-[3px] text-right font-mono text-[11.5px] font-medium tabular-nums text-fg-2", late && "text-danger", flash.has(r.id) && "hl")}>
                  {r.percent}%
                </span>
              </BarRow>
            );
          })}
        </div>
      </>
    );
  return <WidgetFrame meta={config.quarter ?? "All quarters"}>{body}</WidgetFrame>;
}
