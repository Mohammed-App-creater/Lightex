"use client";

import { useState } from "react";
import type { SalesFollowUp } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/choice";
import { DatePicker } from "@/ui/date-picker";
import { Field, Input, Textarea } from "@/ui/input";
import { toast } from "@/ui/toast";
import { addDaysISO, todayISO } from "@/lib/utils/dates";
import { ActivityTypeChips, type LoggableActivityType } from "../activities/activity-dialogs";
import { FormDialog, fieldErrorsOf } from "../activities/form-dialog";
import { useCompleteFollowUp, useReassignFollowUp, useRescheduleFollowUp } from "../api";
import { UserPicker } from "../shared/user-picker";

/**
 * Complete a follow-up (api.md §15): optionally log what happened (an activity on the same record) and schedule the
 * next follow-up, in one call.
 */
export function CompleteFollowUpDialog({ followUp: f, onClose }: { followUp: SalesFollowUp; onClose: () => void }) {
  const complete = useCompleteFollowUp();
  const canLog = useCan("sales.activity.create");
  const canNext = useCan("sales.followup.create");
  const [logIt, setLogIt] = useState(canLog);
  const [type, setType] = useState<LoggableActivityType>("call");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");
  const [next, setNext] = useState(false);
  const [nextDate, setNextDate] = useState<string | null>(addDaysISO(todayISO(), 7));
  const [nextTitle, setNextTitle] = useState("");
  const errs = fieldErrorsOf(complete.error);

  const submit = () => {
    if (next && !nextDate) return;
    complete.mutate(
      {
        id: f.id,
        body: {
          activity: logIt ? { type, summary: summary.trim() || f.title, outcome: outcome.trim() } : null,
          createNext: next && nextDate ? { dueDate: nextDate, title: nextTitle.trim() || undefined } : null,
        },
      },
      {
        onSuccess: (r) => {
          toast.success(r.next ? `Done. Next follow-up on ${r.next.dueDate}` : "Follow-up done");
          onClose();
        },
      },
    );
  };

  return (
    <FormDialog
      title="Complete follow-up"
      onOpenChange={(o) => !o && onClose()}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={complete.isPending}>
            Complete
          </Button>
        </>
      }
    >
      <p className="m-0 text-[13px] text-fg-2">
        <span className="font-medium text-fg">{f.title}</span> · {f.target?.name}
      </p>
      {canLog && (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3">
          <Switch label="Log an activity" checked={logIt} onChange={(e) => setLogIt(e.target.checked)} />
          {logIt && (
            <>
              <ActivityTypeChips value={type} onChange={setType} />
              <Field label="Summary" error={errs["activity.summary"] ?? errs.activity}>
                <Textarea rows={2} maxLength={5000} placeholder={f.title} value={summary} onChange={(e) => setSummary(e.target.value)} />
              </Field>
              <Field label="Outcome">
                <Input maxLength={500} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
              </Field>
            </>
          )}
        </div>
      )}
      {canNext && (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3">
          <Switch label="Schedule the next follow-up" checked={next} onChange={(e) => setNext(e.target.checked)} />
          {next && (
            <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
              <Field label="Due" error={errs["createNext.dueDate"] ?? errs.createNext}>
                <DatePicker aria-label="Next due date" value={nextDate} onChange={setNextDate} min={todayISO()} />
              </Field>
              <Field label="Title">
                <Input maxLength={200} placeholder={f.title} value={nextTitle} onChange={(e) => setNextTitle(e.target.value)} />
              </Field>
            </div>
          )}
        </div>
      )}
    </FormDialog>
  );
}

export function RescheduleDialog({ followUp: f, onClose }: { followUp: SalesFollowUp; onClose: () => void }) {
  const m = useRescheduleFollowUp();
  const [date, setDate] = useState<string | null>(f.dueDate < todayISO() ? todayISO() : f.dueDate);
  const errs = fieldErrorsOf(m.error);
  return (
    <FormDialog
      title="Reschedule"
      width={420}
      onOpenChange={(o) => !o && onClose()}
      onSubmit={() =>
        date &&
        m.mutate(
          { id: f.id, dueDate: date },
          {
            onSuccess: () => {
              toast.success("Rescheduled");
              onClose();
            },
          },
        )
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!date}>
            Save
          </Button>
        </>
      }
    >
      <Field label="New due date" error={errs.dueDate}>
        <DatePicker value={date} onChange={setDate} min={todayISO()} />
      </Field>
    </FormDialog>
  );
}

export function ReassignDialog({ followUp: f, onClose }: { followUp: SalesFollowUp; onClose: () => void }) {
  const m = useReassignFollowUp();
  const [ownerId, setOwnerId] = useState<string | null>(f.ownerId);
  const errs = fieldErrorsOf(m.error);
  return (
    <FormDialog
      title="Reassign"
      width={420}
      onOpenChange={(o) => !o && onClose()}
      onSubmit={() =>
        ownerId &&
        m.mutate(
          { id: f.id, ownerId },
          {
            onSuccess: () => {
              toast.success("Reassigned");
              onClose();
            },
          },
        )
      }
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!ownerId || ownerId === f.ownerId}>
            Reassign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-meta font-medium text-fg-2">Owner</span>
        <UserPicker value={ownerId} onChange={setOwnerId} label="Owner" />
        {errs.ownerId && (
          <span role="alert" className="text-meta text-danger">
            {errs.ownerId}
          </span>
        )}
      </div>
    </FormDialog>
  );
}
