"use client";

import type { WidgetConfigMap } from "@/lib/api/types";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils/cn";
import { firstName } from "@/features/presence/presence-lib";
import { useWorkloadWidget } from "../queries";
import { useLiveFlash } from "../use-live-flash";
import { WidgetEmpty, WidgetError, WidgetFrame, WidgetLegend, WidgetLoading } from "../widget-frame";
import { overCapacity, workloadMeta, workloadValue } from "../widget-lib";
import { BarRow, BarTrack, pct, useWho, type WidgetProps } from "./common";

/** Workload by person (§1.3): stacked in progress (--c1) / to do (--c2), capacity tick, `11/10`. */
export function WorkloadWidget({ project, config }: WidgetProps & { config: WidgetConfigMap["workload"] }) {
  const q = useWorkloadWidget(project.id, config);
  const who = useWho(project.id);
  const r = q.data;
  const rows = r?.rows ?? [];
  const flash = useLiveFlash({
    scope: `p:${project.id}`,
    rows,
    dataUpdatedAt: q.dataUpdatedAt,
    rowKey: (x) => x.user.id,
    rowSig: (x) => `${x.inProgress}/${x.todo}/${x.capacity}`,
    label: "Workload",
    who,
  });
  const unitShort = r?.unit === "hours" ? "h" : "pts";

  let body;
  if (q.isPending) body = <WidgetLoading />;
  else if (q.isError) body = <WidgetError onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  else if (!r?.sprint) body = <WidgetEmpty>No active sprint</WidgetEmpty>;
  else if (!rows.length) body = <WidgetEmpty>No assigned work in this sprint</WidgetEmpty>;
  else
    body = (
      <>
        <WidgetLegend
          items={[
            { kind: "rect", label: "In progress", color: "var(--c1)" },
            { kind: "rect", label: "To do", color: "var(--c2)" },
            { kind: "tick", label: "Capacity" },
          ]}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {rows.map((x) => {
            const total = x.inProgress + x.todo;
            const over = overCapacity(x);
            const v = (n: number) => workloadValue(n, r.unit);
            return (
              <BarRow
                key={x.user.id}
                columns="96px minmax(0,1fr) 52px"
                label={`${x.user.name}: ${v(x.inProgress)} in progress, ${v(x.todo)} to do${x.capacity !== null ? `, capacity ${v(x.capacity)}` : ""}${over ? ", over capacity" : ""}`}
                tipHead={`${x.user.name} · ${unitShort}`}
                tipRows={[
                  { kind: "rect", color: "var(--c1)", value: v(x.inProgress), label: "in progress" },
                  { kind: "rect", color: "var(--c2)", value: v(x.todo), label: "to do" },
                  ...(x.capacity !== null ? [{ kind: "tick" as const, value: v(x.capacity), label: "capacity" }] : []),
                ]}
              >
                <span className="flex min-w-0 items-center gap-[7px] truncate">
                  <Avatar name={x.user.name} hue={x.user.hue} size={20} decorative ring={false} />
                  <span className="truncate">{firstName(x.user.name)}</span>
                </span>
                <BarTrack
                  neutral
                  fills={[
                    { from: 0, width: pct(x.inProgress, r.scale), color: "var(--c1)" },
                    { from: pct(x.inProgress, r.scale), width: pct(x.todo, r.scale), color: "var(--c2)", round: "end" },
                  ]}
                  tick={x.capacity !== null ? pct(x.capacity, r.scale) : null}
                />
                <span className={cn("rounded-xs px-1 py-[3px] text-right font-mono text-[11.5px] font-medium tabular-nums text-fg-2", over && "text-danger", flash.has(x.user.id) && "hl")}>
                  {v(total)}
                  {x.capacity !== null && `/${v(x.capacity)}`}
                </span>
              </BarRow>
            );
          })}
        </div>
      </>
    );
  return <WidgetFrame meta={workloadMeta(r)}>{body}</WidgetFrame>;
}
