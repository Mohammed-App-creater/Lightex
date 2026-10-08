"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { DatePicker } from "@/components/ui/date-picker";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { SidePanel } from "@/components/ui/side-panel";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/features/auth/session";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { Milestone, Objective, ProjectMember, Status, Task } from "@/lib/api/types";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { matchTask } from "./helpers";
import { useSaveMilestone, useSaveObjective } from "./queries";

const schema = z.object({
  title: z.string().trim().min(1, "Add a title").max(120, "Keep titles under 120 characters"),
  ownerId: z.string(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  description: z.string().max(1000, "Keep descriptions under 1000 characters"),
  taskIds: z.array(z.string()),
});
type Values = z.infer<typeof schema>;

export type PanelState =
  | { kind: "objective"; item: Objective | null }
  | { kind: "milestone"; item: Milestone | null };

/** Create / edit side panel for an objective or milestone (board 16 §1.9). 400px; sheet on mobile. */
export function GoalPanel({
  state,
  onClose,
  onSaved,
  projectId,
  members,
  tasks,
  statuses,
}: {
  state: PanelState;
  onClose: () => void;
  onSaved: (kind: PanelState["kind"], id: string, created: boolean) => void;
  projectId: string;
  members: ProjectMember[];
  tasks: Task[];
  statuses: Status[];
}) {
  const isMobile = useIsMobile();
  const label = `${state.item ? "Edit" : "New"} ${state.kind}`;
  return (
    <>
      {!isMobile && (
        <div
          aria-hidden
          onClick={onClose}
          className="fixed inset-0 z-[39] bg-scrim backdrop-blur-[4px] animate-[fade-in_200ms_var(--ease)]"
        />
      )}
      <SidePanel open onClose={onClose} label={label} width={400} className="max-[1023px]:w-[360px]">
        <PanelForm
          key={`${state.kind}-${state.item?.id ?? "new"}`}
          state={state}
          title={label}
          onClose={onClose}
          onSaved={onSaved}
          projectId={projectId}
          members={members}
          tasks={tasks}
          statuses={statuses}
        />
      </SidePanel>
    </>
  );
}

function PanelForm({
  state,
  title,
  onClose,
  onSaved,
  projectId,
  members,
  tasks,
  statuses,
}: {
  state: PanelState;
  title: string;
  onClose: () => void;
  onSaved: (kind: PanelState["kind"], id: string, created: boolean) => void;
  projectId: string;
  members: ProjectMember[];
  tasks: Task[];
  statuses: Status[];
}) {
  const { user } = useSession();
  const saveObjective = useSaveObjective(projectId);
  const saveMilestone = useSaveMilestone(projectId);
  const isMilestone = state.kind === "milestone";
  const item = state.item;
  const defaultOwner =
    item?.ownerId ?? (members.some((m) => m.userId === user?.id) ? (user?.id ?? "") : (members[0]?.userId ?? ""));

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: item ? ("name" in item ? item.name : item.title) : "",
      ownerId: defaultOwner,
      dueDate: item?.dueDate ?? "",
      description: item?.description ?? "",
      taskIds: isMilestone && item ? tasks.filter((t) => t.milestoneId === item.id).map((t) => t.id) : [],
    },
  });
  const errors = form.formState.errors;
  const saving = saveObjective.isPending || saveMilestone.isPending;

  const submit = form.handleSubmit(async (v) => {
    const base = { ownerId: v.ownerId || null, dueDate: v.dueDate, description: v.description.trim() };
    try {
      const saved =
        state.kind === "objective"
          ? await saveObjective.mutateAsync({ id: item?.id, body: { ...base, title: v.title.trim() } })
          : await saveMilestone.mutateAsync({ id: item?.id, body: { ...base, name: v.title.trim(), taskIds: v.taskIds } });
      onSaved(state.kind, saved.id, !item);
    } catch (e) {
      if (isApiError(e) && Object.keys(e.fieldErrors).length) {
        const fe = e.fieldErrors;
        if (fe.title || fe.name) form.setError("title", { message: fe.title ?? fe.name });
        if (fe.dueDate) form.setError("dueDate", { message: fe.dueDate });
      } else {
        toast.error(item ? `Couldn’t save the ${state.kind}` : `Couldn’t create the ${state.kind}`, { body: errorMessage(e) });
      }
    }
  });

  // ⌘/Ctrl+Enter saves from anywhere while the panel is open (focus may sit on the panel itself).
  // Skipped while a save is in flight, so a held or repeated ⌘↵ can't create duplicates.
  const submitRef = useRef(submit);
  const savingRef = useRef(saving);
  const inFlight = useRef(false);
  useEffect(() => {
    submitRef.current = submit;
    savingRef.current = saving;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (e.repeat || inFlight.current || savingRef.current) return;
        inFlight.current = true;
        void submitRef.current().finally(() => {
          inFlight.current = false;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    // The side panel focuses itself on open; move focus on to the title field.
    const id = setTimeout(() => form.setFocus("title"), 60);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(id);
    };
  }, [form]);

  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex h-[52px] flex-none items-center gap-2 border-b border-line pl-5 pr-2.5">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">{title}</h2>
        <Kbd className="max-[760px]:hidden">Esc</Kbd>
        <Button variant="ghost" icon size="sm" aria-label="Close" onClick={onClose} className="max-[760px]:size-11">
          <X size={14} aria-hidden />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
        <Field label="Title" error={errors.title?.message}>
          <Input
            autoFocus
            maxLength={120}
            placeholder={isMilestone ? "e.g. Public launch" : "e.g. Cut p95 latency to 200ms"}
            {...form.register("title")}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
          <Controller
            control={form.control}
            name="ownerId"
            render={({ field }) => (
              <Select
                label="Owner"
                value={field.value || null}
                onChange={field.onChange}
                placeholder="No owner"
                width={220}
                options={members.map((m) => ({
                  value: m.userId,
                  label: m.user.name,
                  icon: <Avatar name={m.user.name} hue={m.user.hue} size={18} ring={false} decorative />,
                }))}
              />
            )}
          />
          <Controller
            control={form.control}
            name="dueDate"
            render={({ field }) => (
              <Field label={isMilestone ? "Date" : "Target date"} error={errors.dueDate?.message}>
                <DatePicker
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onChange={(v) => field.onChange(v ?? "")}
                  onBlur={field.onBlur}
                />
              </Field>
            )}
          />
        </div>
        <Field label="Description" error={errors.description?.message}>
          <Textarea
            placeholder="Optional"
            maxLength={1000}
            className="h-[84px] min-h-[84px] resize-none"
            {...form.register("description")}
          />
        </Field>
        {isMilestone && (
          <Controller
            control={form.control}
            name="taskIds"
            render={({ field }) => (
              <TaskChecklist
                tasks={tasks}
                statuses={statuses}
                value={field.value}
                onChange={field.onChange}
                milestoneId={item?.id}
              />
            )}
          />
        )}
      </div>
      <footer className="flex flex-none items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} kbd="⌘↵">
          {item ? "Save" : "Create"}
        </Button>
      </footer>
    </form>
  );
}

function TaskChecklist({
  tasks,
  statuses,
  value,
  onChange,
  milestoneId,
}: {
  tasks: Task[];
  statuses: Status[];
  value: string[];
  onChange: (v: string[]) => void;
  milestoneId?: string;
}) {
  const [q, setQ] = useState("");
  const glyphOf = useMemo(() => new Map(statuses.map((s) => [s.id, s.glyph])), [statuses]);
  const shown = tasks.filter((t) => matchTask(t, q)).sort((a, b) => a.number - b.number);
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 flex items-center gap-2 p-0 text-meta font-medium text-fg-2">
        Linked tasks <span className="font-mono text-[11px] text-fg-3">{value.length}</span>
      </legend>
      {tasks.length > 8 && (
        <Input inputSize="sm" placeholder="Search tasks…" aria-label="Search tasks" value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} />
      )}
      <div className="max-h-[184px] overflow-y-auto rounded-md border border-line-2 bg-bg p-1">
        {shown.length === 0 && <p className="m-0 px-2 py-2.5 text-[12px] text-fg-3">No tasks match</p>}
        {shown.map((t) => {
          const checked = value.includes(t.id);
          const elsewhere = Boolean(t.milestoneId && t.milestoneId !== milestoneId);
          return (
            <label
              key={t.id}
              className="flex min-h-8 cursor-pointer items-center gap-[9px] rounded-sm px-2 text-[13px] hover:bg-hover max-[760px]:min-h-11"
              title={elsewhere && !checked ? "Linked to another milestone; checking moves it here" : undefined}
            >
              <Checkbox
                checked={checked}
                onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))}
              />
              <StatusGlyph kind={glyphOf.get(t.statusId) ?? "todo"} />
              <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3">{t.key}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
