"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Maximize2, Minimize2, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { ErrorGlyph, StatusGlyph } from "@/components/ui/glyphs";
import { Skeleton } from "@/components/ui/feedback";
import { InlineEditText } from "@/components/ui/inline-edit";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useMe } from "@/features/auth/session";
import { useProjectMembers, useSprints, useStatuses } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isNotFound, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Status, Task, TaskDetail, TaskPatch } from "@/lib/api/types";
import { isTypingTarget } from "@/lib/hooks/use-hotkeys";
import { can, canEditTask, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { useCreateTask, useDeleteTask, useUpdateTask } from "./mutations";
import { DescriptionEditor, RichView } from "./rich-text";
import { TaskAttachments } from "./task-attachments";
import { TaskConversation } from "./task-comments";
import { AddProperty, CF_FORCE, TaskChips, TaskFields, TaskLabels, TaskPlanning } from "./task-properties";
import { TaskDependencies } from "@/features/dependencies/task-dependencies";
import { TaskCustomFields } from "@/features/fields/task-custom-fields";
import { TaskTime } from "@/features/time/task-time";
import { triggerSpark } from "./task-origin";
import { useSparking } from "./task-bits";

export type DetailMode = "panel" | "full" | "sheet";

export function useTaskDetail(key: string) {
  const ws = useCurrentWorkspace()!;
  return useQuery({ queryKey: qk.task(ws.slug, key), queryFn: () => api.tasks.get(ws.slug, key), retry: (n, e) => !isNotFound(e) && n < 1 });
}

export function TaskDetailView({
  taskKey,
  mode,
  onClose,
  onToggleFull,
}: {
  taskKey: string;
  mode: DetailMode;
  onClose?: () => void;
  onToggleFull?: () => void;
}) {
  const q = useTaskDetail(taskKey);
  if (q.isPending) return <DetailSkeleton mode={mode} onClose={onClose} taskKey={taskKey} />;
  if (q.isError) {
    return isNotFound(q.error) ? (
      <DetailMessage taskKey={taskKey} onClose={onClose} title="This task doesn’t exist anymore" body="It was permanently deleted, or moved to a project you can’t see." notFound />
    ) : (
      <DetailMessage
        taskKey={taskKey}
        onClose={onClose}
        title={`Couldn’t load ${taskKey}`}
        body={`${errorMessage(q.error)} Nothing you changed was lost.`}
        refId={isApiError(q.error) ? q.error.ref : undefined}
        onRetry={() => void q.refetch()}
      />
    );
  }
  return <Detail task={q.data} mode={mode} onClose={onClose} onToggleFull={onToggleFull} />;
}

function Detail({ task, mode, onClose, onToggleFull }: { task: TaskDetail; mode: DetailMode; onClose?: () => void; onToggleFull?: () => void }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: statuses = [] } = useStatuses(task.projectId);
  const { data: sprints = [] } = useSprints(task.projectId);
  const update = useUpdateTask();
  const del = useDeleteTask();
  const create = useCreateTask();
  const perms = task.project.my_permissions;
  const deleted = Boolean(task.deletedAt);
  const canEdit = canEditTask(task, perms, me.id) && !deleted;
  const canStatus = (canEdit || can("task.move", perms)) && !deleted;
  const canAssign = canEdit && can("task.assign", perms);
  const canDelete = can("task.delete", perms);
  const canCreate = can("task.create", perms);
  const status = statuses.find((s) => s.id === task.statusId);
  const isDone = status?.category === "done" && status.glyph === "done";
  const spark = useSparking(task.id);
  const [planOpen, setPlanOpen] = useState(false);
  // Board 32: the tray's "Add dates" opens the panel with Start and Due revealed (?reveal=dates).
  const revealDates = useSearchParams().get("reveal") === "dates";
  const [forced, setForced] = useState<Set<string>>(() => new Set(revealDates ? ["start", "due"] : []));
  const revealedFields = new Set([...forced].filter((k) => k.startsWith(CF_FORCE)).map((k) => k.slice(CF_FORCE.length)));
  const [editingDesc, setEditingDesc] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  const full = mode === "full";
  // Sub-tasks can't have sub-tasks (the server rejects it), so a sub-task gets no composer.
  const canAddSub = canCreate && !deleted && !task.parentId;
  // New tasks can't go into a completed sprint (the server answers 422); copies and sub-tasks fall back to the backlog.
  const openSprintId = task.sprintId && sprints.find((s) => s.id === task.sprintId)?.state !== "completed" ? task.sprintId : null;

  const patch = (p: TaskPatch) => {
    if (p.statusId) {
      const s = statuses.find((x) => x.id === p.statusId);
      if (s?.glyph === "done" && task.statusId !== s.id) triggerSpark(task.id);
    }
    update.mutate({ task, patch: p, statuses });
  };

  const toggleDone = () => {
    const target = isDone ? statuses.find((s) => s.glyph === "todo") : statuses.find((s) => s.glyph === "done");
    if (target) patch({ statusId: target.id });
  };

  const link = typeof window !== "undefined" ? `${window.location.origin}${routes.task(ws.slug, task.key)}` : "";
  const copyLink = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      toast.success(`Link to ${task.key} copied`);
    } catch {
      toast.error(`Couldn’t copy the link to ${task.key}`, { body: "Your browser blocked clipboard access." });
    }
  };
  const duplicate = async () => {
    if (create.isPending) return;
    try {
      const t = await create.mutateAsync({
        projectId: task.projectId,
        body: {
          title: `${task.title} (copy)`.slice(0, 200),
          statusId: task.statusId,
          priority: task.priority,
          type: task.type,
          assigneeId: can("task.assign", perms) ? task.assigneeId : null,
          sprintId: openSprintId,
          parentId: task.parentId,
          epicId: task.epicId,
          milestoneId: task.milestoneId,
          dueDate: task.dueDate,
          labelIds: task.labelIds,
          description: task.description,
        },
      });
      toast({ tone: "spark", title: `Duplicated as ${t.key}`, action: { label: "Open", key: "O", onClick: () => router.push(`${routes.project(ws.slug, task.project.key, "board")}?task=${t.key}`) } });
    } catch (e) {
      toast.error("Couldn’t duplicate the task", { body: errorMessage(e) });
    }
  };
  const restore = useMutation({
    mutationFn: () => api.tasks.restore(task.id),
    onSuccess: () => {
      toast.success(`Restored ${task.key}`);
      void qc.invalidateQueries({ queryKey: qk.scope(task.projectId) });
      void qc.invalidateQueries({ queryKey: ["task"] });
    },
    onError: (e) => toast.error(`Couldn’t restore ${task.key}`, { body: errorMessage(e) }),
  });

  // Panel-scoped keys: 1–6 status, ⌘⇧D done, ⌘⇧F expand, ⌘L copy link, ⌘D duplicate, ⇧C add sub-task.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isTypingTarget(e.target) || (e.target as HTMLElement).closest("[role=menu],[role=listbox],.ProseMirror")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && !e.altKey && /^[1-6]$/.test(e.key) && canStatus) {
      const s = statuses[Number(e.key) - 1];
      if (s) {
        e.preventDefault();
        patch({ statusId: s.id });
      }
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "d" && canStatus) {
      e.preventDefault();
      toggleDone();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "f" && onToggleFull) {
      e.preventDefault();
      onToggleFull();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      void copyLink();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === "d" && canCreate && !deleted) {
      e.preventDefault();
      void duplicate();
    } else if (!mod && !e.altKey && e.shiftKey && e.key.toLowerCase() === "c" && canAddSub) {
      e.preventDefault();
      setAddingSub(true);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <header className="flex h-12 flex-none items-center gap-1 border-b border-line pl-3.5 pr-2">
        <span className={cn("max-w-[150px] truncate text-[12px] text-fg-3", mode === "sheet" && "hidden")}>{task.project.name}</span>
        <span className={cn("mx-0.5 text-fg-3", mode === "sheet" && "hidden")}>/</span>
        <CopyKeyButton value={task.key} />
        <span className="flex-1" />
        {canStatus && (
          <Tooltip content={isDone ? "Reopen" : "Mark done"} keys={["⌘", "⇧", "D"]}>
            <button
              type="button"
              aria-pressed={isDone}
              onClick={toggleDone}
              className={cn(
                "mr-1 inline-flex h-7 items-center gap-[7px] rounded-[7px] border border-line-2 bg-raised px-2.5 text-[12px] font-medium transition-[border-color,background-color,color,transform] duration-[var(--dur-fast)] hover:border-ok active:scale-[.97]",
                isDone && "border-transparent bg-ok-s text-ok",
              )}
            >
              {isDone ? <StatusGlyph kind="done" spark={spark} /> : <span aria-hidden className="size-3.5 rounded-full border-[1.5px] border-fg-3" />}
              {isDone ? "Done" : "Mark done"}
            </button>
          </Tooltip>
        )}
        {onToggleFull && mode !== "sheet" && (
          <Button variant="ghost" icon size="sm" aria-label={full ? "Collapse to panel" : "Expand to full page"} tooltip={full ? "Collapse to panel" : "Expand to full page"} tooltipKeys={["⌘", "⇧", "F"]} onClick={onToggleFull}>
            {full ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
          </Button>
        )}
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" icon size="sm" aria-label="More actions">
              <MoreHorizontal size={15} aria-hidden />
            </Button>
          </MenuTrigger>
          <MenuContent align="end" width={220}>
            <MenuItem keys={["⌘", "L"]} onSelect={() => void copyLink()}>
              Copy link
            </MenuItem>
            {canCreate && !deleted && (
              <MenuItem keys={["⌘", "D"]} disabled={create.isPending} onSelect={() => void duplicate()}>
                Duplicate
              </MenuItem>
            )}
            {canDelete && !deleted && (
              <>
                <MenuSeparator />
                <MenuItem danger keys={["⌫"]} onSelect={() => del.mutate(task)}>
                  Delete task
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        {onClose && (
          <Button variant="ghost" icon size="sm" aria-label="Close" tooltip="Close" tooltipKeys={["Esc"]} onClick={onClose}>
            <X size={14} aria-hidden />
          </Button>
        )}
      </header>

      {deleted && (
        <div className="px-5 pt-3.5">
          <div role="status" className="flex items-center gap-3 rounded-md border border-line-2 bg-raised px-3 py-2.5">
            <Trash2 size={16} className="text-danger" aria-hidden />
            <span className="flex-1 font-semibold">
              Deleted <span className="font-normal text-fg-3">· restorable for 30 days</span>
            </span>
            {canDelete && (
              <Button size="sm" loading={restore.isPending} onClick={() => !restore.isPending && restore.mutate()}>
                Restore
              </Button>
            )}
          </div>
        </div>
      )}

      <div className={cn("min-h-0 flex-1 overflow-auto", deleted && "pointer-events-none opacity-55 saturate-[.6]")}>
        <div
          className={cn(
            "mx-auto grid max-w-[1200px] animate-[fade-in_160ms_var(--ease)] gap-y-4 px-5 pb-10 pt-[18px] max-[760px]:px-4",
            full ? "grid-cols-[minmax(0,1fr)_300px] gap-x-12 px-10 pt-7 max-[1023px]:grid-cols-1 [grid-template-areas:'title_rail''main_rail'] max-[1023px]:[grid-template-areas:'title''props''main']" : "grid-cols-1 [grid-template-areas:'title''props''main']",
          )}
          style={full ? undefined : undefined}
        >
          <div className="flex flex-col gap-2 [grid-area:title]">
            <InlineEditText
              value={task.title}
              canEdit={canEdit}
              label="Task title"
              as="h2"
              onSave={(title) => patch({ title })}
              className="ml-[-9px] text-[22px] font-semibold leading-[30px] tracking-[-0.015em] max-[760px]:text-[18px] max-[760px]:leading-[26px]"
            />
            {!canEdit && !deleted && (
              <p className="m-0 flex w-fit items-center gap-2 rounded-md bg-raised px-2.5 py-2 text-[12px] text-fg-2">
                <Eye size={14} aria-hidden /> {can("task.edit_own", perms) ? "You can only edit tasks you reported or are assigned." : "View only"}
              </p>
            )}
          </div>

          <div className={cn("flex flex-col gap-3 [grid-area:props]", full && "self-start border-l border-line pl-6 [grid-area:rail] max-[1023px]:border-l-0 max-[1023px]:pl-0 max-[1023px]:[grid-area:props]")}>
            <TaskChips task={task} statuses={statuses} canEdit={canEdit} canStatus={canStatus} canAssign={canAssign} onPatch={patch} />
            <TaskFields task={task} statuses={statuses} canEdit={canEdit} canStatus={canStatus} canAssign={canAssign} onPatch={patch} forced={forced} />
            <TaskPlanning
              task={task}
              statuses={statuses}
              canEdit={canEdit}
              canStatus={canStatus}
              canAssign={canAssign}
              onPatch={patch}
              forced={forced}
              open={planOpen || full}
              onOpenChange={setPlanOpen}
            />
            <TaskLabels task={task} statuses={statuses} canEdit={canEdit} canStatus={canStatus} canAssign={canAssign} onPatch={patch} />
            <TaskCustomFields task={task} canEdit={canEdit} revealed={revealedFields} onPatch={patch} />
            <AddProperty
              task={task}
              statuses={statuses}
              canEdit={canEdit}
              canStatus={canStatus}
              canAssign={canAssign}
              onPatch={patch}
              forced={forced}
              onForce={(k) => {
                setForced((s) => new Set(s).add(k));
                if (["sprint", "milestone", "epic", "objective"].includes(k)) setPlanOpen(true);
              }}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-6 [grid-area:main]">
            <section aria-label="Description">
              {editingDesc ? (
                <DescriptionEditor
                  initial={task.description}
                  saving={update.isPending}
                  onCancel={() => setEditingDesc(false)}
                  onSave={(doc) => {
                    setEditingDesc(false);
                    patch({ description: doc });
                  }}
                />
              ) : task.description ? (
                canEdit ? (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Edit description"
                    onClick={(e) => {
                      if (!(e.target as HTMLElement).closest("a,button")) setEditingDesc(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.target === e.currentTarget) setEditingDesc(true);
                    }}
                    className="-mx-2 -my-1.5 cursor-text rounded-md px-2 py-1.5 hover:bg-hover"
                  >
                    <RichView doc={task.description} />
                  </div>
                ) : (
                  <RichView doc={task.description} />
                )
              ) : canEdit ? (
                <button type="button" onClick={() => setEditingDesc(true)} className="-mx-2 w-[calc(100%+16px)] rounded-md px-2 py-1.5 text-left text-[14px] text-fg-3 hover:bg-hover">
                  Add a description…
                </button>
              ) : null}
            </section>

            {/* Board 39 order: Description → Dependencies → Time → Sub-tasks → Attachments → Comments. */}
            <TaskDependencies task={task} canEdit={canEdit} wide={full} />
            <TaskTime task={task} canEdit={canEdit} deleted={deleted} forceEstimate={forced.has("timeEstimate")} onPatch={patch} />
            <Subtasks task={task} statuses={statuses} canCreate={canAddSub} sprintId={openSprintId} adding={addingSub} onAddingChange={setAddingSub} />
            <TaskAttachments task={task} canUpload={can("attachment.upload", perms)} deleted={deleted} />
            <TaskConversation task={task} deleted={deleted} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyKeyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={`Copy task key ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className="inline-flex h-[26px] items-center gap-1.5 rounded-sm px-1.5 font-mono text-[12px] font-medium text-fg-2 hover:bg-hover hover:text-fg"
      >
        {value}
        <Copy size={12} strokeWidth={1.5} aria-hidden />
      </button>
      <span role="status" className={cn("text-[12px] text-ok", !copied && "sr-only")}>
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}

function Subtasks({
  task,
  statuses,
  canCreate,
  sprintId,
  adding,
  onAddingChange: setAdding,
}: {
  task: TaskDetail;
  statuses: Status[];
  canCreate: boolean;
  sprintId: string | null;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
}) {
  const me = useMe();
  const router = useRouter();
  const ws = useCurrentWorkspace()!;
  const { data: members = [] } = useProjectMembers(task.projectId);
  const update = useUpdateTask();
  const create = useCreateTask();
  const [draft, setDraft] = useState("");
  const perms = task.project.my_permissions;
  const done = statuses.find((s) => s.glyph === "done");
  const todo = statuses.find((s) => s.glyph === "todo");
  const isDone = (t: Task) => statuses.find((s) => s.id === t.statusId)?.category === "done";
  const total = task.subtasks.length;
  const doneCount = task.subtasks.filter(isDone).length;
  if (!total && !canCreate) return null;

  const add = async () => {
    const title = draft.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    setDraft("");
    try {
      await create.mutateAsync({ projectId: task.projectId, body: { title, parentId: task.id, statusId: todo?.id, sprintId } });
    } catch (e) {
      toast.error("Couldn’t add the sub-task", { body: errorMessage(e) });
    }
  };

  return (
    <section aria-label="Sub-tasks">
      <div className="mb-2 flex items-center gap-2.5">
        <h3 className="m-0 text-[13px] font-semibold">Sub-tasks</h3>
        {total > 0 && (
          <>
            <span className="font-mono text-[11px] font-medium text-fg-3">
              {doneCount}/{total}
            </span>
            <div role="progressbar" aria-label="Sub-task progress" aria-valuenow={Math.round((doneCount / total) * 100)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 max-w-[140px] flex-1 overflow-hidden rounded-full border border-line bg-raised">
              <span className="block h-full origin-left rounded-full bg-ok transition-transform duration-300 ease-out" style={{ transform: `scaleX(${doneCount / total})` }} />
            </div>
          </>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {task.subtasks.map((s) => {
          const canToggle = canEditTask(s, perms, me.id) || can("task.move", perms);
          const assignee = members.find((m) => m.userId === s.assigneeId)?.user;
          const d = isDone(s);
          return (
            <li key={s.id} className="-mx-2 flex min-h-[34px] items-center gap-2.5 rounded-sm px-2 hover:bg-hover">
              {canToggle ? (
                <Checkbox
                  checked={d}
                  aria-label={`Complete ${s.key}`}
                  onChange={() => {
                    const target = d ? todo : done;
                    if (!target) return;
                    if (target.glyph === "done") triggerSpark(s.id);
                    update.mutate({ task: s, patch: { statusId: target.id }, statuses });
                  }}
                />
              ) : (
                <StatusGlyph kind={d ? "done" : "todo"} label={d ? "Done" : "Open"} />
              )}
              <span className="w-[50px] flex-none font-mono text-[11px] font-medium text-fg-3">{s.key}</span>
              <button
                type="button"
                onClick={() => router.push(`${routes.project(ws.slug, task.project.key, "board")}?task=${s.key}`)}
                className={cn("min-w-0 flex-1 truncate text-left hover:underline", d && "text-fg-3 line-through")}
              >
                {s.title}
              </button>
              {assignee && <Avatar name={assignee.name} hue={assignee.hue} size={20} />}
            </li>
          );
        })}
      </ul>
      {canCreate &&
        (adding ? (
          <input
            autoFocus
            value={draft}
            maxLength={200}
            placeholder="Sub-task title"
            aria-label="New sub-task title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void add()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft("");
                setAdding(false);
              }
            }}
            className="mt-1 h-8 w-full rounded-sm border border-accent bg-surface px-2.5 text-[13px] shadow-[0_0_0_3px_var(--accent-s)] outline-none"
          />
        ) : (
          <Button variant="ghost" size="sm" className="-ml-2.5 mt-1" kbd="⇧C" onClick={() => setAdding(true)}>
            <Plus size={13} aria-hidden /> Add sub-task
          </Button>
        ))}
    </section>
  );
}

function DetailHeaderShell({ taskKey, onClose }: { taskKey: string; onClose?: () => void }) {
  return (
    <header className="flex h-12 flex-none items-center gap-2 border-b border-line pl-4 pr-2">
      <span className="font-mono text-[12px] font-medium text-fg-3">{taskKey}</span>
      <span className="flex-1" />
      {onClose && (
        <Button variant="ghost" icon size="sm" aria-label="Close" onClick={onClose}>
          <X size={14} aria-hidden />
        </Button>
      )}
    </header>
  );
}

function DetailSkeleton({ taskKey, onClose }: { taskKey: string; mode: DetailMode; onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label={`Loading ${taskKey}`}>
      <DetailHeaderShell taskKey={taskKey} onClose={onClose} />
      <div className="flex flex-col gap-3.5 px-5 pt-5">
        <Skeleton className="h-[18px] w-[86%]" />
        <Skeleton className="h-[18px] w-[52%]" />
        {[110, 90, 130, 70].map((w) => (
          <div key={w} className="flex gap-6">
            <Skeleton className="h-2.5 w-[60px]" />
            <Skeleton className="h-2.5" style={{ width: w }} />
          </div>
        ))}
        <Skeleton className="mt-2.5 h-2.5 w-full" />
        <Skeleton className="h-2.5 w-[94%]" />
        <Skeleton className="h-2.5 w-[60%]" />
      </div>
    </div>
  );
}

function DetailMessage({
  taskKey,
  onClose,
  title,
  body,
  notFound,
  refId,
  onRetry,
}: {
  taskKey: string;
  onClose?: () => void;
  title: string;
  body: string;
  notFound?: boolean;
  refId?: string;
  onRetry?: () => void;
}) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const projectKey = taskKey.split("-")[0];
  return (
    <div className="flex h-full flex-col">
      <DetailHeaderShell taskKey={taskKey} onClose={onClose} />
      <div role={notFound ? "status" : "alert"} className="flex flex-1 flex-col items-start justify-center gap-2.5 px-7">
        {notFound ? <span className="font-mono text-[12px] text-fg-3">{taskKey}</span> : <ErrorGlyph />}
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <p className="m-0 max-w-[360px] text-[13px] leading-5 text-fg-2">{body}</p>
        <div className="flex items-center gap-2">
          {onRetry && (
            <Button kbd="R" onClick={onRetry}>
              Retry
            </Button>
          )}
          {notFound && projectKey && (
            <Button onClick={() => router.push(routes.project(ws.slug, projectKey, "board"))}>
              Back to board <Kbd>G</Kbd>
              <Kbd>B</Kbd>
            </Button>
          )}
          {refId && <span className="font-mono text-[11px] text-fg-3">ref {refId}</span>}
        </div>
      </div>
    </div>
  );
}
