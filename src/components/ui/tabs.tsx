"use client";

import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { t } from "@/lib/motion";
import { Kbd } from "./kbd";

export type TabItem<T extends string> = { value: T; label: ReactNode; count?: number; kbd?: string };

/**
 * State tabs with a sliding accent indicator (board 04: "indicator slides, content crossfades").
 * Implements the WAI-ARIA tabs pattern with arrow-key roving focus.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
  idBase,
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  label: string;
  className?: string;
  /** Prefix for tab/panel ids; pair with <TabPanel idBase value>. */
  idBase?: string;
}) {
  const auto = useId();
  const base = idBase ?? auto;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = items.length;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = n - 1;
    if (next >= 0) {
      e.preventDefault();
      refs.current[next]?.focus();
      onChange(items[next]!.value);
    }
  };
  return (
    <LayoutGroup id={base}>
      <div role="tablist" aria-label={label} className={cn("relative inline-flex border-b border-line", className)}>
        {items.map((it, i) => {
          const selected = it.value === value;
          return (
            <button
              key={it.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`${base}-tab-${it.value}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel-${it.value}`}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(e) => onKey(e, i)}
              onClick={() => onChange(it.value)}
              className={cn(
                "relative inline-flex h-9 items-center justify-center gap-2 rounded-t-sm px-3 text-[13px] font-medium text-fg-2",
                "transition-[color,background-color] duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg",
                selected && "text-fg",
              )}
            >
              {it.label}
              {it.count !== undefined && (
                <span className="font-mono text-[11px] font-medium text-fg-3">{it.count}</span>
              )}
              {it.kbd && <Kbd>{it.kbd}</Kbd>}
              {selected && (
                <motion.span
                  layoutId="tab-indicator"
                  transition={{ type: "spring", stiffness: 520, damping: 38 }}
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
                />
              )}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

export function TabPanel<T extends string>({
  idBase,
  value,
  children,
  className,
}: {
  idBase: string;
  value: T;
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      key={value}
      id={`${idBase}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${idBase}-tab-${value}`}
      tabIndex={0}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={t.base}
      className={cn("focus-visible:rounded-md", className)}
    >
      {children}
    </motion.div>
  );
}

/** Navigation tabs (project views). Links, with aria-current and the sliding underline. */
export function NavTabs({
  items,
  label,
  className,
}: {
  items: { href: string; label: ReactNode; active: boolean; kbd?: string }[];
  label: string;
  className?: string;
}) {
  return (
    <LayoutGroup id={`nav-${label}`}>
      <nav aria-label={label} className={cn("-mb-px flex gap-0.5 overflow-x-auto border-b border-line", className)}>
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            aria-current={it.active ? "page" : undefined}
            className={cn(
              "relative inline-flex h-9 flex-none items-center gap-2 whitespace-nowrap rounded-t-sm px-3 text-[13px] font-medium text-fg-2",
              "transition-[color,background-color] duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg",
              it.active && "text-fg",
            )}
          >
            {it.label}
            {it.active && (
              <motion.span
                layoutId="navtab-indicator"
                transition={{ type: "spring", stiffness: 520, damping: 38 }}
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent"
              />
            )}
          </Link>
        ))}
      </nav>
    </LayoutGroup>
  );
}

/** Filter pills with a sliding background (board 04 .pills). */
export function FilterPills<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode; count?: number }[];
  label: string;
  className?: string;
}) {
  const id = useId();
  return (
    <LayoutGroup id={id}>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn("relative inline-flex rounded-md border border-line bg-raised p-[3px]", className)}
      >
        {items.map((it) => {
          const on = it.value === value;
          return (
            <button
              key={it.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(it.value)}
              className={cn(
                "relative z-[1] inline-flex h-[26px] items-center justify-center gap-1.5 rounded-sm px-3 text-[12px] font-medium text-fg-2",
                "transition-colors duration-[var(--dur-fast)] ease-out hover:text-fg",
                on && "text-fg",
              )}
            >
              {on && (
                <motion.span
                  layoutId="pill-bg"
                  transition={{ type: "spring", stiffness: 520, damping: 38 }}
                  className="absolute inset-0 -z-[1] rounded-sm bg-hover shadow-[inset_0_0_0_1px_var(--line-2)]"
                />
              )}
              {it.label}
              {it.count !== undefined && <span className="font-mono text-[11px] text-fg-3">{it.count}</span>}
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
