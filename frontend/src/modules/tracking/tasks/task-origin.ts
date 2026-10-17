"use client";

import { createStore } from "@/lib/utils/store";

/**
 * The on-screen rect of the card that opened the task panel, so the panel can morph out of
 * it (board 09 §3.4: card → ghost → panel in 250ms). Cleared once the panel has mounted.
 */
export const taskOrigin = createStore<{ key: string; rect: DOMRect } | null>(null);

export function rememberOrigin(key: string, el: Element | null) {
  if (!el) return;
  taskOrigin.set({ key, rect: el.getBoundingClientRect() });
}

/** Tasks that should play the completion spark on their next render (cleared after 600ms). */
const sparks = createStore<Set<string>>(new Set());
export function triggerSpark(taskId: string) {
  sparks.set((s) => new Set(s).add(taskId));
  setTimeout(() => sparks.set((s) => {
    const n = new Set(s);
    n.delete(taskId);
    return n;
  }), 700);
}
export const sparkStore = sparks;
