"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { PriorityIcon, StatusGlyph, glyphColor, priorityMeta, type GlyphKind, type PriorityLevel } from "./glyphs";

/** Outline badge (board 03 .badge): 22px, glyph tinted, label in --text. */
export function Badge({ children, className, color }: { children: ReactNode; className?: string; color?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-sm border border-line-2 px-2 text-[12px] font-medium text-fg-2",
        className,
      )}
      style={color ? { color } : undefined}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ kind, name }: { kind: GlyphKind; name: string }) {
  return (
    <Badge color={glyphColor[kind]}>
      <StatusGlyph kind={kind} />
      <span className="text-fg">{name}</span>
    </Badge>
  );
}

export function PriorityBadge({ level }: { level: PriorityLevel }) {
  const meta = priorityMeta[level];
  return (
    <Badge color={meta.color}>
      <PriorityIcon level={level} />
      <span className="text-fg">{meta.label}</span>
    </Badge>
  );
}

/** Linked entity chip (epic, milestone, sprint, objective). */
export function EntityChip({
  icon,
  children,
  className,
  size = "md",
}: {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap bg-raised font-medium text-fg-2",
        size === "sm" ? "h-5 rounded-[5px] px-1.5 text-[11px]" : "h-[22px] rounded-sm pl-1.5 pr-2 text-[12px]",
        className,
      )}
    >
      {icon && <span className="flex text-accent-t">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Label chip with a colour dot. */
export function LabelChip({
  name,
  color,
  size = "md",
  className,
}: {
  name: string;
  color: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap border border-line bg-raised font-medium text-fg-2",
        size === "sm" ? "h-5 rounded-[5px] px-1.5 text-[11px]" : "h-[22px] rounded-sm px-2 text-[12px]",
        className,
      )}
    >
      <span aria-hidden className="size-[7px] flex-none rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

/** Task key, click to copy (board 03). Shows "Copied" for 1400ms. */
export function CopyKey({
  value,
  label,
  className,
  size = "md",
}: {
  value: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={`Copy task key ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1400);
        }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xs border border-transparent font-mono font-medium text-fg-2",
          "transition-[background-color,color] duration-[var(--dur-fast)] ease-out hover:bg-hover hover:text-fg",
          size === "sm" ? "h-5 px-[5px] text-[11px] text-fg-3" : "h-[22px] px-1.5 text-[12px]",
          className,
        )}
      >
        {label ?? value}
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} strokeWidth={1.6} aria-hidden />}
      </button>
      <span role="status" aria-live="polite" className={cn("text-[12px] text-ok", !copied && "sr-only")}>
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
