"use client";

import { BurndownChart } from "@/features/reports/charts";
import type { WidgetConfigMap } from "@/lib/api/types";
import { useBurndownWidget } from "../queries";
import { useLiveFlash } from "../use-live-flash";
import { WidgetEmpty, WidgetError, WidgetFrame, WidgetLegend, WidgetLoading } from "../widget-frame";
import { burndownAria } from "../widget-lib";
import { useWho, type WidgetProps } from "./common";

/** Burndown (§1.3): Remaining line + area, dashed ideal, "Today" rule, end dot; sprint name as meta. */
export function BurndownWidget({ project, config, mobile, reduce }: WidgetProps & { config: WidgetConfigMap["burndown"] }) {
  const q = useBurndownWidget(project.id, config.sprintId);
  const who = useWho(project.id);
  const points = q.data?.points ?? [];
  const sprint = q.data?.sprint ?? null;
  const flash = useLiveFlash({
    scope: `p:${project.id}`,
    rows: points,
    dataUpdatedAt: q.dataUpdatedAt,
    rowKey: (p) => p.date,
    rowSig: (p) => String(p.remaining),
    label: "Burndown",
    who,
  });
  const hasData = !!sprint && points.length > 1;

  let body;
  if (q.isPending) body = <WidgetLoading />;
  else if (q.isError) body = <WidgetError onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  else if (!hasData) body = <WidgetEmpty>No active sprint</WidgetEmpty>;
  else
    body = (
      <>
        <WidgetLegend
          items={[
            { kind: "line", label: "Remaining" },
            { kind: "dash", label: "Ideal" },
          ]}
        />
        <div className={flash.size ? "hl min-h-0 flex-1 rounded-md" : "min-h-0 flex-1"}>
          <BurndownChart points={points} name={sprint.name} reduce={reduce} mobile={mobile} fill area remainingLabel="remaining" ariaText={burndownAria(sprint.name, points)} />
        </div>
      </>
    );
  return <WidgetFrame meta={sprint?.name}>{body}</WidgetFrame>;
}
