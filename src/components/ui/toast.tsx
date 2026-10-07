"use client";

import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createStore } from "@/lib/utils/store";
import { t } from "@/lib/motion";
import { cn } from "@/lib/utils/cn";
import { ErrorGlyph, StatusGlyph } from "./glyphs";
import { Kbd } from "./kbd";

/*
 * Toasts (board 05): "optimistic by default". 380px, --raised, e2 shadow, glyph + title + body,
 * one action with a key hint. Max 3 visible; auto-dismiss 4s (undo toasts 5s).
 */

export type ToastTone = "success" | "error" | "info" | "warning" | "spark";

export type ToastInput = {
  title: ReactNode;
  body?: ReactNode;
  tone?: ToastTone;
  action?: { label: string; key?: string; onClick: () => void };
  duration?: number;
  /** De-duplicate: a toast with the same id replaces the previous one. */
  id?: string;
};

type ToastItem = ToastInput & { id: string; createdAt: number };

const store = createStore<ToastItem[]>([]);
let seq = 0;

export function toast(input: ToastInput) {
  const id = input.id ?? `t${++seq}`;
  store.set((list) => [...list.filter((x) => x.id !== id), { ...input, id, createdAt: Date.now() }].slice(-3));
  return id;
}
toast.success = (title: ReactNode, rest?: Omit<ToastInput, "title" | "tone">) =>
  toast({ ...rest, title, tone: "success" });
toast.error = (title: ReactNode, rest?: Omit<ToastInput, "title" | "tone">) => toast({ ...rest, title, tone: "error" });
toast.info = (title: ReactNode, rest?: Omit<ToastInput, "title" | "tone">) => toast({ ...rest, title, tone: "info" });
toast.dismiss = (id: string) => store.set((list) => list.filter((x) => x.id !== id));

export function useToasts() {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY);
}
const EMPTY: ToastItem[] = [];

function ToastGlyph({ tone }: { tone: ToastTone }) {
  if (tone === "error") return <ErrorGlyph />;
  if (tone === "warning") return <ErrorGlyph tone="warn" />;
  if (tone === "spark") return <StatusGlyph kind="done" spark />;
  if (tone === "info") return <StatusGlyph kind="done" color="var(--accent-t)" />;
  return <StatusGlyph kind="done" />;
}

function ToastCard({ item }: { item: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const duration = item.duration ?? (item.action ? 5000 : 4000);
  const start = () => {
    clearTimeout(timer.current);
    if (duration > 0) timer.current = setTimeout(() => toast.dismiss(item.id), duration);
  };
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.createdAt]);
  const tone = item.tone ?? "success";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15 } }}
      transition={t.base}
      role={tone === "error" ? "alert" : "status"}
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={start}
      onFocus={() => clearTimeout(timer.current)}
      onBlur={start}
      className="pointer-events-auto flex w-[380px] max-w-[calc(100vw-32px)] items-center gap-3 rounded-[10px] border border-line-2 bg-raised py-3 pl-3.5 pr-2.5 shadow-pop"
    >
      <ToastGlyph tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{item.title}</span>
        {item.body && <span className="text-[12px] leading-4 text-fg-2">{item.body}</span>}
      </div>
      {item.action ? (
        <button
          type="button"
          onClick={() => {
            item.action!.onClick();
            toast.dismiss(item.id);
          }}
          className="inline-flex h-[26px] flex-none items-center gap-2 rounded-sm px-2 text-[12px] font-medium text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg"
        >
          {item.action.label}
          {item.action.key && <Kbd>{item.action.key}</Kbd>}
        </button>
      ) : (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => toast.dismiss(item.id)}
          className="inline-flex size-[26px] flex-none items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </motion.div>
  );
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']"));
}

export function Toaster({ className }: { className?: string }) {
  const items = useToasts();
  // The key hint on a toast action is live: pressing it runs the newest matching action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const match = [...store.get()].reverse().find((x) => x.action?.key?.toLowerCase() === e.key.toLowerCase());
      if (!match?.action) return;
      e.preventDefault();
      match.action.onClick();
      toast.dismiss(match.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 z-[90] flex flex-col items-end gap-2.5 max-[760px]:inset-x-4 max-[760px]:items-center",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {items.map((it) => (
          <ToastCard key={it.id} item={it} />
        ))}
      </AnimatePresence>
    </div>
  );
}
