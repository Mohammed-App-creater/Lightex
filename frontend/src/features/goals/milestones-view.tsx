"use client";

import { motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { Milestone, Status, Task } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { barGeometry, monthLabelStep, shortDate, timelineScale } from "./helpers";
import { AtRiskBadge, CheckMark, DaysLabel, FillBar, Flash, OwnerAvatar, TaskGrid, useOpenTask, type PeopleMap } from "./parts";
import { useCompleteMilestone } from "./queries";

export type MilestoneViewMode = "timeline" | "list";

type Shared = {
  tasks: Task[];
  statuses: Status[];
  people: PeopleMap;
  canManage: boolean;
  onEdit: (m: Milestone) => void;
};

/** Milestones: Timeline (default) or List, plus mark complete with spark + Undo toast (board 16 §1.5–1.8). */
export function MilestonesView({
  milestones,
  mode,
  projectId,
  flashId,
  selectedId,
  onSelect,
  ...shared
}: Shared & {
  milestones: Milestone[];
  mode: MilestoneViewMode;
  projectId: string;
  flashId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const complete = useCompleteMilestone(projectId);
  const [sparkId, setSparkId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(selectedId);

  const setDone = (m: Milestone, completed: boolean) => {
    complete.mutate({ id: m.id, completed });
    if (!completed) {
      setSparkId(null);
      return;
    }
    setSparkId(m.id);
    onSelect(m.id);
    toast({
      id: `ms-done-${m.id}`,
      tone: "spark",
      title: `${m.name} completed`,
      duration: 4000,
      action: shared.canManage
        ? { label: "Undo", key: "Z", onClick: () => complete.mutate({ id: m.id, completed: false }) }
        : undefined,
    });
  };

  const selected = milestones.find((m) => m.id === selectedId) ?? null;

  if (mode === "list") {
    return (
      <MilestoneList
        milestones={milestones}
        expandedId={expandedId}
        setExpandedId={setExpandedId}
        flashId={flashId}
        sparkId={sparkId}
        setDone={setDone}
        {...shared}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Timeline milestones={milestones} selectedId={selectedId} onSelect={onSelect} flashId={flashId} sparkId={sparkId} />
      {selected && <DetailCard key={selected.id} m={selected} sparkId={sparkId} setDone={setDone} {...shared} />}
    </div>
  );
}

/* ───────────────────────── Timeline ───────────────────────── */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** The "Today" chip (~50px, centred) would cover a month label starting within it. */
function overlapsToday(monthPct: number, todayPct: number, width: number) {
  const dx = ((monthPct - todayPct) / 100) * width;
  return dx > -40 && dx < 30;
}

const LAB = "[--lab:210px] max-[1023px]:[--lab:136px] max-[760px]:[--lab:112px]";

function Timeline({
  milestones,
  selectedId,
  onSelect,
  flashId,
  sparkId,
}: {
  milestones: Milestone[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  flashId: string | null;
  sparkId: string | null;
}) {
  const scale = useMemo(() => timelineScale(milestones), [milestones]);
  const [trackRef, trackW] = useWidth<HTMLDivElement>();
  const step = monthLabelStep(scale.months.length, trackW);
  const todayIn = scale.today > 0 && scale.today < 100;

  const gridlines = (
    <>
      {scale.months.map((mo) => (
        <span key={mo.iso} aria-hidden className="absolute inset-y-0 w-px bg-line" style={{ left: `${mo.pct}%` }} />
      ))}
      {todayIn && (
        <span
          aria-hidden
          className="absolute inset-y-0 border-l-[1.5px] border-dashed border-accent-t opacity-75"
          style={{ left: `${scale.today}%` }}
        />
      )}
    </>
  );

  return (
    <div className={cn("overflow-hidden rounded-[10px] border border-line bg-surface", LAB)}>
      <div className="grid h-9 grid-cols-[var(--lab)_minmax(0,1fr)] border-b border-line">
        <div aria-hidden />
        <div ref={trackRef} className="relative mr-9" aria-hidden>
          {scale.months.map((mo, i) => (
            <span
              key={mo.iso}
              className="absolute inset-y-0 flex items-center whitespace-nowrap border-l border-line pl-2 font-mono text-[11px] font-medium text-fg-3"
              style={{ left: `${mo.pct}%` }}
            >
              {i % step === 0 && !(todayIn && overlapsToday(mo.pct, scale.today, trackW)) ? mo.label : ""}
            </span>
          ))}
          {todayIn && (
            <span
              className="absolute top-2 z-[2] h-5 -translate-x-1/2 whitespace-nowrap rounded-[5px] bg-accent-s px-[7px] font-mono text-[10.5px] font-semibold leading-5 text-accent-t"
              style={{ left: `${scale.today}%` }}
            >
              Today
            </span>
          )}
        </div>
      </div>
      <ul className="m-0 list-none p-0" aria-label="Milestones timeline">
        {milestones.map((m) => {
          const done = Boolean(m.completedAt);
          const risk = m.progress.atRisk;
          const g = barGeometry(scale, m.startDate, m.dueDate);
          const selected = m.id === selectedId;
          return (
            <li key={m.id} className="relative border-b border-line last:border-b-0">
              <Flash on={flashId === m.id} radius={0} />
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`${m.name}, due ${shortDate(m.dueDate)}, ${m.progress.percent}% done${risk ? ", at risk" : ""}${done ? ", completed" : ""}`}
                onClick={() => onSelect(m.id)}
                className={cn(
                  "grid h-[58px] w-full grid-cols-[var(--lab)_minmax(0,1fr)] text-left transition-colors duration-[var(--dur-fast)] hover:bg-hover",
                  selected && "bg-hover shadow-[inset_2px_0_0_var(--accent-t)]",
                )}
              >
                <span className="flex min-w-0 flex-col justify-center gap-[5px] px-3.5 max-[760px]:px-3">
                  <span className="truncate text-[13px] font-semibold text-fg">{m.name}</span>
                  <span className="flex items-center gap-2 font-mono text-[11px] font-medium text-fg-3">
                    <DaysLabel date={m.dueDate} done={done} />
                    {risk && <AtRiskBadge className="max-[760px]:hidden" />}
                  </span>
                </span>
                <span className="relative mr-9 block h-full" aria-hidden>
                  {gridlines}
                  <span className="absolute top-1/2 -mt-1 h-2" style={{ left: `${g.left}%`, width: `${g.width}%` }}>
                    <FillBar percent={m.progress.percent} tone={done ? "ok" : risk ? "warn" : "accent"} className="h-2 w-full rounded-[4px]" />
                  </span>
                  {done ? (
                    <span className="absolute top-1/2 z-[1] -ml-2 -mt-2" style={{ left: `${g.end}%` }}>
                      <CheckMark spark={sparkId === m.id} />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "absolute top-1/2 z-[1] -ml-1.5 -mt-1.5 size-3 rotate-45 rounded-[2px] border-2 bg-surface",
                        risk ? "border-warn" : "border-accent-t",
                      )}
                      style={{ left: `${g.end}%` }}
                    />
                  )}
                  <span
                    className="absolute top-1/2 -mt-1.5 whitespace-nowrap font-mono text-[11px] font-medium leading-3 text-fg-2"
                    style={{ left: `${g.end}%`, transform: g.flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
                  >
                    {shortDate(m.dueDate)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ───────────────────────── Actions ───────────────────────── */

function CompleteAction({
  m,
  canManage,
  setDone,
}: {
  m: Milestone;
  canManage: boolean;
  setDone: (m: Milestone, completed: boolean) => void;
}) {
  const done = Boolean(m.completedAt);
  if (done) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex h-7 items-center gap-2 rounded-[7px] bg-[color-mix(in_oklab,var(--ok)_14%,transparent)] pl-[7px] pr-2.5 text-[12px] font-medium text-ok">
          <CheckMark />
          Completed
        </span>
        {canManage && (
          <Button variant="ghost" size="sm" onClick={() => setDone(m, false)} className="max-[760px]:h-11">
            Reopen
          </Button>
        )}
      </span>
    );
  }
  if (!canManage) return null;
  return (
    <button
      type="button"
      onClick={() => setDone(m, true)}
      className="group inline-flex h-7 items-center gap-[7px] rounded-[7px] border border-line-2 bg-raised px-2.5 text-[12px] font-medium text-fg transition-[border-color,transform] duration-[var(--dur-fast)] hover:border-ok active:scale-[.97] max-[760px]:h-11"
    >
      <span aria-hidden className="size-3.5 rounded-full border-[1.5px] border-fg-3 transition-colors group-hover:border-ok" />
      Mark complete
    </button>
  );
}

/* ───────────────────────── Detail card ───────────────────────── */

function DetailCard({
  m,
  sparkId,
  setDone,
  tasks,
  statuses,
  people,
  canManage,
  onEdit,
}: Shared & {
  m: Milestone;
  sparkId: string | null;
  setDone: (m: Milestone, completed: boolean) => void;
}) {
  const openTask = useOpenTask();
  const done = Boolean(m.completedAt);
  const owner = m.ownerId ? people.get(m.ownerId) : undefined;
  const linked = tasks.filter((t) => t.milestoneId === m.id);
  return (
    <motion.section
      aria-label={`${m.name} details`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col gap-3.5 rounded-[10px] border border-line bg-surface px-[18px] py-4 max-[760px]:p-3.5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 max-[760px]:basis-full">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{m.name}</h3>
            {m.progress.atRisk && <AtRiskBadge />}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] font-medium text-fg-3">
            <OwnerAvatar user={owner} />
            <span className="font-sans text-[12px]">{owner?.name ?? "No owner"}</span>
            <span>
              {shortDate(m.dueDate)} · <DaysLabel date={m.dueDate} done={done} />
              {m.progress.atRisk && ` · expected ${m.progress.expected}%`}
            </span>
          </div>
          {m.description && <p className="m-0 text-[13px] leading-5 text-fg-2">{m.description}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {canManage && (
            <Button variant="ghost" size="sm" onClick={() => onEdit(m)} className="max-[760px]:h-11">
              Edit
            </Button>
          )}
          <CompleteAction m={m} canManage={canManage} setDone={setDone} />
        </div>
      </div>
      <div className="flex items-center gap-2.5 font-mono text-[11.5px] font-medium text-fg-2">
        <FillBar
          percent={m.progress.percent}
          tone={done ? "ok" : m.progress.atRisk ? "warn" : "accent"}
          className="h-1.5 flex-1"
          label={`${m.name} progress`}
        />
        <span>
          {m.progress.done}/{m.progress.total}
        </span>
      </div>
      {sparkId === m.id && <span className="sr-only" role="status">{m.name} completed</span>}
      <TaskGrid tasks={linked} statuses={statuses} people={people} onOpen={openTask} />
    </motion.section>
  );
}

/* ───────────────────────── List ───────────────────────── */

const LIST_COLS =
  "grid-cols-[14px_16px_minmax(0,1fr)_64px_76px_160px_64px] max-[1023px]:grid-cols-[14px_16px_minmax(0,1fr)_120px] max-[760px]:grid-cols-[14px_16px_minmax(0,1fr)_70px] max-[760px]:gap-2.5";

function MilestoneList({
  milestones,
  expandedId,
  setExpandedId,
  flashId,
  sparkId,
  setDone,
  ...shared
}: Shared & {
  milestones: Milestone[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  flashId: string | null;
  sparkId: string | null;
  setDone: (m: Milestone, completed: boolean) => void;
}) {
  const openTask = useOpenTask();
  const { tasks, statuses, people, canManage, onEdit } = shared;
  return (
    <ul className="m-0 list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0" aria-label="Milestones">
      {milestones.map((m) => {
        const done = Boolean(m.completedAt);
        const risk = m.progress.atRisk;
        const open = expandedId === m.id;
        const panelId = `ms-${m.id}-detail`;
        return (
          <li key={m.id} className="relative border-b border-line last:border-b-0">
            <Flash on={flashId === m.id} radius={0} />
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setExpandedId(open ? null : m.id)}
              className={cn(
                "grid min-h-[54px] w-full items-center gap-3.5 px-4 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hover max-[760px]:px-3 max-[760px]:py-2.5",
                LIST_COLS,
              )}
            >
              <ChevronRight
                size={14}
                aria-hidden
                className={cn("text-fg-3 transition-transform duration-[220ms] ease-out", open && "rotate-90")}
              />
              <span className="inline-flex items-center justify-center" aria-hidden>
                {done ? (
                  <CheckMark spark={sparkId === m.id} />
                ) : (
                  <span className={cn("size-2.5 rotate-45 rounded-[2px] border-2", risk ? "border-warn" : "border-accent-t")} />
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-fg">{m.name}</span>
                  {risk && <AtRiskBadge className="max-[760px]:hidden" />}
                </span>
                <span className="hidden font-mono text-[11px] text-fg-3 max-[1023px]:block">
                  {shortDate(m.dueDate)} · <DaysLabel date={m.dueDate} done={done} />
                </span>
              </span>
              <span className="font-mono text-[11.5px] text-fg-2 max-[1023px]:hidden">{shortDate(m.dueDate)}</span>
              <span className="font-mono text-[11.5px] text-fg-3 max-[1023px]:hidden">
                <DaysLabel date={m.dueDate} done={done} />
              </span>
              <span className="flex items-center gap-2.5 font-mono text-[11.5px] text-fg-2">
                <FillBar percent={m.progress.percent} tone={done ? "ok" : risk ? "warn" : "accent"} className="h-1.5 flex-1" />
                <span className="w-8 text-right">{m.progress.percent}%</span>
              </span>
              <span className="text-right font-mono text-[11.5px] text-fg-3 max-[1023px]:hidden">
                {m.progress.total} {m.progress.total === 1 ? "task" : "tasks"}
              </span>
            </button>
            {open && (
              <motion.div
                id={panelId}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-col gap-3 pb-4 pl-[60px] pr-4 max-[1023px]:pl-4 max-[760px]:px-3 max-[760px]:pb-3.5"
              >
                {m.progress.atRisk && (
                  <p className="m-0 font-mono text-[11px] text-fg-3">
                    {m.progress.percent}% done · expected {m.progress.expected}% by today
                  </p>
                )}
                <TaskGrid tasks={tasks.filter((t) => t.milestoneId === m.id)} statuses={statuses} people={people} onOpen={openTask} />
                {(canManage || done) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <CompleteAction m={m} canManage={canManage} setDone={setDone} />
                    {canManage && (
                      <Button variant="ghost" size="sm" onClick={() => onEdit(m)} className="max-[760px]:h-11">
                        Edit
                      </Button>
                    )}
                  </div>
                )}
              </motion.div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
