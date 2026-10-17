"use client";

import { useEffect, useState, type RefObject } from "react";

/*
 * Which inline editor is open in the task panel (spec §9 #10: `editing` = a field, description or
 * property popover is open in this tab). Property rows carry `data-pf="<field>"`; a row counts as
 * being edited while a menu / popover / date picker it owns is open (`data-state="open"` on its
 * trigger) or while focus is in one of its inputs. Recomputed on focus changes and on `data-state`
 * mutations, so no editor needs to report itself.
 */

function compute(root: HTMLElement | null): string | null {
  if (!root) return null;
  const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  for (const el of root.querySelectorAll<HTMLElement>("[data-pf]")) {
    if (el.matches('[data-state="open"]') || el.querySelector('[data-state="open"]')) return el.dataset.pf ?? null;
    if (active && el.contains(active) && active.matches("input, textarea, [contenteditable='true']")) return el.dataset.pf ?? null;
  }
  return null;
}

export function useEditingField(ref: RefObject<HTMLElement | null>) {
  const [field, setField] = useState<string | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => setField(compute(ref.current));
    const mo = new MutationObserver(update);
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      mo.disconnect();
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [ref]);
  return field;
}
