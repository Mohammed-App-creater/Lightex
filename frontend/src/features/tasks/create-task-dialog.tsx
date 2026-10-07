"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Avatar, ProjectBadge, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PriorityIcon, StatusGlyph, priorityMeta, type PriorityLevel } from "@/components/ui/glyphs";
import { Field, Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { shell, useShell, type CreateTaskDefaults } from "@/components/shell/shell-state";
import { useSession } from "@/features/auth/session";
import { useProjectMembers, useStatuses } from "@/features/projects/queries";
import { useProjects } from "@/features/workspace/queries";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Priority } from "@/lib/api/types";
import { can, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes, useRouteInfo } from "@/lib/routes";
import { useCreateTask } from "./mutations";

const schema = z.object({
  projectId: z.string().min(1, "Pick a project"),
  title: z.string().trim().min(1, "Give the task a title").max(200, "Keep titles under 200 characters"),
  statusId: z.string().min(1),
  priority: z.enum(["0", "1", "2", "3", "4"]),
  assigneeId: z.string(),
});
type Values = z.infer<typeof schema>;

export function CreateTaskDialog() {
  const { createTask } = useShell();
  return createTask ? <Inner defaults={createTask} /> : null;
}

function Inner({ defaults }: { defaults: CreateTaskDefaults }) {
  const ws = useCurrentWorkspace()!;
  const { user } = useSession();
  const router = useRouter();
  const route = useRouteInfo();
  const { data: projects = [] } = useProjects(ws.slug);
  const allowed = useMemo(() => projects.filter((p) => can("task.create", p.my_permissions)), [projects]);
  const initialProject =
    defaults.projectId ?? allowed.find((p) => p.key === route.projectKey)?.id ?? allowed[0]?.id ?? "";

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { projectId: initialProject, title: defaults.title ?? "", statusId: defaults.statusId ?? "", priority: "0", assigneeId: "" },
  });
  const projectId = useWatch({ control: form.control, name: "projectId" });
  const project = allowed.find((p) => p.id === projectId);
  const { data: statuses = [] } = useStatuses(projectId || undefined);
  const { data: members = [] } = useProjectMembers(projectId || undefined);
  const canAssign = can("task.assign", project?.my_permissions);
  const create = useCreateTask();

  // Default the status to Todo once the project's statuses load (or after switching project).
  const statusId = useWatch({ control: form.control, name: "statusId" });
  useEffect(() => {
    if (!statuses.length) return;
    if (!statuses.some((s) => s.id === statusId)) {
      const todo = statuses.find((s) => s.glyph === "todo") ?? statuses[0]!;
      form.setValue("statusId", defaults.statusId && statuses.some((s) => s.id === defaults.statusId) ? defaults.statusId : todo.id);
    }
  }, [statuses, statusId, form, defaults.statusId]);

  const close = () => shell.closeCreateTask();

  const submit = form.handleSubmit(async (v) => {
    try {
      const task = await create.mutateAsync({
        projectId: v.projectId,
        body: {
          title: v.title,
          statusId: v.statusId,
          priority: Number(v.priority) as Priority,
          assigneeId: v.assigneeId || null,
          parentId: defaults.parentId,
          sprintId: defaults.sprintId,
        },
      });
      close();
      const p = allowed.find((x) => x.id === task.projectId);
      toast({
        tone: "spark",
        title: `${task.key} created`,
        body: task.title.slice(0, 60),
        action: p
          ? {
              label: "Open",
              key: "O",
              onClick: () => router.push(`${routes.project(ws.slug, p.key, route.view && route.view !== "overview" ? route.view : "board")}?task=${task.key}`),
            }
          : undefined,
      });
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.title) form.setError("title", { message: e.fieldErrors.title });
      else toast.error("Couldn’t create the task", { body: errorMessage(e) });
    }
  });

  if (!allowed.length) {
    return (
      <Modal open onOpenChange={(o) => !o && close()} title="New task" description="You can’t create tasks in any project yet. Ask a project admin to give you a role with “Create tasks”.">
        <div className="flex justify-end">
          <Button onClick={close}>Close</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={defaults.parentId ? "New sub-task" : "New task"} width={520}>
      <form
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <Field label="Title" error={form.formState.errors.title?.message}>
          <Input autoFocus placeholder="What needs doing?" maxLength={200} {...form.register("title")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Controller
            control={form.control}
            name="projectId"
            render={({ field }) => (
              <Select
                label="Project"
                value={field.value}
                onChange={(v) => {
                  field.onChange(v);
                  form.setValue("assigneeId", "");
                }}
                disabled={Boolean(defaults.parentId)}
                options={allowed.map((p) => ({ value: p.id, label: p.name, icon: <ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={18} /> }))}
              />
            )}
          />
          <Controller
            control={form.control}
            name="statusId"
            render={({ field }) => (
              <Select
                label="Status"
                value={field.value || null}
                onChange={field.onChange}
                options={statuses.map((s, i) => ({ value: s.id, label: s.name, icon: <StatusGlyph kind={s.glyph} />, keys: [String(i + 1)] }))}
              />
            )}
          />
          <Controller
            control={form.control}
            name="priority"
            render={({ field }) => (
              <Select
                label="Priority"
                value={field.value}
                onChange={field.onChange}
                options={([4, 3, 2, 1, 0] as PriorityLevel[]).map((p) => ({ value: String(p) as Values["priority"], label: priorityMeta[p].label, icon: <PriorityIcon level={p} /> }))}
              />
            )}
          />
          {canAssign ? (
            <Controller
              control={form.control}
              name="assigneeId"
              render={({ field }) => (
                <Select
                  label="Assignee"
                  value={field.value || "none"}
                  onChange={(v) => field.onChange(v === "none" ? "" : v)}
                  options={[
                    { value: "none", label: "Unassigned", icon: <UnassignedAvatar size={20} /> },
                    ...members.map((m) => ({ value: m.userId, label: m.userId === user?.id ? `${m.user.name} (me)` : m.user.name, icon: <Avatar name={m.user.name} hue={m.user.hue} size={20} decorative /> })),
                  ]}
                />
              )}
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-2">Assignee</span>
              <span className="flex h-8 items-center gap-2 text-[13px] text-fg-3">Unassigned · your role can’t assign tasks</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" kbd="Esc" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" kbd="⌘↵" loading={create.isPending}>
            Create task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
