"use client";

import type { CSSProperties } from "react";
import { initialsOf } from "@/components/ui/avatar";
import type { PresencePerson, User } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { groupLabel, personLabel } from "./presence-lib";

/*
 * The design's `pr` stack (§1.5): others (by arrival) with the pulsing live ring in their hue and a
 * green dot, at most 4 then "+N", and you last without a ring ("Alex Kim, you"). Rendered only
 * when at least one other person is present. Sizes 26 (headers) and 20 (cards, phones).
 */

export function PresenceStack({
  others,
  me,
  size = 26,
  label,
  max = 4,
  editingWhat,
  dot = size === 26,
  className,
  bg,
}: {
  others: readonly PresencePerson[];
  me?: Pick<User, "id" | "name" | "hue"> | null;
  size?: 26 | 20;
  /** Group label; defaults to "Jordan and Riley are here". */
  label?: string;
  max?: number;
  /** "the layout" → "Jordan Lee, editing the layout". */
  editingWhat?: string;
  dot?: boolean;
  className?: string;
  /** The surface behind the stack (the avatar ring gap); defaults to --bg. */
  bg?: string;
}) {
  if (!others.length) return null;
  const shown = others.slice(0, max);
  const extra = others.length - shown.length;
  const sm = size === 20;
  return (
    <span role="group" aria-label={label ?? groupLabel(others)} className={cn("pr", className)} style={bg ? ({ "--pr-bg": bg } as CSSProperties) : undefined}>
      {shown.map((p) => {
        const text = personLabel(p, { editingWhat });
        return (
          <span key={p.user.id} role="img" aria-label={text} title={text} className={cn("pr-av live", sm && "sm")} style={{ "--hue": p.user.hue } as CSSProperties}>
            {initialsOf(p.user.name)}
            {dot && <span aria-hidden className="pr-dot" />}
          </span>
        );
      })}
      {extra > 0 && (
        <span className={cn("pr-more", sm && "sm")} role="img" aria-label={`${extra} more`} title={others.slice(max).map((p) => p.user.name).join(", ")}>
          +{extra}
        </span>
      )}
      {me && (
        <span role="img" aria-label={`${me.name}, you`} title={`${me.name}, you`} className={cn("pr-av", sm && "sm")} style={{ "--hue": me.hue } as CSSProperties}>
          {initialsOf(me.name)}
        </span>
      )}
    </span>
  );
}

/** A single live-ringed avatar (toasts). */
export function LiveAvatar({ person, className }: { person: Pick<User, "name" | "hue">; className?: string }) {
  return (
    <span aria-hidden className={cn("pr-av live sm", className)} style={{ "--hue": person.hue, marginLeft: 0 } as CSSProperties}>
      {initialsOf(person.name)}
    </span>
  );
}
