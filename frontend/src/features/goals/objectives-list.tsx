"use client";

import { motion } from "motion/react";
import { CalendarDays, ChevronRight, Link2, Pencil } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Objective, Status, Task } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { shortDate } from "./helpers";
import { LinkPicker } from "./link-picker";
import { Flash, ObjectiveRing, OwnerAvatar, TaskGroups, useOpenTask, type PeopleMap } from "./parts";
import { useToggleObjectiveTask } from "./queries";

/** Objectives accordion (board 16 §1.4). One expanded at a time. */
export function ObjectivesList({
  objectives,
  tasks,
  statuses,
  people,
  canManage,
  projectId,
  flashId,
  onEdit,
}: {
  objectives: Objective[];
  tasks: Task[];
  statuses: Status[];
  people: PeopleMap;
  canManage: boolean;
  projectId: string;
  flashId: string | null;
  onEdit: (o: Objective) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const toggle = useToggleObjectiveTask(projectId, tasks, statuses);
  const openTask = useOpenTask();

  return (
    <div className="flex flex-col gap-2">
      {objectives.map((o) => (
        <ObjectiveRow
          key={o.id}
          objective={o}
          open={openId === o.id}
          onToggleOpen={() => {
            setOpenId((cur) => (cur === o.id ? null : o.id));
            setPickerFor(null);
          }}
          tasks={tasks}
          statuses={statuses}
          people={people}
          canManage={canManage}
          flash={flashId === o.id}
          pickerOpen={pickerFor === o.id}
          setPicker={(v) => setPickerFor(v ? o.id : null)}
          onLink={(taskId, link) => toggle.mutate({ objectiveId: o.id, taskId, link })}
          onEdit={() => onEdit(o)}
          openTask={openTask}
        />
      ))}
    </div>
  );
}

function ObjectiveRow({
  objective: o,
  open,
  onToggleOpen,
  tasks,
  statuses,
  people,
  canManage,
  flash,
  pickerOpen,
  setPicker,
  onLink,
  onEdit,
  openTask,
}: {
  objective: Objective;
  open: boolean;
  onToggleOpen: () => void;
  tasks: Task[];
  statuses: Status[];
  people: PeopleMap;
  canManage: boolean;
  flash: boolean;
  pickerOpen: boolean;
  setPicker: (v: boolean) => void;
  onLink: (taskId: string, link: boolean) => void;
  onEdit: () => void;
  openTask: (key: string) => void;
}) {
  const owner = o.ownerId ? people.get(o.ownerId) : undefined;
  const linked = tasks.filter((t) => o.taskIds.includes(t.id));
  const panelId = `obj-${o.id}-tasks`;
  const linkBtn = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => {
    setPicker(false);
    linkBtn.current?.focus({ preventScroll: true });
  }, [setPicker]);

  return (
    <article
      className={cn(
        "relative rounded-[10px] border bg-surface transition-colors duration-150",
        open ? "border-line-2" : "border-line hover:border-line-2",
      )}
    >
      <Flash on={flash} />
      <div className="flex items-center gap-0.5 pr-2.5 max-[760px]:pr-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-3.5 rounded-[10px] py-3 pl-3.5 pr-2 text-left max-[760px]:gap-3 max-[760px]:p-3"
        >
          <ObjectiveRing percent={o.progress.percent} done={o.progress.done} total={o.progress.total} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-fg">{o.title}</span>
            <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-fg-3">
              <span className="inline-flex items-center gap-1.5">
                <OwnerAvatar user={owner} />
                {owner?.name ?? "No owner"}
              </span>
              <span className="inline-flex items-center gap-1.5 font-mono">
                <CalendarDays size={12} aria-hidden />
                {shortDate(o.dueDate)}
              </span>
              <span className="inline-flex items-center gap-1.5 font-mono">
                <Link2 size={12} aria-hidden />
                {o.progress.done}/{o.progress.total} tasks
              </span>
            </span>
          </span>
          <ChevronRight
            size={14}
            aria-hidden
            className={cn("flex-none text-fg-3 transition-transform duration-[220ms] ease-out", open && "rotate-90")}
          />
        </button>
        {canManage && (
          <button
            type="button"
            aria-label={`Edit ${o.title}`}
            onClick={onEdit}
            className="inline-flex size-[30px] flex-none items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:bg-hover hover:text-fg max-[760px]:size-11"
          >
            <Pencil size={14} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <motion.div
          id={panelId}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col gap-3 pb-4 pl-[68px] pr-4 pt-0.5 max-[1023px]:pl-4 max-[760px]:px-3 max-[760px]:pb-3.5"
        >
          {linked.length ? (
            <TaskGroups tasks={linked} statuses={statuses} people={people} onOpen={openTask} />
          ) : (
            <p className="m-0 text-[12px] text-fg-3">No linked tasks</p>
          )}
          {canManage && (
            <>
              <button
                ref={linkBtn}
                type="button"
                data-link-trigger
                aria-expanded={pickerOpen}
                onClick={() => setPicker(!pickerOpen)}
                className={cn(
                  "inline-flex h-7 items-center gap-[7px] self-start rounded-[7px] border border-dashed px-2.5 text-[12px] font-medium transition-colors max-[760px]:h-11",
                  pickerOpen ? "border-control text-fg" : "border-line-2 text-fg-2 hover:border-control hover:text-fg",
                )}
              >
                <Link2 size={13} aria-hidden />
                Link tasks
              </button>
              {pickerOpen && (
                <LinkPicker objective={o} tasks={tasks} statuses={statuses} onToggle={onLink} onClose={closePicker} />
              )}
            </>
          )}
        </motion.div>
      )}
    </article>
  );
}
