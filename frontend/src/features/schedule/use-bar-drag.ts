"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { dragModeAt, type DragMode } from "./schedule-lib";

/*
 * Hand-written pointer drag for timeline bars, calendar chips and tray items (board 32 §1.4; dnd-kit's
 * sortable model doesn't fit day-snapped bars). Mouse/pen activate after 3 px of movement; touch
 * needs a 200 ms press-and-hold (6 px tolerance) so a plain swipe still scrolls. Edge zones are 9 px
 * (16 px for touch). Esc or pointercancel during a drag reverts with no request. A press without
 * movement is a tap (opens the task).
 */

export type DragState = { mode: DragMode; dx: number; dy: number; clientX: number; clientY: number; pointerType: string };

export const EDGE_MOUSE = 9;
export const EDGE_TOUCH = 16;
const MOVE_PX = 3;
const HOLD_MS = 200;
const HOLD_TOLERANCE = 6;

type Opts = {
  /** Dragging allowed (editable item). Taps work either way. */
  enabled: boolean;
  /** Edge zones resize (timeline bars). */
  resizable?: boolean;
  onStart?: (s: DragState) => void;
  onMove: (s: DragState) => void;
  onEnd: (commit: boolean, s: DragState) => void;
  onTap?: () => void;
};

type Live = {
  pointerId: number;
  el: HTMLElement;
  x: number;
  y: number;
  mode: DragMode;
  pointerType: string;
  active: boolean;
  done: boolean;
  timer?: ReturnType<typeof setTimeout>;
  last: DragState;
};

export function useBarDrag(opts: Opts) {
  const live = useRef<Live | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const escRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  const stopEsc = () => {
    if (escRef.current) window.removeEventListener("keydown", escRef.current, true);
    escRef.current = null;
  };
  useEffect(() => () => stopEsc(), []);

  const finish = (commit: boolean) => {
    const l = live.current;
    if (!l) return;
    clearTimeout(l.timer);
    stopEsc();
    try {
      if (l.el.hasPointerCapture(l.pointerId)) l.el.releasePointerCapture(l.pointerId);
    } catch {
      /* element gone */
    }
    live.current = null;
    if (l.active && !l.done) optsRef.current.onEnd(commit, l.last);
  };

  const activate = () => {
    const l = live.current;
    if (!l || l.active) return;
    l.active = true;
    try {
      l.el.setPointerCapture(l.pointerId);
    } catch {
      /* pointer already released */
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    escRef.current = onKey;
    window.addEventListener("keydown", onKey, true);
    optsRef.current.onStart?.(l.last);
  };

  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0 || live.current) return;
      const el = e.currentTarget;
      const touch = e.pointerType === "touch";
      const r = el.getBoundingClientRect();
      const mode: DragMode = opts.enabled && opts.resizable ? dragModeAt(e.clientX - r.left, r.width, touch ? EDGE_TOUCH : EDGE_MOUSE) : "move";
      const l: Live = {
        pointerId: e.pointerId,
        el,
        x: e.clientX,
        y: e.clientY,
        mode,
        pointerType: e.pointerType,
        active: false,
        done: false,
        last: { mode, dx: 0, dy: 0, clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType },
      };
      live.current = l;
      if (opts.enabled && touch) l.timer = setTimeout(activate, HOLD_MS);
      else if (opts.enabled) {
        // Capture now: an edge grab moves straight off the bar, before the 3 px activation.
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic event */
        }
      }
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const l = live.current;
      if (!l || e.pointerId !== l.pointerId) return;
      const dx = e.clientX - l.x;
      const dy = e.clientY - l.y;
      l.last = { mode: l.mode, dx, dy, clientX: e.clientX, clientY: e.clientY, pointerType: l.pointerType };
      if (!l.active) {
        const dist = Math.hypot(dx, dy);
        if (l.pointerType === "touch") {
          // Moved before the hold completed: it's a scroll, not a drag.
          if (dist > HOLD_TOLERANCE) {
            clearTimeout(l.timer);
            live.current = null;
          }
          return;
        }
        if (!optsRef.current.enabled || dist < MOVE_PX) return;
        activate();
      }
      e.preventDefault();
      optsRef.current.onMove(l.last);
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) {
      const l = live.current;
      if (!l || e.pointerId !== l.pointerId) return;
      if (!l.active) {
        clearTimeout(l.timer);
        live.current = null;
        if (Math.hypot(e.clientX - l.x, e.clientY - l.y) < HOLD_TOLERANCE) optsRef.current.onTap?.();
        return;
      }
      finish(true);
    },
    onPointerCancel() {
      finish(false);
    },
    /** Lost capture without an up (window blur): revert. */
    onLostPointerCapture() {
      if (live.current?.active) finish(false);
    },
  };
}
