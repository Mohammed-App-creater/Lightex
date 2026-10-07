"use client";

import { useEffect, useRef } from "react";

/*
 * Global keyboard shortcuts.
 *   "c"            single key
 *   "mod+k"        ⌘ on Apple, Ctrl elsewhere
 *   "mod+shift+l"
 *   "g b"          sequence: G then B (within 1s)
 *   "?" "["        printable characters match e.key
 * Plain keys never fire while typing in an input, textarea, select or contenteditable,
 * or while a modal dialog other than the palette owns focus.
 */

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

export function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  return Boolean(
    el.closest("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable='true'], [contenteditable=''], [role='combobox']"),
  );
}

function isMac() {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
}

function comboOf(e: KeyboardEvent) {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  const parts = [];
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  // Shift is implicit for characters like "?"; only name it for letters/named keys.
  if (e.shiftKey && (/^[a-z]$/.test(key) || key.length > 1)) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

export function useHotkeys(map: HotkeyMap, enabled = true) {
  const mapRef = useRef(map);
  useEffect(() => {
    mapRef.current = map;
  });

  useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const combo = comboOf(e);
      const typing = isTypingTarget(e.target);
      const hasMod = combo.includes("mod+") || combo.includes("alt+");
      if (typing && !hasMod) return;
      // Inside an open dialog (other than ones that opt in), only modifier shortcuts work.
      const inDialog = (e.target as HTMLElement | null)?.closest?.("[role='dialog'], [role='alertdialog']");
      if (inDialog && !hasMod) return;

      const handlers = mapRef.current;
      if (pending) {
        const seq = `${pending} ${combo}`;
        pending = null;
        clearTimeout(timer);
        if (handlers[seq]) {
          e.preventDefault();
          handlers[seq](e);
          return;
        }
      }
      if (handlers[combo]) {
        e.preventDefault();
        handlers[combo](e);
        return;
      }
      // Start a sequence if any binding begins with this key.
      if (!hasMod && Object.keys(handlers).some((k) => k.startsWith(`${combo} `))) {
        pending = combo;
        timer = setTimeout(() => (pending = null), 1000);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [enabled]);
}
