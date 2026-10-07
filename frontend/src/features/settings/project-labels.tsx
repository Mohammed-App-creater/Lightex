"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus, Tag, Trash2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { useLabels } from "@/features/projects/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Label, Project } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ColorPicker, LabelPill, PanelHeader } from "./project-parts";
import { LABEL_NAME_MAX, labelNameError, nextFreeColor, tasksLabel } from "./project-lib";
import { NameInput } from "./project-workflow";

const GRID = "grid grid-cols-[40px_minmax(0,1fr)_88px_40px] items-center px-1.5 max-[760px]:grid-cols-[44px_minmax(0,1fr)_44px_44px]";

/** Labels tab (board 28): click a name to rename, the dot to recolor. */
export function LabelsPanel({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const labels = useLabels(project.id);
  const [draft, setDraft] = useState<{ name: string; color: string; submitted: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [removing, setRemoving] = useState<Label | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const key = qk.labels(project.id);
  const list = labels.data ?? [];

  const write = async (optimistic: Label[] | null, call: () => Promise<unknown>, failMsg: string) => {
    const prev = qc.getQueryData<Label[]>(key);
    if (optimistic) qc.setQueryData(key, optimistic);
    try {
      await call();
      return true;
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      toast.error(failMsg, { body: errorMessage(e) });
      return false;
    } finally {
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const create = async () => {
    if (!draft || creating) return;
    const err = labelNameError(draft.name, list, undefined, true);
    if (err) return setDraft({ ...draft, submitted: true });
    setCreating(true);
    try {
      const l = await api.projects.createLabel(project.id, draft.name.trim(), draft.color);
      setDraft(null);
      setFresh(l.id);
      toast.success(`Created ${l.name}`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.name) setDraft({ ...draft, submitted: true });
      toast.error("Couldn’t create label", { body: errorMessage(e) });
    } finally {
      setCreating(false);
    }
  };

  const rename = async () => {
    const ed = editing;
    setEditing(null);
    if (!ed) return;
    const l = list.find((x) => x.id === ed.id);
    const name = ed.value.trim();
    if (!l || !name || name === l.name || labelNameError(name, list, l.id)) return;
    await write(
      list.map((x) => (x.id === l.id ? { ...x, name } : x)),
      () => api.projects.updateLabel(project.id, l.id, { name }),
      "Couldn’t rename label",
    );
  };

  const recolor = (l: Label, color: string) =>
    void write(
      list.map((x) => (x.id === l.id ? { ...x, color } : x)),
      () => api.projects.updateLabel(project.id, l.id, { color }),
      "Couldn’t change color",
    );

  const remove = async (l: Label) => {
    const ok = await write(
      list.filter((x) => x.id !== l.id),
      () => api.projects.removeLabel(project.id, l.id),
      "Couldn’t delete label",
    );
    if (ok) {
      toast.success(`Deleted ${l.name}`);
      void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
    }
  };

  const draftErr = draft ? labelNameError(draft.name, list, undefined, draft.submitted) : null;

  return (
    <div className="flex flex-col">
      <PanelHeader title="Labels" count={labels.data ? list.length : undefined}>
        {canEdit && !draft && labels.isSuccess && (
          <Button variant="primary" size="sm" onClick={() => setDraft({ name: "", color: nextFreeColor(list), submitted: false })}>
            <Plus size={12} aria-hidden /> New label
          </Button>
        )}
      </PanelHeader>

      {labels.isPending ? (
        <div role="status" aria-busy="true" aria-label="Loading labels" className="rounded-lg border border-line bg-surface">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={cn(GRID, "h-[46px] border-b border-line last:border-b-0")}>
              <span className="flex justify-center">
                <Skeleton className="size-3 rounded-full" />
              </span>
              <Skeleton className="h-[22px] rounded-[6px]" style={{ width: 70 + ((i * 23) % 50) }} />
              <span className="flex justify-end pr-3">
                <Skeleton className="h-2.5 w-5" />
              </span>
            </div>
          ))}
        </div>
      ) : labels.isError ? (
        <ErrorState title="Couldn’t load labels" body={errorMessage(labels.error)} onRetry={() => void labels.refetch()} />
      ) : list.length === 0 && !draft ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-2 px-4 py-11 text-center">
          <span className="inline-flex size-10 items-center justify-center rounded-lg border border-line bg-raised text-fg-2">
            <Tag size={18} aria-hidden />
          </span>
          <h3 className="m-0 mt-1 text-[14px] font-semibold">No labels yet</h3>
          <span className="font-mono text-[11px] text-fg-3">{canEdit ? "Bug · Feature · Docs" : "A project admin can add labels"}</span>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-surface" role="table" aria-label="Labels">
          <div role="row" className={cn(GRID, "h-[34px] border-b border-line font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-fg-3")}>
            <span role="columnheader">
              <span className="sr-only">Color</span>
            </span>
            <span role="columnheader" className="pl-1.5">
              Label
            </span>
            <span role="columnheader" className="pr-3 text-right">
              Tasks
            </span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {draft && (
            <div role="row" className={cn(GRID, "h-[46px] border-b border-line bg-accent-s max-[760px]:h-auto max-[760px]:min-h-[54px] max-[760px]:flex-wrap max-[760px]:py-1.5")}>
              <span role="cell" className="flex justify-center">
                <ColorPicker value={draft.color} align="start" label="New label color" onChange={(color) => setDraft({ ...draft, color })} />
              </span>
              <span role="cell" className="flex min-w-0 items-center pr-2">
                <input
                  autoFocus
                  type="text"
                  value={draft.name}
                  placeholder="Label name"
                  aria-label="New label name"
                  aria-invalid={draftErr ? true : undefined}
                  aria-describedby="lb-new-h"
                  maxLength={LABEL_NAME_MAX}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value, submitted: false })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void create();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setDraft(null);
                    }
                  }}
                  className={cn(
                    "h-7 min-w-0 flex-1 rounded-sm border border-accent bg-bg px-1.5 text-[13px] font-medium text-fg shadow-[0_0_0_3px_var(--accent-s)] outline-none placeholder:text-fg-3 max-[760px]:h-[38px] max-[760px]:text-[15px]",
                    draftErr && "border-danger",
                  )}
                />
              </span>
              <span role="cell" className="col-span-2 flex items-center justify-end gap-1 pr-0.5">
                <span id="lb-new-h" role={draftErr ? "alert" : undefined} className="mr-1 whitespace-nowrap text-[12px] text-danger">
                  {draftErr}
                </span>
                <Button variant="secondary" size="sm" loading={creating} onClick={() => void create()}>
                  Create
                </Button>
                <Button variant="ghost" icon size="sm" aria-label="Cancel new label" onClick={() => setDraft(null)}>
                  <X size={13} aria-hidden />
                </Button>
              </span>
            </div>
          )}
          {list.map((l) => {
            const isEditing = editing?.id === l.id;
            const n = l.taskCount ?? 0;
            return (
              <div
                key={l.id}
                role="row"
                className={cn(
                  GRID,
                  "h-[46px] border-b border-line transition-colors duration-[var(--dur-fast)] last:border-b-0 hover:bg-hover max-[760px]:h-[54px]",
                  fresh === l.id && "animate-[fade-in_400ms_var(--ease)] bg-accent-s",
                )}
              >
                <span role="cell" className="flex justify-center">
                  {canEdit ? (
                    <ColorPicker value={l.color} align="start" label={`Recolor ${l.name}`} onChange={(c) => recolor(l, c)} />
                  ) : (
                    <span aria-hidden className="size-3 rounded-full" style={{ background: l.color }} />
                  )}
                </span>
                <span role="cell" className="flex min-w-0 items-center pr-2">
                  {isEditing ? (
                    <NameInput
                      value={editing.value}
                      label="Label name"
                      max={LABEL_NAME_MAX}
                      error={labelNameError(editing.value, list, l.id)}
                      onChange={(value) => setEditing({ id: l.id, value })}
                      onCommit={() => void rename()}
                      onCancel={() => setEditing(null)}
                    />
                  ) : canEdit ? (
                    <button
                      type="button"
                      aria-label={`Rename ${l.name}`}
                      onClick={() => setEditing({ id: l.id, value: l.name })}
                      className="flex h-7 min-w-0 cursor-text items-center rounded-sm px-1.5 hover:bg-raised"
                    >
                      <LabelPill name={l.name} color={l.color} />
                    </button>
                  ) : (
                    <LabelPill name={l.name} color={l.color} className="ml-1.5" />
                  )}
                </span>
                <span role="cell" className={cn("pr-3 text-right font-mono text-[12px] font-medium", n ? "text-fg-2" : "text-fg-3")} aria-label={tasksLabel(n)}>
                  {n}
                </span>
                <span role="cell" className="flex justify-center">
                  {canEdit && (
                    <Button variant="ghost" icon size="sm" aria-label={`Delete ${l.name}`} tooltip="Delete" className="hover:text-danger max-[760px]:size-10" onClick={() => setRemoving(l)}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        role="alertdialog"
        width={420}
        title={
          removing ? (
            <span className="flex items-center gap-2.5">
              Delete <LabelPill name={removing.name} color={removing.color} />?
            </span>
          ) : (
            ""
          )
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              autoFocus
              onClick={() => {
                const l = removing;
                setRemoving(null);
                if (l) void remove(l);
              }}
            >
              Delete label
            </Button>
          </>
        }
      >
        {removing && (removing.taskCount ?? 0) > 0 && (
          <div className="flex items-center gap-2.5 rounded-md border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2 text-[12.5px]">
            <TriangleAlert size={14} aria-hidden className="flex-none text-danger" />
            <span>
              Removed from <b className="font-mono font-semibold">{tasksLabel(removing.taskCount ?? 0)}</b>
            </span>
          </div>
        )}
      </Modal>
    </div>
  );
}
