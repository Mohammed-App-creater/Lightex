"use client";

import * as D from "@radix-ui/react-dialog";
import { Calendar, ChevronRight, Flag, Hexagon, RefreshCcw, Tag, Timer, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Avatar, ProjectBadge, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { DateChip, DatePicker } from "@/components/ui/date-picker";
import { PriorityIcon, StatusGlyph, priorityMeta, type PriorityLevel } from "@/components/ui/glyphs";
import { Textarea } from "@/components/ui/input";
import { Menu, MenuCheckboxItem, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { shell, useShell, type CreateTaskDefaults } from "@/components/shell/shell-state";
import { useMe } from "@/features/auth/session";
import { epicSwatch } from "@/features/epics/epic-model";
import { useEpics, useLabels, useMilestones, useProjectMembers, useSprints, useStatuses } from "@/features/projects/queries";
import { useProjects } from "@/features/workspace/queries";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Priority, RichDoc } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { addDaysISO, shortDate, todayISO } from "@/lib/utils/dates";
import { useCreateTask } from "./mutations";

/*
 * Create task (board 30): project chip › New task, a large title, Status · Priority · Assignee chips,
 * "More fields" (sprint, milestone, epic, due, labels, estimate, description), Create another,
 * ⌘↵ creates. Bottom sheet on phones.
 */

type Draft = {
  projectId: string;
  title: string;
  statusId: string;
  priority: Priority;
  assigneeId: string | null;
  /** undefined = not chosen yet (defaults to the active sprint once sprints load). */
  sprintId: string | null | undefined;
  milestoneId: string | null;
  epicId: string | null;
  dueDate: string | null;
  labelIds: string[];
  estimate: number | null;
  description: string;
};

const ESTIMATES = [1, 2, 3, 5, 8];

export function CreateTaskDialog() {
  const { createTask } = useShell();
  return createTask ? <Inner defaults={createTask} /> : null;
}

function Inner({ defaults }: { defaults: CreateTaskDefaults }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const route = useRouteInfo();
  const mobile = useIsMobile();
  const { data: projects = [], isPending: projectsPending } = useProjects(ws.slug);
  const allowed = useMemo(() => projects.filter((p) => can("task.create", p.my_permissions) && p.status !== "archived"), [projects]);
  const initialProject = defaults.projectId ?? allowed.find((p) => p.key === route.projectKey)?.id ?? allowed[0]?.id ?? "";

  const blank = (projectId: string): Draft => ({
    projectId,
    title: defaults.title ?? "",
    statusId: defaults.statusId ?? "",
    priority: 0,
    assigneeId: null,
    sprintId: defaults.sprintId,
    milestoneId: null,
    epicId: null,
    dueDate: defaults.dueDate ?? null,
    labelIds: [],
    estimate: null,
    description: "",
  });
  const [d, setD] = useState<Draft>(() => blank(initialProject));
  const [more, setMore] = useState(false);
  const [another, setAnother] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  // Projects may load after the dialog opens (C pressed on a cold start).
  if (!d.projectId && initialProject) patch({ projectId: initialProject });

  const project = allowed.find((p) => p.id === d.projectId);
  const { data: statuses = [] } = useStatuses(d.projectId || undefined);
  const { data: members = [] } = useProjectMembers(d.projectId || undefined);
  const { data: sprints = [] } = useSprints(d.projectId || undefined);
  const { data: milestones = [] } = useMilestones(d.projectId || undefined);
  const { data: epics = [] } = useEpics(d.projectId || undefined);
  const { data: labels = [] } = useLabels(d.projectId || undefined);
  const canAssign = can("task.assign", project?.my_permissions);
  const create = useCreateTask();
  const active = sprints.find((s) => s.state === "active");

  // Status: the chosen one, else the requested default, else Todo (derived once statuses load).
  const status =
    statuses.find((s) => s.id === d.statusId) ??
    statuses.find((s) => s.id === defaults.statusId) ??
    statuses.find((s) => s.glyph === "todo") ??
    statuses[0];
  const sprintId = d.sprintId === undefined ? active?.id ?? null : d.sprintId;
  const sprint = sprints.find((s) => s.id === sprintId);
  const ms = milestones.find((m) => m.id === d.milestoneId);
  const epic = epics.find((e) => e.id === d.epicId);
  const assignee = members.find((m) => m.userId === d.assigneeId)?.user ?? (d.assigneeId === me.id ? me : undefined);
  const moreCount = [d.sprintId !== undefined && d.sprintId !== (active?.id ?? null), d.milestoneId, d.epicId, d.dueDate, d.labelIds.length, d.estimate, d.description.trim()].filter(Boolean).length;

  const close = () => shell.closeCreateTask();

  const submit = async () => {
    if (create.isPending) return;
    const title = d.title.trim();
    if (!title) {
      setErr("Title is required");
      titleRef.current?.focus();
      return;
    }
    if (!project) return;
    const desc = d.description.trim();
    try {
      const task = await create.mutateAsync({
        projectId: project.id,
        body: {
          title: title.slice(0, 200),
          statusId: status?.id,
          priority: d.priority,
          assigneeId: d.assigneeId,
          parentId: defaults.parentId,
          sprintId,
          milestoneId: d.milestoneId,
          epicId: d.epicId,
          dueDate: d.dueDate,
          labelIds: d.labelIds,
          estimate: d.estimate,
          description: desc ? ({ type: "doc", content: desc.split(/\n{2,}/).map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })) } as RichDoc) : null,
        },
      });
      toast({
        tone: "spark",
        title: `${task.key} created`,
        body: task.title.slice(0, 60),
        action: {
          label: "Open",
          key: "O",
          onClick: () => router.push(`${routes.project(ws.slug, project.key, route.view && route.view !== "overview" ? route.view : "board")}?task=${task.key}`),
        },
      });
      if (another) {
        setD((x) => ({ ...x, title: "", description: "" }));
        setErr(null);
        requestAnimationFrame(() => titleRef.current?.focus());
      } else close();
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.title) setErr(e.fieldErrors.title);
      else toast.error("Couldn’t create the task", { body: errorMessage(e) });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // A second ⌘↵ while the first create is in flight would make a duplicate task.
      if (!create.isPending) void submit();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "text") {
      e.preventDefault();
    }
  };

  const shellClass = mobile
    ? "fixed inset-x-0 bottom-0 z-[61] flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[18px] border-t border-line-2 bg-surface shadow-pop outline-none data-[state=open]:animate-[sheet-up_280ms_var(--ease)]"
    : "fixed left-1/2 top-[72px] z-[61] flex max-h-[calc(100dvh-96px)] w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line-2 bg-surface shadow-modal outline-none data-[state=open]:animate-[modal-in_200ms_var(--ease)]";

  return (
    <D.Root open onOpenChange={(o) => !o && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-scrim backdrop-blur-[6px] data-[state=open]:animate-[fade-in_180ms_var(--ease)]" />
        <D.Content
          aria-describedby={undefined}
          className={shellClass}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            titleRef.current?.focus();
          }}
        >
          {mobile && <span aria-hidden className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-line-2" />}
          {!projectsPending && !allowed.length ? (
            <div className="flex flex-col gap-4 p-6">
              <D.Title className="m-0 text-[16px] font-semibold">New task</D.Title>
              <p className="m-0 text-[13px] leading-5 text-fg-2">You can’t create tasks in any project yet. Ask a project admin to give you a role with “Create tasks”.</p>
              <div className="flex justify-end">
                <Button onClick={close}>Close</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex h-12 flex-none items-center gap-2 pl-3.5 pr-2">
                <Menu>
                  <MenuTrigger asChild disabled={Boolean(defaults.parentId)}>
                    <button
                      type="button"
                      aria-label={`Project: ${project?.name ?? "pick a project"}`}
                      title={defaults.parentId ? "Sub-tasks stay in their parent’s project" : undefined}
                      className={cn(chip, "h-[26px] gap-1.5 pl-1 pr-2", mobile && "h-8")}
                    >
                      {project ? <ProjectBadge code={project.key.slice(0, 2)} hue={project.hue} size={18} /> : null}
                      {project?.name ?? "Project"}
                    </button>
                  </MenuTrigger>
                  <MenuContent align="start" width={220} aria-label="Project">
                    <MenuRadioGroup
                      value={d.projectId}
                      onValueChange={(id) => id !== d.projectId && setD({ ...blank(id), title: d.title, description: d.description, priority: d.priority })}
                    >
                      {allowed.map((p) => (
                        <MenuRadioItem key={p.id} value={p.id} icon={<ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={18} />}>
                          {p.name}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuContent>
                </Menu>
                <ChevronRight size={12} className="flex-none text-fg-3" aria-hidden />
                <D.Title className="m-0 text-[13px] font-semibold">{defaults.parentId ? "New sub-task" : "New task"}</D.Title>
                <span className="flex-1" />
                <D.Close asChild>
                  <Button variant="ghost" size="sm" icon aria-label="Close" tooltip="Close" tooltipKeys={["Esc"]} className={mobile ? "size-11" : undefined}>
                    <X size={14} aria-hidden />
                  </Button>
                </D.Close>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] pb-4 pt-0.5">
                <div
                  className={cn(
                    "-mx-2 rounded-md border border-transparent px-2 py-0.5 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-s)]",
                    err && "border-danger shadow-[0_0_0_3px_var(--danger-s)] focus-within:border-danger",
                  )}
                >
                  <input
                    ref={titleRef}
                    type="text"
                    aria-label="Task title"
                    aria-invalid={Boolean(err)}
                    aria-describedby={err ? "ct-title-err" : undefined}
                    placeholder="Task title"
                    maxLength={200}
                    value={d.title}
                    onChange={(e) => {
                      patch({ title: e.target.value });
                      if (err && e.target.value.trim()) setErr(null);
                    }}
                    className={cn("h-10 w-full bg-transparent text-[20px] focus-visible:!shadow-none focus-visible:!outline-none font-semibold tracking-[-0.015em] text-fg outline-none placeholder:font-medium placeholder:text-fg-3", mobile && "text-[19px]")}
                  />
                </div>
                {err && (
                  <span id="ct-title-err" role="alert" className="-mt-1.5 flex items-center gap-1.5 text-[12px] text-danger">
                    {err}
                  </span>
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" aria-label={`Status: ${status?.name ?? "…"}`} className={cn(chip, mobile && "h-9")}>
                        <StatusGlyph kind={status?.glyph ?? "todo"} />
                        {status?.name ?? "Status"}
                      </button>
                    </MenuTrigger>
                    <MenuContent align="start" width={200} aria-label="Status">
                      <MenuRadioGroup value={status?.id ?? ""} onValueChange={(v) => patch({ statusId: v })}>
                        {statuses.map((s, i) => (
                          <MenuRadioItem key={s.id} value={s.id} icon={<StatusGlyph kind={s.glyph} />} meta={String(i + 1)}>
                            {s.name}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuContent>
                  </Menu>
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" aria-label={`Priority: ${priorityMeta[d.priority].label}`} className={cn(chip, d.priority === 0 && ghost, mobile && "h-9")}>
                        <PriorityIcon level={d.priority} bars />
                        {d.priority ? priorityMeta[d.priority].label : "Priority"}
                      </button>
                    </MenuTrigger>
                    <MenuContent align="start" width={190} aria-label="Priority">
                      <MenuRadioGroup value={String(d.priority)} onValueChange={(v) => patch({ priority: Number(v) as Priority })}>
                        {([0, 4, 3, 2, 1] as PriorityLevel[]).map((p) => (
                          <MenuRadioItem key={p} value={String(p)} icon={<PriorityIcon level={p} bars />}>
                            {priorityMeta[p].label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuContent>
                  </Menu>
                  <Menu>
                    <MenuTrigger asChild>
                      <button type="button" aria-label={`Assignee: ${assignee?.name ?? "Unassigned"}`} className={cn(chip, !assignee && ghost, mobile && "h-9")}>
                        {assignee ? <Avatar name={assignee.name} hue={assignee.hue} size={18} decorative /> : <UnassignedAvatar size={18} />}
                        {assignee ? assignee.name.split(" ")[0] : "Assignee"}
                      </button>
                    </MenuTrigger>
                    <MenuContent align="start" width={220} aria-label="Assignee" className="max-h-[320px] overflow-y-auto">
                      <MenuRadioGroup value={d.assigneeId ?? ""} onValueChange={(v) => patch({ assigneeId: v || null })}>
                        <MenuRadioItem value="" icon={<UnassignedAvatar size={20} />}>
                          Unassigned
                        </MenuRadioItem>
                        {(canAssign ? members.map((m) => m.user) : members.filter((m) => m.userId === me.id).map((m) => m.user)).map((u) => (
                          <MenuRadioItem key={u.id} value={u.id} icon={<Avatar name={u.name} hue={u.hue} size={20} decorative />} meta={u.id === me.id ? "me" : undefined}>
                            {u.name}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                      {!canAssign && <p className="m-0 px-2 pb-1.5 pt-1 text-[11.5px] text-fg-3">Your role can only assign tasks to you.</p>}
                    </MenuContent>
                  </Menu>
                </div>

                <button
                  type="button"
                  aria-expanded={more}
                  onClick={() => setMore((m) => !m)}
                  className="-ml-2 inline-flex h-7 items-center gap-[7px] self-start rounded-sm px-2 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg max-[760px]:h-11"
                >
                  <ChevronRight size={12} strokeWidth={2} aria-hidden className={cn("transition-transform duration-200", more && "rotate-90")} />
                  More fields
                  {!more && moreCount > 0 && (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-s px-1 font-mono text-[10.5px] font-semibold text-accent-t">{moreCount}</span>
                  )}
                </button>
                <div className="collapse-rows" data-open={more}>
                  <div className={cn(!more && "invisible")}>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 pb-3 max-[560px]:grid-cols-1">
                      <MoreField label="Sprint" icon={<RefreshCcw size={14} strokeWidth={1.5} aria-hidden />} value={sprint?.name ?? "No sprint"} empty={!sprint}>
                        <MenuRadioGroup value={sprintId ?? ""} onValueChange={(v) => patch({ sprintId: v || null })}>
                          {sprints
                            .filter((s) => s.state !== "completed")
                            .map((s) => (
                              <MenuRadioItem key={s.id} value={s.id} meta={s.state === "active" ? "Active" : "Planned"}>
                                {s.name}
                              </MenuRadioItem>
                            ))}
                          <MenuRadioItem value="">No sprint</MenuRadioItem>
                        </MenuRadioGroup>
                      </MoreField>
                      <MoreField label="Milestone" icon={<Flag size={14} strokeWidth={1.5} aria-hidden />} value={ms?.name ?? "None"} empty={!ms}>
                        <MenuRadioGroup value={d.milestoneId ?? ""} onValueChange={(v) => patch({ milestoneId: v || null })}>
                          {milestones
                            .filter((m) => !m.completedAt)
                            .map((m) => (
                              <MenuRadioItem key={m.id} value={m.id} meta={shortDate(m.dueDate)}>
                                {m.name}
                              </MenuRadioItem>
                            ))}
                          <MenuRadioItem value="">None</MenuRadioItem>
                        </MenuRadioGroup>
                      </MoreField>
                      <MoreField label="Epic" icon={<Hexagon size={14} strokeWidth={1.5} aria-hidden />} value={epic?.name ?? "None"} empty={!epic}>
                        <MenuRadioGroup value={d.epicId ?? ""} onValueChange={(v) => patch({ epicId: v || null })}>
                          {epics.filter((e) => !e.archivedAt).map((e) => (
                            <MenuRadioItem key={e.id} value={e.id} icon={<span aria-hidden className="size-2 rounded-[3px]" style={{ background: epicSwatch(e.hue) }} />}>
                              {e.name}
                            </MenuRadioItem>
                          ))}
                          <MenuRadioItem value="">None</MenuRadioItem>
                        </MenuRadioGroup>
                      </MoreField>
                      <div className="grid min-h-8 grid-cols-[84px_minmax(0,1fr)] items-center max-[760px]:min-h-11">
                        <span className="text-[12px] font-medium text-fg-3">Due date</span>
                        <DatePicker
                          value={d.dueDate}
                          onChange={(v) => patch({ dueDate: v })}
                          quick={(pick) => (
                            <>
                              <DateChip onClick={() => pick(todayISO())}>Today</DateChip>
                              <DateChip onClick={() => pick(addDaysISO(todayISO(), 1))}>Tomorrow</DateChip>
                              <DateChip onClick={() => pick(addDaysISO(todayISO(), 7))}>Next week</DateChip>
                              {active && <DateChip onClick={() => pick(active.endDate)}>Sprint end</DateChip>}
                              {milestones
                                .filter((m) => !m.completedAt)
                                .slice(0, 3)
                                .map((m) => (
                                  <DateChip key={m.id} title={`${m.name} · ${shortDate(m.dueDate)}`} onClick={() => pick(m.dueDate)}>
                                    {m.name}
                                  </DateChip>
                                ))}
                              {d.dueDate && <DateChip onClick={() => pick(null)}>No due date</DateChip>}
                            </>
                          )}
                        >
                          <button type="button" aria-label={`Due date: ${d.dueDate ? shortDate(d.dueDate) : "None"}`} className={cn(moreBtn, !d.dueDate && "text-fg-3")}>
                            <Calendar size={14} strokeWidth={1.5} aria-hidden />
                            <span className="truncate">{d.dueDate ? shortDate(d.dueDate) : "None"}</span>
                          </button>
                        </DatePicker>
                      </div>
                      <MoreField
                        label="Labels"
                        icon={<Tag size={14} strokeWidth={1.5} aria-hidden />}
                        value={d.labelIds.length ? d.labelIds.map((id) => labels.find((l) => l.id === id)?.name).filter(Boolean).join(", ") : "None"}
                        empty={!d.labelIds.length}
                      >
                        {labels.length === 0 && <p className="m-0 px-2 py-2 text-[12.5px] text-fg-3">No labels in this project</p>}
                        {labels.map((l) => (
                          <MenuCheckboxItem
                            key={l.id}
                            checked={d.labelIds.includes(l.id)}
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={(c) => patch({ labelIds: c ? [...d.labelIds, l.id] : d.labelIds.filter((x) => x !== l.id) })}
                            icon={<span aria-hidden className="size-[7px] rounded-full" style={{ background: l.color }} />}
                          >
                            {l.name}
                          </MenuCheckboxItem>
                        ))}
                      </MoreField>
                      <MoreField label="Estimate" icon={<Timer size={14} strokeWidth={1.5} aria-hidden />} value={d.estimate ? `${d.estimate} pts` : "None"} empty={!d.estimate}>
                        <MenuRadioGroup value={String(d.estimate ?? "")} onValueChange={(v) => patch({ estimate: v ? Number(v) : null })}>
                          {ESTIMATES.map((n) => (
                            <MenuRadioItem key={n} value={String(n)}>
                              {n} {n === 1 ? "point" : "points"}
                            </MenuRadioItem>
                          ))}
                          <MenuRadioItem value="">None</MenuRadioItem>
                        </MenuRadioGroup>
                      </MoreField>
                    </div>
                    <label htmlFor="ct-desc" className="text-[12px] font-medium text-fg-3">
                      Description
                    </label>
                    <Textarea
                      id="ct-desc"
                      rows={3}
                      maxLength={4000}
                      placeholder="Add details…"
                      value={d.description}
                      onChange={(e) => patch({ description: e.target.value })}
                      className="mt-1.5 block min-h-[72px] resize-y"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-none items-center gap-2 border-t border-line py-2.5 pl-4 pr-3 max-[760px]:pb-[max(10px,env(safe-area-inset-bottom))]">
                <label className="-ml-1.5 flex h-[30px] cursor-pointer items-center gap-[9px] rounded-sm px-1.5 text-[12.5px] font-medium text-fg-2 hover:text-fg max-[760px]:h-11">
                  <Switch checked={another} onChange={(e) => setAnother(e.target.checked)} />
                  {mobile ? "Another" : "Create another"}
                </label>
                <span className="flex-1" />
                {!mobile && (
                  <Button variant="ghost" onClick={close}>
                    Cancel
                  </Button>
                )}
                <Button variant="primary" kbd={mobile ? undefined : "⌘↵"} loading={create.isPending} onClick={() => void submit()} aria-keyshortcuts="Meta+Enter Control+Enter" className={mobile ? "h-11" : undefined}>
                  {mobile ? "Create task" : "Create"}
                </Button>
              </div>
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

const chip =
  "inline-flex h-7 flex-none items-center gap-[7px] whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-2.5 text-[12.5px] font-medium text-fg transition-[border-color,background-color] duration-[var(--dur-fast)] hover:border-control hover:bg-hover data-[state=open]:border-control data-[state=open]:bg-hover disabled:cursor-default disabled:hover:border-line-2 disabled:hover:bg-raised";
const ghost = "border-dashed bg-transparent text-fg-3";

const moreBtn =
  "-ml-2 inline-flex h-7 min-w-0 max-w-[calc(100%+8px)] items-center gap-[7px] rounded-sm px-2 text-left text-[13px] font-medium text-fg transition-colors hover:bg-hover data-[state=open]:bg-hover max-[760px]:h-11 [&_svg]:flex-none [&_svg]:text-fg-3";

function MoreField({ label, icon, value, empty, children }: { label: string; icon: ReactNode; value: string; empty: boolean; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[84px_minmax(0,1fr)] items-center max-[760px]:min-h-11">
      <span className="text-[12px] font-medium text-fg-3">{label}</span>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label={`${label}: ${value}`} className={cn(moreBtn, empty && "text-fg-3")}>
            {icon}
            <span className="truncate">{value}</span>
          </button>
        </MenuTrigger>
        <MenuContent align="start" width={220} aria-label={label} className="max-h-[320px] overflow-y-auto">
          {children}
        </MenuContent>
      </Menu>
    </div>
  );
}
