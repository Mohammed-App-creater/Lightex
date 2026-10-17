"use client";

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { PresencePerson } from "@/lib/api/types";
import { initialsOf } from "@/components/ui/avatar";
import { cn } from "@/lib/utils/cn";
import { canonicalField, firstName } from "./presence-lib";

/* The design's `pr-edit` pill, field `flag`, description border and `cm-ty` typing row (§1.5). */

const PencilIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" />
  </svg>
);
const GridIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 3h4.5v4.5H2.5zM9 3h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />
  </svg>
);

/** "Jordan is editing" / "Jordan is editing the layout", in the first editor's hue. Information only. */
export function EditingPill({ person, label, icon = "pencil", className }: { person: PresencePerson; label: string; icon?: "pencil" | "grid"; className?: string }) {
  return (
    <span role="status" className={cn("pr-edit animate-[fade-in_180ms_var(--ease)]", className)} style={{ "--hue": person.user.hue } as CSSProperties}>
      {icon === "grid" ? <GridIcon /> : <PencilIcon />}
      {label}
    </span>
  );
}

/* ───────── field flags (task panel) ───────── */

type FlagCtx = { flags: ReadonlyMap<string, PresencePerson>; flash: ReadonlySet<string> };
const FieldFlagCtx = createContext<FlagCtx>({ flags: new Map(), flash: new Set() });

/** Field flags of the open task, and the fields to flash after someone else changed them. */
export function FieldFlagProvider({ flags, flash, children }: { flags: ReadonlyMap<string, PresencePerson>; flash: ReadonlySet<string>; children: ReactNode }) {
  return <FieldFlagCtx.Provider value={{ flags, flash }}>{children}</FieldFlagCtx.Provider>;
}

export function useFieldFlag(field: string): PresencePerson | null {
  return useContext(FieldFlagCtx).flags.get(canonicalField(field)) ?? null;
}

/**
 * Wraps a property row. Always marks it (`data-pf`) so the panel can tell which editor is open; when
 * someone else edits the field it gets an inset ring in their hue and a name flag ("Riley").
 */
export function PresenceField({ field, children, className, as: Tag = "div" }: { field: string; children: ReactNode; className?: string; as?: "div" | "span" }) {
  const p = useFieldFlag(field);
  const flash = useContext(FieldFlagCtx).flash.has(canonicalField(field));
  return (
    <Tag data-pf={field} className={cn("relative rounded-[7px]", p && "pf-live", flash && "hl", className)} style={p ? ({ "--hue": p.user.hue } as CSSProperties) : undefined}>
      {p && <span className="pf-flag">{firstName(p.user.name)}</span>}
      {children}
    </Tag>
  );
}

/* ───────── typing row (comments) ───────── */

/** Avatar + dots + "Sam is typing" (aria-live polite); fades out 200 ms after the last typist stops. */
export function TypingIndicator({ people, label }: { people: readonly PresencePerson[]; label: string }) {
  // The last non-empty row stays rendered (fading) for 200 ms after the last typist stops.
  const [shown, setShown] = useState<{ people: readonly PresencePerson[]; label: string } | null>(label ? { people, label } : null);
  if (label && (shown?.label !== label || shown.people !== people)) setShown({ people, label });
  const fading = !label && !!shown;
  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => setShown(null), 200);
    return () => clearTimeout(t);
  }, [fading]);
  return (
    <div aria-live="polite" className="min-h-7">
      {shown && (
        <div className={cn("flex h-7 items-center gap-2 text-[12px] text-fg-3 transition-opacity duration-200", fading ? "opacity-0" : "opacity-100")}>
          <span className="pr" style={{ paddingLeft: 0 }}>
            {shown.people.slice(0, 3).map((p, i) => (
              <span key={p.user.id} aria-hidden className="pr-av sm" style={{ "--hue": p.user.hue, marginLeft: i ? -5 : 0, "--pr-bg": "var(--surface)" } as CSSProperties}>
                {initialsOf(p.user.name)}
              </span>
            ))}
          </span>
          <span aria-hidden className="ty-dots">
            <i />
            <i />
            <i />
          </span>
          <span>{shown.label}</span>
        </div>
      )}
    </div>
  );
}
