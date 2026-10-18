"use client";

import { useState } from "react";
import type { ApiError } from "@/api/errors";
import type { SalesBody, SalesSettings } from "@/api/types";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/card";
import { Switch } from "@/ui/choice";
import { ErrorState, SkeletonRows } from "@/ui/feedback";
import { Field, Input } from "@/ui/input";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { isValidation, useSalesSettings, useUpdateSalesSettings } from "../api";
import { isMoney } from "../shared/money";

type Weekday = SalesSettings["weekStart"];
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const NUMBERS = [
  ["statusGreenPct", "Green at (% of target)", "On track at or above this achievement."],
  ["statusYellowPct", "Yellow at (% of target)", "At risk at or above this; red below."],
  ["upcomingDays", "Upcoming follow-ups (days)", undefined],
  ["staleDays", "Stale after (days)", "Open deals without activity for this long."],
  ["quotationValidityDays", "Quotation validity (days)", undefined],
] as const;
type NumKey = (typeof NUMBERS)[number][0];

type Form = Omit<SalesSettings, NumKey | "updatedAt" | "calendarDisplay"> & Record<NumKey, string>;

const toForm = (s: SalesSettings): Form => ({
  weekStart: s.weekStart,
  fiscalYearStartMonth: s.fiscalYearStartMonth,
  largeDealThreshold: s.largeDealThreshold,
  dailyReportCutoff: s.dailyReportCutoff.slice(0, 5),
  dailyReportRequired: s.dailyReportRequired,
  ...(Object.fromEntries(NUMBERS.map(([k]) => [k, String(s[k])])) as Record<NumKey, string>),
});

export function GeneralSettings({ canManage }: { canManage: boolean }) {
  const q = useSalesSettings();
  if (q.isPending) return <SkeletonRows rows={6} label="Loading settings" />;
  if (q.isError) return <ErrorState title="Couldn’t load the settings" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return <GeneralForm key={q.data.updatedAt ?? "new"} settings={q.data} canManage={canManage} />;
}

function GeneralForm({ settings, canManage }: { settings: SalesSettings; canManage: boolean }) {
  const [f, setF] = useState(() => toForm(settings));
  const [local, setLocal] = useState<Record<string, string>>({});
  const save = useUpdateSalesSettings();
  const server = save.error && isValidation(save.error) ? (save.error as ApiError).fieldErrors : {};
  const errs = { ...server, ...local };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const ro = !canManage;

  const submit = () => {
    const e: Record<string, string> = {};
    for (const [k] of NUMBERS) if (!/^\d+$/.test(f[k].trim())) e[k] = "Enter a whole number";
    if (!isMoney(f.largeDealThreshold)) e.largeDealThreshold = "Enter an amount like 1000000.00";
    if (!/^\d{2}:\d{2}$/.test(f.dailyReportCutoff)) e.dailyReportCutoff = "Use HH:MM";
    setLocal(e);
    if (Object.keys(e).length) return;
    const body: SalesBody<"sales_settings_update"> = {
      weekStart: f.weekStart,
      fiscalYearStartMonth: f.fiscalYearStartMonth,
      largeDealThreshold: f.largeDealThreshold.trim(),
      dailyReportCutoff: f.dailyReportCutoff,
      dailyReportRequired: f.dailyReportRequired,
      ...(Object.fromEntries(NUMBERS.map(([k]) => [k, Number(f[k])])) as Record<NumKey, number>),
    };
    save.mutate(body, { onSuccess: () => toast.success("Settings saved") });
  };

  return (
    <Panel title="General">
      <form
        className="grid gap-4 min-[760px]:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select
          label="Week starts on"
          value={f.weekStart}
          onChange={(v) => set("weekStart", v)}
          options={WEEKDAYS.map((d) => ({ value: d, label: cap(d) }))}
          disabled={ro}
        />
        <Select
          label="Fiscal year starts in"
          value={String(f.fiscalYearStartMonth)}
          onChange={(v) => set("fiscalYearStartMonth", Number(v))}
          options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
          disabled={ro}
        />
        {NUMBERS.map(([k, label, hint]) => (
          <Field key={k} label={label} hint={hint} error={errs[k]}>
            <Input inputMode="numeric" value={f[k]} onChange={(e) => set(k, e.target.value)} disabled={ro} />
          </Field>
        ))}
        <Field label="Large deal threshold (ETB)" error={errs.largeDealThreshold}>
          <Input inputMode="decimal" value={f.largeDealThreshold} onChange={(e) => set("largeDealThreshold", e.target.value)} disabled={ro} />
        </Field>
        <Field label="Daily report cutoff" hint="Reports submitted after this time are late." error={errs.dailyReportCutoff}>
          <Input type="time" value={f.dailyReportCutoff} onChange={(e) => set("dailyReportCutoff", e.target.value)} disabled={ro} />
        </Field>
        <div className="flex items-end">
          <Switch
            label="Daily report required on working days"
            checked={f.dailyReportRequired}
            onChange={(e) => set("dailyReportRequired", e.target.checked)}
            disabled={ro}
          />
        </div>
        {canManage && (
          <div className="flex justify-end min-[760px]:col-span-2">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save settings
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}
