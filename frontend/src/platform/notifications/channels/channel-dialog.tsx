"use client";

import * as D from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { useIsMobile } from "@/lib/hooks/use-media-query";
import type { NotificationChannel } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ChannelIcon, XGlyph } from "./icons";

/**
 * The connect dialogs' frame (board 38 `.ch-dlg`): 380 px modal, a bottom sheet at ≤ 760 px. Escape and
 * the × close it (Radix handles Escape before any page hotkey).
 */
export function ChannelDialog({
  channel,
  title,
  label,
  onClose,
  children,
}: {
  channel: NotificationChannel;
  title: string;
  /** Accessible name (design: "Connect Telegram", "Verify phone for SMS"). */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheet = useIsMobile();
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-scrim backdrop-blur-[6px] data-[state=open]:animate-[fade-in_180ms_var(--ease)]" />
        <D.Content
          aria-label={label}
          // The design names the dialog "Connect Telegram" while its heading says "Telegram".
          aria-labelledby={undefined}
          aria-describedby={undefined}
          className={cn(
            "fixed z-[61] flex flex-col gap-4 overflow-auto border border-line-2 bg-surface p-5 shadow-modal outline-none",
            sheet
              ? "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[18px] border-x-0 border-b-0 pb-[max(20px,env(safe-area-inset-bottom))] data-[state=open]:animate-[sheet-up_280ms_var(--ease)]"
              : "left-1/2 top-1/2 max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-[14px] data-[state=open]:animate-[modal-in_180ms_var(--ease)]",
          )}
        >
          {sheet && <span aria-hidden className="mx-auto -mt-2 h-1 w-9 flex-none rounded-full bg-line-2" />}
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="inline-flex size-8 flex-none items-center justify-center rounded-lg border border-line-2 bg-raised text-fg">
              <ChannelIcon channel={channel} />
            </span>
            <D.Title className="m-0 flex-1 text-[16px] font-semibold tracking-[-0.01em]">{title}</D.Title>
            <D.Close
              aria-label="Close"
              className="inline-flex size-9 items-center justify-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg max-[760px]:size-11"
            >
              <XGlyph size={14} />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
