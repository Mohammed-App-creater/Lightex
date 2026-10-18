"use client";

import { useState } from "react";
import type { ApiError } from "@/api/errors";
import type { SalesTargetAllocation } from "@/api/types";
import { useTeams } from "@/platform/teams/queries";
import { Button } from "@/ui/button";
import { Segmented } from "@/ui/choice";
import { Field, Input } from "@/ui/input";
import { Modal } from "@/ui/modal";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/utils/cn";
import { isValidation, useAllocateTarget, useSetTarget, useSlug } from "../api";
import { addMoney, formatMoney, isMoney, subMoney, toCents } from "../shared/money";
import { UserPicker } from "../shared/user-picker";

export type SubjectType = SalesTargetAllocation["subjectType"];
export type PeriodType = "year" | "quarter" | "month";
export type Subject = { type: SubjectType; id: string | null; name?: string };

/** The fields every allocation tree node has (company, team and user nodes). */
export type TreeNode = Omit<SalesTargetAllocation, "children"> & { children?: TreeNode[] };

const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-07-01" + 3 → "2026-10-01" (first-of-month dates only). */
export function addMonths(iso: string, n: number) {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-01`;
}
export const fiscalStart = (year: number, startMonth: number) => `${year}-${pad(startMonth)}-01`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Period starts of a fiscal year: the year, its four quarters and twelve months. */
export function periodOptions(type: PeriodType, year: number, startMonth: number) {
  const s = fiscalStart(year, startMonth);
  if (type === "year") return [{ value: s, label: `FY ${year} (from ${monthLabel(s)})` }];
  if (type === "quarter") return [0, 1, 2, 3].map((i) => ({ value: addMonths(s, i * 3), label: `Q${i + 1} · ${monthLabel(addMonths(s, i * 3))}` }));
  return Array.from({ length: 12 }, (_, i) => ({ value: addMonths(s, i), label: monthLabel(addMonths(s, i)) }));
}

/** The stored amount of a period on a tree node, for pre-filling. */
function storedAmount(node: TreeNode | undefined, type: PeriodType, start: string): string {
  if (!node) return "";
  if (type === "year") return node.target ?? "";
  for (const q of node.quarters) {
    if (type === "quarter" && q.start === start) return q.amount ?? "";
    for (const m of q.months) if (type === "month" && m.start === start) return m.amount ?? "";
  }
  return "";
}

const SUBJECT_LABEL: Record<SubjectType, string> = { company: "Company", team: "Team", user: "Person" };

/** Set (create or update) one target: subject, period type, period start, amount (api.md §18). */
export function SetTargetDialog({
  year,
  startMonth,
  subject: fixed,
  node,
  subjectTypes,
  onClose,
}: {
  year: number;
  startMonth: number;
  /** Opened from a tree row: the subject is fixed. */
  subject: Subject | null;
  node?: TreeNode;
  /** Subject kinds the viewer may manage (header button). */
  subjectTypes: SubjectType[];
  onClose: () => void;
}) {
  const slug = useSlug();
  const teams = useTeams(slug).data ?? [];
  const set = useSetTarget();
  const [type, setType] = useState<SubjectType>(fixed?.type ?? subjectTypes[0] ?? "user");
  const [subjectId, setSubjectId] = useState<string | null>(fixed?.id ?? null);
  const [periodType, setPeriodType] = useState<PeriodType>("year");
  const [periodStart, setPeriodStart] = useState(fiscalStart(year, startMonth));
  const [amount, setAmount] = useState(() => storedAmount(node, "year", fiscalStart(year, startMonth)));
  const [note, setNote] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const server = set.error && isValidation(set.error) ? (set.error as ApiError).fieldErrors : {};
  const errs = { ...server, ...local };

  const pickPeriod = (t: PeriodType, start: string) => {
    setPeriodType(t);
    setPeriodStart(start);
    const prior = storedAmount(node, t, start);
    if (prior) setAmount(prior);
  };

  const save = () => {
    const l: Record<string, string> = {};
    if (type !== "company" && !subjectId) l.subjectId = type === "team" ? "Pick a team" : "Pick a person";
    if (!isMoney(amount)) l.amount = "Enter an amount like 250000.00";
    setLocal(l);
    if (Object.keys(l).length) return;
    set.mutate(
      { subjectType: type, subjectId: type === "company" ? null : subjectId, periodType, periodStart, amount: amount.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success("Target saved");
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={fixed ? `Set target · ${fixed.name ?? SUBJECT_LABEL[fixed.type]}` : "Set target"}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={set.isPending} onClick={save}>
            Save target
          </Button>
        </>
      }
    >
      {!fixed && (
        <div className="flex flex-col gap-2">
          <Segmented
            label="Subject"
            value={type}
            onChange={(t) => {
              setType(t);
              setSubjectId(null);
            }}
            options={subjectTypes.map((t) => ({ value: t, label: SUBJECT_LABEL[t] }))}
          />
          {type === "team" && (
            <Select label="Team" value={subjectId} onChange={setSubjectId} options={teams.map((t) => ({ value: t.id, label: t.name }))} placeholder="Pick a team" />
          )}
          {type === "user" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-2">Person</span>
              <UserPicker value={subjectId} onChange={setSubjectId} />
            </div>
          )}
          {errs.subjectId && (
            <span role="alert" className="text-meta text-danger">
              {errs.subjectId}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-3 min-[480px]:grid-cols-2">
        <Select
          label="Period"
          value={periodType}
          onChange={(t) => pickPeriod(t, periodOptions(t, year, startMonth)[0]!.value)}
          options={[
            { value: "year", label: "Year" },
            { value: "quarter", label: "Quarter" },
            { value: "month", label: "Month" },
          ]}
        />
        <Select label="Starting" value={periodStart} onChange={(s) => pickPeriod(periodType, s)} options={periodOptions(periodType, year, startMonth)} />
      </div>
      {errs.periodStart && <span className="text-meta text-danger">{errs.periodStart}</span>}
      <Field label="Amount (ETB)" error={errs.amount}>
        <Input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

type Method = "equal" | "working_days" | "manual";

/** Sum of amounts (empty counts as 0); null when any is not a valid amount. */
const sum = (vs: string[]) => (vs.every((v) => !v.trim() || isMoney(v)) ? addMoney(...vs.map((v) => v.trim() || "0")) : null);

export function GapText({ gap, label }: { gap: string | null; label?: string }) {
  if (gap == null) return <span className="text-fg-3">—</span>;
  const c = toCents(gap);
  const zero = c === toCents("0");
  const over = c < toCents("0");
  return (
    <span className={cn("tabular", zero ? "text-ok" : over ? "text-danger" : "text-warn")}>
      {label ? `${label} ` : ""}
      {zero ? "Balanced" : over ? `Over by ${formatMoney(subMoney("0", gap))}` : `${formatMoney(gap)} left`}
    </span>
  );
}

/**
 * Allocate a year target into quarters and months (api.md §18): `equal`, `working_days`, or `manual` amounts with a
 * live gap (year − Σ quarters, quarter − Σ months). Manual mismatches are allowed and reported, never refused.
 */
export function AllocateDialog({ node, year, onClose }: { node: TreeNode; year: number; onClose: () => void }) {
  const alloc = useAllocateTarget();
  const [method, setMethod] = useState<Method>(node.target ? "equal" : "manual");
  const [quarters, setQuarters] = useState(() => node.quarters.map((q) => q.amount ?? ""));
  const [months, setMonths] = useState(() => node.quarters.flatMap((q) => q.months.map((m) => m.amount ?? "")));
  const qSum = sum(quarters);
  const yearGap = node.target && qSum ? subMoney(node.target, qSum) : null;
  const bad = [...quarters, ...months].some((v) => v.trim() && !isMoney(v));
  const anyQ = quarters.some((v) => v.trim());
  const anyM = months.some((v) => v.trim());

  const save = () => {
    const fill = (vs: string[]) => vs.map((v) => v.trim() || "0.00");
    const body =
      method === "manual"
        ? { ...(anyQ ? { quarters: fill(quarters) } : {}), ...(anyM ? { months: fill(months) } : {}) }
        : {};
    alloc.mutate(
      { subjectType: node.subjectType, subjectId: node.subjectId, year, method, ...body },
      {
        onSuccess: () => {
          toast.success(`Allocated ${node.name}’s ${year} target`);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Allocate · ${node.name}`}
      description={`Year target ${formatMoney(node.target)} for FY ${year}.`}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={alloc.isPending}
            disabled={(method !== "manual" && !node.target) || (method === "manual" && (bad || (!anyQ && !anyM)))}
            disabledReason={
              method !== "manual" && !node.target
                ? "Set the year target first"
                : method === "manual" && bad
                  ? "Fix the invalid amounts"
                  : method === "manual" && !anyQ && !anyM
                    ? "Enter quarter or month amounts"
                    : undefined
            }
            onClick={save}
          >
            Allocate
          </Button>
        </>
      }
    >
      <Segmented
        label="Method"
        value={method}
        onChange={setMethod}
        options={[
          { value: "equal", label: "Equal" },
          { value: "working_days", label: "Working days" },
          { value: "manual", label: "Manual" },
        ]}
      />
      {method === "equal" && <p className="m-0 text-[13px] text-fg-2">Splits the year target evenly into four quarters and twelve months.</p>}
      {method === "working_days" && (
        <p className="m-0 text-[13px] text-fg-2">Splits by working-day weight (half days count half, holidays zero), so busy months get more.</p>
      )}
      {method === "manual" && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[13px]" aria-live="polite">
            Year gap: <GapText gap={yearGap} />
          </p>
          {node.quarters.map((q, qi) => {
            const ms = months.slice(qi * 3, qi * 3 + 3);
            const mSum = sum(ms);
            const qGap = quarters[qi]?.trim() && isMoney(quarters[qi]!) && mSum && ms.some((v) => v.trim()) ? subMoney(quarters[qi]!, mSum) : null;
            return (
              <fieldset key={q.start} className="m-0 flex flex-col gap-2 rounded-md border border-line p-3">
                <legend className="px-1 text-meta font-medium text-fg-2">
                  Q{qi + 1} · {monthLabel(q.start)}
                </legend>
                <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-4">
                  <Field label="Quarter">
                    <Input
                      inputMode="decimal"
                      value={quarters[qi] ?? ""}
                      aria-invalid={Boolean(quarters[qi]?.trim() && !isMoney(quarters[qi]!))}
                      onChange={(e) => setQuarters((x) => x.map((v, i) => (i === qi ? e.target.value : v)))}
                    />
                  </Field>
                  {q.months.map((m, mi) => {
                    const idx = qi * 3 + mi;
                    return (
                      <Field key={m.start} label={monthLabel(m.start)}>
                        <Input
                          inputMode="decimal"
                          value={months[idx] ?? ""}
                          aria-invalid={Boolean(months[idx]?.trim() && !isMoney(months[idx]!))}
                          onChange={(e) => setMonths((x) => x.map((v, i) => (i === idx ? e.target.value : v)))}
                        />
                      </Field>
                    );
                  })}
                </div>
                <span className="text-meta">
                  Months vs quarter: <GapText gap={qGap} />
                </span>
              </fieldset>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
