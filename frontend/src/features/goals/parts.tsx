"use client";

import { motion } from "motion/react";
import { usePathname } from "next/navigation";
import { useCallback, type ReactNode } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { StatusGlyph, type GlyphKind } from "@/components/ui/glyphs";
import { ProgressRing } from "@/components/ui/feedback";
import type { Status, Task, User } from "@/lib/api/types";
import { daysLabel } from "@/lib/domain/progress";
import { pushUrl, withTaskParam } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { groupTasksByStatus } from "./helpers";

/* Small building blocks shared by the objectives and milestones views (board 16). */

export type PeopleMap = Map<string, Pick<User, "id" | "name" | "hue">>;

/** Opens a task in the side panel via ?task=KEY on the current URL. */
export function useOpenTask() {
  const pathname = usePathname();
  return useCallback(
    (key: string) => pushUrl(withTaskParam(pathname, window.location.search, key)),
    [pathname],
  );
}

/** "At risk" badge (.g-risk): warn tint, 6px dot. */
export function AtRiskBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 flex-none items-center gap-[5px] rounded-[5px] border px-[7px] font-sans text-[11px] font-semibold leading-none text-warn",
        "border-[color-mix(in_oklab,var(--warn)_35%,transparent)] bg-[color-mix(in_oklab,var(--warn)_13%,transparent)]",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      At risk
    </span>
  );
}

/** "14d left" / "3d over" / "Due today" / "Done". */
export function DaysLabel({ date, done, className }: { date: string; done: boolean; className?: string }) {
  const d = daysLabel(date, done);
  return (
    <span
      className={cn(
        "whitespace-nowrap",
        d.tone === "ok" && "text-ok",
        d.tone === "danger" && "text-danger",
        d.tone === "warn" && "text-warn",
        className,
      )}
    >
      {d.text}
    </span>
  );
}

/** 16px green check; `spark` plays the cyan completion burst. */
export function CheckMark({ spark, className }: { spark?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-4 flex-none items-center justify-center", className)}>
      <span className="inline-flex scale-[1.143]">
        <StatusGlyph kind="done" spark={spark} />
      </span>
    </span>
  );
}

export function OwnerAvatar({ user, size = 20 }: { user: Pick<User, "name" | "hue"> | undefined; size?: 20 | 24 }) {
  return user ? <Avatar name={user.name} hue={user.hue} size={size} ring={false} decorative /> : <UnassignedAvatar size={size} label="No owner" />;
}

/** Objective progress ring: 40px, accent-t (ok at 100%), centre label is the number only. */
export function ObjectiveRing({ percent, done, total }: { percent: number; done: number; total: number }) {
  return (
    <span className="relative inline-flex flex-none">
      <ProgressRing
        value={percent}
        size={40}
        stroke={4}
        track="var(--line-2)"
        color={percent >= 100 ? "var(--ok)" : "var(--accent-t)"}
        label={`${done} of ${total} tasks done,`}
      />
      <span aria-hidden className="absolute inset-0 flex items-center justify-center font-mono text-[10.5px] font-semibold leading-none text-fg">
        {percent}
      </span>
    </span>
  );
}

/** Track bar with a fill that grows from 0 (transform only). */
export function FillBar({
  percent,
  tone,
  className,
  label,
}: {
  percent: number;
  tone: "accent" | "warn" | "ok";
  className?: string;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <span
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuenow={label ? pct : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-hidden={label ? undefined : true}
      className={cn("block overflow-hidden rounded-full bg-line-2", className)}
    >
      <motion.span
        className={cn("block h-full origin-left rounded-full", tone === "warn" ? "bg-warn" : tone === "ok" ? "bg-ok" : "bg-accent-t")}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: pct / 100 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      />
    </span>
  );
}

/** One linked task: key · title · assignee. Opens the task panel. */
export function TaskRow({
  task,
  people,
  glyph,
  onOpen,
}: {
  task: Task;
  people: PeopleMap;
  glyph?: GlyphKind;
  onOpen: (key: string) => void;
}) {
  const assignee = task.assigneeId ? people.get(task.assigneeId) : undefined;
  return (
    <button
      type="button"
      onClick={() => onOpen(task.key)}
      className="-mx-2 flex min-h-[30px] min-w-0 items-center gap-[9px] rounded-sm px-2 text-left text-[13px] transition-colors duration-[var(--dur-fast)] hover:bg-hover max-[760px]:min-h-11"
    >
      {glyph && <StatusGlyph kind={glyph} />}
      <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{task.key}</span>
      <span className="min-w-0 flex-1 truncate text-fg">{task.title}</span>
      {assignee ? (
        <span title={assignee.name} className="inline-flex">
          <Avatar name={assignee.name} hue={assignee.hue} size={20} ring={false} />
        </span>
      ) : (
        <UnassignedAvatar size={20} />
      )}
    </button>
  );
}

/** Linked tasks grouped by status: glyph + group name + count, then rows. */
export function TaskGroups({
  tasks,
  statuses,
  people,
  onOpen,
}: {
  tasks: Task[];
  statuses: Status[];
  people: PeopleMap;
  onOpen: (key: string) => void;
}) {
  const groups = groupTasksByStatus(tasks, statuses);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6 gap-y-1">
      {groups.map((g) => (
        <section key={g.status.id} aria-label={`${g.status.name}, ${g.tasks.length}`} className="flex min-w-0 flex-col">
          <h4 className="m-0 flex h-7 items-center gap-2 text-[12px] font-semibold text-fg-2">
            <StatusGlyph kind={g.status.glyph} />
            {g.status.name}
            <span className="font-mono text-[11px] font-medium text-fg-3">{g.tasks.length}</span>
          </h4>
          {g.tasks.map((t) => (
            <TaskRow key={t.id} task={t} people={people} onOpen={onOpen} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** Flat task grid with status glyphs (milestone detail). */
export function TaskGrid({
  tasks,
  statuses,
  people,
  onOpen,
}: {
  tasks: Task[];
  statuses: Status[];
  people: PeopleMap;
  onOpen: (key: string) => void;
}) {
  if (!tasks.length) return <p className="m-0 text-[12px] text-fg-3">No linked tasks</p>;
  const glyphOf = (t: Task) => statuses.find((s) => s.id === t.statusId)?.glyph ?? "todo";
  const ordered = groupTasksByStatus(tasks, statuses).flatMap((g) => g.tasks);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-6">
      {ordered.map((t) => (
        <TaskRow key={t.id} task={t} glyph={glyphOf(t)} people={people} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** New/edited rows flash an accent-soft ring that fades over 1400ms (opacity only). */
export function Flash({ on, radius = 10 }: { on: boolean; radius?: number }) {
  if (!on) return null;
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute -inset-px z-[1] shadow-[0_0_0_3px_var(--accent-s)]"
      style={{ borderRadius: radius }}
      initial={{ opacity: 1 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 1.4, ease: "easeOut" }}
    />
  );
}

/** "View only" pill (viewer). */
export function ViewOnlyPill({ icon }: { icon: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] flex-none items-center gap-1.5 rounded-sm border border-line-2 px-2 font-mono text-[11px] font-medium text-fg-3">
      {icon}
      View only
    </span>
  );
}
