"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { confirmState } from "./lib";
import { FactChips } from "./project-parts";
import { hueName, PROJECT_DESC_MAX, PROJECT_HUES, projectKeyError, projectNameError, sanitizeKey } from "./project-lib";
import { SaveBar, type SaveState } from "./save-bar";
import { useLeaveGuard } from "./use-leave-guard";

type Draft = { name: string; key: string; description: string; hue: number };
const draftOf = (p: Project): Draft => ({ name: p.name, key: p.key, description: p.description, hue: p.hue });

/** Settings row (board 28 .st-row): 150px heading + controls (stacks below 760px). */
function Row({ title, children, first, danger }: { title: string; children: React.ReactNode; first?: boolean; danger?: boolean }) {
  return (
    <section
      aria-label={title}
      className={cn(
        "grid grid-cols-[150px_minmax(0,1fr)] gap-x-8 gap-y-2.5 border-t border-line py-5 max-[760px]:grid-cols-1 max-[760px]:py-4",
        first && "border-t-0 pt-1",
      )}
    >
      <h3 className={cn("m-0 text-[13px] font-semibold leading-8 max-[760px]:leading-[18px]", danger && "text-danger")}>{title}</h3>
      <div className="flex min-w-0 max-w-[560px] flex-col gap-3.5">{children}</div>
    </section>
  );
}

export function GeneralPanel({
  project,
  canEdit,
  canArchive,
  canDelete,
  onDeleted,
}: {
  project: Project;
  canEdit: boolean;
  canArchive: boolean;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  return (
    <div className="flex flex-col">
      {canEdit ? <GeneralEdit key={`${project.id}-${project.key}`} project={project} /> : <GeneralReadOnly project={project} />}
      {(canArchive || canDelete) && (
        <DangerZone project={project} canArchive={canArchive && project.status !== "archived"} canDelete={canDelete} onDeleted={onDeleted} />
      )}
    </div>
  );
}

/* ───────────────────────── Edit ───────────────────────── */

function GeneralEdit({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(project));
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [serverErr, setServerErr] = useState<Record<string, string>>({});
  const [shake, setShake] = useState(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const saved = draftOf(project);
  const dirty = (Object.keys(saved) as (keyof Draft)[]).some((k) => saved[k] !== draft[k]);
  const nameErr = projectNameError(draft.name);
  const keyErr = projectKeyError(draft.key);
  const invalid = Boolean(nameErr || keyErr);
  const state: SaveState =
    phase === "saving" ? "saving" : phase === "error" && dirty ? "error" : dirty ? (invalid ? "invalid" : "dirty") : phase === "saved" ? "saved" : "idle";
  useLeaveGuard(dirty && phase !== "saving", () => setShake((s) => s + 1));

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerErr({});
    if (phase === "saved" || phase === "error") setPhase("idle");
  };

  const save = async () => {
    if (!dirty || invalid || phase === "saving") return;
    setPhase("saving");
    try {
      const body: Partial<Draft> = {};
      if (draft.name.trim() !== project.name) body.name = draft.name.trim();
      if (draft.key !== project.key) body.key = draft.key;
      if (draft.description !== project.description) body.description = draft.description;
      if (draft.hue !== project.hue) body.hue = draft.hue;
      const next = await api.projects.update(project.id, body);
      qc.setQueryData(qk.project(ws.slug, next.key), next);
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      void qc.invalidateQueries({ queryKey: qk.directory(ws.slug) });
      setPhase("saved");
      savedTimer.current = setTimeout(() => setPhase((p) => (p === "saved" ? "idle" : p)), 2000);
      if (next.key !== project.key) {
        void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
        router.replace(`${routes.project(ws.slug, next.key, "settings")}${window.location.search}`);
      } else {
        void qc.invalidateQueries({ queryKey: qk.project(ws.slug, project.key) });
      }
    } catch (e) {
      if (isApiError(e) && Object.keys(e.fieldErrors).length) {
        setServerErr(e.fieldErrors);
        setPhase("idle");
      } else {
        setPhase("error");
        toast.error("Couldn’t save project", { body: errorMessage(e) });
      }
    }
  };

  const keyChanged = draft.key !== project.key;
  const keyHelp = serverErr.key ?? keyErr ?? (keyChanged ? `${project.key}-123 → ${draft.key}-123` : `${draft.key}-123`);
  const keyTone = serverErr.key || keyErr ? "text-danger" : keyChanged ? "text-ok" : "text-fg-3";

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Row title="Identity" first>
        <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-3.5 max-[760px]:grid-cols-[minmax(0,1fr)_108px]">
          <Field label="Name" error={serverErr.name ?? (draft.name !== project.name ? nameErr : null)}>
            <Input value={draft.name} maxLength={48} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ps-key" className="text-meta font-medium text-fg-2">
              Key
            </label>
            <Input
              id="ps-key"
              mono
              value={draft.key}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={keyErr || serverErr.key ? true : undefined}
              aria-describedby="ps-key-h"
              className="tracking-[0.04em]"
              onChange={(e) => set({ key: sanitizeKey(e.target.value) })}
            />
            <span id="ps-key-h" role={keyErr || serverErr.key ? "alert" : undefined} className={cn("min-h-4 font-mono text-[11px] leading-4", keyTone)}>
              {keyHelp}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ps-desc" className="text-meta font-medium text-fg-2">
            Description
          </label>
          <Textarea
            id="ps-desc"
            rows={3}
            value={draft.description}
            maxLength={PROJECT_DESC_MAX}
            placeholder="What is this project for?"
            aria-describedby="ps-desc-h"
            onChange={(e) => set({ description: e.target.value.slice(0, PROJECT_DESC_MAX) })}
          />
          <span id="ps-desc-h" className="ml-auto font-mono text-[11px] text-fg-3">
            {draft.description.length}/{PROJECT_DESC_MAX}
          </span>
        </div>
      </Row>
      <Row title="Icon color">
        <div className="flex flex-wrap items-center gap-4">
          <BigBadge code={draft.key || "?"} hue={draft.hue} />
          <HueSwatches value={draft.hue} onChange={(hue) => set({ hue })} />
        </div>
      </Row>
      <SaveBar state={state} shake={shake} onSave={() => void save()} onDiscard={() => (setDraft(draftOf(project)), setServerErr({}), setPhase("idle"))} />
    </form>
  );
}

/** Project icon hue swatches (board 28 .ps-sws): radiogroup with arrow-key roving focus. */
function HueSwatches({ value, onChange }: { value: number; onChange: (hue: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = PROJECT_HUES.findIndex((h) => h.hue === value);
  return (
    <div role="radiogroup" aria-label="Icon color" className="flex flex-wrap items-center gap-2">
      {PROJECT_HUES.map((h, i) => {
        const on = h.hue === value;
        return (
          <button
            key={h.hue}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={h.name}
            tabIndex={on || (idx < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(h.hue)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const n = (i + step + PROJECT_HUES.length) % PROJECT_HUES.length;
              refs.current[n]?.focus();
              onChange(PROJECT_HUES[n]!.hue);
            }}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md transition-transform duration-150 hover:scale-[1.08] max-[760px]:size-10 max-[760px]:rounded-[10px]",
              on && "shadow-[0_0_0_2px_var(--bg),0_0_0_4px_oklch(0.68_0.14_var(--h))]",
            )}
            style={
              {
                "--h": h.hue,
                background: `oklch(var(--pk-l) var(--pk-c) ${h.hue})`,
                color: `oklch(var(--pkt-l) var(--pkt-c) ${h.hue})`,
              } as React.CSSProperties
            }
          >
            {on && <Check size={13} strokeWidth={2.2} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/** 48px project badge (board 28 .ps-badge). */
function BigBadge({ code, hue }: { code: string; hue: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-12 flex-none items-center justify-center rounded-lg font-mono text-[12.5px] font-semibold tracking-[0.02em]"
      style={{ background: `oklch(var(--pk-l) var(--pk-c) ${hue})`, color: `oklch(var(--pkt-l) var(--pkt-c) ${hue})` }}
    >
      {code.slice(0, 5)}
    </span>
  );
}

/* ───────────────────────── Read-only ───────────────────────── */

function GeneralReadOnly({ project }: { project: Project }) {
  return (
    <div className="flex flex-col">
      <Row title="Identity" first>
        <div className="flex min-h-[34px] items-center gap-3">
          <BigBadge code={project.key} hue={project.hue} />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-meta font-medium text-fg-2">Name</span>
            <span className="truncate text-[14px] font-medium">{project.name}</span>
          </span>
        </div>
        <span className="flex flex-col gap-1">
          <span className="text-meta font-medium text-fg-2">Key</span>
          <span>
            <code className="rounded-xs border border-line bg-raised px-1.5 py-px font-mono text-[12px]">{project.key}</code>
            <span className="ml-2 font-mono text-[11px] text-fg-3">{project.key}-123</span>
          </span>
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-meta font-medium text-fg-2">Description</span>
          <span className="text-[14px] leading-5 text-fg-2">{project.description || "No description"}</span>
        </span>
      </Row>
      <Row title="Icon color">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="size-7 rounded-md" style={{ background: `oklch(var(--pk-l) var(--pk-c) ${project.hue})` }} />
          <span className="text-[13px] font-medium">{hueName(project.hue)}</span>
        </div>
      </Row>
    </div>
  );
}

/* ───────────────────────── Danger zone ───────────────────────── */

function DangerZone({
  project,
  canArchive,
  canDelete,
  onDeleted,
}: {
  project: Project;
  canArchive: boolean;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const st = confirmState(text, project.key);
  if (!canArchive && !canDelete) return null;

  const close = () => {
    if (busy) return;
    setDialog(null);
    setText("");
  };

  const archive = async () => {
    setBusy(true);
    try {
      const next = await api.projects.archive(project.id);
      qc.setQueryData(qk.project(ws.slug, project.key), next);
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      void qc.invalidateQueries({ queryKey: qk.directory(ws.slug) });
      toast.success(`Archived ${project.name}`);
      setDialog(null);
    } catch (e) {
      toast.error("Couldn’t archive", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (st !== "match" || busy) return;
    setBusy(true);
    try {
      await api.projects.remove(project.id, text);
      // Keep the cached project so the screen can show the "moved to Trash" state.
      void qc.invalidateQueries({ queryKey: qk.projects(ws.slug) });
      void qc.invalidateQueries({ queryKey: qk.directory(ws.slug) });
      void qc.invalidateQueries({ queryKey: qk.trash(ws.slug) });
      setDialog(null);
      setText("");
      onDeleted();
    } catch (e) {
      toast.error("Couldn’t delete project", { body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row title="Danger zone" danger>
      <div className="overflow-hidden rounded-lg border border-danger bg-surface">
        {canArchive && (
          <div className="flex items-center gap-4 px-4 py-3.5 max-[760px]:flex-wrap">
            <div className="min-w-0 flex-1">
              <h4 className="m-0 mb-1 text-[13px] font-semibold">Archive project</h4>
              <p className="m-0 font-mono text-[11.5px] text-fg-3">Read-only · restorable</p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setDialog("archive")}>
              Archive
            </Button>
          </div>
        )}
        {canDelete && (
          <div className={cn("flex items-center gap-4 px-4 py-3.5 max-[760px]:flex-wrap", canArchive && "border-t border-line")}>
            <div className="min-w-0 flex-1">
              <h4 className="m-0 mb-1 text-[13px] font-semibold">Delete project</h4>
              <p className="m-0 font-mono text-[11.5px] text-fg-3">
                {project.openTaskCount} open tasks · {project.memberCount} members
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setDialog("delete")}>
              Delete project
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={dialog === "archive"}
        onOpenChange={(o) => !o && close()}
        role="alertdialog"
        width={420}
        title={`Archive ${project.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" autoFocus loading={busy} onClick={() => void archive()}>
              Archive
            </Button>
          </>
        }
      >
        <FactChips items={["Read-only", "Hidden from sidebar", "Restorable"]} />
      </Modal>

      <Modal
        open={dialog === "delete"}
        onOpenChange={(o) => !o && close()}
        role="alertdialog"
        width={420}
        title={`Delete ${project.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabledReason={st === "match" ? undefined : `Type ${project.key} to enable Delete`}
              onClick={() => void del()}
            >
              Delete project
            </Button>
          </>
        }
      >
        <FactChips items={[`${project.openTaskCount} open tasks`, `${project.memberCount} members`, "Trash · 30 days"]} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ps-del-confirm" className="text-meta font-medium text-fg-2">
            Type <code className="rounded-xs border border-line bg-raised px-1.5 py-px font-mono text-[12px] text-fg">{project.key}</code> to confirm
          </label>
          <Input
            id="ps-del-confirm"
            mono
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={text}
            maxLength={8}
            aria-invalid={st === "mismatch" ? true : undefined}
            aria-describedby="ps-del-why"
            onChange={(e) => setText(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void del();
              }
            }}
          />
          <span
            id="ps-del-why"
            role="status"
            className={cn("flex items-center gap-1.5 text-[12px]", st === "match" ? "text-ok" : st === "mismatch" ? "text-danger" : "text-fg-3")}
          >
            {st === "mismatch" && <TriangleAlert size={12} aria-hidden />}
            {st === "empty" ? "Type the key to enable Delete" : st === "prefix" ? "Keep typing" : st === "match" ? "Matches" : `Doesn’t match ${project.key}`}
          </span>
        </div>
      </Modal>
    </Row>
  );
}
