"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { CustomField } from "@/lib/api/types";
import { tasksText } from "./field-lib";

/** Delete confirm (board 39): Cancel has focus; the danger button starts the 5 s pending delete. */
export function DeleteFieldDialog({ field, onOpenChange, onConfirm }: { field: CustomField | null; onOpenChange: (open: boolean) => void; onConfirm: (f: CustomField) => void }) {
  return (
    <Modal
      open={Boolean(field)}
      onOpenChange={onOpenChange}
      role="alertdialog"
      width={420}
      title={field ? `Delete “${field.name}”?` : ""}
      description={
        field ? (
          field.taskCount > 0 ? (
            <>
              Used in <b className="font-mono font-semibold text-fg">{tasksText(field.taskCount)}</b>. Their values are removed.
            </>
          ) : (
            "Not used in any task."
          )
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" autoFocus onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!field) return;
              onConfirm(field);
              onOpenChange(false);
            }}
          >
            Delete field
          </Button>
        </>
      }
    />
  );
}

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void; projectId: string }>();

if (typeof window !== "undefined") {
  // Commit deletes still waiting on their Undo window before the page goes away.
  window.addEventListener("pagehide", () => pending.forEach((p) => p.run()));
}

/**
 * Pending delete (v1 pattern used for attachments and views): the row disappears at once, a toast
 * offers Undo for 5 s, and DELETE is only sent when the toast expires. Undo cancels the request.
 */
export function usePendingFieldDelete(projectId: string, announce: (msg: string) => void) {
  const qc = useQueryClient();
  const key = qk.customFields(projectId);
  return (field: CustomField) => {
    const prev = qc.getQueryData<CustomField[]>(key);
    qc.setQueryData<CustomField[]>(key, (l) => l?.filter((f) => f.id !== field.id));
    announce(`${field.name} deleted`);
    const run = () => {
      const p = pending.get(field.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(field.id);
      api.customFields
        .remove(field.id)
        .then(() => void qc.invalidateQueries({ queryKey: qk.scope(projectId) }))
        .catch((e) => {
          if (prev) qc.setQueryData(key, prev);
          toast.error(`Couldn’t delete “${field.name}”`, { body: `${errorMessage(e)} Restored.` });
        })
        .finally(() => void qc.invalidateQueries({ queryKey: key }));
    };
    pending.set(field.id, { timer: setTimeout(run, 5200), run, projectId });
    toast({
      tone: "info",
      title: `Deleted “${field.name}”`,
      duration: 5000,
      action: {
        label: "Undo",
        key: "Z",
        onClick: () => {
          const p = pending.get(field.id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(field.id);
          qc.setQueryData<CustomField[]>(key, (l) => (l?.some((f) => f.id === field.id) ? l : [...(l ?? []), field].sort((a, b) => a.position - b.position)));
          announce(`${field.name} restored`);
        },
      },
    });
  };
}

/** Field ids whose DELETE is still waiting on Undo (a reorder must still list them). */
export const pendingFieldIds = (projectId: string) => [...pending.entries()].filter(([, p]) => p.projectId === projectId).map(([id]) => id);
