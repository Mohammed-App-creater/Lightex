"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useProjectMembers } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { TaskDetail, TaskPatch, TimeEntry } from "@/lib/api/types";
import { can } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { shortDate, todayISO } from "@/lib/utils/dates";
import { checkEntry, checkEstimate, checkLogDate, formatClock, formatMinutes, logHint } from "./duration";
import { elapsed, invalidateTime, useMyTimer, useNow, useStartTimer, useStopTimer } from "./use-timer";

/* Task panel "Time" (board 39): total / estimate bar, timer, Log time form, entries. */

/** Header chip shown while the viewer's timer runs on this task (role=timer, pulse + clock). */
export function RunningTimerChip({ taskId }: { taskId: string }) {
  const { data: timer } = useMyTimer();
  const on = timer?.taskId === taskId;
  const now = useNow(on);
  if (!on) return null;
  const clock = formatClock(elapsed(timer, now));
  return (
    <span role="timer" aria-label={`Timer running ${clock}`} className="inline-flex h-7 flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] bg-accent-s px-2.5 font-mono text-[12px] font-medium tabular-nums text-accent-t max-[760px]:h-9">
      <span className="tx-pulse" aria-hidden />
      {clock}
    </span>
  );
}

const inputCls =
  "h-7 w-full min-w-0 rounded-sm border border-line-2 bg-surface px-2 text-[13px] text-fg outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-s)] max-[760px]:h-10 max-[760px]:text-[15px]";

export function TaskTime({
  task,
  canEdit,
  deleted,
  forceEstimate,
  onPatch,
}: {
  task: TaskDetail;
  /** Can edit the task (sets the time estimate). */
  canEdit: boolean;
  deleted: boolean;
  /** "Add property → Time estimate" was picked: open the estimate editor. */
  forceEstimate: boolean;
  onPatch: (p: TaskPatch) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const perms = task.project.my_permissions;
  const canLog = can("time.log", perms) && !deleted;
  const canDeleteAny = can("time.delete_any", perms);
  const entries = useQuery({ queryKey: qk.timeEntries(task.id), queryFn: () => api.time.entries(task.id) });
  const { data: members = [] } = useProjectMembers(task.projectId);
  const { data: timer } = useMyTimer();
  const running = timer?.taskId === task.id;
  const now = useNow(running);
  const start = useStartTimer();
  const stop = useStopTimer();

  const [logOpen, setLogOpen] = useState(false);
  const [estDraft, setEstDraft] = useState<string | null>(null);
  const [estDismissed, setEstDismissed] = useState(false);
  const editingEst = estDraft !== null || (forceEstimate && task.timeEstimateMinutes === null && !estDismissed && canEdit);

  const remove = useMutation({
    mutationFn: (e: TimeEntry) => api.time.remove(e.id),
    onMutate: async (e) => {
      await qc.cancelQueries({ queryKey: qk.timeEntries(task.id) });
      const prev = qc.getQueryData<TimeEntry[]>(qk.timeEntries(task.id));
      qc.setQueryData<TimeEntry[]>(qk.timeEntries(task.id), (l) => l?.filter((x) => x.id !== e.id));
      return { prev };
    },
    onError: (err, _e, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.timeEntries(task.id), ctx.prev);
      toast.error("Couldn’t delete the entry", { body: `${errorMessage(err)} Reverted.` });
    },
    onSuccess: (_d, e) => toast.success(`Deleted ${formatMinutes(e.minutes)}`),
    onSettled: () => invalidateTime(qc, [task.id]),
  });

  const list = entries.data ?? [];
  // Before entries load, the task's own counter decides whether there is anything to show.
  const hasTime = entries.data ? list.length > 0 : task.loggedMinutes > 0;
  const est = task.timeEstimateMinutes;
  if (!hasTime && !canLog && !(canEdit && (est !== null || editingEst))) return null;

  const total = entries.data ? list.reduce((a, e) => a + e.minutes, 0) : task.loggedMinutes;
  const over = est ? total - est : 0;
  const pct = est ? Math.min(100, Math.round((total / est) * 100)) : 0;

  const commitEst = () => {
    const raw = (estDraft ?? "").trim();
    setEstDraft(null);
    setEstDismissed(true);
    if (!raw) {
      if (est !== null) onPatch({ timeEstimateMinutes: null });
      return;
    }
    const p = checkEstimate(raw);
    if (p.error !== undefined) return toast.error("Couldn’t set the estimate", { body: p.error });
    if (p.minutes !== est) onPatch({ timeEstimateMinutes: p.minutes });
  };

  const userOf = (id: string) => members.find((m) => m.userId === id)?.user;

  return (
    <section aria-label="Time tracking">
      <div className="mb-2 flex min-h-6 flex-wrap items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold">Time</h3>
        <span className="flex items-center font-mono text-[11px] font-medium text-fg-3">
          {formatMinutes(total)}
          {editingEst ? (
            <span className="ml-1 inline-flex items-center gap-1">
              /
              <input
                autoFocus
                aria-label="Time estimate"
                placeholder="6h"
                value={estDraft ?? ""}
                onChange={(e) => setEstDraft(e.target.value)}
                onBlur={commitEst}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEst();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEstDraft(null);
                    setEstDismissed(true);
                  }
                }}
                className="h-[26px] w-[72px] rounded-sm border border-accent bg-surface px-2 font-mono text-[12px] text-fg shadow-[0_0_0_3px_var(--accent-s)] outline-none max-[760px]:h-9"
              />
            </span>
          ) : est !== null ? (
            canEdit ? (
              <button type="button" aria-label={`Time estimate ${formatMinutes(est)}. Click to edit`} onClick={() => setEstDraft(formatMinutes(est))} className="ml-1 rounded-xs px-0.5 hover:bg-hover hover:text-fg">
                / {formatMinutes(est)}
              </button>
            ) : (
              <span className="ml-1">/ {formatMinutes(est)}</span>
            )
          ) : null}
        </span>
        {est !== null && !editingEst && (
          <div
            role="progressbar"
            aria-label="Time logged vs estimate"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 max-w-[160px] flex-1 overflow-hidden rounded-full border border-line bg-raised"
          >
            <span className={cn("block h-full origin-left rounded-full transition-transform duration-300 ease-out", over > 0 ? "bg-warn" : "bg-ok")} style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        )}
        {over > 0 && !editingEst && <span className="font-mono text-[11px] font-medium text-warn">+{formatMinutes(over)} over</span>}
      </div>

      {canLog && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={running}
            disabled={start.isPending || stop.isPending}
            onClick={() => (running && timer ? stop.mutate(timer) : start.mutate({ id: task.id, key: task.key }))}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-md border border-line-2 bg-raised pl-2.5 pr-3 text-[12.5px] font-medium text-fg transition-[background-color,border-color,color,transform] duration-150 hover:border-control hover:bg-hover active:scale-[.97] max-[760px]:h-11",
              running && "border-transparent bg-accent-s text-accent-t hover:border-transparent hover:bg-accent-s",
            )}
          >
            {running ? <Square size={12} fill="currentColor" aria-hidden /> : <Play size={12} fill="currentColor" aria-hidden />}
            {running ? "Stop timer" : "Start timer"}
            <span role="timer" className={cn("min-w-11 font-mono text-[13px] tabular-nums", running ? "text-accent-t" : "text-fg-2")}>
              {formatClock(running ? elapsed(timer, now) : 0)}
            </span>
          </button>
          <Button variant="secondary" aria-expanded={logOpen} onClick={() => setLogOpen((o) => !o)} className="max-[760px]:h-11">
            Log time
          </Button>
        </div>
      )}

      {logOpen && canLog && <LogForm task={task} onDone={() => setLogOpen(false)} />}

      {entries.isPending ? (
        <div aria-busy="true" aria-label="Loading time entries" className="flex flex-col gap-2.5 py-1">
          <Skeleton className="h-2.5 w-[70%]" />
          <Skeleton className="h-2.5 w-[55%]" />
        </div>
      ) : entries.isError ? (
        <p role="alert" className="m-0 flex items-center gap-2 py-1 text-[12px] text-fg-2">
          Couldn’t load time entries.
          <button type="button" className="font-medium text-accent-t hover:underline" onClick={() => void entries.refetch()}>
            Retry
          </button>
        </p>
      ) : list.length === 0 ? (
        <p className="m-0 py-1 text-[11px] text-fg-3">No time logged</p>
      ) : (
        <ul role="list" aria-label="Time entries" className="m-0 list-none p-0">
          {list.map((e) => {
            const u = userOf(e.userId);
            const removable = (e.userId === me.id && can("time.log", perms)) || canDeleteAny;
            return (
              <li key={e.id} className="group/te -mx-2 flex min-h-[34px] items-center gap-2.5 rounded-sm px-2 hover:bg-hover max-[760px]:min-h-11">
                <Avatar name={u?.name ?? "Former member"} hue={u?.hue} size={20} />
                <span className="w-[60px] flex-none font-mono text-[12px] font-medium tabular-nums">{formatMinutes(e.minutes)}</span>
                <span className={cn("min-w-0 flex-1 truncate text-[13px]", e.note ? "text-fg-2" : "text-fg-3")}>{e.note || (e.source === "timer" ? "Timer" : "Manual entry")}</span>
                {e.source === "timer" && <span className="rounded-xs border border-line px-1 py-0.5 font-mono text-[10px] font-medium leading-none text-fg-3">timer</span>}
                <span className="w-11 flex-none text-right text-[11px] text-fg-3">{shortDate(e.date)}</span>
                {removable && !deleted && (
                  <button
                    type="button"
                    aria-label={`Delete entry ${formatMinutes(e.minutes)} ${shortDate(e.date)}`}
                    onClick={() => remove.mutate(e)}
                    className="flex size-[22px] flex-none items-center justify-center rounded-[5px] text-fg-3 opacity-0 transition-opacity duration-[var(--dur-fast)] hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover/te:opacity-100 max-[760px]:size-9 max-[760px]:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <X size={12} aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Log time form: Duration · Date · Note; errors only after the first submit, hint when valid. */
function LogForm({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const today = todayISO();
  const [dur, setDur] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const parsed = checkEntry(dur);
  const dateErr = checkLogDate(date, today);
  const error = parsed.error ?? dateErr;

  const log = useMutation({
    mutationFn: (body: { minutes: number; date: string; note: string }) => api.time.log(task.id, body),
    onSuccess: (e) => {
      qc.setQueryData<TimeEntry[]>(qk.timeEntries(task.id), (l) => [e, ...(l ?? [])].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
      toast.success(`Logged ${formatMinutes(e.minutes)} on ${task.key}`);
      invalidateTime(qc, [task.id]);
      onDone();
    },
    onError: (e) => {
      const fields = isApiError(e) ? e.fieldErrors : {};
      toast.error("Couldn’t log time", { body: Object.values(fields)[0] ?? errorMessage(e) });
    },
  });

  const submit = () => {
    setTried(true);
    if (error || parsed.minutes === undefined || log.isPending) return;
    log.mutate({ minutes: parsed.minutes, date, note: note.trim().slice(0, 140) });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onDone();
    }
  };

  return (
    <div role="group" aria-label="Log time" onKeyDown={onKey} className="mb-2.5 flex animate-[menu-in_160ms_var(--ease)] flex-col gap-2.5 rounded-[10px] border border-line-2 bg-bg p-3">
      <div className="grid grid-cols-[120px_150px_minmax(0,1fr)] gap-2 max-[760px]:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-[5px] text-[11px] font-medium text-fg-3">
          Duration
          <input
            autoFocus
            type="text"
            placeholder="1h 30m"
            aria-invalid={tried && parsed.error !== undefined ? true : undefined}
            value={dur}
            onChange={(e) => setDur(e.target.value)}
            className={cn(inputCls, "font-mono text-[12.5px]", tried && parsed.error !== undefined && "border-danger")}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-[5px] text-[11px] font-medium text-fg-3">
          Date
          <input
            type="date"
            max={today}
            aria-invalid={tried && dateErr ? true : undefined}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={cn(inputCls, "font-mono text-[12px] [color-scheme:light_dark]", tried && dateErr && "border-danger")}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-[5px] text-[11px] font-medium text-fg-3 max-[760px]:col-span-2">
          Note
          <input type="text" maxLength={140} placeholder="What did you work on?" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
        </label>
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        {tried && error ? (
          <span role="alert" className="text-[12px] text-danger">
            {error}
          </span>
        ) : parsed.minutes !== undefined && !dateErr ? (
          <span className="font-mono text-[11px] text-fg-3">{logHint(parsed.minutes, date)}</span>
        ) : null}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" kbd="↵" loading={log.isPending} onClick={submit}>
          Log
        </Button>
      </div>
    </div>
  );
}
