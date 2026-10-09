"use client";

import { Avatar } from "@/components/ui/avatar";
import { firstName } from "@/features/presence/presence-lib";
import { activityText } from "@/features/tasks/activity-text";
import type { ActivityEntry } from "@/lib/api/types";
import { useIsLive } from "@/lib/realtime/status-store";
import { cn } from "@/lib/utils/cn";
import { ago } from "@/lib/utils/dates";
import { useActivityWidget } from "../queries";
import { useLiveFlash } from "../use-live-flash";
import { WidgetEmpty, WidgetError, WidgetFrame, WidgetLoading } from "../widget-frame";
import { useWho, type WidgetProps } from "./common";

const KEY = "\u0000";

/** "Riley moved PRJ-45 to In review": v1 activity text with the task key set in mono. */
function Line({ a }: { a: ActivityEntry }) {
  const raw = activityText(a, a.taskKey ? KEY : undefined);
  // Verbs without "this" / "the task" ("commented") name the task after them: "commented on PRJ-33".
  const text = a.taskKey && !raw.includes(KEY) ? `${raw} on ${KEY}` : raw;
  const [before, after] = a.taskKey ? text.split(KEY) : [text, undefined];
  return (
    <>
      {before}
      {a.taskKey && after !== undefined && (
        <>
          <span className="font-mono text-[11px] font-medium text-fg">{a.taskKey}</span>
          {after}
        </>
      )}
    </>
  );
}

/** Recent activity (§1.3): avatar, First name + verb + key + tail, relative time ("now" in the live tone). */
export function ActivityWidget({ project }: WidgetProps) {
  const live = useIsLive();
  const q = useActivityWidget(project.id);
  const who = useWho(project.id);
  const rows = q.data?.data ?? [];
  const flash = useLiveFlash({
    scope: `p:${project.id}`,
    rows: rows.slice(0, 1),
    dataUpdatedAt: q.dataUpdatedAt,
    rowKey: (a) => a.id,
    rowSig: (a) => a.id,
    label: "Recent activity",
    who,
  });

  let body;
  if (q.isPending) body = <WidgetLoading />;
  else if (q.isError) body = <WidgetError onRetry={() => void q.refetch()} retrying={q.isRefetching} />;
  else if (!rows.length) body = <WidgetEmpty>No activity yet</WidgetEmpty>;
  else
    body = (
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-hidden p-0">
        {rows.map((a) => {
          const actor = a.actorId ? who(a.actorId) : null;
          const t = ago(a.createdAt);
          const now = t === "just now";
          return (
            <li key={a.id} className={cn("-mx-1.5 flex min-h-8 min-w-0 flex-none items-center gap-[9px] rounded-sm px-1.5 py-[3px] text-[12.5px] leading-[17px] text-fg-2", flash.has(a.id) && "hl")}>
              <Avatar name={actor?.name ?? "Lightex"} hue={actor?.hue} size={20} decorative ring={false} />
              <span className="min-w-0 flex-1 truncate">
                <b className="font-semibold text-fg">{actor ? firstName(actor.name) : "Lightex"}</b> <Line a={a} />
              </span>
              <span className={cn("flex-none font-mono text-[11px] font-medium text-fg-3", now && "text-[oklch(var(--lv-l)_var(--lv-c)_150)]")}>{now ? "now" : t}</span>
            </li>
          );
        })}
      </ul>
    );
  return <WidgetFrame meta={live ? "live" : undefined}>{body}</WidgetFrame>;
}
