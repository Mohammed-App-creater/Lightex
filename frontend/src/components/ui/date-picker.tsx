"use client";

import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils/cn";
import { addDaysISO, shortDate, todayISO } from "@/lib/utils/dates";

/*
 * DatePicker: a token-styled replacement for the native <input type="date"> (whose popup uses the
 * OS font and accent). Values stay ISO calendar dates (YYYY-MM-DD) so callers keep their semantics.
 * The trigger matches Select/Input; the popover holds a Monday-first month grid with roving focus
 * (arrows, PageUp/PageDown, Home/End, Enter/Space; Escape closes) and an optional quick-chip slot.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = [
  ["Mo", "Monday"],
  ["Tu", "Tuesday"],
  ["We", "Wednesday"],
  ["Th", "Thursday"],
  ["Fr", "Friday"],
  ["Sa", "Saturday"],
  ["Su", "Sunday"],
] as const;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const yearOf = (iso: string) => Number(iso.slice(0, 4));
const monthOf = (iso: string) => Number(iso.slice(5, 7)) - 1;
const dayOf = (iso: string) => Number(iso.slice(8, 10));
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
/** Monday = 0 … Sunday = 6. */
const weekdayOf = (iso: string) => (new Date(yearOf(iso), monthOf(iso), dayOf(iso)).getDay() + 6) % 7;

function clamp(iso: string, min?: string, max?: string) {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/** Same day-of-month `delta` months away, clamped to that month's length. */
function addMonthsISO(iso: string, delta: number) {
  const total = yearOf(iso) * 12 + monthOf(iso) + delta;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  return toISO(y, m, Math.min(dayOf(iso), daysIn(y, m)));
}

function longLabel(iso: string) {
  const wd = WEEKDAYS[weekdayOf(iso)]![1];
  return `${wd}, ${MONTHS[monthOf(iso)]} ${dayOf(iso)}, ${yearOf(iso)}`;
}

/* ───────── Calendar (month grid) ───────── */

export type CalendarProps = {
  value: string | null | undefined;
  onSelect: (iso: string) => void;
  min?: string;
  max?: string;
  /** Move focus to the selected (or today's) day on mount. */
  autoFocus?: boolean;
  className?: string;
};

export function Calendar({ value, onSelect, min, max, autoFocus, className }: CalendarProps) {
  const today = todayISO();
  const selected = value && ISO_RE.test(value) ? value : null;
  const [focus, setFocus] = useState(() => clamp(selected ?? today, min, max));
  const [view, setView] = useState(() => focus.slice(0, 7));
  const gridRef = useRef<HTMLDivElement>(null);
  const moveDomFocus = useRef(Boolean(autoFocus));

  const vy = Number(view.slice(0, 4));
  const vm = Number(view.slice(5, 7)) - 1;
  const first = toISO(vy, vm, 1);
  const start = addDaysISO(first, -weekdayOf(first));
  const days = Array.from({ length: 42 }, (_, i) => addDaysISO(start, i));
  // The roving tab stop must be a day that is on screen.
  const tabStop = focus.slice(0, 7) === view ? focus : clamp(first, min, max);

  useEffect(() => {
    if (!moveDomFocus.current) return;
    moveDomFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${tabStop}"]`)?.focus({ preventScroll: true });
  }, [tabStop]);

  const goTo = (iso: string, domFocus: boolean) => {
    const next = clamp(iso, min, max);
    moveDomFocus.current = domFocus;
    setFocus(next);
    setView(next.slice(0, 7));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = tabStop;
    let next: string | null = null;
    if (e.key === "ArrowLeft") next = addDaysISO(from, -1);
    else if (e.key === "ArrowRight") next = addDaysISO(from, 1);
    else if (e.key === "ArrowUp") next = addDaysISO(from, -7);
    else if (e.key === "ArrowDown") next = addDaysISO(from, 7);
    else if (e.key === "Home") next = addDaysISO(from, -weekdayOf(from));
    else if (e.key === "End") next = addDaysISO(from, 6 - weekdayOf(from));
    else if (e.key === "PageUp") next = addMonthsISO(from, e.shiftKey ? -12 : -1);
    else if (e.key === "PageDown") next = addMonthsISO(from, e.shiftKey ? 12 : 1);
    if (!next) return;
    // Handled here: keep arrows away from surrounding menus/lists (portals bubble in React).
    e.preventDefault();
    e.stopPropagation();
    goTo(next, true);
  };

  const prevMonth = addMonthsISO(first, -1);
  const nextMonth = addMonthsISO(first, 1);
  const prevDisabled = Boolean(min && addDaysISO(first, -1) < min);
  const nextDisabled = Boolean(max && nextMonth > max);
  const navBtn =
    "flex size-7 items-center justify-center rounded-sm text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent max-[760px]:size-10";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous month"
          disabled={prevDisabled}
          onClick={() => goTo(prevMonth, false)}
          className={navBtn}
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
        <span aria-live="polite" className="flex-1 text-center text-[13px] font-semibold text-fg">
          {MONTHS[vm]} {vy}
        </span>
        <button
          type="button"
          aria-label="Next month"
          disabled={nextDisabled}
          onClick={() => goTo(nextMonth, false)}
          className={navBtn}
        >
          <ChevronRight size={14} aria-hidden />
        </button>
      </div>
      <div ref={gridRef} role="grid" aria-label={`${MONTHS[vm]} ${vy}`} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
        <div role="row" className="grid grid-cols-7">
          {WEEKDAYS.map(([short, long]) => (
            <span
              key={short}
              role="columnheader"
              aria-label={long}
              className="flex h-6 items-center justify-center text-[11px] font-medium text-fg-3"
            >
              {short}
            </span>
          ))}
        </div>
        {[0, 1, 2, 3, 4, 5].map((w) => (
          <div key={w} role="row" className="grid grid-cols-7 gap-0.5">
            {days.slice(w * 7, w * 7 + 7).map((iso) => {
              const out = iso.slice(0, 7) !== view;
              const isSel = iso === selected;
              const isToday = iso === today;
              const disabled = Boolean((min && iso < min) || (max && iso > max));
              return (
                <span key={iso} role="gridcell" aria-selected={isSel} className="flex justify-center">
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={iso === tabStop ? 0 : -1}
                    disabled={disabled}
                    aria-label={longLabel(iso)}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => onSelect(iso)}
                    onFocus={() => !out && iso !== focus && setFocus(iso)}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-sm text-[12.5px] font-medium tabular text-fg",
                      "transition-[background-color,color] duration-[var(--dur-fast)] ease-out hover:bg-hover",
                      "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent max-[760px]:size-10",
                      out && "text-fg-3",
                      isToday && !isSel && "text-accent-t shadow-[inset_0_0_0_1px_var(--accent)]",
                      isSel && "on-accent bg-accent font-semibold text-white hover:bg-accent-h",
                    )}
                  >
                    {dayOf(iso)}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── quick chips ───────── */

/** Small chip for the DatePicker quick slot (Today, Tomorrow, Sprint end, Clear…). */
export function DateChip({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-6 max-w-full truncate rounded-sm border border-line bg-surface px-2 text-[12px] font-medium text-fg transition-colors duration-[var(--dur-fast)] hover:bg-hover max-[760px]:h-9"
    >
      {children}
    </button>
  );
}

/* ───────── DatePicker (trigger + popover) ───────── */

export type DatePickerProps = {
  /** ISO date (YYYY-MM-DD); "" or null = no date. */
  value: string | null | undefined;
  onChange: (iso: string | null) => void;
  placeholder?: string;
  size?: "sm" | "md";
  min?: string;
  max?: string;
  /** Show an inline clear (×) on the default trigger when a date is set. */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  onBlur?: () => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  /** Quick actions under the grid. `pick` sets the value and closes. */
  quick?: (pick: (iso: string | null) => void) => ReactNode;
  /** Custom trigger (rendered via Popover.Trigger asChild). Replaces the default field trigger. */
  children?: ReactElement;
};

export const DatePicker = forwardRef<HTMLButtonElement, DatePickerProps>(function DatePicker(
  {
    value,
    onChange,
    placeholder = "Pick a date",
    size = "md",
    min,
    max,
    clearable,
    disabled,
    id,
    name,
    className,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    onBlur,
    open: openProp,
    defaultOpen,
    onOpenChange,
    align = "start",
    quick,
    children,
  },
  ref,
) {
  const [openState, setOpenState] = useState(Boolean(defaultOpen));
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    if (openProp === undefined) setOpenState(o);
    onOpenChange?.(o);
  };
  const date = value && ISO_RE.test(value) ? value : null;
  const pick = (iso: string | null) => {
    onChange(iso);
    setOpen(false);
  };
  const showClear = Boolean(clearable && date && !disabled && !children);

  const trigger = children ?? (
    <button
      ref={ref}
      type="button"
      id={id}
      name={name}
      disabled={disabled}
      aria-label={ariaLabel ? `${ariaLabel}: ${date ? shortDate(date) : "none"}` : undefined}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      // aria-invalid isn't valid on a button; the Field error is still linked via aria-describedby.
      data-invalid={ariaInvalid === true || ariaInvalid === "true" ? "" : undefined}
      aria-haspopup="dialog"
      onBlur={onBlur}
      className={cn(
        "inline-flex w-full min-w-0 items-center gap-2 rounded-sm border border-control bg-surface px-2.5 text-left text-fg",
        "transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-out hover:border-fg-3",
        "data-[state=open]:border-accent data-[state=open]:shadow-[0_0_0_3px_var(--ring)]",
        "disabled:cursor-not-allowed disabled:border-line disabled:bg-raised disabled:text-fg-3 disabled:hover:border-line",
        "data-[invalid]:border-danger",
        size === "sm" ? "h-7 text-[12px]" : "h-8 text-[13px] max-[1023px]:h-11",
        showClear && "pr-8",
      )}
    >
      <CalendarDays size={14} strokeWidth={1.6} className="flex-none text-fg-3" aria-hidden />
      <span className={cn("min-w-0 flex-1 truncate", date ? "font-mono font-medium" : "text-fg-3")}>
        {date ? shortDate(date) : placeholder}
      </span>
    </button>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {children ? (
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      ) : (
        <span className={cn("relative block min-w-0", className)}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          {showClear && (
            <button
              type="button"
              aria-label="Clear date"
              onClick={() => onChange(null)}
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg max-[1023px]:size-8"
            >
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          )}
        </span>
      )}
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label="Choose date"
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[70] flex w-max max-w-[calc(100vw-16px)] flex-col gap-2 rounded-[10px] border border-line-2 bg-raised p-2.5 text-fg shadow-pop outline-none data-[state=open]:animate-[menu-in_150ms_var(--ease)]"
        >
          <Calendar value={date} onSelect={pick} min={min} max={max} autoFocus />
          {quick && <div className="flex w-0 min-w-full flex-wrap gap-1.5 border-t border-line pt-2">{quick(pick)}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});
