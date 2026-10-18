"use client";

import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ApiError } from "@/api/errors";
import type { SalesHoliday } from "@/api/types";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { Segmented } from "@/ui/choice";
import { DatePicker } from "@/ui/date-picker";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { Field, Input } from "@/ui/input";
import { Modal } from "@/ui/modal";
import { toast } from "@/ui/toast";
import { isValidation, useCreateHoliday, useDeleteHoliday, useHolidays, useSalesCalendar, useUpdateHoliday, useUpdateSalesCalendar } from "../api";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEIGHTS = [
  { value: "0", label: "Off" },
  { value: "0.5", label: "Half" },
  { value: "1", label: "Full" },
];

/** Working calendar (api.md §5.5: Monday-first weights 0 / 0.5 / 1) and holidays (§5.6). */
export function CalendarSettings({ canManage }: { canManage: boolean }) {
  return (
    <div className="grid gap-4 min-[1100px]:grid-cols-2">
      <WeekPanel canManage={canManage} />
      <HolidaysPanel canManage={canManage} />
    </div>
  );
}

function WeekPanel({ canManage }: { canManage: boolean }) {
  const q = useSalesCalendar();
  if (q.isPending) return <SkeletonRows rows={7} label="Loading the calendar" />;
  if (q.isError) return <ErrorState title="Couldn’t load the calendar" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return <WeekForm key={q.data.updatedAt ?? "new"} weights={q.data.weekdayWeights} canManage={canManage} />;
}

function WeekForm({ weights, canManage }: { weights: number[]; canManage: boolean }) {
  const [w, setW] = useState(() => weights.map(String));
  const save = useUpdateSalesCalendar();
  const dirty = w.some((v, i) => Number(v) !== weights[i]);
  const none = w.every((v) => v === "0");
  return (
    <Panel title="Working week">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {DAYS.map((d, i) => (
          <li key={d} className="flex items-center justify-between gap-3">
            <span className="text-[14px]">{d}</span>
            {canManage ? (
              <Segmented label={`${d} weight`} value={w[i]!} options={WEIGHTS} onChange={(v) => setW((x) => x.map((y, j) => (j === i ? v : y)))} />
            ) : (
              <span className="text-meta text-fg-2">{WEIGHTS.find((o) => Number(o.value) === weights[i])?.label ?? weights[i]}</span>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!dirty || none}
            disabledReason={none ? "At least one day must be a working day" : undefined}
            loading={save.isPending}
            onClick={() => save.mutate(w.map(Number), { onSuccess: () => toast.success("Working week saved") })}
          >
            Save week
          </Button>
        </div>
      )}
    </Panel>
  );
}

function HolidaysPanel({ canManage }: { canManage: boolean }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const q = useHolidays({ filter: { year } });
  const del = useDeleteHoliday();
  const [editing, setEditing] = useState<SalesHoliday | "new" | null>(null);
  return (
    <Panel
      title="Holidays"
      actions={
        <>
          <Button icon size="sm" variant="ghost" aria-label="Previous year" onClick={() => setYear(year - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="tabular text-[13px] font-medium">{year}</span>
          <Button icon size="sm" variant="ghost" aria-label="Next year" onClick={() => setYear(year + 1)}>
            <ChevronRight size={14} />
          </Button>
          {canManage && (
            <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
              <Plus size={14} aria-hidden /> Add
            </Button>
          )}
        </>
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={3} label="Loading holidays" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load holidays" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data.length === 0 ? (
        <EmptyState title={`No holidays in ${year}`} body="Holidays count as non-working days for targets and daily reports." />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {q.data.map((h) => (
            <li key={h.id} className="flex min-h-11 items-center gap-3 py-1.5">
              <span className="w-[92px] flex-none tabular text-meta text-fg-2">{h.date}</span>
              <span className="min-w-0 flex-1 truncate text-[14px]">{h.name}</span>
              {canManage && (
                <span className="flex gap-0.5">
                  <Button icon size="sm" variant="ghost" aria-label={`Edit ${h.name}`} onClick={() => setEditing(h)}>
                    <Pencil size={14} />
                  </Button>
                  <Button icon size="sm" variant="danger-ghost" aria-label={`Delete ${h.name}`} onClick={() => del.mutate(h.id, { onSuccess: () => toast.success(`Deleted ${h.name}`) })}>
                    <Trash2 size={14} />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <HolidayDialog holiday={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function HolidayDialog({ holiday, onClose }: { holiday: SalesHoliday | null; onClose: () => void }) {
  const create = useCreateHoliday();
  const update = useUpdateHoliday();
  const mut = holiday ? update : create;
  const [date, setDate] = useState<string | null>(holiday?.date ?? null);
  const [name, setName] = useState(holiday?.name ?? "");
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = mut.error && isValidation(mut.error) ? (mut.error as ApiError).fieldErrors : {};
  const errs = { ...server, ...local };
  const save = () => {
    const l: Record<string, string> = {};
    if (!date) l.date = "Pick a date";
    if (!name.trim()) l.name = "Enter a name";
    setLocal(l);
    if (Object.keys(l).length) return;
    const body = { date: date!, name: name.trim() };
    const done = () => {
      toast.success(holiday ? "Holiday saved" : `Added ${body.name}`);
      onClose();
    };
    if (holiday) update.mutate({ id: holiday.id, body }, { onSuccess: done });
    else create.mutate(body, { onSuccess: done });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={holiday ? "Edit holiday" : "Add holiday"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={mut.isPending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Date" error={errs.date}>
        <DatePicker value={date} onChange={setDate} />
      </Field>
      <Field label="Name" error={errs.name}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Modal>
  );
}
