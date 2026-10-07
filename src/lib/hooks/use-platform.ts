"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

function detectMac() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

/** True on Apple platforms. Server snapshot is false, so hydration stays consistent. */
export function useIsMac() {
  return useSyncExternalStore(noop, detectMac, () => false);
}

/** Display label for the primary modifier: ⌘ on Apple, Ctrl elsewhere. */
export function useModKey() {
  return useIsMac() ? "⌘" : "Ctrl";
}

/** Replaces the ⌘ glyph in a design shortcut with the platform modifier. */
export function formatKeys(keys: string[], isMac: boolean): string[] {
  return keys.map((k) => (k === "⌘" || k === "Mod" ? (isMac ? "⌘" : "Ctrl") : k));
}
