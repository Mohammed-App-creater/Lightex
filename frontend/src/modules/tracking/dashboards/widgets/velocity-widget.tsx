"use client";

import { VelocityChart } from "@/features/reports/charts";
import type { WidgetConfigMap } from "@/lib/api/types";
import { useVelocityWidget } from "../queries";
import { useLiveFlash } from "../use-live-flash";
import { WidgetEmpty, WidgetError, WidgetFrame, WidgetLegend, WidgetLoading } from "../widget-frame";
import { velocityAvg } from "../widget-lib";
import { useWho, type WidgetProps } from "./common";

/** Velocity (§1.3): grouped committed / completed bars per sprint (S9…S13); meta "avg 35". */
export function VelocityWidget({ project, config, mobile, reduce }: WidgetProps & { config: WidgetConfigMap["velocity"] }) {
  const q = useVelocityWidget(project.id, config.range);
  const who = useWho(project.id);
  const pts = q.data?.points ?? [];
  const ready = !!q.data && !q.data.insufficient && pts.length > 0;
  const avg = velocityAvg(pts);
  const flash = useLiveFlash({
    scope: `p:${project.id}`,
    rows: pts,
    dataUpdatedAt: q.dataUpdatedAt,
    rowKey: (p) => p.sprint,
    rowSig: (p) => `${p.committed}/${p.completed}`,
    label: "Velocity",
    who,
  });

  let body;
  if (q.isPending) body = <WidgetLoading />;
  else if (q.isError) body = <WidgetError onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  else if (!ready) body = <WidgetEmpty>Velocity needs 3 completed sprints</WidgetEmpty>;
  else
    body = (
      <>
        <WidgetLegend
          items={[
            { kind: "rect", label: "Committed", color: "var(--c2)" },
            { kind: "rect", label: "Completed", color: "var(--c1)" },
          ]}
        />
        <div className={flash.size ? "hl min-h-0 flex-1 rounded-md" : "min-h-0 flex-1"}>
          <VelocityChart
            pts={pts}
            avg={avg}
            reduce={reduce}
            mobile={mobile}
            fill
            ariaText={`Velocity, sprints ${pts[0]?.sprint.replace(/^S/, "")} to ${pts[pts.length - 1]?.sprint.replace(/^S/, "")}: average ${avg} points completed of ${Math.round(pts.reduce((a, p) => a + p.committed, 0) / pts.length)} committed`}
          />
        </div>
      </>
    );
  return <WidgetFrame meta={ready ? `avg ${avg}` : undefined}>{body}</WidgetFrame>;
}
