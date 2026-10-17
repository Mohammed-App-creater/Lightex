"use client";

import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Button, type ButtonVariant } from "./button";

const scrim =
  "fixed inset-0 z-[60] bg-scrim backdrop-blur-[8px] data-[state=open]:animate-[fade-in_180ms_var(--ease)]";

/** Modal: "confirmations only" (board 05). 440px, radius 12, padding 24, gap 16. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 440,
  role = "dialog",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  role?: "dialog" | "alertdialog";
  className?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={scrim} />
        <D.Content
          role={role}
          className={cn(
            "fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto",
            "rounded-lg border border-line-2 bg-surface p-6 shadow-modal outline-none",
            "data-[state=open]:animate-[modal-in_180ms_var(--ease)]",
            className,
          )}
          style={{ maxWidth: width }}
        >
          <div className="flex flex-col gap-1.5">
            <D.Title className="m-0 text-[16px] font-semibold leading-6">{title}</D.Title>
            {description ? (
              <D.Description className="m-0 text-[13px] leading-5 text-fg-2">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>
            )}
          </div>
          {children}
          {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Confirmation with Cancel (Esc) and a confirm button (↵). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void | Promise<unknown>;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" kbd="Esc" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            kbd="↵"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** Mobile bottom sheet (task detail < 760px). 92dvh, radius 18 top, grab handle. */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
  className,
  height = "92dvh",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
  height?: string;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={cn(scrim, "backdrop-blur-[4px]")} />
        <D.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-x-0 bottom-0 z-[61] flex flex-col overflow-hidden rounded-t-[18px] border-t border-line-2 bg-surface outline-none",
            "shadow-[0_-16px_48px_rgba(0,0,0,.45)] data-[state=open]:animate-[sheet-up_280ms_var(--ease)]",
            className,
          )}
          style={{ height }}
        >
          <D.Title className="sr-only">{title}</D.Title>
          <span aria-hidden className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-line-2" />
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Left navigation drawer (< 1024px). 300px, slides in 250ms, scrim closes. */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  width = 300,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={cn(scrim, "backdrop-blur-[6px]")} />
        <D.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-[61] flex flex-col bg-surface shadow-[24px_0_48px_rgba(0,0,0,.4)] outline-none data-[state=open]:animate-[drawer-in_250ms_var(--ease)]"
          style={{ width, maxWidth: "88vw" }}
        >
          <D.Title className="sr-only">{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/**
 * Bare dialog container (board 40 import wizard): the scrim, focus trap, Esc and modal-in motion of
 * Modal, without its title block or padding, so the caller lays out its own head / body / footer.
 * The title is visually hidden. Below 760px it becomes a full-height sheet.
 */
export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 760,
  height = 640,
  className,
  onEscapeKeyDown,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
  height?: number;
  className?: string;
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={scrim} />
        <D.Content
          onEscapeKeyDown={onEscapeKeyDown}
          className={cn(
            "fixed left-1/2 top-1/2 z-[61] flex h-[var(--dlg-h)] w-[calc(100%-32px)] max-w-[var(--dlg-w)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden",
            "max-h-[calc(100dvh-32px)] rounded-lg border border-line-2 bg-surface shadow-modal outline-none",
            "data-[state=open]:animate-[modal-in_180ms_var(--ease)]",
            "max-[760px]:inset-0 max-[760px]:h-dvh max-[760px]:max-h-none max-[760px]:w-full max-[760px]:max-w-none max-[760px]:translate-x-0 max-[760px]:translate-y-0 max-[760px]:rounded-none max-[760px]:border-0",
            "max-[760px]:data-[state=open]:animate-[sheet-up_280ms_var(--ease)]",
            className,
          )}
          style={{ "--dlg-w": `${width}px`, "--dlg-h": `${height}px` } as CSSProperties}
        >
          <D.Title className="sr-only">{title}</D.Title>
          <D.Description className="sr-only">{description ?? title}</D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function DialogClose({ label = "Close", className }: { label?: string; className?: string }) {
  return (
    <D.Close asChild>
      <Button variant="ghost" icon size="sm" aria-label={label} className={className}>
        <X size={14} aria-hidden />
      </Button>
    </D.Close>
  );
}
