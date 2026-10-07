"use client";

import * as D from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, ListTodo, Play, RefreshCcw, X } from "lucide-react";
import { motion } from "motion/react";
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { toast } from "@/components/ui/toast";
import { useProjectMembers } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { BurndownPoint, Sprint, Task } from "@/lib/api/types";
import { useCan } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { dateRange, shortDate } from "@/lib/utils/dates";
import {
  allState,
  completionPlan,
  contributors,
  defaultKeep,
  glyphLookup,
  partitionCarry,
  reviewStats,
  sumPts,
  type Dest,
} from "./sprint-model";
import { StartSprintDialog } from "./sprint-dialogs";

const scrim = "fixed inset-0 z-[60] bg-scrim backdrop-blur-[8px] data-[state=open]:animate-[fade-in_180ms_var(--ease)]";

type Result = { name: string; donePts: number; totalPts: number; doneN: number; nNext: number; nBack: number };

/** Board query for one sprint (tasks + statuses), shared with the sprint board view. */
export function useSprintTasks(projectId: string, sprintId: string, enabled = true) {
  return useQuery({
    queryKey: qk.board(projectId, sprintId),
    queryFn: () => api.board.get(projectId, sprintId),
    enabled,
  });
}

/**
 * Complete sprint (board 26): a 3-step review → carry over → done flow. Replaces the old
 * single-step confirm. Unfinished tasks are split per task between the next planned sprint
 * and the backlog using the existing planning API (bulk move + complete).
 */
export function CompleteSprintDialog({
  sprint,
  next,
  open,
  onOpenChange,
}: {
  sprint: Sprint;
  next: Sprint | undefined;
  /** Kept for callers of the old dialog; counts now come from the sprint's tasks. */
  openCount?: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [result, setResult] = useState<Result | null>(null);
  const [startNext, setStartNext] = useState(false);
  const canSprint = useCan("sprint.manage");
  const titleId = useId();
  const qc = useQueryClient();
  const data = useSprintTasks(sprint.projectId, sprint.id, open && step !== 3);
  const glyphOf = useMemo(() => glyphLookup(data.data?.statuses ?? []), [data.data]);
  const tasks = useMemo(() => data.data?.tasks ?? [], [data.data]);
  const stats = useMemo(() => reviewStats(sprint, tasks, glyphOf), [sprint, tasks, glyphOf]);
  const [keepOverride, setKeep] = useState<Record<string, boolean>>({});
  const keep = useMemo(() => ({ ...defaultKeep(stats.open), ...keepOverride }), [stats.open, keepOverride]);
  const [dest, setDest] = useState<Dest>(next ? "next" : "backlog");
  const split = partitionCarry(stats.open, keep, next ? dest : "backlog", Boolean(next));

  const complete = useMutation({
    mutationFn: async () => {
      const plan = completionPlan(split, next?.id ?? null);
      if (plan.preMove) await api.tasks.bulk(sprint.projectId, { ids: plan.preMove.ids, patch: { sprintId: plan.preMove.sprintId } });
      return api.planning.completeSprint(sprint.id, plan.target);
    },
    onSuccess: () => {
      setResult({
        name: sprint.name,
        donePts: stats.donePts,
        totalPts: stats.totalPts,
        doneN: stats.done.length,
        nNext: split.toNext.length,
        nBack: split.toBacklog.length,
      });
      setStep(3);
      void qc.invalidateQueries({ queryKey: qk.scope(sprint.projectId) });
      void qc.invalidateQueries({ queryKey: ["task"] });
    },
    onError: (e) => {
      // A partial pre-move may have landed; refresh so the list matches the server.
      void qc.invalidateQueries({ queryKey: qk.scope(sprint.projectId) });
      toast.error(`Couldn’t complete ${sprint.name}`, { body: errorMessage(e) });
    },
  });

  const close = (o: boolean) => {
    if (!o && complete.isPending) return;
    onOpenChange(o);
  };
  const title = step === 3 && result ? result.name : `Complete ${sprint.name}`;
  const steps: [string, 1 | 2 | 3][] = [
    ["Review", 1],
    ["Carry over", 2],
    ["Done", 3],
  ];
  const foot =
    step === 1
      ? stats.open.length
        ? `${stats.open.length} unfinished to place next`
        : "all tasks done"
      : step === 2
        ? `${next ? `${split.toNext.length} → ${next.name} · ` : ""}${split.toBacklog.length} → Backlog`
        : "";

  return (
    <>
      <D.Root open={open && !startNext} onOpenChange={close}>
        <D.Portal>
          <D.Overlay className={scrim} />
          <D.Content
            aria-labelledby={titleId}
            aria-describedby={undefined}
            className={cn(
              "fixed z-[61] flex flex-col border border-line-2 bg-surface shadow-modal outline-none",
              "left-1/2 top-1/2 max-h-[calc(100dvh-40px)] w-[min(680px,calc(100%-40px))] -translate-x-1/2 -translate-y-1/2 rounded-[14px]",
              "data-[state=open]:animate-[modal-in_180ms_var(--ease)]",
              "max-[760px]:inset-x-0 max-[760px]:bottom-0 max-[760px]:left-0 max-[760px]:top-auto max-[760px]:max-h-[92dvh] max-[760px]:w-auto max-[760px]:translate-x-0 max-[760px]:translate-y-0",
              "max-[760px]:rounded-b-none max-[760px]:rounded-t-[18px] max-[760px]:border-b-0 max-[760px]:data-[state=open]:animate-[sheet-up_280ms_var(--ease)]",
            )}
          >
            <span aria-hidden className="mx-auto mt-2 hidden h-1 w-9 flex-none rounded-full bg-line-2 max-[760px]:block" />
            <div className="flex flex-none items-center gap-3 border-b border-line py-3.5 pl-5 pr-3">
              <D.Title id={titleId} className="m-0 min-w-0 truncate text-[16px] font-semibold leading-6">
                {title}
              </D.Title>
              <span className="flex-1" />
              <ol aria-label="Steps" className="m-0 flex list-none items-center gap-1.5 p-0">
                {steps.map(([label, n], i) => {
                  const ok = step > n || step === 3;
                  const on = step === n && n !== 3;
                  return (
                    <li key={n} className="contents">
                      {i > 0 && <span aria-hidden className="h-px w-3.5 flex-none bg-line-2" />}
                      <span
                        aria-current={step === n ? "step" : undefined}
                        className={cn("inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px] font-medium text-fg-3", on && "text-fg")}
                      >
                        <i
                          className={cn(
                            "inline-flex size-[18px] flex-none items-center justify-center rounded-full border-[1.5px] border-line-2 text-[10px] not-italic",
                            on && "border-accent-t text-accent-t",
                            ok && "border-ok bg-ok text-bg",
                          )}
                        >
                          {ok ? <Check size={11} strokeWidth={3} aria-hidden /> : n}
                        </i>
                        <span className="max-[760px]:sr-only">{label}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              <D.Close asChild>
                <Button variant="ghost" icon size="sm" aria-label="Close" className="max-[760px]:size-11" disabled={complete.isPending}>
                  <X size={14} aria-hidden />
                </Button>
              </D.Close>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
              {step !== 3 && data.isPending ? (
                <div aria-busy="true" aria-label="Loading sprint" className="flex flex-col gap-3">
                  <div className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2">
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-[70px] rounded-[9px]" />
                    ))}
                  </div>
                  <Skeleton className="h-2.5 w-full" />
                  <Skeleton className="h-40 w-full rounded-[10px]" />
                </div>
              ) : step !== 3 && data.isError ? (
                <ErrorState title="Couldn’t load the sprint" body={errorMessage(data.error)} onRetry={() => void data.refetch()} retrying={data.isFetching} />
              ) : step === 1 ? (
                <ReviewStep sprint={sprint} stats={stats} glyphOf={glyphOf} />
              ) : step === 2 ? (
                <CarryStep
                  next={next}
                  dest={dest}
                  setDest={setDest}
                  open={stats.open}
                  keep={keep}
                  setKeep={(patch) => setKeep((k) => ({ ...k, ...patch }))}
                  toNext={new Set(split.toNext)}
                  glyphOf={glyphOf}
                />
              ) : (
                result && <DoneStep result={result} nextName={next?.name} />
              )}
            </div>
            <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-5 py-3">
              <span className="font-mono text-[11.5px] text-fg-3">{foot}</span>
              <span className="flex-1" />
              {step === 1 && (
                <>
                  <Button variant="ghost" onClick={() => close(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" disabled={data.isPending || data.isError} onClick={() => setStep(2)}>
                    Next <ArrowRight size={13} aria-hidden />
                  </Button>
                </>
              )}
              {step === 2 && (
                <>
                  <Button variant="ghost" disabled={complete.isPending} onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button variant="primary" loading={complete.isPending} onClick={() => complete.mutate()}>
                    <Check size={13} aria-hidden /> Complete sprint
                  </Button>
                </>
              )}
              {step === 3 && (
                <>
                  <Button variant="ghost" onClick={() => close(false)}>
                    Close
                  </Button>
                  {next && canSprint && result && result.nNext > 0 && (
                    <Button variant="primary" onClick={() => setStartNext(true)}>
                      <Play size={12} aria-hidden /> Start {next.name}
                    </Button>
                  )}
                </>
              )}
            </footer>
          </D.Content>
        </D.Portal>
      </D.Root>
      {startNext && next && (
        <StartSprintDialog
          sprint={{ ...next, progress: { ...next.progress, total: next.progress.total + (result?.nNext ?? 0) } }}
          open
          onOpenChange={(o) => {
            if (!o) {
              setStartNext(false);
              onOpenChange(false);
            }
          }}
        />
      )}
    </>
  );
}

type Stats = ReturnType<typeof reviewStats>;

function H3({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] font-semibold">
      {children}
      <span className="flex-1" />
      {right}
    </div>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] font-medium text-fg-3">{children}</span>;
}

function ReviewStep({ sprint, stats, glyphOf }: { sprint: Sprint; stats: Stats; glyphOf: ReturnType<typeof glyphLookup> }) {
  const canReport = useCan("report.view");
  const members = useProjectMembers(sprint.projectId);
  const people = new Map((members.data ?? []).map((m) => [m.userId, m.user]));
  const ctr = contributors(stats.done);
  const cmax = Math.max(1, ...ctr.map((c) => c.pts));
  const tiles = [
    { l: "Completed", v: String(stats.done.length), u: "tasks" },
    { l: "Velocity", v: String(stats.donePts), u: `/${stats.totalPts} pts` },
    { l: "Carried over", v: String(stats.open.length), u: `${stats.openPts} pts` },
    { l: "Scope added", v: `+${stats.addedPts}`, u: "pts" },
  ];
  return (
    <>
      <div className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2">
        {tiles.map((t) => (
          <div key={t.l} className="flex min-w-0 flex-col gap-1.5 rounded-[9px] border border-line bg-bg px-3 py-2.5">
            <span className="text-[11.5px] leading-[14px] text-fg-3">{t.l}</span>
            <span className="whitespace-nowrap text-[22px] font-semibold leading-[26px] tracking-[-0.02em] tabular-nums">
              {t.v}
              <small className="ml-[3px] font-mono text-[11.5px] font-medium tracking-normal text-fg-3">{t.u}</small>
            </span>
          </div>
        ))}
      </div>
      <section className="flex flex-col gap-2.5" aria-label="Completed vs carried over">
        <H3
          right={
            <span className="flex items-center gap-3 font-mono text-[11px] font-medium text-fg-3">
              <span className="flex items-center gap-1.5">
                <i aria-hidden className="size-2 rounded-[2px] bg-[var(--c1)]" />
                {stats.done.length} done
              </span>
              <span className="flex items-center gap-1.5">
                <i aria-hidden className="size-2 rounded-[2px] bg-[var(--c2)]" />
                {stats.open.length} open
              </span>
            </span>
          }
        >
          Completed vs carried over
        </H3>
        <div
          role="img"
          aria-label={`${stats.done.length} tasks completed, ${stats.open.length} carried over`}
          className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px] bg-raised"
        >
          {stats.done.length + stats.open.length > 0 && (
            <>
              <motion.span
                className="block h-full origin-left bg-[var(--c1)]"
                style={{ width: `${stats.donePct}%` }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              />
              {stats.open.length > 0 && <span className="block h-full flex-1 bg-[var(--c2)]" />}
            </>
          )}
        </div>
      </section>
      <div className={cn("grid gap-3", canReport && "grid-cols-2 max-[760px]:grid-cols-1")}>
        {canReport && <BurndownPanel sprint={sprint} />}
        <section aria-label="Contributors" className="flex min-w-0 flex-col gap-2.5 rounded-[10px] border border-line bg-bg p-3">
          <H3 right={<Count>tasks · pts</Count>}>
            Contributors <Count>{ctr.length}</Count>
          </H3>
          {ctr.length === 0 ? (
            <p className="m-0 text-[12.5px] text-fg-3">No completed tasks with an assignee.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {ctr.map((c) => {
                const u = people.get(c.userId);
                return (
                  <li key={c.userId} className="flex min-h-7 items-center gap-2 text-[12.5px]">
                    <Avatar name={u?.name ?? "Former member"} hue={u?.hue} size={20} ring={false} decorative />
                    <span className="w-[92px] min-w-0 truncate font-medium">{u?.name ?? "Former member"}</span>
                    <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
                      <span className="block h-full rounded-full bg-[var(--c1)]" style={{ width: `${(c.pts / cmax) * 100}%` }} />
                    </span>
                    <span className="font-mono text-[11.5px] text-fg-2">
                      {c.n} · {c.pts}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <section aria-label="Scope added mid-sprint" className="flex flex-col gap-2">
        <H3 right={<span className="font-mono text-[11.5px] text-fg-3">+{stats.addedPts} pts</span>}>
          Scope added mid-sprint <Count>{stats.added.length}</Count>
        </H3>
        {stats.added.length === 0 ? (
          <p className="m-0 flex items-center gap-2 text-[12.5px] text-fg-3">
            <StatusGlyph kind="backlog" /> No scope change
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {stats.added.map((t) => {
              const by = people.get(t.reporterId);
              return (
                <li key={t.id} className="flex min-h-9 items-center gap-2.5 border-b border-line text-[12.5px] last:border-b-0">
                  <StatusGlyph kind={glyphOf(t.statusId)} />
                  <span className="w-[62px] flex-none font-mono text-[11.5px] font-medium text-fg-3 max-[760px]:hidden">{t.key}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                  <span className="font-mono text-[11.5px] text-info">+{t.estimate ?? 0}</span>
                  <span className="w-[46px] text-right font-mono text-[11.5px] text-fg-3 max-[760px]:hidden">{shortDate(t.createdAt.slice(0, 10))}</span>
                  <span title={`Added by ${by?.name ?? "someone"}`} className="flex">
                    <Avatar name={by?.name ?? "?"} hue={by?.hue} size={20} ring={false} decorative />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function BurndownPanel({ sprint }: { sprint: Sprint }) {
  const q = useQuery({
    queryKey: qk.reports(sprint.projectId, "burndown", sprint.id),
    queryFn: () => api.reports.burndown(sprint.projectId, sprint.id),
  });
  return (
    <section aria-label="Burndown" className="flex min-w-0 flex-col gap-2.5 rounded-[10px] border border-line bg-bg p-3">
      <H3
        right={
          <span className="flex items-center gap-3 font-mono text-[11px] font-medium text-fg-3">
            <span className="flex items-center gap-1.5">
              <i aria-hidden className="h-0.5 w-3 bg-[var(--c1)]" /> Left
            </span>
            <span className="flex items-center gap-1.5">
              <i aria-hidden className="w-3 border-t-[1.5px] border-dashed border-fg-3" /> Ideal
            </span>
          </span>
        }
      >
        Burndown
      </H3>
      {q.isPending ? (
        <Skeleton className="h-[132px] w-full rounded-md" />
      ) : q.isError ? (
        <p role="alert" className="m-0 flex items-center gap-2 text-[12.5px] text-fg-2">
          Couldn’t load the burndown.
          <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
            <RefreshCcw size={12} aria-hidden /> Retry
          </Button>
        </p>
      ) : q.data.points.length < 2 ? (
        <p className="m-0 text-[12.5px] text-fg-3">Not enough days to chart yet.</p>
      ) : (
        <Burndown points={q.data.points} />
      )}
    </section>
  );
}

/** Small burndown (board 26 .rp-chart): remaining line + area, dashed ideal, today marker, hover/focus hits. */
export function Burndown({ points }: { points: BurndownPoint[] }) {
  const [tip, setTip] = useState<number | null>(null);
  const W = 300;
  const H = 120;
  const N = points.length;
  const max = Math.max(10, Math.ceil(Math.max(...points.map((p) => Math.max(p.ideal, p.remaining ?? 0))) / 10) * 10);
  const x = (i: number) => ((i + 0.5) / N) * W;
  const y = (v: number) => (1 - v / max) * H;
  const reached = points.map((p, i) => ({ ...p, i })).filter((p) => p.remaining !== null);
  const today = reached.at(-1)?.i ?? 0;
  const line = reached.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.remaining!).toFixed(1)}`).join(" ");
  const area = reached.length ? `${line} L${x(today).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z` : "";
  const last = reached.at(-1);
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] grid-rows-[120px_auto] gap-x-1.5 gap-y-1">
      <div className="relative font-mono text-[10px] text-fg-3" aria-hidden>
        {[max, max / 2, 0].map((v) => (
          <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - v / max) * 100}%` }}>
            {v}
          </span>
        ))}
      </div>
      <div className="relative">
        {[max, max / 2, 0].map((v) => (
          <i key={v} aria-hidden className={cn("absolute inset-x-0 h-px bg-line", v === 0 && "bg-line-2")} style={{ top: `${(1 - v / max) * 100}%` }} />
        ))}
        <i aria-hidden className="absolute inset-y-0 w-px bg-accent-t opacity-50" style={{ left: `${((today + 0.5) / N) * 100}%` }} />
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
          <path d={area} fill="var(--c1)" opacity={0.12} />
          <path d={`M${x(0)} ${y(points[0]!.ideal)} L${x(N - 1)} ${y(0)}`} fill="none" stroke="var(--text-3)" strokeWidth={1.5} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke="var(--c1)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {last && (
          <span
            aria-hidden
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-[var(--c1)]"
            style={{ left: `${(x(last.i) / W) * 100}%`, top: `${(y(last.remaining!) / H) * 100}%` }}
          />
        )}
        <div className="absolute inset-0 flex" onMouseLeave={() => setTip(null)}>
          {points.map((p, i) => (
            <button
              key={p.date}
              type="button"
              aria-label={`${shortDate(p.date)}: ${p.remaining === null ? "not reached" : `${p.remaining} points left`}, ideal ${p.ideal}`}
              onMouseEnter={() => setTip(i)}
              onFocus={() => setTip(i)}
              onBlur={() => setTip(null)}
              className="relative h-full flex-1 cursor-default rounded-[2px] outline-none focus-visible:bg-hover"
            >
              {tip === i && (
                <>
                  <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-line-2" />
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute top-1 z-10 flex min-w-[110px] flex-col gap-1 rounded-md border border-line-2 bg-raised px-2.5 py-2 text-left text-[11.5px] shadow-pop",
                      (i + 0.5) / N > 0.55 ? "right-[calc(50%+6px)]" : "left-[calc(50%+6px)]",
                    )}
                  >
                    <span className="font-mono text-[10.5px] text-fg-3">
                      {shortDate(p.date)}
                      {i === today ? " · today" : ""}
                    </span>
                    {p.remaining !== null && (
                      <span className="flex items-center gap-1.5">
                        <i className="h-0.5 w-2.5 bg-[var(--c1)]" />
                        <b className="font-semibold">{p.remaining}</b> pts left
                      </span>
                    )}
                    <span className="flex items-center gap-1.5 text-fg-2">
                      <i className="w-2.5 border-t border-dashed border-fg-3" />
                      <b className="font-semibold text-fg">{p.ideal}</b> ideal
                    </span>
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
      <span />
      <div className="relative h-3 font-mono text-[10px] text-fg-3" aria-hidden>
        <span className="absolute left-0">{shortDate(points[0]!.date)}</span>
        {today > 0 && today < N - 1 && (
          <span className="absolute -translate-x-1/2 text-accent-t" style={{ left: `${((today + 0.5) / N) * 100}%` }}>
            Today
          </span>
        )}
        <span className="absolute right-0">{shortDate(points[N - 1]!.date)}</span>
      </div>
    </div>
  );
}

function CarryStep({
  next,
  dest,
  setDest,
  open,
  keep,
  setKeep,
  toNext,
  glyphOf,
}: {
  next: Sprint | undefined;
  dest: Dest;
  setDest: (d: Dest) => void;
  open: Task[];
  keep: Record<string, boolean>;
  setKeep: (patch: Record<string, boolean>) => void;
  toNext: Set<string>;
  glyphOf: ReturnType<typeof glyphLookup>;
}) {
  const members = useProjectMembers(open[0]?.projectId);
  const people = new Map((members.data ?? []).map((m) => [m.userId, m.user]));
  const items = [...open].sort((a, b) => b.priority - a.priority || a.number - b.number);
  const state = allState(items, keep);
  const dests: { id: Dest; name: string; meta: string; icon: ReactNode }[] = [
    ...(next ? [{ id: "next" as const, name: next.name, meta: dateRange(next.startDate, next.endDate), icon: <RefreshCcw size={14} aria-hidden /> }] : []),
    { id: "backlog", name: "Backlog", meta: "unscheduled", icon: <ListTodo size={14} aria-hidden /> },
  ];
  const destName = dest === "next" && next ? next.name : "Backlog";
  const otherName = dest === "next" ? "Backlog" : (next?.name ?? "Backlog");
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key) || dests.length < 2) return;
    e.preventDefault();
    const idx = dests.findIndex((d) => d.id === dest);
    const nextIdx = (idx + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + dests.length) % dests.length;
    setDest(dests[nextIdx]!.id);
    (e.currentTarget.parentElement?.children[nextIdx] as HTMLElement | undefined)?.focus();
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <StatusGlyph kind="done" />
        <p className="m-0 text-[13px] font-semibold">Every task is done</p>
        <p className="m-0 text-[12.5px] text-fg-3">Nothing to carry over.</p>
      </div>
    );
  }
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <H3>Move checked tasks to</H3>
        <div role="radiogroup" aria-label="Destination for checked tasks" className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1">
          {dests.map((d) => {
            const on = dest === d.id;
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => setDest(d.id)}
                onKeyDown={onRadioKey}
                className={cn(
                  "flex min-w-0 items-center gap-2.5 rounded-[10px] border border-line-2 bg-bg px-3 py-[11px] text-left transition-[border-color,box-shadow] duration-150 ease-out hover:border-control",
                  on && "border-accent shadow-[0_0_0_3px_var(--accent-s)] hover:border-accent",
                )}
              >
                <span aria-hidden className={cn("relative size-4 flex-none rounded-full border-[1.5px] border-control", on && "border-accent")}>
                  {on && <span className="absolute inset-[3px] rounded-full bg-accent" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <b className="font-semibold">{d.name}</b>
                  <span className="font-mono text-[11.5px] text-fg-3">{d.meta}</span>
                </span>
                <span className="text-fg-3">{d.icon}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="flex flex-col" aria-label="Unfinished tasks">
        <div className="flex min-h-9 items-center gap-2.5 border-b border-line px-2.5 text-[12.5px] font-semibold">
          <Checkbox
            aria-label="Select all unfinished"
            checked={state === "true"}
            indeterminate={state === "mixed"}
            onChange={() => setKeep(Object.fromEntries(items.map((t) => [t.id, state !== "true"])))}
          />
          <span>Unfinished</span>
          <Count>{items.length}</Count>
          <span className="flex-1" />
          <span className="font-mono text-[11.5px] font-medium text-fg-3">unchecked → {otherName}</span>
        </div>
        {items.map((t) => {
          const on = Boolean(keep[t.id]);
          const goesNext = toNext.has(t.id);
          const a = t.assigneeId ? people.get(t.assigneeId) : undefined;
          return (
            <label
              key={t.id}
              className="grid min-h-10 cursor-pointer grid-cols-[16px_14px_58px_minmax(0,1fr)_24px_20px_100px] items-center gap-2.5 border-b border-line px-2.5 text-[13px] transition-colors hover:bg-hover max-[760px]:min-h-12 max-[760px]:grid-cols-[16px_14px_minmax(0,1fr)_auto]"
            >
              <Checkbox checked={on} aria-label={`Move ${t.key} to ${destName}`} onChange={() => setKeep({ [t.id]: !on })} />
              <StatusGlyph kind={glyphOf(t.statusId)} />
              <span className="font-mono text-[11.5px] font-medium text-fg-3 max-[760px]:hidden">{t.key}</span>
              <span className={cn("min-w-0 truncate font-medium", !on && "text-fg-2")}>{t.title}</span>
              <span className="text-right font-mono text-[11.5px] text-fg-3 max-[760px]:hidden">{t.estimate ?? "–"}</span>
              <span className="flex max-[760px]:hidden">
                {a ? <Avatar name={a.name} hue={a.hue} size={20} ring={false} decorative /> : <UnassignedAvatar size={20} />}
              </span>
              <span className={cn("inline-flex items-center justify-end gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px] font-medium", goesNext ? "text-accent-t" : "text-fg-3")}>
                <ArrowRight size={12} aria-hidden />
                {goesNext ? next?.name : "Backlog"}
              </span>
            </label>
          );
        })}
        <p className="m-0 mt-2 flex items-center gap-1.5 text-[12px] text-fg-3">
          Medium priority and above are checked by default · {sumPts(open)} pts unfinished
        </p>
      </section>
    </>
  );
}

function DoneStep({ result, nextName }: { result: Result; nextName?: string }) {
  const dots = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  return (
    <div role="status" className="flex flex-col items-center gap-4 py-8 text-center">
      <span className="relative flex size-[60px] items-center justify-center">
        {dots.map((a, i) => (
          <motion.span
            key={i}
            aria-hidden
            className="absolute size-[5px] rounded-full bg-[var(--spark)]"
            initial={{ x: 0, y: 0, opacity: 1, scale: 0.4 }}
            animate={{ x: Math.cos(a) * 46, y: Math.sin(a) * 46, opacity: 0, scale: 1 }}
            transition={{ duration: 0.56, ease: [0.16, 1, 0.3, 1], delay: 0.08 }}
          />
        ))}
        <motion.span
          aria-hidden
          className="flex size-[60px] items-center justify-center rounded-full bg-ok text-bg"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18 }}
        >
          <Check size={30} strokeWidth={3.5} />
        </motion.span>
      </span>
      <h3 className="m-0 text-[16px] font-semibold">{result.name} completed</h3>
      <div className="flex flex-wrap justify-center gap-2">
        <Tag>
          <b className="text-fg">{result.donePts}</b>/{result.totalPts} pts
        </Tag>
        <Tag>
          <b className="text-fg">{result.doneN}</b> done
        </Tag>
        {nextName && (
          <Tag>
            {result.nNext} → {nextName}
          </Tag>
        )}
        <Tag>{result.nBack} → Backlog</Tag>
      </div>
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[26px] items-center gap-1 whitespace-nowrap rounded-[5px] border border-line-2 px-2.5 font-mono text-[12px] font-medium text-fg-2">
      {children}
    </span>
  );
}
