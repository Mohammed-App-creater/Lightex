"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { shell } from "@/components/shell/shell-state";
import { TopBarActions } from "@/components/shell/top-bar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { useMe } from "@/features/auth/session";
import { applyFilters } from "@/features/filters/filter-model";
import { useFilterOptions, useUrlFilters } from "@/features/filters/use-filters";
import { useEpics, useMilestones, useProjectMembers, useSprints, useStatuses } from "@/features/projects/queries";
import { rememberOrigin } from "@/features/tasks/task-origin";
import type { ISODate, Task, TimelineGroup, TimelineZoom } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { can, canEditTask, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl, replaceUrl, routes, withTaskParam } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { todayISO } from "@/lib/utils/dates";
import { DependencyArrows } from "./dependency-arrows";
import { useScheduleTasks, useUnscheduled } from "./queries";
import {
  addDays,
  axisTicks,
  dayAtX,
  dayCenter,
  defaultAnchor,
  fmtDay,
  fmtRange,
  gridlines,
  parseTimelineParams,
  weekendBands,
  windowOf,
  withTimelineParams,
  ZOOM,
  ZOOMS,
  type Window,
} from "./schedule-lib";
import { FilteredEmpty, LiveRegion, RangeProgress, ScheduleError, TimelineIcon, TimelineSkeleton, TruncatedBanner } from "./schedule-states";
import { ScheduleToolbar } from "./schedule-toolbar";
import { GroupRow, TaskRow } from "./timeline-group";
import { MilestonesLane, SprintsLane, TimelineAxis, TimelineOverlay } from "./timeline-lanes";
import { buildGroups, buildRows, rowHeight, rowOffsets, type TlRow } from "./timeline-model";
import { UnscheduledTray } from "./unscheduled-tray";
import { keyTitle, useReschedule, type Rescheduler } from "./use-reschedule";

/*
 * Board 32 Timeline (§1.2): Milestones and Sprints lanes, then one group per epic (epic bar + task
 * bars) or per assignee. Zoom / pan / group / dependencies / tray live in the URL (§6.7). At ≤ 760 px
 * it is read-only, the label column narrows to 96 px and the lanes scroll sideways in their own box.
 */

const LABEL_W = 220;
const LABEL_W_MOBILE = 96;
const MOBILE_LANE_MIN = 720;
const VIRTUALIZE_OVER = 150;
const COLLAPSE_KEY = (projectId: string) => `lightex-timeline-collapsed:${projectId}`;

function loadCollapsed(projectId: string): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(COLLAPSE_KEY(projectId)) : null;
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function TimelineScreen() {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  const params = parseTimelineParams(new URLSearchParams(qs));
  const mobile = useIsMobile();
  const today = todayISO();
  const at = params.at ?? defaultAnchor(params.zoom, today);
  const win = windowOf(params.zoom, at);
  const perms = project.my_permissions;
  const canCreate = can("task.create", perms);
  const canAddDates = can("task.edit_any", perms) || can("task.edit_own", perms);
  const canEpics = can("epic.manage", perms);
  const canSprintsTab = can("sprint.manage", perms) || can("task.move", perms);
  const labelWidth = mobile ? LABEL_W_MOBILE : LABEL_W;
  const trayOpen = params.tray && !mobile;

  const statusesQ = useStatuses(project.id);
  const statuses = statusesQ.data;
  const tasksQ = useScheduleTasks(project.id, win.from, win.to, statuses);
  const epicsQ = useEpics(project.id);
  const msQ = useMilestones(project.id);
  const sprintsQ = useSprints(project.id);
  const membersQ = useProjectMembers(project.id);
  const trayQ = useUnscheduled(project.id, statuses, trayOpen);
  const { rules, setRules } = useUrlFilters();
  const filterOpts = useFilterOptions(project.id);
  const rs = useReschedule(project.id);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(project.id));
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSE_KEY(project.id), JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });

  /* ───── URL state ───── */
  const go = (patch: Parameters<typeof withTimelineParams>[1], push = false) => (push ? pushUrl : replaceUrl)(`${pathname}${withTimelineParams(qs, patch)}`);
  const setZoom = (z: TimelineZoom) => go({ zoom: z, at: null }, true);
  const pan = (dir: 1 | -1) => go({ at: addDays(at, dir * ZOOM[params.zoom].step) });
  const setGroup = (g: TimelineGroup) => go({ group: g }, true);
  const toggleTray = (open = !params.tray) => go({ tray: open });

  /* ───── lane width (drag maths, arrows) ───── */
  const [laneWidth, setLaneWidth] = useState(0);
  const laneEl = useRef<HTMLDivElement | null>(null);
  const laneRef = useCallback((el: HTMLDivElement | null) => {
    laneEl.current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ───── data → rows ───── */
  const all = tasksQ.data?.data ?? [];
  const tasks = applyFilters(all, rules, filterOpts.ctx);
  const epics = epicsQ.data ?? [];
  const epicHue = new Map(epics.map((e) => [e.id, e.hue]));
  const statusById = new Map((statuses ?? []).map((s) => [s.id, s]));
  const users = new Map((membersQ.data ?? []).map((m) => [m.userId, m.user]));
  const groups = buildGroups(tasks, params.group, epics, membersQ.data ?? [], win);
  const failed = [epicsQ.isError && "epics", msQ.isError && "milestones", sprintsQ.isError && "sprints"].filter(Boolean) as string[];
  const sprintsInWindow = (sprintsQ.data ?? []).some((s) => s.endDate >= win.from && s.startDate <= win.to);
  const rows = buildRows(groups, collapsed, { milestones: msQ.isSuccess, sprints: sprintsQ.isSuccess && sprintsInWindow, error: failed.length ? failed.join(", ") : null });
  const { tops, total } = rowOffsets(rows);

  const ticks = axisTicks(params.zoom, win, today);
  const todayX = dayCenter(today, win);
  const milestones = msQ.data ?? [];
  const guides = milestones.map((m) => dayCenter(m.dueDate, win)).filter((x): x is number => x !== null);

  const openTask = (task: Task, el?: HTMLElement | null, reveal = false) => {
    if (el) rememberOrigin(task.key, el);
    const url = withTaskParam(pathname, qs, task.key);
    pushUrl(reveal ? `${url}${url.includes("?") ? "&" : "?"}reveal=dates` : url);
  };

  const resolveDay = (x: number, y: number): ISODate | null => {
    const lane = laneEl.current;
    const box = scrollRef.current?.getBoundingClientRect();
    if (!lane || !box) return null;
    const r = lane.getBoundingClientRect();
    if (x < r.left || x > r.right || y < box.top || y > box.bottom) return null;
    return dayAtX(x - r.left, r.width, win);
  };

  const editableTask = (t: Task) => !mobile && canEditTask(t, perms, me.id);

  /* ───── render ───── */
  const placeholder = tasksQ.isPlaceholderData && tasksQ.isFetching;
  const toolbar = (
    <ScheduleToolbar
      onPrev={() => pan(-1)}
      onNext={() => pan(1)}
      onToday={() => go({ at: null })}
      seg={{ label: "Zoom", value: params.zoom, options: ZOOMS.map((z) => ({ value: z, label: ZOOM[z].label })), onChange: setZoom }}
      extras={
        <>
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="ghost">
                Group: <span className="text-fg">{params.group === "epic" ? "Epic" : "Assignee"}</span>
              </Button>
            </MenuTrigger>
            <MenuContent align="start" width={180}>
              <MenuRadioGroup value={params.group} onValueChange={(v) => setGroup(v as TimelineGroup)}>
                <MenuRadioItem value="epic">Epic</MenuRadioItem>
                <MenuRadioItem value="assignee">Assignee</MenuRadioItem>
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
          {!mobile && (
            <Button size="sm" variant="ghost" aria-pressed={params.deps} onClick={() => go({ deps: !params.deps })} className={cn(params.deps && "bg-hover text-fg")}>
              <span aria-hidden className={cn("inline-flex size-3.5 items-center justify-center rounded-[4px] border", params.deps ? "border-accent bg-accent text-white" : "border-control")}>
                {params.deps && (
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </span>
              Dependencies
            </Button>
          )}
        </>
      }
      tray={mobile ? undefined : { count: trayQ.data ? trayQ.data.data.length : null, more: Boolean(trayQ.data?.more), open: params.tray, onToggle: () => toggleTray() }}
      rules={rules}
      setRules={setRules}
      opts={filterOpts}
      count={tasksQ.isPending ? null : tasks.length}
    />
  );

  let body: ReactNode;
  if (tasksQ.isPending || statusesQ.isPending) {
    body = <TimelineSkeleton labelWidth={labelWidth} />;
  } else if (tasksQ.isError && !tasksQ.data) {
    body = <ScheduleError title="Couldn’t load timeline" error={tasksQ.error} onRetry={() => void tasksQ.refetch()} retrying={tasksQ.isFetching} />;
  } else {
    const empty = all.length === 0;
    const filteredOut = !empty && tasks.length === 0;
    body = (
      <div ref={scrollRef} data-tl-root="" className="relative min-h-0 min-w-0 flex-1 overflow-auto" style={{ "--tl-lab": `${labelWidth}px` } as CSSProperties}>
        <div style={{ minWidth: mobile ? labelWidth + MOBILE_LANE_MIN : undefined }}>
          <TimelineAxis ref={laneRef} label={params.group === "epic" ? "Epics" : "People"} labelWidth={labelWidth} ticks={ticks} today={todayX} />
          <div className="relative" style={{ height: total }}>
            <TimelineOverlay labelWidth={labelWidth} weekends={weekendBands(params.zoom, win)} lines={gridlines(ticks)} guides={guides} today={todayX} />
            {params.deps && !mobile && <DependencyArrows rows={rows} tops={tops} height={total} labelWidth={labelWidth} laneWidth={laneWidth} win={win} />}
            <Rows rows={rows} tops={tops} total={total} scrollRef={scrollRef}>
              {(row) => (
                <RowContent
                  row={row}
                  labelWidth={labelWidth}
                  win={win}
                  laneWidth={() => laneWidth}
                  mobile={mobile}
                  rs={rs}
                  canEpics={canEpics}
                  zoom={params.zoom}
                  milestonesHref={routes.project(ws.slug, project.key, "milestones")}
                  sprintHref={canSprintsTab ? (id) => `${routes.project(ws.slug, project.key, "sprints")}?sprint=${encodeURIComponent(id)}` : null}
                  collapsedToggle={toggleGroup}
                  onRetryLanes={() => {
                    if (epicsQ.isError) void epicsQ.refetch();
                    if (msQ.isError) void msQ.refetch();
                    if (sprintsQ.isError) void sprintsQ.refetch();
                  }}
                  milestones={milestones}
                  sprints={sprintsQ.data ?? []}
                  statusOf={(id) => statusById.get(id)}
                  hueOf={(t) => (t.epicId ? (epicHue.get(t.epicId) ?? null) : null)}
                  editable={editableTask}
                  onOpen={openTask}
                />
              )}
            </Rows>
          </div>
          {empty && (
            <div className="flex justify-center px-6 py-14">
              <EmptyState
                align="center"
                icon={<TimelineIcon size={22} />}
                title="Nothing scheduled"
                body={<span className="font-mono text-[11px] text-fg-3">0 tasks with dates · {fmtRange(win.from, win.to)}</span>}
                actions={
                  canAddDates && !mobile ? (
                    <Button onClick={() => toggleTray(true)}>Add dates</Button>
                  ) : undefined
                }
              />
            </div>
          )}
          {filteredOut && <FilteredEmpty onClear={() => setRules([])} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Timeline">
      {canCreate && (
        <TopBarActions>
          <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id })}>
            <Plus size={14} aria-hidden /> New task
          </Button>
        </TopBarActions>
      )}
      {toolbar}
      <RangeProgress on={placeholder} />
      {tasksQ.data?.truncated && <TruncatedBanner />}
      <div className="flex min-h-0 flex-1">
        {body}
        {trayOpen && (
          <UnscheduledTray
            q={trayQ}
            statuses={statuses ?? []}
            users={users}
            canEdit={editableTask}
            onClose={() => toggleTray(false)}
            onOpen={(t) => openTask(t)}
            onAddDates={(t) => openTask(t, null, true)}
            resolveDay={resolveDay}
            onDrop={(t, day) =>
              rs.commit(t, { startDate: null, dueDate: day }, { toast: keyTitle(t.key, `→ ${fmtDay(day)}`), announce: `${t.key} ${t.title}: due ${fmtDay(day)}`, fromTray: true })
            }
          />
        )}
      </div>
      <LiveRegion />
    </div>
  );
}

/* ───────── rows (virtualised over 150) ───────── */

function Rows({ rows, tops, total, scrollRef, children }: { rows: TlRow[]; tops: number[]; total: number; scrollRef: RefObject<HTMLDivElement | null>; children: (row: TlRow) => ReactNode }) {
  if (rows.length > VIRTUALIZE_OVER) return <VirtualRows rows={rows} scrollRef={scrollRef} total={total}>{children}</VirtualRows>;
  return (
    <>
      {rows.map((row, i) => (
        <RowShell key={row.key} row={row} top={tops[i]!}>
          {children(row)}
        </RowShell>
      ))}
    </>
  );
}

function VirtualRows({ rows, scrollRef, children }: { rows: TlRow[]; scrollRef: RefObject<HTMLDivElement | null>; total: number; children: (row: TlRow) => ReactNode }) {
  // Large windows only (> 150 rows). TanStack Virtual's API can't be memoised by the React Compiler.
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (i) => rowHeight(rows[i]!), overscan: 12, scrollMargin: 53 });
  return (
    <>
      {v.getVirtualItems().map((it) => {
        const row = rows[it.index]!;
        return (
          <RowShell key={row.key} row={row} top={it.start - v.options.scrollMargin}>
            {children(row)}
          </RowShell>
        );
      })}
    </>
  );
}

function RowShell({ row, top, children }: { row: TlRow; top: number; children: ReactNode }) {
  return (
    <div className="absolute inset-x-0 grid border-b border-line" style={{ top, height: rowHeight(row), gridTemplateColumns: "var(--tl-lab) minmax(0,1fr)" }}>
      {children}
    </div>
  );
}

type RowContentProps = {
  row: TlRow;
  labelWidth: number;
  win: Window;
  laneWidth: () => number;
  mobile: boolean;
  rs: Rescheduler;
  canEpics: boolean;
  zoom: TimelineZoom;
  milestonesHref: string;
  sprintHref: ((id: string) => string) | null;
  collapsedToggle: (id: string) => void;
  onRetryLanes: () => void;
  milestones: import("@/lib/api/types").Milestone[];
  sprints: import("@/lib/api/types").Sprint[];
  statusOf: (id: string) => import("@/lib/api/types").Status | undefined;
  hueOf: (t: Task) => number | null;
  editable: (t: Task) => boolean;
  onOpen: (t: Task, el?: HTMLElement | null) => void;
};

function RowContent(p: RowContentProps) {
  const { row } = p;
  const common = { win: p.win, laneWidth: p.laneWidth, mobile: p.mobile, rs: p.rs };
  switch (row.kind) {
    case "milestones":
      return <MilestonesLane milestones={p.milestones} win={p.win} zoom={p.zoom} href={p.milestonesHref} />;
    case "sprints":
      return <SprintsLane sprints={p.sprints} win={p.win} hrefFor={p.sprintHref ? (s) => p.sprintHref!(s.id) : null} />;
    case "error":
      return (
        <div role="alert" className="sticky left-0 z-[3] col-span-2 flex items-center gap-2 bg-bg px-3 text-[12.5px] text-fg-2">
          <span className="truncate">Couldn’t load {row.what}.</span>
          <button type="button" onClick={p.onRetryLanes} className="rounded-[5px] px-1.5 font-medium text-accent-t hover:bg-accent-s">
            Retry
          </button>
        </div>
      );
    case "group":
      return <GroupRow {...common} group={row.group} open={row.open} onToggle={() => p.collapsedToggle(row.group.id)} canManageEpics={p.canEpics} />;
    case "task":
      return (
        <TaskRow
          {...common}
          task={row.task}
          status={p.statusOf(row.task.statusId)}
          hue={p.hueOf(row.task)}
          editable={p.editable(row.task)}
          tabbable={row.first && !row.group.span}
          onOpen={(t, el) => p.onOpen(t, el)}
        />
      );
  }
}
