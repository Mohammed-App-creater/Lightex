"use client";

import { useState } from "react";
import type { SalesActivityType } from "@/api/types";
import { useSession } from "@/platform/auth/session";
import { useCan } from "@/platform/roles/can";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/choice";
import { DatePicker } from "@/ui/date-picker";
import { Field, Input, Textarea } from "@/ui/input";
import { toast } from "@/ui/toast";
import { addDaysISO, todayISO } from "@/lib/utils/dates";
import { cn } from "@/lib/utils/cn";
import { useCreateFollowUp, useLogActivity } from "../api";
import type { QuickActionDialogProps, QuickActionTarget } from "../shared/quick-actions";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";
import { FormDialog, fieldErrorsOf, localDateTime } from "./form-dialog";
import { TargetPicker } from "./target-picker";

/** Activity types a person can log (`quotation` is written by the system). */
export type LoggableActivityType = Exclude<SalesActivityType, "quotation">;
export const ACTIVITY_TYPES: { value: LoggableActivityType; label: string }[] = [
  { value: "call", label: "Call" },
  { value: "visit", label: "Visit" },
  { value: "meeting", label: "Meeting" },
  { value: "email", label: "Email" },
  { value: "note", label: "Note" },
  { value: "other", label: "Other" },
];

/** Chip row for the activity type (wraps on mobile; 44px touch targets below 1024px). */
export function ActivityTypeChips({ value, onChange }: { value: LoggableActivityType; onChange: (t: LoggableActivityType) => void }) {
  return (
    <div role="radiogroup" aria-label="Activity type" className="flex flex-wrap gap-1.5">
      {ACTIVITY_TYPES.map((t) => (
        <button
          key={t.value}
          type="button"
          role="radio"
          aria-checked={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "inline-flex h-8 items-center rounded-full border px-3 text-[12px] font-medium max-[1023px]:h-10",
            value === t.value ? "border-accent bg-accent-s text-fg" : "border-line text-fg-2 hover:bg-hover hover:text-fg",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const FOLLOW_UP_TYPES = ["sales.lead", "sales.opportunity", "sales.company"] as const;
type FollowUpTargetType = (typeof FOLLOW_UP_TYPES)[number];
const isFollowUpTarget = (t: QuickActionTarget | null): t is QuickActionTarget & { targetType: FollowUpTargetType } =>
  Boolean(t && (FOLLOW_UP_TYPES as readonly string[]).includes(t.targetType));

/**
 * Log a call / visit / meeting / email / note (spec §10 activity quick-log). Opened from a record, the target is
 * prefilled. "Add a follow-up" creates one on the same record in the same call (needs `sales.followup.create`).
 */
export function LogActivityDialog({ target, onClose, defaultType = "call" }: QuickActionDialogProps & { defaultType?: LoggableActivityType }) {
  const log = useLogActivity();
  const canFollowUp = useCan("sales.followup.create");
  const [type, setType] = useState<LoggableActivityType>(defaultType);
  const [rec, setRec] = useState<QuickActionTarget | null>(target);
  const [occurredAt, setOccurredAt] = useState(() => localDateTime());
  const [maxAt] = useState(() => localDateTime(new Date(Date.now() + 5 * 60_000)));
  const [duration, setDuration] = useState("");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");
  const [withFollowUp, setWithFollowUp] = useState(false);
  const [fuDate, setFuDate] = useState<string | null>(addDaysISO(todayISO(), 1));
  const [fuTitle, setFuTitle] = useState("");
  const [localErr, setLocalErr] = useState<Record<string, string>>({});
  const errs = { ...fieldErrorsOf(log.error), ...localErr };

  const submit = () => {
    const e: Record<string, string> = {};
    if (!rec) e.targetId = "Pick what this is about";
    const mins = duration.trim() ? Number(duration) : null;
    if (mins !== null && (!Number.isInteger(mins) || mins < 0 || mins > 1440)) e.durationMinutes = "Minutes, 0–1440";
    if (withFollowUp && !fuDate) e.followUp = "Pick a due date";
    setLocalErr(e);
    if (Object.keys(e).length || !rec) return;
    log.mutate(
      {
        type,
        targetType: rec.targetType,
        targetId: rec.targetId,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : undefined,
        durationMinutes: mins,
        summary: summary.trim(),
        outcome: outcome.trim(),
        followUp: withFollowUp && fuDate ? { dueDate: fuDate, title: fuTitle.trim() || undefined } : null,
      },
      {
        onSuccess: (r) => {
          toast.success(r.followUp ? "Activity logged with a follow-up" : "Activity logged");
          onClose();
        },
      },
    );
  };

  const title = type === "call" ? "Log call" : type === "visit" ? "Log visit" : "Log activity";
  return (
    <FormDialog
      title={title}
      onOpenChange={(o) => !o && onClose()}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={log.isPending}>
            Save
          </Button>
        </>
      }
    >
      <ActivityTypeChips value={type} onChange={setType} />
      <TargetPicker value={rec} onChange={setRec} error={errs.targetId ?? errs.targetType} />
      <div className="grid grid-cols-[1fr_120px] gap-3 max-[420px]:grid-cols-1">
        <Field label="When" error={errs.occurredAt}>
          <Input type="datetime-local" value={occurredAt} max={maxAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field label="Minutes" error={errs.durationMinutes}>
          <Input type="number" inputMode="numeric" min={0} max={1440} placeholder="15" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
      </div>
      <Field label="Summary" error={errs.summary}>
        <Textarea rows={3} maxLength={5000} placeholder="What happened?" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <Field label="Outcome" error={errs.outcome}>
        <Input maxLength={500} placeholder="e.g. Interested, send a quote" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
      </Field>
      {canFollowUp && (
        <div className="flex flex-col gap-3 rounded-md border border-line p-3">
          <Switch label="Add a follow-up" checked={withFollowUp} onChange={(e) => setWithFollowUp(e.target.checked)} />
          {withFollowUp && (
            <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
              <Field label="Due" error={errs.followUp ?? errs["followUp.dueDate"]}>
                <DatePicker value={fuDate} onChange={setFuDate} min={todayISO()} />
              </Field>
              <Field label="Title">
                <Input maxLength={200} placeholder="Follow up" value={fuTitle} onChange={(e) => setFuTitle(e.target.value)} />
              </Field>
            </div>
          )}
        </div>
      )}
    </FormDialog>
  );
}

export const LogCallDialog = (p: QuickActionDialogProps) => <LogActivityDialog {...p} defaultType="call" />;
export const LogVisitDialog = (p: QuickActionDialogProps) => <LogActivityDialog {...p} defaultType="visit" />;

/** Schedule a follow-up on a lead, opportunity or company (a contact target falls back to picking a record). */
export function AddFollowUpDialog({ target, onClose }: QuickActionDialogProps) {
  const create = useCreateFollowUp();
  const { user } = useSession();
  const { beyondOwn } = useSalesScope("sales.followup.reassign");
  const [rec, setRec] = useState<QuickActionTarget | null>(isFollowUpTarget(target) ? target : null);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(addDaysISO(todayISO(), 1));
  const [notes, setNotes] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(user?.id ?? null);
  const [localErr, setLocalErr] = useState<Record<string, string>>({});
  const errs = { ...fieldErrorsOf(create.error), ...localErr };

  const submit = () => {
    const e: Record<string, string> = {};
    if (!isFollowUpTarget(rec)) e.targetId = "Pick a deal, lead or company";
    if (!title.trim()) e.title = "Give it a title";
    if (!dueDate) e.dueDate = "Pick a due date";
    setLocalErr(e);
    if (Object.keys(e).length || !isFollowUpTarget(rec) || !dueDate) return;
    create.mutate(
      {
        targetType: rec.targetType,
        targetId: rec.targetId,
        title: title.trim(),
        dueDate,
        notes: notes.trim() || undefined,
        ownerId: ownerId && ownerId !== user?.id ? ownerId : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Follow-up added");
          onClose();
        },
      },
    );
  };

  return (
    <FormDialog
      title="Add follow-up"
      onOpenChange={(o) => !o && onClose()}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Add follow-up
          </Button>
        </>
      }
    >
      <TargetPicker value={rec} onChange={setRec} types={[...FOLLOW_UP_TYPES]} error={errs.targetId ?? errs.targetType} />
      <Field label="Title" error={errs.title}>
        <Input maxLength={200} placeholder="e.g. Call back about the proposal" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
        <Field label="Due" error={errs.dueDate}>
          <DatePicker value={dueDate} onChange={setDueDate} min={todayISO()} />
        </Field>
        {beyondOwn && (
          <div className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-fg-2">Owner</span>
            <UserPicker value={ownerId} onChange={setOwnerId} label="Owner" />
            {errs.ownerId && (
              <span role="alert" className="text-meta text-danger">
                {errs.ownerId}
              </span>
            )}
          </div>
        )}
      </div>
      <Field label="Notes" error={errs.notes}>
        <Textarea rows={3} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormDialog>
  );
}
