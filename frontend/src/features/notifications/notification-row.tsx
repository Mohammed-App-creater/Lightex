"use client";

import { forwardRef } from "react";
import { Avatar } from "@/components/ui/avatar";
import { StatusGlyph, glyphColor } from "@/components/ui/glyphs";
import type { Notification, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ago } from "@/lib/utils/dates";
import { glyphForStatusName, isSystem, lineParts, rowLabel, subjectOf } from "./events";
import { CheckIcon, EventIcon, HollowCircleIcon, OpenIcon } from "./icons";

/** 30px actor avatar with the event badge, or the rounded system tile. */
export function WhoTile({ n, actor, size = 30 }: { n: Notification; actor: User | null; size?: 30 | 24 }) {
  if (isSystem(n) || !actor) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex flex-none items-center justify-center border border-line-2 bg-raised",
          size === 30 ? "size-[30px] rounded-md" : "size-6 rounded-[6px]",
        )}
      >
        <EventIcon type={n.type} size={size === 30 ? 15 : 13} />
      </span>
    );
  }
  return (
    <span aria-hidden className="relative inline-flex flex-none">
      <Avatar name={actor.name} hue={actor.hue} size={size} ring={false} decorative />
      {size === 30 && (
        <span className="absolute -bottom-1 -right-[5px] flex size-[17px] items-center justify-center rounded-full border border-line-2 bg-surface">
          <EventIcon type={n.type} size={10} stroke={1.8} />
        </span>
      )}
    </span>
  );
}

export function InlineStatus({ name }: { name: string }) {
  const kind = glyphForStatusName(name);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <StatusGlyph kind={kind} className="size-3" color={glyphColor[kind]} />
      <span className="truncate text-fg">{name}</span>
    </span>
  );
}

type RowProps = {
  n: Notification;
  actor: User | null;
  selected: boolean;
  /** Stagger index for the Mark-all-read dot fade (null = no stagger). */
  stagger: number | null;
  onOpen: () => void;
  onToggleRead: () => void;
  onFocusRow: () => void;
  now: number;
};

export const NotificationRow = forwardRef<HTMLButtonElement, RowProps>(function NotificationRow(
  { n, actor, selected, stagger, onOpen, onToggleRead, onFocusRow, now },
  ref,
) {
  const read = Boolean(n.readAt);
  const { lead, verb } = lineParts(n, actor?.name ?? null);
  const subject = subjectOf(n);
  const toggleLabel = read ? "Mark unread" : "Mark read";

  return (
    <li
      data-row={n.id}
      className={cn(
        "group relative grid min-h-[60px] grid-cols-[12px_36px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md py-2 pl-2.5 pr-3.5",
        "transition-[background-color] duration-150 ease-out max-[760px]:min-h-[68px] [@media(hover:none)]:min-h-[68px]",
        selected ? "bg-accent-s" : "hover:bg-hover",
      )}
    >
      <button
        ref={ref}
        type="button"
        data-hit
        aria-label={rowLabel(n, actor?.name ?? null, now)}
        aria-current={selected || undefined}
        onClick={onOpen}
        onFocus={onFocusRow}
        className="absolute inset-0 z-0 rounded-md"
      />
      {/* Col 1: unread dot */}
      <span aria-hidden className="pointer-events-none relative z-[1] flex justify-center">
        <span
          className={cn(
            "size-2 rounded-full bg-accent-t transition-[transform,opacity] ease-out",
            read ? "scale-0 opacity-0" : "scale-100 opacity-100",
          )}
          style={{
            transitionDuration: "220ms, 180ms",
            transitionDelay: stagger !== null ? `${stagger * 45}ms` : undefined,
          }}
        />
      </span>
      {/* Col 2: who */}
      <span aria-hidden className="pointer-events-none relative z-[1] flex justify-center">
        <WhoTile n={n} actor={actor} />
      </span>
      {/* Col 3: text */}
      <span aria-hidden className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] leading-[17px] text-fg-2">
          <b
            className={cn(
              "flex-none transition-colors duration-200",
              read ? "font-medium text-fg-2" : "font-semibold text-fg",
            )}
          >
            {lead}
          </b>
          {verb && <span className="truncate">{verb}</span>}
          {n.type === "status" && n.payload.toStatus && <InlineStatus name={n.payload.toStatus} />}
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-4">
          {subject.key && <span className="flex-none font-mono text-[11.5px] text-fg-3">{subject.key}</span>}
          <span className={cn("truncate transition-colors duration-200", read ? "text-fg-2" : "text-fg")}>{subject.title}</span>
        </span>
        {n.payload.quote && (
          <span className="truncate text-[12.5px] leading-4 text-fg-3">“{n.payload.quote}”</span>
        )}
      </span>
      {/* Col 4: time */}
      <span
        aria-hidden
        className="pointer-events-none relative z-[1] font-mono text-[11px] text-fg-3 transition-opacity duration-150 min-[761px]:group-focus-within:opacity-0 min-[761px]:group-hover:opacity-0 [@media(hover:none)]:!opacity-100"
      >
        {ago(n.createdAt, now)}
      </span>
      {/* Hover actions */}
      <span
        className={cn(
          "absolute right-2.5 top-1/2 z-[2] -mt-[15px] flex translate-x-1 gap-0.5 rounded-md opacity-0",
          "pointer-events-none transition-[opacity,transform] ease-out [transition-duration:120ms,160ms]",
          "group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100",
          "group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100",
          "max-[760px]:hidden [@media(hover:none)]:hidden",
          selected ? "bg-transparent" : "bg-hover",
        )}
      >
        <button
          type="button"
          aria-label={toggleLabel}
          title={`${toggleLabel} (E)`}
          onClick={onToggleRead}
          onFocus={onFocusRow}
          className="inline-flex size-[30px] items-center justify-center rounded-[7px] text-fg-2 hover:bg-raised hover:text-fg"
        >
          {read ? <HollowCircleIcon /> : <CheckIcon />}
        </button>
        <button
          type="button"
          aria-label={subject.key ? `Open ${subject.key}` : "Open"}
          title="Open task (↵)"
          onClick={onOpen}
          onFocus={onFocusRow}
          className="inline-flex size-[30px] items-center justify-center rounded-[7px] text-fg-2 hover:bg-raised hover:text-fg"
        >
          <OpenIcon />
        </button>
      </span>
    </li>
  );
});

