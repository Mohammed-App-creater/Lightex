"use client";

import * as Popover from "@radix-ui/react-popover";
import { Calendar, Check, ChevronDown, Download } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import type { Project } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { defaultCustom, normalizeCustom, RANGE_OPTIONS, rangeLabel, type RangeState } from "./lib";

/* Header controls of board 17: project select, date range, export. */

export const selClass = cn(
  "inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-2.5 text-[13px] font-medium text-fg",
  "transition-[background-color,border-color] duration-[var(--dur-fast)] ease-out hover:border-control hover:bg-hover",
  "data-[state=open]:border-control data-[state=open]:bg-hover max-[760px]:h-11",
);

export const projectCode = (key: string) => key.slice(0, 2).toUpperCase();

export function ProjectSelect({
  projects,
  current,
  onChange,
}: {
  projects: Pick<Project, "id" | "key" | "name" | "hue">[];
  current: Pick<Project, "key" | "name" | "hue">;
  onChange: (key: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={`Project: ${current.name}`} className={cn(selClass, "min-w-0 @max-[760px]:basis-full")}>
          <ProjectBadge code={projectCode(current.key)} hue={current.hue} />
          <span className="min-w-0 truncate">{current.name}</span>
          <ChevronDown size={14} className="ml-auto text-fg-3" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={240}>
        <MenuRadioGroup value={current.key} onValueChange={onChange}>
          {projects.map((p) => (
            <MenuRadioItem key={p.id} value={p.key} icon={<ProjectBadge code={projectCode(p.key)} hue={p.hue} />}>
              {p.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

const itemClass =
  "flex h-[30px] w-full items-center gap-2.5 rounded-sm px-2 text-left text-[13px] font-medium text-fg outline-none hover:bg-hover focus-visible:bg-hover max-[1023px]:h-11";

export function RangeSelect({
  value,
  today,
  onChange,
}: {
  value: RangeState;
  today: string;
  onChange: (r: RangeState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(value.range === "custom");
  const def = defaultCustom(today);
  const [from, setFrom] = useState(value.from ?? def.from);
  const [to, setTo] = useState(value.to ?? def.to);
  const listRef = useRef<HTMLDivElement>(null);
  const rid = useId();

  const pick = (r: RangeState) => {
    onChange(r);
    setOpen(false);
  };

  // Arrow keys move between the options (menu-like roving focus).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // The custom-range form (date pickers, Apply) keeps its own keyboard handling.
    if ((e.target as HTMLElement).closest("form")) return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-ri]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setCustom(value.range === "custom");
          setFrom(value.from ?? def.from);
          setTo(value.to ?? def.to);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" aria-label={`Date range: ${rangeLabel(value)}`} className={cn(selClass, "@max-[760px]:flex-1")}>
          <Calendar size={16} strokeWidth={1.5} className="text-fg-2" aria-hidden />
          <span>{rangeLabel(value)}</span>
          <ChevronDown size={14} className="ml-auto text-fg-3" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            listRef.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
          }}
          className="z-[70] w-[228px] rounded-md border border-line-2 bg-raised p-1 text-fg shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <div ref={listRef} role="menu" aria-label="Date range" onKeyDown={onKeyDown}>
            {RANGE_OPTIONS.map((o) => {
              const on = value.range === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  data-ri
                  className={itemClass}
                  onClick={() => pick({ range: o.value })}
                >
                  <span className="flex-1">{o.label}</span>
                  {on && <Check size={16} strokeWidth={1.8} className="text-accent-t" aria-hidden />}
                </button>
              );
            })}
            <div role="separator" className="-mx-1 my-1 h-px bg-line" />
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value.range === "custom"}
              aria-expanded={custom}
              data-ri
              className={itemClass}
              onClick={() => setCustom((c) => !c)}
            >
              <span className="flex-1">Custom range</span>
              {value.range === "custom" && <Check size={16} strokeWidth={1.8} className="text-accent-t" aria-hidden />}
            </button>
            {custom && (
              <form
                className="flex flex-col gap-2 px-2 pb-2 pt-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  pick({ range: "custom", ...normalizeCustom(from, to, today) });
                }}
              >
                <div className="flex items-center justify-between gap-2.5 text-[12px] text-fg-2">
                  <span id={`${rid}-from`}>From</span>
                  <DatePicker
                    size="sm"
                    className="w-[132px] max-[1023px]:[&>button]:h-11"
                    aria-labelledby={`${rid}-from`}
                    max={today}
                    value={from}
                    onChange={(v) => v && setFrom(v)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2.5 text-[12px] text-fg-2">
                  <span id={`${rid}-to`}>To</span>
                  <DatePicker
                    size="sm"
                    className="w-[132px] max-[1023px]:[&>button]:h-11"
                    aria-labelledby={`${rid}-to`}
                    min={from || undefined}
                    max={today}
                    value={to}
                    onChange={(v) => v && setTo(v)}
                  />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" variant="secondary">
                    Apply
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ExportMenu({ onCsv, busy }: { onCsv: () => void; busy: string | null }) {
  return (
    <div className="flex items-center gap-2 @max-[760px]:ml-auto">
      {busy && (
        <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-fg-2">
          <Spinner />
          {busy}
        </span>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button variant="primary" className="max-[760px]:h-11" disabled={!!busy}>
            <Download size={16} strokeWidth={1.5} aria-hidden />
            Export
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={200}>
          <MenuItem meta="data" onSelect={onCsv}>
            CSV
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled meta="Coming soon">
            PNG
          </MenuItem>
          <MenuItem disabled meta="Coming soon">
            PDF
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
