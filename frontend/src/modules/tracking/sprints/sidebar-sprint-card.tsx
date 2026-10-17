"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { Project } from "@/api/types";
import { ProgressRing } from "@/ui/feedback";
import { Tooltip } from "@/ui/tooltip";
import { daysUntil } from "@/lib/domain/progress";
import { routes } from "@/platform/routes";
import { useActiveSprint } from "@/modules/tracking/projects/queries";

/** The active sprint of the sidebar's current project (registry slot `sidebarProjectCard`; rail = progress ring only). */
export function SprintCard({ project, ws, rail, onNavigate }: { project: Project | undefined; ws: string; rail?: boolean; onNavigate?: () => void }) {
  const { data: sprint } = useActiveSprint(project?.id);
  if (!project || !sprint) return null;
  const pct = sprint.progress.percent;
  const left = Math.max(0, daysUntil(sprint.endDate));
  const label = `${sprint.name}, ${pct} percent, ${left} days left. Open board`;
  const href = routes.project(ws, project.key, "board");
  if (rail) {
    return (
      <Tooltip content={`${sprint.name} · ${pct}% · ${left}d left`} side="right">
        <Link href={href} aria-label={label} className="flex h-9 w-10 items-center justify-center rounded-md hover:bg-hover">
          <ProgressRing value={pct} size={24} stroke={4} color="var(--accent-t)" label={sprint.name} />
        </Link>
      </Tooltip>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      onClick={onNavigate}
      className="mb-1.5 flex items-center gap-2.5 rounded-[10px] border border-line bg-bg px-2.5 py-[9px] transition-[border-color,background-color,transform] duration-150 [transition-timing-function:var(--spring)] hover:-translate-y-px hover:border-line-2 hover:bg-raised"
    >
      <ProgressRing value={pct} size={30} stroke={3.5} color="var(--accent-t)" label={sprint.name} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-[13px] font-semibold leading-4">{sprint.name}</span>
        <span className="font-mono text-[11px] leading-[14px] text-fg-3">
          {pct}% · {left}d left
        </span>
      </span>
      <ChevronRight size={14} className="text-fg-3" aria-hidden />
    </Link>
  );
}
