"use client";

import * as Popover from "@radix-ui/react-popover";
import { CalendarRange, ChevronRight, Plus, Search, Target, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/choice";
import { DateChip, DatePicker } from "@/components/ui/date-picker";
import { PriorityIcon, StatusGlyph, priorityMeta, type PriorityLevel } from "@/components/ui/glyphs";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { BlockedChip } from "@/features/dependencies/blocked-badge";
import { hasValue } from "@/features/fields/field-lib";
import { useCustomFields } from "@/features/fields/queries";
import { CF_TYPE_ICON } from "@/features/filters/filter-bar";
import { RunningTimerChip } from "@/features/time/task-time";
import { useEpics, useLabels, useMilestones, useObjectives, useProjectMembers, useSprints } from "@/features/projects/queries";
import type { Priority, Status, TaskDetail, TaskPatch, TaskType } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { addDaysISO, shortDate, todayISO } from "@/lib/utils/dates";
import { daysUntil } from "@/lib/domain/progress";
import { PresenceField } from "@/features/presence/presence-ui";

/* Task properties (board 14 §2.8): 3 chips · 4 fields · Planning folded · empty = hidden. */

type Props = {
  task: TaskDetail;
  statuses: Status[];
  canEdit: boolean;
  canStatus: boolean;
  canAssign: boolean;
  onPatch: (patch: TaskPatch) => void;
  full?: boolean;
};

const TYPES: { value: TaskType; label: string }[] = [
  { value: "feature", label: "Feature" },
  { value: "bug", label: "Bug" },
  { value: "chore", label: "Chore" },
  { value: "spike", label: "Spike" },
];

const chipBase =
  "inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-2.5 text-[12.5px] font-medium text-fg transition-colors duration-[var(--dur-fast)] max-[760px]:h-9";
const chipEdit = "hover:border-control hover:bg-hover data-[state=open]:border-control data-[state=open]:bg-hover";
const ghostChip = "border-dashed bg-transparent text-fg-3 hover:text-fg";

function Chip({ editable, ghost, children, label }: { editable: boolean; ghost?: boolean; children: ReactNode; label: string }) {
  if (!editable) return <span className={cn(chipBase, "cursor-default")} aria-label={label}>{children}</span>;
  return (
    <MenuTrigger asChild>
      <button type="button" aria-label={label} className={cn(chipBase, chipEdit, ghost && ghostChip)}>
        {children}
      </button>
    </MenuTrigger>
  );
}

export function TaskChips({ task, statuses, canEdit, canStatus, canAssign, onPatch }: Props) {
  const { data: members = [] } = useProjectMembers(task.projectId);
  const status = statuses.find((s) => s.id === task.statusId);
  const assignee = members.find((m) => m.userId === task.assigneeId)?.user;
  return (
    <div className="flex flex-wrap items-center gap-1.5 max-[760px]:flex-nowrap max-[760px]:overflow-x-auto">
      <PresenceField field="statusId" as="span" className="inline-flex">
      <Menu>
        <Chip editable={canStatus} label={`Status: ${status?.name ?? ""}`}>
          {status && <StatusGlyph kind={status.glyph} />}
          {status?.name}
        </Chip>
        <MenuContent align="start" width={220} aria-label="Status">
          <MenuRadioGroup value={task.statusId} onValueChange={(v) => onPatch({ statusId: v })}>
            {statuses.map((s, i) => (
              <MenuRadioItem key={s.id} value={s.id} icon={<StatusGlyph kind={s.glyph} />} keys={[String(i + 1)]}>
                {s.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      </PresenceField>

      {(task.priority > 0 || canEdit) && (
        <PresenceField field="priority" as="span" className="inline-flex">
        <Menu>
          <Chip editable={canEdit} ghost={task.priority === 0} label={`Priority: ${priorityMeta[task.priority].label}`}>
            {task.priority === 0 ? (
              <>
                <Plus size={12} aria-hidden /> Priority
              </>
            ) : (
              <>
                <PriorityIcon level={task.priority} />
                {priorityMeta[task.priority].label}
              </>
            )}
          </Chip>
          <MenuContent align="start" width={220} aria-label="Priority">
            <MenuRadioGroup value={String(task.priority)} onValueChange={(v) => onPatch({ priority: Number(v) as Priority })}>
              {([4, 3, 2, 1, 0] as PriorityLevel[]).map((p, i) => (
                <MenuRadioItem key={p} value={String(p)} icon={<PriorityIcon level={p} />} keys={[String(i)]}>
                  {priorityMeta[p].label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        </PresenceField>
      )}

      {(assignee || canAssign) && (
        <PresenceField field="assigneeId" as="span" className="inline-flex">
        <Menu>
          <Chip editable={canAssign} ghost={!assignee} label={`Assignee: ${assignee?.name ?? "Unassigned"}`}>
            {assignee ? (
              <>
                <Avatar name={assignee.name} hue={assignee.hue} size={20} decorative />
                {assignee.name}
              </>
            ) : (
              <>
                <Plus size={12} aria-hidden /> Assign
              </>
            )}
          </Chip>
          <MenuContent align="start" width={240} aria-label="Assignee">
            <MenuRadioGroup value={task.assigneeId ?? ""} onValueChange={(v) => onPatch({ assigneeId: v || null })}>
              {members.map((m) => (
                <MenuRadioItem key={m.userId} value={m.userId} icon={<Avatar name={m.user.name} hue={m.user.hue} size={20} decorative />}>
                  {m.user.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {task.assigneeId && (
              <>
                <MenuSeparator />
                <MenuItem icon={<UnassignedAvatar size={18} />} onSelect={() => onPatch({ assigneeId: null })}>
                  Unassign
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        </PresenceField>
      )}
      {/* Board 32: the task's span when it has both dates. */}
      {task.startDate && task.dueDate && (
        <span className={cn(chipBase, "cursor-default font-mono text-[12px]")} aria-label={`Scheduled ${shortDate(task.startDate)} to ${shortDate(task.dueDate)}`}>
          <CalendarRange size={13} aria-hidden className="text-fg-3" />
          {shortDate(task.startDate)} → {shortDate(task.dueDate)}
        </span>
      )}
      {/* Board 39: derived Blocked chip and the viewer's running timer (read-only). */}
      <BlockedChip task={task} />
      <RunningTimerChip taskId={task.id} />
    </div>
  );
}

/* ───────── four-field grid ───────── */

const fieldBtn =
  "-mx-2 flex min-w-0 flex-col gap-[3px] rounded-[7px] px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)]";

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] font-medium leading-[14px] text-fg-3">{children}</span>;
}
function FieldValue({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium leading-[18px] text-fg">{children}</span>;
}

export function TaskFields({ task, canEdit, onPatch, forced }: Props & { forced: Set<string> }) {
  const { data: members = [] } = useProjectMembers(task.projectId);
  const { data: sprints = [] } = useSprints(task.projectId);
  const reporter = members.find((m) => m.userId === task.reporterId)?.user;
  const [editingEst, setEditingEst] = useState(false);
  const [est, setEst] = useState("");
  const typeLabel = TYPES.find((t) => t.value === task.type)?.label ?? task.type;
  const sprint = sprints.find((s) => s.id === task.sprintId);
  const showEst = task.estimate !== null || forced.has("estimate");
  const showDue = Boolean(task.dueDate) || forced.has("due");
  const showStart = Boolean(task.startDate) || forced.has("start");

  const commitEst = () => {
    setEditingEst(false);
    const n = est.trim() === "" ? null : Math.max(0, Math.min(99, parseInt(est, 10)));
    if (n === null || !Number.isNaN(n)) {
      if (n !== task.estimate) onPatch({ estimate: n });
    }
  };

  return (
    <div className="grid grid-cols-2 gap-x-3">
      <div className={fieldBtn}>
        <FieldLabel>Reporter</FieldLabel>
        <FieldValue>
          {reporter && <Avatar name={reporter.name} hue={reporter.hue} size={20} decorative />}
          {reporter?.name ?? "—"}
        </FieldValue>
      </div>

      <Menu>
        {canEdit ? (
          <MenuTrigger asChild>
            <button type="button" className={cn(fieldBtn, "hover:bg-hover data-[state=open]:bg-hover")} aria-label={`Type: ${typeLabel}`}>
              <FieldLabel>Type</FieldLabel>
              <FieldValue>{typeLabel}</FieldValue>
            </button>
          </MenuTrigger>
        ) : (
          <div className={fieldBtn}>
            <FieldLabel>Type</FieldLabel>
            <FieldValue>{typeLabel}</FieldValue>
          </div>
        )}
        <MenuContent align="start" width={200}>
          <MenuRadioGroup value={task.type} onValueChange={(v) => onPatch({ type: v as TaskType })}>
            {TYPES.map((t) => (
              <MenuRadioItem key={t.value} value={t.value}>
                {t.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>

      {showEst && (
        <PresenceField field="estimate">
        {editingEst ? (
          <div className={fieldBtn}>
            <FieldLabel>Estimate</FieldLabel>
            <span className="flex items-center gap-1.5">
              <input
                autoFocus
                type="number"
                min={0}
                max={99}
                aria-label="Estimate in points"
                value={est}
                onChange={(e) => setEst(e.target.value)}
                onBlur={commitEst}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEst();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditingEst(false);
                  }
                }}
                className="h-[26px] w-14 rounded-sm border border-accent bg-surface px-2 text-right font-mono text-[13px] font-medium tabular shadow-[0_0_0_3px_var(--accent-s)] outline-none max-[760px]:h-9"
              />
              <span className="text-[13px] text-fg-3">pts</span>
            </span>
          </div>
        ) : canEdit ? (
          <button
            type="button"
            className={cn(fieldBtn, "hover:bg-hover")}
            aria-label={`Estimate: ${task.estimate ?? "none"}. Click to edit`}
            onClick={() => {
              setEst(task.estimate === null ? "" : String(task.estimate));
              setEditingEst(true);
            }}
          >
            <FieldLabel>Estimate</FieldLabel>
            <FieldValue>{task.estimate === null ? <span className="text-fg-3">Set…</span> : `${task.estimate} pts`}</FieldValue>
          </button>
        ) : (
          <div className={fieldBtn}>
            <FieldLabel>Estimate</FieldLabel>
            <FieldValue>{task.estimate} pts</FieldValue>
          </div>
        )}
        </PresenceField>
      )}

      {showStart && (
        <PresenceField field="startDate">
          <StartField task={task} canEdit={canEdit} onPatch={onPatch} />
        </PresenceField>
      )}
      {showDue && (
        <PresenceField field="dueDate">
          <DueField task={task} canEdit={canEdit} onPatch={onPatch} sprintEnd={sprint?.endDate} />
        </PresenceField>
      )}
    </div>
  );
}

function DueField({ task, canEdit, onPatch, sprintEnd }: { task: TaskDetail; canEdit: boolean; onPatch: (p: TaskPatch) => void; sprintEnd?: string }) {
  const d = task.dueDate;
  const days = d ? daysUntil(d) : null;
  const soon = days !== null && days >= 0 && days <= 2 && !task.completedAt;
  const late = days !== null && days < 0 && !task.completedAt;
  const rel = days === null ? "" : days === 0 ? "today" : days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : `${-days} day${days === -1 ? "" : "s"} late`;
  const value = (
    <>
      <FieldLabel>Due date</FieldLabel>
      <FieldValue>
        {d ? shortDate(d) : <span className="text-fg-3">Set…</span>}
        {d && <span className={cn("font-normal text-fg-3", soon && "text-warn", late && "text-danger")}>· {rel}</span>}
      </FieldValue>
    </>
  );
  if (!canEdit) return <div className={fieldBtn}>{value}</div>;
  const nextMonday = (() => {
    const t = new Date();
    const add = ((8 - t.getDay()) % 7) || 7;
    return addDaysISO(todayISO(), add);
  })();
  return (
    <DatePicker
      value={d}
      // Board 32: days before the start date can't be picked (the server refuses start > due).
      min={task.startDate ?? undefined}
      onChange={(v) => onPatch({ dueDate: v })}
      quick={(pick) => (
        <>
          <DateChip onClick={() => pick(addDaysISO(todayISO(), 1))}>Tomorrow</DateChip>
          <DateChip onClick={() => pick(nextMonday)}>Next week</DateChip>
          {sprintEnd && <DateChip onClick={() => pick(sprintEnd)}>Sprint end</DateChip>}
          {d && <DateChip onClick={() => pick(null)}>Clear</DateChip>}
        </>
      )}
    >
      <button type="button" className={cn(fieldBtn, "hover:bg-hover data-[state=open]:bg-hover")} aria-label={`Due date: ${d ? shortDate(d) : "none"}`}>
        {value}
      </button>
    </DatePicker>
  );
}

/** Board 32: Start date (shown when set or revealed through "Add property"); days after the due date are disabled. */
function StartField({ task, canEdit, onPatch }: { task: TaskDetail; canEdit: boolean; onPatch: (p: TaskPatch) => void }) {
  const d = task.startDate;
  const value = (
    <>
      <FieldLabel>Start date</FieldLabel>
      <FieldValue>{d ? shortDate(d) : <span className="text-fg-3">Set…</span>}</FieldValue>
    </>
  );
  if (!canEdit) return <div className={fieldBtn}>{value}</div>;
  return (
    <DatePicker
      value={d}
      max={task.dueDate ?? undefined}
      onChange={(v) => onPatch({ startDate: v })}
      quick={(pick) => (
        <>
          <DateChip onClick={() => pick(todayISO())}>Today</DateChip>
          {d && <DateChip onClick={() => pick(null)}>Clear</DateChip>}
        </>
      )}
    >
      <button type="button" className={cn(fieldBtn, "hover:bg-hover data-[state=open]:bg-hover")} aria-label={`Start date: ${d ? shortDate(d) : "none"}`}>
        {value}
      </button>
    </DatePicker>
  );
}

/* ───────── planning accordion ───────── */

export function TaskPlanning({ task, canEdit, onPatch, open, onOpenChange, forced }: Props & { open: boolean; onOpenChange: (o: boolean) => void; forced: Set<string> }) {
  const { data: sprints = [] } = useSprints(task.projectId);
  const { data: milestones = [] } = useMilestones(task.projectId);
  const { data: epics = [] } = useEpics(task.projectId);
  const { data: objectives = [] } = useObjectives(task.projectId);
  const sprint = sprints.find((s) => s.id === task.sprintId);
  const milestone = milestones.find((m) => m.id === task.milestoneId);
  const epic = epics.find((e) => e.id === task.epicId);
  const linked = objectives.filter((o) => task.objectiveIds.includes(o.id));
  const show = Boolean(sprint || milestone || epic || linked.length || forced.size || canEdit);
  if (!show) return null;
  const summary = [sprint?.name, milestone?.name, linked.length ? `${linked.length} objective${linked.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");

  const row = (label: string, current: string | undefined, items: { id: string; name: string }[], key: "sprintId" | "milestoneId" | "epicId", value: string | null, noneLabel: string, force: string) => {
    if (!current && !canEdit && !forced.has(force)) return null;
    return (
      <PresenceField field={key} className="grid min-h-[30px] grid-cols-[84px_minmax(0,1fr)] items-center px-2.5">
        <span className="text-[12px] font-medium text-fg-3">{label}</span>
        {canEdit ? (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`${label}: ${current ?? noneLabel}`} className="-ml-1.5 min-h-[26px] max-w-full truncate rounded-sm px-1.5 text-left text-[13px] font-medium leading-[1.3] hover:bg-hover data-[state=open]:bg-hover">
                {current ?? <span className="text-fg-3">{noneLabel}</span>}
              </button>
            </MenuTrigger>
            <MenuContent align="start" width={240}>
              <MenuRadioGroup value={value ?? ""} onValueChange={(v) => onPatch({ [key]: v || null } as TaskPatch)}>
                {items.map((it) => (
                  <MenuRadioItem key={it.id} value={it.id}>
                    {it.name}
                  </MenuRadioItem>
                ))}
                <MenuRadioItem value="">{noneLabel}</MenuRadioItem>
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        ) : (
          <span className="truncate text-[13px] font-medium">{current ?? "—"}</span>
        )}
      </PresenceField>
    );
  };

  return (
    <div className="rounded-[10px] border border-line bg-bg">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex h-[38px] w-full items-center gap-2 rounded-[10px] px-2.5 text-left text-[12.5px] font-semibold hover:bg-hover"
      >
        <ChevronRight size={12} aria-hidden className={cn("text-fg-3 transition-transform duration-200", open && "rotate-90")} />
        Planning
        <span className={cn("min-w-0 flex-1 truncate font-normal text-fg-3 transition-opacity duration-150", open && "opacity-0")}>{summary}</span>
      </button>
      <div className="collapse-rows" data-open={open}>
        <div>
          <div className="pb-2">
            {row("Sprint", sprint?.name, sprints.filter((s) => s.state !== "completed" || s.id === task.sprintId), "sprintId", task.sprintId, "No sprint", "sprint")}
            {row("Milestone", milestone?.name, milestones, "milestoneId", task.milestoneId, "No milestone", "milestone")}
            {row("Epic", epic?.name, epics.filter((e) => !e.archivedAt || e.id === task.epicId), "epicId", task.epicId, "No epic", "epic")}
            {(linked.length > 0 || canEdit) && (
              <div className="grid grid-cols-[84px_minmax(0,1fr)] items-start px-2.5 py-1">
                <span className="pt-[5px] text-[12px] font-medium text-fg-3">Objectives</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {linked.map((o) => (
                    <span key={o.id} className={cn("inline-flex h-6 items-center gap-[5px] rounded-sm border border-line bg-raised pl-2 text-[12px] font-medium", canEdit ? "pr-1" : "pr-2")}>
                      <Target size={11} className="text-accent-t" aria-hidden />
                      <span className="max-w-[180px] truncate">{o.title}</span>
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={`Unlink ${o.title}`}
                          onClick={() => onPatch({ objectiveIds: task.objectiveIds.filter((x) => x !== o.id) })}
                          className="flex size-[18px] items-center justify-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg"
                        >
                          <X size={9} strokeWidth={2.5} aria-hidden />
                        </button>
                      )}
                    </span>
                  ))}
                  {canEdit && <ObjectivePicker task={task} objectives={objectives} onPatch={onPatch} />}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ObjectivePicker({ task, objectives, onPatch }: { task: TaskDetail; objectives: { id: string; title: string }[]; onPatch: (p: TaskPatch) => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => objectives.filter((o) => o.title.toLowerCase().includes(q.trim().toLowerCase())), [objectives, q]);
  return (
    <Popover.Root onOpenChange={(o) => !o && setQ("")}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Link objective"
          className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-sm border border-dashed border-line-2 px-1.5 text-[12px] font-medium text-fg-3 hover:border-control hover:text-fg"
        >
          <Plus size={12} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-[70] w-[260px] rounded-[10px] border border-line-2 bg-raised p-1 shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]">
          <div className="relative p-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search objectives…"
              aria-label="Search objectives"
              className="h-[30px] w-full rounded-sm border border-line-2 bg-bg pl-7 pr-2 text-[13px] outline-none focus:border-accent"
            />
          </div>
          <div role="listbox" aria-multiselectable="true" aria-label="Objectives" className="max-h-[220px] overflow-auto">
            {shown.map((o) => {
              const on = task.objectiveIds.includes(o.id);
              return (
                <label key={o.id} className="flex h-[30px] cursor-pointer items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium hover:bg-hover">
                  <Checkbox
                    checked={on}
                    onChange={() => onPatch({ objectiveIds: on ? task.objectiveIds.filter((x) => x !== o.id) : [...task.objectiveIds, o.id] })}
                  />
                  <span className="truncate">{o.title}</span>
                </label>
              );
            })}
            {shown.length === 0 && <p className="m-0 px-2 py-2.5 text-[12px] text-fg-3">No objectives match.</p>}
          </div>
          <p className="m-0 border-t border-line px-2 py-1.5 font-mono text-[11px] text-fg-3">
            {shown.length} of {objectives.length} match
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ───────── labels + add property ───────── */

export function TaskLabels({ task, canEdit, onPatch }: Props) {
  const { data: labels = [] } = useLabels(task.projectId);
  const on = labels.filter((l) => task.labelIds.includes(l.id));
  if (!on.length && !canEdit) return null;
  return (
    <PresenceField field="labels" className="flex flex-wrap items-center gap-1.5">
      {on.map((l) => (
        <span key={l.id} className="inline-flex h-[22px] items-center gap-1.5 rounded-sm border border-line bg-raised px-2 text-[12px] font-medium">
          <span className="size-[7px] rounded-full" style={{ background: l.color }} aria-hidden />
          {l.name}
        </span>
      ))}
      {canEdit && (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="Add label"
              className="inline-flex h-[22px] min-w-[22px] items-center justify-center gap-1 rounded-sm border border-dashed border-line-2 px-1.5 text-[12px] font-medium text-fg-3 hover:border-control hover:text-fg"
            >
              <Plus size={12} aria-hidden />
              {on.length === 0 && "Label"}
            </button>
          </MenuTrigger>
          <MenuContent align="start" width={200}>
            {labels.map((l) => (
              <MenuCheckboxItem
                key={l.id}
                checked={task.labelIds.includes(l.id)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(c) =>
                  onPatch({ labelIds: c ? [...task.labelIds, l.id] : task.labelIds.filter((x) => x !== l.id) })
                }
                icon={<span className="size-[7px] rounded-full" style={{ background: l.color }} />}
              >
                {l.name}
              </MenuCheckboxItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </PresenceField>
  );
}

/** Prefix for "Add property" keys that reveal a custom-field row (board 39). */
export const CF_FORCE = "cf:";

export function AddProperty({ task, canEdit, forced, onForce }: Props & { forced: Set<string>; onForce: (k: string) => void }) {
  const { data: fields = [] } = useCustomFields(task.projectId);
  if (!canEdit) return null;
  // Board 39: hidden custom fields (no value, not required, not revealed) and the time estimate.
  const hiddenFields = [...fields].sort((a, b) => a.position - b.position).filter((f) => !f.required && !hasValue(task.customFields?.[f.id]) && !forced.has(`${CF_FORCE}${f.id}`));
  const showEstimate = task.timeEstimateMinutes === null && !forced.has("timeEstimate");
  const missing = [
    { k: "estimate", label: "Estimate", has: task.estimate !== null },
    { k: "start", label: "Start date", has: Boolean(task.startDate) },
    { k: "due", label: "Due date", has: Boolean(task.dueDate) },
    { k: "sprint", label: "Sprint", has: Boolean(task.sprintId) },
    { k: "milestone", label: "Milestone", has: Boolean(task.milestoneId) },
    { k: "epic", label: "Epic", has: Boolean(task.epicId) },
    { k: "objective", label: "Objective", has: task.objectiveIds.length > 0 },
  ].filter((m) => !m.has && !forced.has(m.k));
  if (!missing.length && !hiddenFields.length && !showEstimate) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="-ml-2 inline-flex h-[26px] w-fit items-center gap-1.5 rounded-sm px-2 text-[12px] font-medium text-fg-3 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg">
          <Plus size={12} aria-hidden /> Add property
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={200}>
        {missing.map((m) => (
          <MenuItem key={m.k} onSelect={() => onForce(m.k)}>
            {m.label}
          </MenuItem>
        ))}
        {showEstimate && <MenuItem onSelect={() => onForce("timeEstimate")}>Time estimate</MenuItem>}
        {hiddenFields.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Custom fields</MenuLabel>
            {hiddenFields.map((f) => (
              <MenuItem key={f.id} icon={CF_TYPE_ICON[f.type]} onSelect={() => onForce(`${CF_FORCE}${f.id}`)}>
                {f.name}
              </MenuItem>
            ))}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}
