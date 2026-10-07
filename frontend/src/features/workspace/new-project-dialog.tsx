"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { StatusGlyph } from "@/components/ui/glyphs";
import { Field, Input, Textarea } from "@/components/ui/input";
import { DialogClose, Modal, Sheet } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project, ProjectTemplate, Status } from "@/lib/api/types";
import { CATEGORY_LABEL, PROJECT_TEMPLATES, templateDef } from "@/lib/domain/project-templates";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { deriveKey, validateKey } from "./my-work";
import { useProjects } from "./queries";

/**
 * New project (board 24 "Create project"): name → key (2–5 A–Z, derived until edited, taken keys
 * flagged live), optional description, one of 4 workflow templates with a live status preview.
 * Opened by ?new-project=1; the caller gates it on project.create (the server checks too).
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (p: Project) => void;
}) {
  const ws = useCurrentWorkspace()!;
  const mobile = useIsMobile();
  const title = (
    <span className="flex items-center gap-2.5 pr-8">
      New project <span className="font-mono text-[12px] font-medium text-fg-3">{ws.name}</span>
    </span>
  );
  // Remount the form on every open so it starts clean.
  const body = open ? <NewProjectForm onDone={() => onOpenChange(false)} onCreated={onCreated} sheet={mobile} /> : null;
  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title="New project" height="auto" className="max-h-[92dvh]">
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-2 text-[16px] font-semibold">{title}</div>
        {body}
      </Sheet>
    );
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} width={640} className="gap-5">
      <DialogClose className="absolute right-4 top-4" />
      {body}
    </Modal>
  );
}

function NewProjectForm({ onDone, onCreated, sheet }: { onDone: () => void; onCreated?: (p: Project) => void; sheet: boolean }) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const qc = useQueryClient();
  const { data: projects = [] } = useProjects(ws.slug);
  const [name, setName] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("scrum");
  const [hover, setHover] = useState<ProjectTemplate | null>(null);
  const [tried, setTried] = useState(false);
  const [serverErr, setServerErr] = useState<{ name?: string; key?: string }>({});
  const tplRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const key = keyTouched ? keyInput : deriveKey(name);
  const keyProblem = validateKey(
    key,
    projects.map((p) => p.key),
  );
  const keyIsTaken = Boolean(keyProblem?.endsWith("is taken"));
  const showKeyErr = Boolean(keyProblem) && (tried || (keyTouched && key.length > 0) || keyIsTaken);
  const nameErr = tried && !name.trim() ? "Name required" : (serverErr.name ?? null);
  const keyErr = showKeyErr ? keyProblem : (serverErr.key ?? null);
  const shown = templateDef(hover ?? template);

  const create = useMutation({
    mutationFn: () => api.projects.create(ws.slug, { name: name.trim(), key, description: description.trim() || undefined, template }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      onCreated?.(p);
      onDone();
      toast({
        tone: "spark",
        title: `Created ${p.name}`,
        action: { label: "Open", key: "O", onClick: () => router.push(routes.project(ws.slug, p.key)) },
      });
    },
    onError: (e) => {
      if (isApiError(e) && Object.keys(e.fieldErrors).length) setServerErr(e.fieldErrors as { name?: string; key?: string });
      else toast.error("Couldn’t create the project", { body: errorMessage(e) });
    },
  });

  const submit = () => {
    setTried(true);
    if (!name.trim() || keyProblem || create.isPending) return;
    create.mutate();
  };

  const onTplKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + PROJECT_TEMPLATES.length) % PROJECT_TEMPLATES.length;
    setTemplate(PROJECT_TEMPLATES[n]!.id);
    setHover(null);
    tplRefs.current[n]?.focus();
  };

  const cats: Status["category"][] = ["todo", "in_progress", "done"];
  let delay = 0;

  return (
    <form
      noValidate
      className={cn("flex min-h-0 flex-col gap-4", sheet && "overflow-y-auto px-4 pb-6")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="flex flex-wrap items-start gap-3">
        <Field label="Name" error={nameErr} className="min-w-[200px] flex-[1_1_220px]">
          <Input
            autoFocus
            placeholder="Mobile Web"
            maxLength={60}
            autoComplete="off"
            value={name}
            onChange={(e) => {
              setName(e.target.value.slice(0, 60));
              setServerErr((s) => ({ ...s, name: undefined }));
            }}
          />
        </Field>
        <Field
          label="Key"
          error={keyErr}
          className="flex-[0_0_136px] max-[760px]:flex-[1_1_136px]"
          labelAction={<span className="font-mono text-[11px] leading-none text-fg-3">{/^[A-Z]{2,5}$/.test(key) ? `${key}-1` : "2–5 letters"}</span>}
        >
          <Input
            mono
            placeholder="KEY"
            maxLength={8}
            autoComplete="off"
            spellCheck={false}
            className="uppercase tracking-[0.04em]"
            value={key}
            onChange={(e) => {
              const v = e.target.value.toUpperCase().replace(/\s+/g, "").slice(0, 8);
              setKeyInput(v);
              setKeyTouched(v.length > 0);
              setServerErr((s) => ({ ...s, key: undefined }));
            }}
          />
        </Field>
      </div>

      <Field label="Description" labelAction={<span className="text-meta leading-none text-fg-3">optional</span>}>
        <Textarea rows={2} maxLength={280} className="min-h-14" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 280))} />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span id="np-workflow" className="text-meta font-medium text-fg-2">
          Workflow
        </span>
        <div role="radiogroup" aria-labelledby="np-workflow" className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2" onMouseLeave={() => setHover(null)}>
          {PROJECT_TEMPLATES.map((t, i) => {
            const on = t.id === template;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tplRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => {
                  setTemplate(t.id);
                  setHover(null);
                }}
                onMouseEnter={() => setHover(t.id)}
                onKeyDown={(e) => onTplKey(e, i)}
                className={cn(
                  "flex min-w-0 flex-col items-start gap-2.5 rounded-[10px] border border-line-2 bg-bg p-3 text-left transition-[border-color,background-color,box-shadow] duration-[120ms] hover:border-control",
                  on && "border-accent bg-accent-s shadow-[inset_0_0_0_1px_var(--accent)] hover:border-accent",
                )}
              >
                <span className="flex gap-1" aria-hidden>
                  {t.statuses.map((s) => (
                    <StatusGlyph key={s.glyph} kind={s.glyph} />
                  ))}
                </span>
                <span className="text-[13px] font-semibold leading-4">{t.name}</span>
                <span className="font-mono text-[11px] leading-none text-fg-3">{t.meta}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        aria-live="polite"
        aria-label={`${shown.name} creates ${cats.map((c) => shown.statuses.filter((s) => s.category === c).map((s) => s.name).join(", ")).join("; ")}`}
        className="grid grid-cols-3 gap-2.5 rounded-[10px] border border-line bg-bg p-3"
      >
        {cats.map((c) => (
          <div key={c} className="flex min-w-0 flex-col gap-1.5">
            <span className="border-b border-line px-0.5 pb-[7px] pt-0.5 font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.06em] text-fg-3">
              {CATEGORY_LABEL[c]}
            </span>
            {shown.statuses
              .filter((s) => s.category === c)
              .map((s) => {
                delay += 40;
                return (
                  <span
                    key={`${shown.id}-${s.glyph}`}
                    className="flex h-[30px] items-center gap-2 overflow-hidden whitespace-nowrap rounded-[7px] border border-line bg-surface px-[9px] text-[12.5px] font-medium motion-safe:animate-[rise-in_240ms_var(--ease)_both] max-[760px]:px-[7px] max-[760px]:text-[12px]"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    <StatusGlyph kind={s.glyph} />
                    <span className="truncate">{s.name}</span>
                  </span>
                );
              })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">
          {shown.name} · {shown.statuses.length} statuses
        </span>
        <Button variant="ghost" kbd="Esc" onClick={onDone} className="max-[760px]:[&_.kbd]:hidden">
          Cancel
        </Button>
        <Button type="submit" variant="primary" kbd="⌘↵" loading={create.isPending} className="max-[760px]:[&_.kbd]:hidden">
          Create project
        </Button>
      </div>
    </form>
  );
}
