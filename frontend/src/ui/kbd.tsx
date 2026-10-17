"use client";

import { Fragment } from "react";
import { cn } from "@/lib/utils/cn";
import { formatKeys, useIsMac } from "@/lib/hooks/use-platform";

/** A single keycap. "⌘"/"Mod" render as ⌘ on Apple platforms and Ctrl elsewhere. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  const isMac = useIsMac();
  const [label] = formatKeys([children], isMac);
  return <kbd className={cn("kbd", className)}>{label}</kbd>;
}

/**
 * A shortcut made of keys. `keys` is a list of keycaps pressed together, e.g. ["⌘", "K"].
 * `sequence` renders "G then B" style chords.
 */
export function Shortcut({
  keys,
  sequence,
  className,
}: {
  keys: string[];
  sequence?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((k, i) => (
        <Fragment key={`${k}-${i}`}>
          {sequence && i > 0 && <span className="text-[11px] text-fg-3">then</span>}
          <Kbd>{k}</Kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** Plain-text form of a shortcut for aria-keyshortcuts / titles. */
export function shortcutText(keys: string[], isMac: boolean, sequence = false) {
  return formatKeys(keys, isMac).join(sequence ? " then " : "+");
}
