"use client";

import * as Popover from "@radix-ui/react-popover";
import { Bookmark, Calendar, ChevronDown, CircleDashed, Filter, Hexagon, Plus, RefreshCcw, SignalHigh, Tag, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { FilterField, FilterRule } from "@/lib/api/types";
import { useHotkeys } from "@/lib/hooks/use-hotkeys";
import { cn } from "@/lib/utils/cn";
import { shortDate } from "@/lib/utils/dates";
import { FILTER_FIELDS, MAX_RULES, OP_LABEL, completeRules, fieldLabel, isComplete, isMulti, newRule, opsFor, withOp } from "./filter-model";
import type { FilterOptions } from "./use-filters";

export const FIELD_ICON: Record<FilterField, ReactNode> = {
  status: <CircleDashed size={13} strokeWidth={1.6} aria-hidden />,
  priority: <SignalHigh size={13} strokeWidth={1.6} aria-hidden />,
  assignee: <UserRound size={13} strokeWidth={1.6} aria-hidden />,
  label: <Tag size={13} strokeWidth={1.6} aria-hidden />,
  sprint: <RefreshCcw size={13} strokeWidth={1.6} aria-hidden />,
  due: <Calendar size={13} strokeWidth={1.6} aria-hidden />,
  epic: <Hexagon size={13} strokeWidth={1.6} aria-hidden />,
};

const pickBtn =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-[7px] border border-line-2 bg-surface px-2.5 text-[12.5px] font-medium text-fg transition-[border-color,background-color] duration-[var(--dur-fast)] hover:border-control hover:bg-hover data-[state=open]:border-control data-[state=open]:bg-hover [&_svg]:flex-none [&_svg]:text-fg-3 max-[760px]:h-9";

/**
 * Filter bar (board 30): Filter button with count badge → builder (field · operator · value rows,
 * joined with AND), active chips, Clear all, match count and Save view. F opens, ⇧F clears.
 */
export function FilterBar({
  rules,
  onChange,
  opts,
  count,
  onSave,
  leading,
  trailing,
  className,
}: {
  rules: FilterRule[];
  onChange: (rules: FilterRule[]) => void;
  opts: FilterOptions;
  /** Tasks shown with the current filters; null while loading. */
  count: number | null;
  /** Shown when at least one filter is complete. */
  onSave?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const done = completeRules(rules);
  const live = done.length;

  useHotkeys({
    f: () => {
      setHighlight(null);
      setOpen(true);
    },
    "shift+f": () => rules.length && onChange([]),
  });

  return (
    <div className={cn("relative flex min-h-11 flex-none items-center gap-1.5 border-b border-line px-3 py-1.5 max-[760px]:flex-wrap", className)}>
      {leading}
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // Drop half-built rows when the builder closes.
          if (!o && rules.some((r) => !isComplete(r))) onChange(done);
        }}
      >
        <Popover.Trigger asChild>
          <Button size="sm" variant={live ? "secondary" : "ghost"} aria-haspopup="dialog" tooltip="Filter" tooltipKeys={["F"]}>
            <Filter size={13} aria-hidden /> Filter
            {live > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-s px-1 font-mono text-[10.5px] font-semibold text-accent-t" aria-label={`${live} active`}>
                {live}
              </span>
            )}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            collisionPadding={12}
            aria-label="Filter builder"
            role="dialog"
            className="z-[65] w-[548px] max-w-[calc(100vw-24px)] origin-[var(--radix-popover-content-transform-origin)] rounded-lg border border-line-2 bg-raised p-2 shadow-pop outline-none data-[state=open]:animate-[menu-in_180ms_var(--ease)]"
          >
            <Builder rules={rules} onChange={onChange} opts={opts} count={count} highlight={highlight} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <ul role="list" aria-label="Active filters" className="m-0 flex min-w-0 list-none items-center gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none]">
        {rules.map((r, i) =>
          isComplete(r) ? (
            <li
              key={`${r.field}-${i}`}
              className={cn(
                "inline-flex h-[26px] flex-none animate-[rise-in_200ms_var(--spring)] items-center rounded-[7px] border border-line-2 bg-surface transition-colors hover:border-control",
                open && highlight === i && "border-accent bg-accent-s",
              )}
            >
              <button
                type="button"
                aria-label={`Edit filter: ${opts.describe(r)}`}
                onClick={() => {
                  setHighlight(i);
                  setOpen(true);
                }}
                className="inline-flex h-6 items-center gap-[5px] whitespace-nowrap rounded-l-[6px] pl-2 pr-1 text-[12px] font-medium text-fg [&_svg]:text-fg-3"
              >
                {FIELD_ICON[r.field]}
                {fieldLabel(r.field)}
                <span className="font-normal text-fg-3">{OP_LABEL[r.op]}</span>
                {r.op !== "empty" && <span className="max-w-[180px] truncate">{opts.valuesText(r)}</span>}
              </button>
              <button
                type="button"
                aria-label={`Remove filter ${opts.describe(r)}`}
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
                className="flex h-6 w-[22px] items-center justify-center rounded-r-[6px] border-l border-line text-fg-3 hover:bg-hover hover:text-fg"
              >
                <X size={9} strokeWidth={2.2} aria-hidden />
              </button>
            </li>
          ) : null,
        )}
      </ul>
      {live > 0 && (
        <button type="button" onClick={() => onChange([])} className="h-6 flex-none rounded-[5px] px-1.5 text-[12.5px] font-medium text-accent-t hover:bg-accent-s">
          Clear all
        </button>
      )}
      <span className="flex-1" />
      <span className="flex-none font-mono text-[11.5px] font-medium text-fg-3" aria-live="polite">
        {count === null ? "—" : `${count} ${count === 1 ? "task" : "tasks"}`}
      </span>
      {onSave && live > 0 && (
        <Button size="sm" variant="secondary" aria-haspopup="dialog" onClick={onSave}>
          <Bookmark size={13} aria-hidden /> Save view
        </Button>
      )}
      {trailing}
    </div>
  );
}

function Builder({ rules, onChange, opts, count, highlight }: { rules: FilterRule[]; onChange: (r: FilterRule[]) => void; opts: FilterOptions; count: number | null; highlight: number | null }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState<number | null>(null);
  const set = (i: number, r: FilterRule) => onChange(rules.map((x, j) => (j === i ? r : x)));

  const addField = (field: FilterField) => {
    const i = rules.length;
    onChange([...rules, newRule(field)]);
    // After the Add menu has closed (it resets openMenu), open the new row's value picker.
    setTimeout(() => setOpenMenu(`v-${i}`), 0);
  };

  return (
    <div className="flex flex-col">
      {rules.length === 0 && <p className="m-0 px-2 py-2.5 text-[12.5px] text-fg-3">No filters yet</p>}
      {rules.map((r, i) => {
        const ok = isComplete(r);
        const values = opts.options(r.field);
        return (
          <div
            key={`${i}-${r.field}`}
            className={cn(
              "grid grid-cols-[44px_auto_auto_minmax(0,1fr)_26px] items-center gap-1.5 rounded-md p-1 max-[560px]:grid-cols-[auto_auto_minmax(0,1fr)_32px]",
              highlight === i && "bg-accent-s",
            )}
          >
            <span className="pr-1 text-right font-mono text-[11px] font-medium text-fg-3 max-[560px]:hidden">{i === 0 ? "Where" : "and"}</span>
            <Menu open={openMenu === `f-${i}`} onOpenChange={(o) => setOpenMenu(o ? `f-${i}` : null)}>
              <MenuTrigger asChild>
                <button type="button" aria-label={`Field: ${fieldLabel(r.field)}`} className={pickBtn}>
                  {FIELD_ICON[r.field]}
                  {fieldLabel(r.field)}
                </button>
              </MenuTrigger>
              <MenuContent align="start" width={200} aria-label="Field">
                <MenuRadioGroup
                  value={r.field}
                  onValueChange={(f) => {
                    if (f === r.field) return;
                    set(i, newRule(f as FilterField));
                    setTimeout(() => setOpenMenu(`v-${i}`), 0);
                  }}
                >
                  {FILTER_FIELDS.map((f) => (
                    <MenuRadioItem key={f.id} value={f.id} icon={<span className="flex size-4 items-center justify-center text-fg-3">{FIELD_ICON[f.id]}</span>}>
                      {f.label}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
            <Menu open={openMenu === `o-${i}`} onOpenChange={(o) => setOpenMenu(o ? `o-${i}` : null)}>
              <MenuTrigger asChild>
                <button type="button" aria-label={`Operator: ${OP_LABEL[r.op]}`} className={cn(pickBtn, "text-fg-2")}>
                  {OP_LABEL[r.op]}
                  <ChevronDown size={11} aria-hidden />
                </button>
              </MenuTrigger>
              <MenuContent align="start" width={170} aria-label="Operator">
                <MenuRadioGroup value={r.op} onValueChange={(op) => set(i, withOp(r, op as FilterRule["op"]))}>
                  {opsFor(r.field).map((op) => (
                    <MenuRadioItem key={op} value={op}>
                      {OP_LABEL[op]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
            {r.op === "empty" ? (
              <span />
            ) : r.field === "due" && customDate === i ? (
              <DatePicker
                defaultOpen
                value={/^\d{4}/.test(r.values[0] ?? "") ? r.values[0] : opts.ctx.today}
                onChange={(v) => v && set(i, { ...r, values: [v] })}
                onOpenChange={(o) => !o && setCustomDate(null)}
              >
                <button type="button" aria-label="Due date" className={cn(pickBtn, "justify-start border-accent font-mono")}>
                  <Calendar size={12} aria-hidden />
                  <span className="min-w-0 truncate">
                    {shortDate(/^\d{4}/.test(r.values[0] ?? "") ? r.values[0] : opts.ctx.today)}
                  </span>
                </button>
              </DatePicker>
            ) : (
              <Menu open={openMenu === `v-${i}`} onOpenChange={(o) => setOpenMenu(o ? `v-${i}` : null)}>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Value: ${ok ? opts.valuesText(r) : "pick a value"}`}
                    className={cn(pickBtn, "justify-start", !ok && "border-dashed bg-transparent text-fg-3")}
                  >
                    <span className="min-w-0 truncate">{ok ? opts.valuesText(r) : "Pick value"}</span>
                  </button>
                </MenuTrigger>
                <MenuContent
                  align="start"
                  width={230}
                  aria-label={fieldLabel(r.field)}
                  className="max-h-[320px] overflow-y-auto"
                >
                  {values.length === 0 && <p className="m-0 px-2 py-2 text-[12.5px] text-fg-3">Nothing to pick yet</p>}
                  {isMulti(r.op)
                    ? values.map((v) => (
                        <MenuCheckboxItem
                          key={v.id}
                          checked={r.values.includes(v.id)}
                          onSelect={(e) => e.preventDefault()}
                          onCheckedChange={(c) => set(i, { ...r, values: c ? [...r.values, v.id] : r.values.filter((x) => x !== v.id) })}
                          icon={v.icon}
                        >
                          <span className="flex items-center justify-between gap-2">
                            {v.label}
                            {v.meta && <span className="font-mono text-[11px] text-fg-3">{v.meta}</span>}
                          </span>
                        </MenuCheckboxItem>
                      ))
                    : (
                      <MenuRadioGroup value={r.values[0] ?? ""} onValueChange={(v) => set(i, { ...r, values: [v] })}>
                        {values.map((v) => (
                          <MenuRadioItem key={v.id} value={v.id} icon={v.icon} meta={v.meta}>
                            {v.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    )}
                  {r.field === "due" && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Calendar size={13} aria-hidden />} onSelect={() => setCustomDate(i)}>
                        Pick a date…
                      </MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            )}
            <button
              type="button"
              aria-label={`Remove ${fieldLabel(r.field)} filter`}
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
              className="flex size-[26px] items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg max-[760px]:size-8"
            >
              <X size={11} strokeWidth={2} aria-hidden />
            </button>
          </div>
        );
      })}
      <div className="mt-1 flex items-center gap-2 border-t border-line px-1 pb-0.5 pt-1.5">
        {rules.length < MAX_RULES && (
          <Menu open={openMenu === "add"} onOpenChange={(o) => setOpenMenu(o ? "add" : null)}>
            <MenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <Plus size={13} aria-hidden /> Add filter
              </Button>
            </MenuTrigger>
            <MenuContent align="start" width={200} aria-label="Field">
              {FILTER_FIELDS.map((f) => (
                <MenuItem key={f.id} icon={FIELD_ICON[f.id]} onSelect={() => addField(f.id)}>
                  {f.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[11.5px] font-medium text-fg-3">{count === null ? "—" : `${count} ${count === 1 ? "task" : "tasks"}`}</span>
      </div>
      <FocusHighlight index={highlight} />
    </div>
  );
}

/** Moves focus to the highlighted row's value button when the builder opens from a chip. */
function FocusHighlight({ index }: { index: number | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (index === null) return;
    const root = ref.current?.parentElement;
    const row = root?.children[index] as HTMLElement | undefined;
    row?.querySelector<HTMLElement>("button[aria-label^='Value'], button[aria-label^='Operator']")?.focus();
  }, [index]);
  return <span ref={ref} hidden />;
}
