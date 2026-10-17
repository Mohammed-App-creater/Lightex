"use client";

import { useId, useState } from "react";
import { Switch } from "@/components/ui/choice";
import { PriorityIcon } from "@/components/ui/glyphs";
import type { QuietHours as Quiet } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { MoonGlyph } from "./icons";
import { DAYS, browserTimeZone, quietError, segments, summary, timeZoneOptions, tzLabel } from "./quiet";

/*
 * Board 38 "Quiet hours" card: the switch and the mono summary; when on, From / To (committed on blur or
 * the picker, not per keystroke), the time zone (every IANA zone, the browser's first), the 24 h bar with
 * the window hatched (two parts overnight), day toggles and "Urgent still notifies".
 */

const labelCache = new Map<string, string>();
const label = (tz: string) => {
  let l = labelCache.get(tz);
  if (!l) {
    l = tzLabel(tz);
    labelCache.set(tz, l);
  }
  return l;
};

const INPUT =
  "h-[34px] w-full rounded-sm border border-control bg-surface px-2.5 font-mono text-[12.5px] text-fg transition-[border-color,box-shadow] hover:border-fg-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--ring)] focus:outline-none max-[760px]:h-11 max-[760px]:text-[15px]";

function TimeField({ label: text, value, onCommit, error }: { label: string; value: string; onCommit: (v: string) => void; error?: string }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-fg-2">
        {text}
      </label>
      <input
        id={id}
        type="time"
        aria-label={text === "From" ? "Quiet from" : "Quiet until"}
        aria-invalid={error ? true : undefined}
        value={shown}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className={cn(INPUT, error && "border-danger")}
      />
    </div>
  );
}

export function QuietHoursCard({ value, onChange }: { value: Quiet; onChange: (q: Quiet) => void }) {
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const tzId = useId();
  const set = (patch: Partial<Quiet>) => {
    const next = { ...value, ...patch };
    const err = quietError(next);
    setError(err);
    if (!err) onChange(next);
  };
  const zones = timeZoneOptions(browserTimeZone(), value.timezone);
  const segs = segments(value.from, value.to);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <label className="flex min-h-[52px] cursor-pointer items-center gap-2.5 px-3.5 py-3">
        <MoonGlyph />
        <b className="font-semibold">Quiet hours</b>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3" data-testid="quiet-summary">
          {summary(value)}
        </span>
        <Switch aria-label="Quiet hours" checked={value.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
      </label>
      {value.enabled && (
        <div className="flex animate-[fade-in_180ms_var(--ease)] flex-col gap-4 border-t border-line px-3.5 py-4">
          <div className="grid grid-cols-[120px_120px_minmax(0,1fr)] gap-3 max-[760px]:grid-cols-2">
            <TimeField label="From" value={value.from} onCommit={(from) => set({ from })} error={error?.field === "from" ? error.message : undefined} />
            <TimeField label="To" value={value.to} onCommit={(to) => set({ to })} error={error?.field === "to" ? error.message : undefined} />
            <div className="flex min-w-0 flex-col gap-1.5 max-[760px]:col-span-2">
              <label htmlFor={tzId} className="text-[12px] font-medium text-fg-2">
                Timezone
              </label>
              <select
                id={tzId}
                aria-label="Timezone"
                value={value.timezone ?? ""}
                onChange={(e) => set({ timezone: e.currentTarget.value || null })}
                className={cn(INPUT, "cursor-pointer font-sans text-[13px]")}
              >
                {!value.timezone && <option value="">Choose a time zone</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {label(z)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && (
            <span role="alert" className="-mt-2 text-[12px] text-danger">
              {error.message}
            </span>
          )}
          {!value.timezone && <span className="-mt-2 text-[12px] text-fg-3">Quiet hours start once a time zone is set.</span>}
          <div>
            <div role="img" aria-label={`Quiet from ${value.from} to ${value.to}`} className="relative h-[26px] overflow-hidden rounded-sm border border-line bg-raised">
              {segs.map((s) => (
                <span key={s.left} data-seg className="ch-seg absolute inset-y-0" style={{ left: `${s.left}%`, width: `${s.width}%` }} />
              ))}
            </div>
            <div aria-hidden className="mt-1.5 flex justify-between font-mono text-[10.5px] text-fg-3">
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>24</span>
            </div>
          </div>
          <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => (
              <button
                key={d.short}
                type="button"
                aria-pressed={value.days[i]}
                aria-label={d.full}
                onClick={() => {
                  const days = [...value.days] as Quiet["days"];
                  days[i] = !days[i];
                  set({ days });
                }}
                className={cn(
                  "h-[30px] w-10 rounded-[7px] border border-line-2 text-[12px] font-medium text-fg-2 transition-colors hover:border-control hover:text-fg max-[760px]:h-10 max-[760px]:w-11",
                  value.days[i] && "border-accent bg-accent-s text-fg",
                )}
              >
                {d.short}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 font-medium">
            <Switch checked={value.urgentBypass} onChange={(e) => set({ urgentBypass: e.currentTarget.checked })} aria-label="Urgent still notifies" />
            <span>Urgent still notifies</span>
            <PriorityIcon level={4} bars />
          </label>
        </div>
      )}
    </div>
  );
}
