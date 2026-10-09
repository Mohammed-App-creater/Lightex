"use client";

import { Plus } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { shell } from "@/components/shell/shell-state";
import { TopBarActions } from "@/components/shell/top-bar";
import { Button } from "@/components/ui/button";
import { useMe } from "@/features/auth/session";
import { applyFilters, completeRules } from "@/features/filters/filter-model";
import { useFilterOptions, useUrlFilters } from "@/features/filters/use-filters";
import { useEpics, useProjectMembers, useStatuses } from "@/features/projects/queries";
import { rememberOrigin } from "@/features/tasks/task-origin";
import type { CalendarMode, ISODate, Task } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { can, canEditTask, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl, replaceUrl, routes, withTaskParam } from "@/lib/routes";
import { todayISO } from "@/lib/utils/dates";
import { Agenda } from "./agenda";
import { CalendarMonth, type CalCtx } from "./calendar-month";
import { CalendarWeek } from "./calendar-week";
import { useScheduleTasks, useUnscheduled } from "./queries";
import {
  addDays,
  addMonths,
  calendarMove,
  fmtDay,
  fmtDow,
  fmtMonth,
  isWeekend,
  mondayOf,
  monthGrid,
  normaliseCalendarAt,
  parseCalendarParams,
  sortDay,
  withCalendarParams,
} from "./schedule-lib";
import { CalendarSkeleton, FilteredEmpty, LiveRegion, RangeProgress, ScheduleError, TruncatedBanner } from "./schedule-states";
import { ScheduleToolbar } from "./schedule-toolbar";
import { UnscheduledTray } from "./unscheduled-tray";
import { keyTitle, usePreviews, useReschedule } from "./use-reschedule";

/*
 * Board 32 Calendar (§1.3): month grid (Mon-first, "+N more") and week columns. Tasks sit on their
 * due date; drag a chip to another day (start shifts by the same delta) or use Alt+arrows. At ≤ 760 px
 * it becomes the agenda (§1.9). Mode, anchor, selected day and tray live in the URL (§6.7).
 */

export function CalendarScreen() {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  const params = parseCalendarParams(new URLSearchParams(qs));
  const mobile = useIsMobile();
  const today = todayISO();
  const perms = project.my_permissions;
  const canCreate = can("task.create", perms);
  const trayOpen = params.tray && !mobile;

  const anchor = params.at ?? today;
  const grid = monthGrid(anchor);
  const selected = params.day ?? today;
  const agendaStart = mondayOf(selected);
  const range: { from: ISODate; to: ISODate } = mobile
    ? { from: agendaStart, to: addDays(agendaStart, 27) }
    : params.mode === "month"
      ? { from: grid.start, to: addDays(grid.start, grid.rows * 7 - 1) }
      : { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 6) };

  const statusesQ = useStatuses(project.id);
  const statuses = statusesQ.data;
  const tasksQ = useScheduleTasks(project.id, range.from, range.to, statuses);
  const membersQ = useProjectMembers(project.id);
  const epicsQ = useEpics(project.id);
  const trayQ = useUnscheduled(project.id, statuses, trayOpen);
  const { rules, setRules } = useUrlFilters();
  const filterOpts = useFilterOptions(project.id);
  const rs = useReschedule(project.id);
  const previews = usePreviews();
  const [overDay, setOverDay] = useState<ISODate | null>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    // Alt+arrow moved a chip to another cell: keep focus on it (§1.4).
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    document.querySelector<HTMLElement>(`[data-chip-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false });
  });

  /* ───── URL state ───── */
  const go = (patch: Parameters<typeof withCalendarParams>[1], push = false) => (push ? pushUrl : replaceUrl)(`${pathname}${withCalendarParams(qs, patch)}`);
  const setMode = (m: CalendarMode) => go({ mode: m, at: params.at ? normaliseCalendarAt(m, params.at) : null }, true);
  const shift = (dir: 1 | -1) => {
    const next = params.mode === "month" ? addMonths(grid.first, dir) : addDays(mondayOf(anchor), dir * 7);
    go({ at: normaliseCalendarAt(params.mode, next) });
  };
  const toggleTray = (open = !params.tray) => go({ tray: open });

  /* ───── data ───── */
  const statusById = new Map((statuses ?? []).map((s) => [s.id, s]));
  const users = new Map((membersQ.data ?? []).map((m) => [m.userId, m.user]));
  const epicById = new Map((epicsQ.data ?? []).map((e) => [e.id, e]));
  const all = tasksQ.data?.data ?? [];
  const tasks = applyFilters(all, rules, filterOpts.ctx);
  const filtersOn = completeRules(rules).length > 0;
  /** Due date shown (a keyboard move previews at once). */
  const dueOf = (t: Task) => previews[t.id]?.dates.dueDate ?? t.dueDate;
  const byDay = new Map<ISODate, Task[]>();
  for (const t of tasks) {
    const due = dueOf(t);
    if (!due || due < range.from || due > range.to) continue;
    byDay.set(due, [...(byDay.get(due) ?? []), t]);
  }
  for (const [k, v] of byDay) byDay.set(k, sortDay(v, (id) => statusById.get(id)?.glyph));
  const tasksOn = (day: ISODate) => byDay.get(day) ?? [];
  const chipCount = [...byDay.values()].reduce((a, l) => a + l.length, 0);
  const pinned = new Set(Object.entries(previews).filter(([, p]) => p.source === "key").map(([id]) => id));

  const openTask = (task: Task, el?: HTMLElement | null, reveal = false) => {
    if (el) rememberOrigin(task.key, el);
    const url = withTaskParam(pathname, qs, task.key);
    pushUrl(reveal ? `${url}${url.includes("?") ? "&" : "?"}reveal=dates` : url);
  };
  const editable = (t: Task) => !mobile && canEditTask(t, perms, me.id);
  const resolveDay = (x: number, y: number): ISODate | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const day = (el as HTMLElement).dataset?.day;
      if (day) return day;
    }
    return null;
  };
  const drop = (t: Task, day: ISODate) =>
    rs.commit(t, calendarMove(t, day), { toast: keyTitle(t.key, `→ ${fmtDow(day)}`), announce: `${t.key} moved to ${fmtDow(day)}` });

  const ctx: CalCtx = {
    today,
    overDay,
    tasksOn,
    pinned,
    drop,
    chipProps: (t, day) => ({
      task: t,
      due: day,
      status: statusById.get(t.statusId),
      user: t.assigneeId ? users.get(t.assigneeId) : null,
      editable: editable(t),
      onOpen: (el) => openTask(t, el),
      resolveDay,
      onOver: setOverDay,
      onDrop: (d) => drop(t, d),
      onNudge: (delta) => {
        const to = addDays(dueOf(t) ?? day, delta);
        refocus.current = t.id;
        rs.nudge(t, calendarMove(t, to), "move", { toast: keyTitle(t.key, `→ ${fmtDow(to)}`), announce: `${t.key} ${t.title}: due ${fmtDow(to)}` });
      },
      onCancel: () => rs.cancel(t.id),
      onFlush: () => rs.flush(t.id),
    }),
  };

  /* ───── mobile agenda ───── */
  if (mobile) {
    if (tasksQ.isError && !tasksQ.data) return <ScheduleError title="Couldn’t load calendar" error={tasksQ.error} onRetry={() => void tasksQ.refetch()} retrying={tasksQ.isFetching} />;
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-label="Calendar">
        <Agenda
          projectName={project.name}
          selected={selected}
          weekStart={agendaStart}
          today={today}
          loading={tasksQ.isPending || statusesQ.isPending}
          tasksOn={tasksOn}
          statusOf={(id) => statusById.get(id)}
          userOf={(id) => (id ? users.get(id) : undefined)}
          epicOf={(id) => (id ? epicById.get(id) : undefined)}
          timelineHref={routes.project(ws.slug, project.key, "timeline")}
          canCreate={canCreate}
          onSelect={(d) => go({ day: d === today ? null : d })}
          onWeek={(dir) => go({ day: addDays(selected, dir * 7) })}
          onToday={() => go({ day: null })}
          onOpen={(t, el) => openTask(t, el)}
          onCreate={() => shell.openCreateTask({ projectId: project.id, dueDate: selected })}
        />
        <LiveRegion />
      </div>
    );
  }

  /* ───── desktop ───── */
  const period = params.mode === "month" ? fmtMonth(grid.first) : `${fmtDay(range.from)} – ${fmtDay(range.to)}`;
  const loading = tasksQ.isPending || statusesQ.isPending;
  let body: ReactNode;
  if (loading) {
    const days = Array.from({ length: params.mode === "month" ? grid.rows * 7 : 7 }, (_, i) => addDays(range.from, i));
    body = <CalendarSkeleton rows={params.mode === "month" ? grid.rows : 1} days={days.map((d) => ({ n: String(Number(d.slice(8))), weekend: isWeekend(d) }))} />;
  } else if (tasksQ.isError && !tasksQ.data) {
    body = <ScheduleError title="Couldn’t load calendar" error={tasksQ.error} onRetry={() => void tasksQ.refetch()} retrying={tasksQ.isFetching} />;
  } else {
    body = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {filtersOn && all.length > 0 && tasks.length === 0 && <FilteredEmpty banner onClear={() => setRules([])} />}
        {params.mode === "month" ? <CalendarMonth start={grid.start} rows={grid.rows} first={grid.first} last={grid.last} ctx={ctx} /> : <CalendarWeek start={range.from} ctx={ctx} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Calendar">
      {canCreate && (
        <TopBarActions>
          <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id })}>
            <Plus size={14} aria-hidden /> New task
          </Button>
        </TopBarActions>
      )}
      <ScheduleToolbar
        onPrev={() => shift(-1)}
        onNext={() => shift(1)}
        onToday={() => go({ at: null })}
        period={period}
        periodSuffix={!loading && chipCount === 0 ? "· Nothing due" : undefined}
        seg={{
          label: "Calendar mode",
          value: params.mode,
          options: [
            { value: "month", label: "Month" },
            { value: "week", label: "Week" },
          ],
          onChange: setMode,
        }}
        tray={{ count: trayQ.data ? trayQ.data.data.length : null, more: Boolean(trayQ.data?.more), open: params.tray, onToggle: () => toggleTray() }}
        rules={rules}
        setRules={setRules}
        opts={filterOpts}
        count={loading ? null : chipCount}
      />
      <RangeProgress on={tasksQ.isPlaceholderData && tasksQ.isFetching} />
      {tasksQ.data?.truncated && <TruncatedBanner />}
      <div className="flex min-h-0 flex-1">
        {body}
        {trayOpen && (
          <UnscheduledTray
            q={trayQ}
            statuses={statuses ?? []}
            users={users}
            canEdit={editable}
            onClose={() => toggleTray(false)}
            onOpen={(t) => openTask(t)}
            onAddDates={(t) => openTask(t, null, true)}
            resolveDay={resolveDay}
            onOver={setOverDay}
            onDrop={(t, day) => rs.commit(t, { startDate: null, dueDate: day }, { toast: keyTitle(t.key, `→ ${fmtDow(day)}`), announce: `${t.key} moved to ${fmtDow(day)}`, fromTray: true })}
          />
        )}
      </div>
      <LiveRegion />
    </div>
  );
}
