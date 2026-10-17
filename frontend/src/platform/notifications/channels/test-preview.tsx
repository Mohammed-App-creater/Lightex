"use client";

import { useEffect } from "react";
import { LogoMark } from "./logo-mark";
import { ChannelIcon } from "./icons";
import type { PreviewCard, PreviewChannel } from "./model";

/**
 * The device-style preview after Send test (board 38 `.ch-pv`): top right for 4 s, next to the toast
 * "Test sent · Telegram". The copy is the neutral `test` template (§6.5, §10 #13), never task data.
 */
export function TestPreview({ channel, card, onDone }: { channel: PreviewChannel; card: PreviewCard; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      role="status"
      aria-label="Notification preview"
      className="ch-pv fixed right-3 top-3 z-[90] flex w-[300px] max-w-[calc(100%-24px)] flex-col gap-[5px] rounded-2xl border border-line-2 bg-raised/95 px-3.5 py-3 shadow-modal backdrop-blur-md"
    >
      <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
        <span aria-hidden className="inline-flex size-5 items-center justify-center rounded-[5px] border border-line-2 bg-surface text-fg">
          {card.logo ? <LogoMark /> : <ChannelIcon channel={channel} size={12} />}
        </span>
        <b className="text-[10.5px] font-semibold uppercase tracking-[.04em] text-fg-2">{card.app}</b>
        <span className="min-w-0 flex-1 truncate">{card.from}</span>
        <span>now</span>
      </div>
      {card.title && <span className="text-[13px] font-semibold">{card.title}</span>}
      <span className="text-[12.5px] leading-[17px] text-fg-2">{card.body}</span>
    </div>
  );
}
