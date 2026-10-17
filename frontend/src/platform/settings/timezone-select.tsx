"use client";

import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Globe, Search } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils/cn";
import { filterTimeZones, timeZoneLabel, timeZoneOffset, timeZoneOptions } from "./lib";

/** How many matches the list renders (the full IANA list is ~420 names; typing narrows it). */
const SHOWN = 80;

/**
 * Sales S0: the workspace time zone. A combobox over `Intl.supportedValuesOf("timeZone")` (or a short fallback list):
 * type to filter, ↑↓ move, ↵ picks, Esc closes.
 */
export function TimezoneSelect({
  id,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  id?: string;
  value: string;
  onChange: (tz: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const all = useMemo(() => timeZoneOptions(value), [value]);
  const matches = filterTimeZones(all, q);
  const results = matches.slice(0, SHOWN);
  const current = Math.min(active, Math.max(0, results.length - 1));

  const pick = (tz: string | undefined) => {
    if (!tz) return;
    onChange(tz);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      const next = (current + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[current]);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQ("");
          const at = all.indexOf(value);
          setActive(at >= 0 && at < SHOWN ? at : 0);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-describedby={describedBy}
          className={cn(
            "inline-flex h-8 w-full items-center gap-2 rounded-sm border border-control bg-surface px-2.5 text-left text-[13px] font-medium text-fg",
            "transition-[border-color] duration-[var(--dur-fast)] hover:border-fg-3 data-[state=open]:border-accent max-[1023px]:h-11",
            invalid && "border-danger",
          )}
        >
          <Globe size={14} className="flex-none text-fg-3" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{timeZoneLabel(value)}</span>
          <span className="font-mono text-[11.5px] font-normal text-fg-3">{timeZoneOffset(value)}</span>
          <ChevronDown size={14} className="text-fg-3" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          role="dialog"
          aria-label="Choose a time zone"
          className="z-[70] w-[var(--radix-popover-trigger-width)] min-w-[280px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[10px] border border-line-2 bg-raised shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <div className="flex items-center gap-2 border-b border-line px-2.5 text-fg-3">
            <Search size={13} aria-hidden className="flex-none" />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
              aria-label="Search time zones"
              placeholder="Search city or region"
              value={q}
              maxLength={60}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3 max-[760px]:h-11 max-[760px]:text-[15px]"
            />
          </div>
          <div id={listId} role="listbox" aria-label="Time zones" className="max-h-[260px] overflow-auto p-1">
            {results.length === 0 ? (
              <p className="m-0 px-2 py-3.5 text-center text-[12px] text-fg-3">No matching time zones</p>
            ) : (
              results.map((tz, i) => (
                <div
                  key={tz}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={tz === value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(tz)}
                  className={cn(
                    "flex h-[30px] cursor-pointer items-center gap-2.5 rounded-sm px-2 text-[13px] font-medium max-[760px]:h-11",
                    i === current && "bg-hover",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{timeZoneLabel(tz)}</span>
                  <span className="font-mono text-[11px] font-normal text-fg-3">{timeZoneOffset(tz)}</span>
                  <Check size={14} strokeWidth={1.8} className={cn("flex-none text-accent-t", tz !== value && "invisible")} aria-hidden />
                </div>
              ))
            )}
            {matches.length > SHOWN && (
              <p className="m-0 px-2 py-2 text-[11.5px] text-fg-3">
                {matches.length - SHOWN} more · keep typing to narrow
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
