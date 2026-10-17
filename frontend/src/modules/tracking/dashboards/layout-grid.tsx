"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { STACK_HEIGHT, WIDGET_NAME } from "@/lib/domain/dashboards";
import { cn } from "@/lib/utils/cn";
import { clampSize, hitIndex, pack, packedRows, rowUnit, type DraftWidget } from "./layout-lib";
import { WidgetChromeProvider, type WidgetChrome } from "./widget-frame";

/*
 * The 12-column widget grid (spec §1.4). Cards are absolutely positioned from pack() and moved with
 * `transform: translate` (the only property that animates). Row unit 152 px at ≥ 1024 px grid
 * width, 128 px below; 12 px gutters (6 px around each card).
 *
 * Edit mode: dashed column guides and row lines; the grip drags (pointer capture, 4 px threshold,
 * touch 200 ms press-and-hold) — when the pointer enters another widget's packed rect the dragged
 * one moves to that index and the layout repacks around a dashed placeholder; ←/↑ and →/↓ on the
 * grip reorder (focus stays on the grip). The corner resizes in whole columns / rows (clamped to
 * 3–12 and minH–4) with a size badge; ←/→ and ↑/↓ on it resize, badge for 900 ms.
 *
 * `stack` (phones): full-width cards in layout order at the design's stack heights, no editing.
 */

type Drag = { key: string; x: number; y: number; ox: number; oy: number };
type Pending = { key: string; pointerId: number; sx: number; sy: number; ox: number; oy: number; touch: boolean; armed: boolean; timer?: ReturnType<typeof setTimeout> };
type Resize = { key: string; sx: number; sy: number; w0: number; h0: number };

export function LayoutGrid({
  items,
  editing,
  stack,
  fresh,
  renderWidget,
  settingsFor,
  onMove,
  onResize,
  onRemove,
}: {
  items: DraftWidget[];
  editing: boolean;
  stack: boolean;
  /** Key of a just-added widget (pop-in). */
  fresh: string | null;
  renderWidget: (w: DraftWidget) => ReactNode;
  settingsFor?: (w: DraftWidget) => ReactNode;
  /** Move a widget to a position among the visible ones; `final` on drop / key press. */
  onMove: (key: string, toIndex: number, final: boolean) => void;
  onResize: (key: string, w: number, h: number, final: boolean) => void;
  onRemove: (key: string) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  /*
   * While a card is in the air the cards keep their DOM order (only their transforms change):
   * moving the dragged element in the DOM would drop its pointer capture. Layout order returns
   * on drop, so screen readers and Tab follow the visual order.
   */
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const [rz, setRz] = useState<string | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const resizing = useRef<Resize | null>(null);
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const focusKey = useRef<string | null>(null);
  const badgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(badgeTimer.current), []);

  // Keyboard reorder re-renders the cards in their new order: put focus back on the grip.
  useLayoutEffect(() => {
    const k = focusKey.current;
    if (!k) return;
    focusKey.current = null;
    grips.current.get(k)?.focus({ preventScroll: true });
  });

  const U = rowUnit(width);
  const colW = width / 12;
  const rects = pack(items);
  const rows = packedRows(rects);
  const indexOf = (key: string) => items.findIndex((w) => w.key === key);

  /* ───── pointer drag ───── */

  const gridPoint = (e: { clientX: number; clientY: number }) => {
    const r = gridRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const startDrag = (p: Pending) => {
    p.armed = true;
    setFrozen(items.map((w) => w.key));
    setDrag({ key: p.key, x: p.sx - p.ox, y: p.sy - p.oy, ox: p.ox, oy: p.oy });
  };

  const gripDown = (w: DraftWidget) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const i = indexOf(w.key);
    const r = rects[i];
    if (!r) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = gridPoint(e);
    const p: Pending = { key: w.key, pointerId: e.pointerId, sx: pt.x, sy: pt.y, ox: pt.x - r.x * colW, oy: pt.y - r.y * U, touch: e.pointerType === "touch", armed: false };
    if (p.touch) p.timer = setTimeout(() => pending.current === p && startDrag(p), 200);
    pending.current = p;
  };

  const gripMove = (e: PointerEvent<HTMLButtonElement>) => {
    const p = pending.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const pt = gridPoint(e);
    if (!p.armed) {
      const moved = Math.hypot(pt.x - p.sx, pt.y - p.sy) > 4;
      if (!moved) return;
      if (p.touch) {
        // Moving before the 200 ms hold cancels the drag.
        clearTimeout(p.timer);
        pending.current = null;
        return;
      }
      startDrag(p);
    }
    setDrag({ key: p.key, x: pt.x - p.ox, y: pt.y - p.oy, ox: p.ox, oy: p.oy });
    const col = Math.floor(pt.x / Math.max(1, colW));
    const row = Math.floor(pt.y / U);
    const from = indexOf(p.key);
    if (rects[from] && hitIndex([rects[from]!], col, row) === 0) return;
    let to = hitIndex(rects, col, row);
    if (to < 0 && row >= rows) to = items.length - 1;
    if (to >= 0 && to !== from) onMove(p.key, to, false);
  };

  const gripUp = (e: PointerEvent<HTMLButtonElement>) => {
    const p = pending.current;
    if (!p || p.pointerId !== e.pointerId) return;
    clearTimeout(p.timer);
    pending.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (p.armed) {
      setDrag(null);
      setFrozen(null);
      onMove(p.key, indexOf(p.key), true);
    }
  };

  const gripKey = (w: DraftWidget) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const d = ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 } as Record<string, number>)[e.key];
    if (!d) return;
    e.preventDefault();
    const from = indexOf(w.key);
    const to = Math.max(0, Math.min(items.length - 1, from + d));
    if (to === from) return;
    focusKey.current = w.key;
    onMove(w.key, to, true);
  };

  /* ───── resize ───── */

  const showBadge = (key: string) => {
    setBadge(key);
    clearTimeout(badgeTimer.current);
    badgeTimer.current = setTimeout(() => setBadge(null), 900);
  };

  const rzDown = (w: DraftWidget) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizing.current = { key: w.key, sx: e.clientX, sy: e.clientY, w0: w.w, h0: w.h };
    setRz(w.key);
  };
  const rzMove = (w: DraftWidget) => (e: PointerEvent<HTMLButtonElement>) => {
    const r = resizing.current;
    if (!r || r.key !== w.key) return;
    const next = clampSize(w.type, r.w0 + Math.round((e.clientX - r.sx) / Math.max(1, colW)), r.h0 + Math.round((e.clientY - r.sy) / U));
    if (next.w !== w.w || next.h !== w.h) onResize(w.key, next.w, next.h, false);
  };
  const rzUp = (w: DraftWidget) => (e: PointerEvent<HTMLButtonElement>) => {
    const r = resizing.current;
    if (!r || r.key !== w.key) return;
    resizing.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setRz(null);
    onResize(w.key, w.w, w.h, true);
  };
  const rzKey = (w: DraftWidget) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const m = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!m) return;
    e.preventDefault();
    const next = clampSize(w.type, w.w + m[0], w.h + m[1]);
    showBadge(w.key);
    if (next.w !== w.w || next.h !== w.h) onResize(w.key, next.w, next.h, true);
  };

  /* ───── render ───── */

  const chrome = (w: DraftWidget): WidgetChrome => ({
    name: WIDGET_NAME[w.type],
    editing: editing && !stack,
    sizeLabel: `${w.w} × ${w.h}`,
    showSize: rz === w.key || badge === w.key,
    onRemove: () => onRemove(w.key),
    settings: settingsFor?.(w),
    grip: {
      ref: (el) => {
        if (el) grips.current.set(w.key, el);
        else grips.current.delete(w.key);
      },
      onPointerDown: gripDown(w),
      onPointerMove: gripMove,
      onPointerUp: gripUp,
      onPointerCancel: gripUp,
      onKeyDown: gripKey(w),
    },
    resize: {
      onPointerDown: rzDown(w),
      onPointerMove: rzMove(w),
      onPointerUp: rzUp(w),
      onPointerCancel: rzUp(w),
      onKeyDown: rzKey(w),
    },
  });

  if (stack) {
    return (
      <div className="flex flex-col gap-3">
        {items.map((w) => (
          <div key={w.key} style={{ height: STACK_HEIGHT[w.type] }}>
            <WidgetChromeProvider value={chrome(w)}>{renderWidget(w)}</WidgetChromeProvider>
          </div>
        ))}
      </div>
    );
  }

  const dragIndex = drag ? indexOf(drag.key) : -1;
  const ph = dragIndex >= 0 ? rects[dragIndex] : null;
  const rectOf = new Map(items.map((w, i) => [w.key, rects[i]!]));
  const domOrder = frozen ? [...frozen.map((k) => items.find((w) => w.key === k)).filter((w): w is DraftWidget => !!w), ...items.filter((w) => !frozen.includes(w.key))] : items;
  return (
    <div ref={gridRef} className="relative -mx-1.5" style={{ height: rows * U, "--u": `${U}px` } as CSSProperties}>
      {editing && (
        <div aria-hidden className="db-guides">
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      {ph && width > 0 && <div aria-hidden className="db-ph" style={{ width: ph.w * colW, height: ph.h * U, transform: `translate(${ph.x * colW}px, ${ph.y * U}px)` }} />}
      {width > 0 &&
        domOrder.map((w) => {
          const r = rectOf.get(w.key)!;
          const dragging = drag?.key === w.key;
          const x = dragging ? drag.x : r.x * colW;
          const y = dragging ? drag.y : r.y * U;
          return (
            <div
              key={w.key}
              className={cn("db-w", editing && "ed", dragging && "drag", fresh === w.key && "new")}
              style={{ width: r.w * colW, height: r.h * U, transform: `translate(${x}px, ${y}px)` }}
            >
              <WidgetChromeProvider value={chrome(w)}>{renderWidget(w)}</WidgetChromeProvider>
            </div>
          );
        })}
    </div>
  );
}
