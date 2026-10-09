"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useCopy } from "@/features/integrations/queries";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { TelegramLink } from "@/lib/api/types";
import { apiMode } from "@/lib/env";
import { cn } from "@/lib/utils/cn";
import { ChannelDialog } from "./channel-dialog";
import { ClockGlyph, CopyGlyph, Glyph, OkGlyph, SparkCheck, Spin } from "./icons";
import { useTelegramLink } from "./queries";
import { browserTimeZone } from "./quiet";
import { TG_INITIAL, codeCells, formatClock, isWarn, remainingSeconds, telegramHandle, telegramStartError, tgReducer } from "./telegram-machine";

/*
 * Connect Telegram (board 38, spec §8.5): C2 on open (with the browser time zone) → the deep link and the
 * 6-character code with a countdown, C3 polled every 2 s → "Connected as @alexkim", or Code expired →
 * New code. Closing before it links cancels the code (C4).
 *
 * The design's QR code is not drawn: it needs the `uqr` dependency, which is pending a decision. The
 * "Open Telegram" deep-link button stands in for it on every device.
 */

let inflight: { key: string; promise: Promise<TelegramLink> } | null = null;

/**
 * One C2 per dialog opening and "New code" press: mounts of the same opening (StrictMode's double effect,
 * the lazy chunk swapping in) reuse the request. `opening` comes from the page and differs per opening.
 */
function startShared(opening: number, gen: number): Promise<TelegramLink> {
  const key = `${opening}:${gen}`;
  if (inflight?.key === key) return inflight.promise;
  const promise = api.channels.startTelegram(browserTimeZone());
  inflight = { key, promise };
  promise.catch(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  return promise;
}

export function TelegramDialog({ opening, onClose, onSendTest }: { opening: number; onClose: () => void; onSendTest: () => void }) {
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(tgReducer, TG_INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const [gen, setGen] = useState(0);
  const { copied, copy } = useCopy();
  const linkId = useRef<string | null>(null);

  // C2 on open and on "New code". Mounts that overlap (StrictMode's double effect, the lazy chunk swapping
  // in) share one in-flight request: a second C2 would cancel the code the surviving mount shows.
  useEffect(() => {
    let live = true;
    startShared(opening, gen)
      .then((link) => {
        if (!live) return;
        linkId.current = link.id;
        setNow(Date.now());
        dispatch({ type: "started", link });
      })
      .catch((e: unknown) => {
        if (live) dispatch({ type: "failed", ...telegramStartError(e) });
      });
    return () => {
      live = false;
    };
  }, [opening, gen]);

  const pending = state.phase === "pending";
  const announced = useRef<string | null>(null);
  const onLinked = (id: string, username: string) => {
    // The 2 s poll and a scan's refetch can both see "linked": announce once per link.
    if (announced.current === id) return;
    announced.current = id;
    void qc.invalidateQueries({ queryKey: qk.channels() });
    toast.success("Telegram connected", { body: `Connected as ${username}` });
  };
  useTelegramLink(pending ? state.link.id : null, pending, (link) => {
    if (link.status === "linked" && link.connection) onLinked(link.id, telegramHandle(link.connection));
    dispatch({ type: "polled", link });
  });

  // The countdown (1 s, only while a code is pending).
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      dispatch({ type: "tick", now: n });
    }, 1000);
    return () => clearInterval(t);
  }, [pending]);

  const close = () => {
    if (state.phase === "pending" || state.phase === "starting") {
      const id = linkId.current;
      if (id) void api.channels.cancelTelegram(id).catch(() => undefined);
    }
    onClose();
  };
  const newCode = () => {
    linkId.current = null;
    dispatch({ type: "start" });
    setGen((g) => g + 1);
  };
  const simulateScan = async () => {
    const m = await import("@/lib/mock/handlers/channels");
    const { mockSession } = await import("@/lib/mock/db");
    m.simulateTelegramScan(mockSession.get());
    await qc.refetchQueries({ queryKey: ["notification-channels", "telegram-link"] });
  };

  const left = state.phase === "pending" ? remainingSeconds(state.link.expiresAt, now) : 0;

  return (
    <ChannelDialog channel="telegram" title="Telegram" label="Connect Telegram" onClose={close}>
      {state.phase === "starting" && (
        <div role="status" aria-label="Creating a code" className="flex flex-col items-center gap-3 py-6">
          <Spin size={16} />
          <span className="text-[12.5px] text-fg-2">Creating a code…</span>
        </div>
      )}

      {state.phase === "error" && (
        <div className="flex flex-col gap-3.5">
          <p role="alert" className="m-0 flex items-start gap-2 text-[12.5px] leading-[18px] text-danger">
            <Glyph d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.1" size={14} stroke={1.6} className="mt-0.5 flex-none" />
            {state.message}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            {state.code !== "already_connected" && state.code !== "channel_unavailable" && (
              <Button variant="primary" onClick={newCode}>
                Try again
              </Button>
            )}
          </div>
        </div>
      )}

      {(state.phase === "pending" || state.phase === "expired") && (
        <>
          <p className="m-0 text-[12.5px] leading-[18px] text-fg-2">Alerts in Telegram, with a link back to the task.</p>
          {/*
            TODO(board 38, QR): the design's QR code (a `t.me` deep-link QR on a white tile, blurred with an
            "Expired" overlay when the code expires) goes here. It needs the `uqr` npm package (spec §8.10),
            which is pending a dependency decision: see docs/final-report.md §8 "Board 38". Until then the
            deep-link button below is the primary action on every device.
          */}
          <div className="flex flex-col items-center gap-2">
            {state.phase === "pending" ? (
              <Button variant="primary" asChild className="w-full max-[760px]:h-11">
                <a href={state.link.deepLink} target="_blank" rel="noopener noreferrer">
                  Open Telegram
                </a>
              </Button>
            ) : (
              <Button variant="primary" className="w-full max-[760px]:h-11" disabledReason="This code expired. Get a new code.">
                Open Telegram
              </Button>
            )}
            {apiMode === "mock" && state.phase === "pending" && (
              <button type="button" data-mock-scan onClick={() => void simulateScan()} className="rounded text-[12px] font-medium text-accent-t hover:underline">
                Simulate scan (mock)
              </button>
            )}
          </div>
          <div className="flex items-center gap-2.5 whitespace-nowrap text-[12px] text-fg-3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
            or send to <b className="font-mono font-medium text-fg-2">@{state.link.botUsername}</b>
          </div>
          <div className="flex items-center justify-center gap-1.5" aria-label={`Link code ${state.link.code}`} role="group">
            {codeCells(state.link.code).map((c, i) => (
              <span
                key={i}
                aria-hidden
                className={cn(
                  "inline-flex h-[38px] w-[30px] items-center justify-center rounded-[7px] border border-line-2 bg-bg font-mono text-[16px] font-semibold text-fg",
                  c.gap && "ml-2",
                  state.phase === "expired" && "text-fg-3 line-through",
                )}
              >
                {c.c}
              </span>
            ))}
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label="Copy link code"
              className="ml-1"
              onClick={() => copy(state.link.code)}
              disabledReason={state.phase === "expired" ? "This code expired" : undefined}
            >
              {copied === state.link.code ? (
                <span className="text-ok">
                  <OkGlyph size={14} />
                </span>
              ) : (
                <CopyGlyph />
              )}
            </Button>
          </div>
          <div className="flex min-h-[30px] flex-wrap items-center gap-2 border-t border-line pt-3">
            {state.phase === "pending" ? (
              <>
                <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap text-[12px] text-fg-2">
                  <Spin />
                  Waiting for confirmation…
                </span>
                <span className="flex-1" />
                <span
                  className={cn("inline-flex items-center gap-1.5 font-mono text-[12px] text-fg-2", isWarn(left) && "text-warn")}
                  aria-label={`Code expires in ${formatClock(left)}`}
                  data-warn={isWarn(left) || undefined}
                >
                  <ClockGlyph />
                  {formatClock(left)}
                </span>
              </>
            ) : (
              <>
                <span role="alert" className="text-[12px] text-danger">
                  Code expired
                </span>
                <span className="flex-1" />
                <Button size="sm" onClick={newCode}>
                  New code
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {state.phase === "linked" && (
        <>
          <div role="status" className="flex flex-col items-center gap-3 pb-0.5 pt-2.5 text-center">
            <SparkCheck />
            <span className="font-semibold">
              Connected as <span className="font-mono">{telegramHandle(state.connection)}</span>
            </span>
          </div>
          <div className="flex gap-2 [&>*]:flex-1">
            <Button onClick={onSendTest}>Send test</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      )}
    </ChannelDialog>
  );
}
