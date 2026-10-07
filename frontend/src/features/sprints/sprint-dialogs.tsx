"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Sprint } from "@/lib/api/types";
import { addDaysISO, todayISO } from "@/lib/utils/dates";

function useInvalidateSprints(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.scope(projectId) });
    void qc.invalidateQueries({ queryKey: ["task"] });
  };
}

/** Start sprint: dates + goal (board 05 modal style). */
export function StartSprintDialog({ sprint, open, onOpenChange }: { sprint: Sprint; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateSprints(sprint.projectId);
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(addDaysISO(todayISO(), 13));
  const [goal, setGoal] = useState(sprint.goal);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.planning.startSprint(sprint.id, { startDate: start, endDate: end, goal }),
    onSuccess: (s) => {
      invalidate();
      onOpenChange(false);
      toast({ tone: "spark", title: `${s.name} started`, body: `${s.progress.total} tasks · ${s.progress.points} points` });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Start ${sprint.name}?`}
      description={`${sprint.progress.total} tasks · ${sprint.progress.points} points planned.`}
      footer={
        <>
          <Button variant="ghost" kbd="Esc" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" kbd="↵" loading={m.isPending} onClick={() => (end < start ? setError("End must be after start") : m.mutate())}>
            Start sprint
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <Input type="date" mono value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="End">
          <Input type="date" mono value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <Field label="Sprint goal" hint="Optional · what does done look like?">
        <Textarea value={goal} maxLength={200} onChange={(e) => setGoal(e.target.value)} className="min-h-16" />
      </Field>
      {error && (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** Edit name, goal and dates of a sprint. */
export function EditSprintDialog({ sprint, open, onOpenChange }: { sprint: Sprint; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateSprints(sprint.projectId);
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [start, setStart] = useState(sprint.startDate);
  const [end, setEnd] = useState(sprint.endDate);
  const [error, setError] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () => api.planning.updateSprint(sprint.id, { name, goal, startDate: start, endDate: end }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      toast.success("Sprint saved");
    },
    onError: (e) => setError(isApiError(e) ? { ...e.fieldErrors, form: e.fieldErrors.endDate ? "" : errorMessage(e) } : { form: errorMessage(e) }),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit sprint"
      footer={
        <>
          <Button variant="ghost" kbd="Esc" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => (!name.trim() ? setError({ name: "Name the sprint" }) : m.mutate())}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Name" error={error.name}>
        <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <Input type="date" mono value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="End" error={error.endDate}>
          <Input type="date" mono value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <Field label="Goal">
        <Textarea value={goal} maxLength={200} onChange={(e) => setGoal(e.target.value)} className="min-h-16" />
      </Field>
      {error.form && <p role="alert" className="m-0 text-meta text-danger">{error.form}</p>}
    </Modal>
  );
}

/** Delete a planned sprint; its tasks return to the backlog. */
export function DeleteSprintDialog({ sprint, open, onOpenChange }: { sprint: Sprint; open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateSprints(sprint.projectId);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${sprint.name}?`}
      description={sprint.progress.total ? `${sprint.progress.total} ${sprint.progress.total === 1 ? "task returns" : "tasks return"} to the backlog.` : "The sprint is empty."}
      confirmLabel="Delete sprint"
      confirmVariant="danger"
      onConfirm={async () => {
        try {
          await api.planning.removeSprint(sprint.id);
          invalidate();
          toast.success(`${sprint.name} deleted`);
        } catch (e) {
          toast.error(`Couldn’t delete ${sprint.name}`, { body: errorMessage(e) });
          throw e;
        }
      }}
    />
  );
}
