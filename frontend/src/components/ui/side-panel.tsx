"use client";

import { motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import { Sheet } from "./modal";

/**
 * Side panel (board 04/14): 480–520px, --surface, --line-2 border, e3 shadow, slides in 250ms.
 * Non-modal on desktop (the board stays usable behind it); a modal bottom sheet below 760px.
 * Focus moves into the panel on open and back to the opener on close; Esc closes.
 */
export function SidePanel({
  open,
  onClose,
  label,
  children,
  width = 520,
  className,
  layoutId,
  closeOnEscape = true,
  animateIn = true,
}: {
  /** Skip the slide-in (e.g. when a card has just morphed into the panel). */
  animateIn?: boolean;
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  width?: number;
  className?: string;
  /** Shared-element id so a card can morph into the panel. */
  layoutId?: string;
  closeOnEscape?: boolean;
}) {
  const isMobile = useIsMobile();
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || isMobile) return;
    opener.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(id);
      opener.current?.focus?.({ preventScroll: true });
    };
  }, [open, isMobile]);

  useEffect(() => {
    if (!open || isMobile || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Let open menus, popovers and editors consume Escape first.
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-radix-popper-content-wrapper], [role='dialog'] [role='dialog'], .ProseMirror")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isMobile, onClose, closeOnEscape]);

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(o) => !o && onClose()} title={label}>
        {children}
      </Sheet>
    );
  }

  if (!open) return null;
  return (
    <motion.aside
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      layoutId={layoutId}
      initial={layoutId || !animateIn ? false : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.16 } }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "fixed bottom-0 right-0 top-0 z-40 flex max-w-full flex-col border-l border-line-2 bg-surface shadow-modal outline-none",
        className,
      )}
      style={{ width }}
    >
      {children}
    </motion.aside>
  );
}
