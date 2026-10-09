"use client";

import { Switch } from "@/components/ui/choice";
import type { NotificationChannel, NotificationEvent, NotificationPreferences } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { EVENTS, PREF_ROWS } from "../events";
import { EventIcon } from "../icons";
import { ChannelIcon } from "./icons";
import { CHANNEL_NAME, CHANNEL_ORDER, CHANNEL_SHORT, type ColumnState } from "./model";

/*
 * 6 events × 5 channels (board 38 `.pm`). A channel that isn't usable gets a hatched column with dashed,
 * non-interactive "off" toggles (role="img", "…: not connected"); its header offers Connect, or says
 * Off by admin / Blocked / Unavailable. At ≤ 760 px the headers use the short labels and drop the icons.
 */

const ROW = "grid grid-cols-[minmax(0,1fr)_repeat(5,104px)] max-[760px]:grid-cols-[minmax(0,1fr)_repeat(5,48px)]";
const CHIP = "whitespace-nowrap rounded-[5px] border border-dashed border-line-2 px-[5px] py-[3px] font-mono text-[10.5px] font-medium leading-none text-fg-3";

function Note({ state, name, onConnect, onRetry }: { state: ColumnState; name: string; onConnect: () => void; onRetry?: () => void }) {
  switch (state.note) {
    case "connect":
      return (
        <button type="button" onClick={onConnect} aria-label={`Connect ${name}`} className="rounded text-[12px] font-medium text-accent-t hover:underline max-[760px]:text-[10.5px]">
          Connect
        </button>
      );
    case "policy":
      return (
        <span className={CHIP} title="Turned off by an admin">
          <span className="max-[760px]:hidden">Off by admin</span>
          <span className="hidden max-[760px]:inline">Off</span>
        </span>
      );
    case "blocked":
      return (
        <span className={CHIP} title={name === "Push" ? "Blocked in browser" : "Bot blocked in Telegram"}>
          Blocked
        </span>
      );
    case "opted_out":
      return (
        <span className={CHIP} title="You replied STOP">
          STOP
        </span>
      );
    case "unavailable":
      return (
        <span className={CHIP} title="Not available">
          <span className="max-[760px]:hidden">Unavailable</span>
          <span className="hidden max-[760px]:inline">Off</span>
        </span>
      );
    case "retry":
      return (
        <button type="button" onClick={onRetry} className="rounded text-[11px] font-medium text-accent-t hover:underline" aria-label={`${name} unavailable. Retry`}>
          Retry
        </button>
      );
    default:
      return null;
  }
}

export function PreferencesMatrix({
  prefs,
  columns,
  onToggle,
  onConnect,
  onRetry,
}: {
  prefs: NotificationPreferences;
  columns: Record<NotificationChannel, ColumnState>;
  onToggle: (event: NotificationEvent, channel: NotificationChannel, on: boolean) => void;
  onConnect?: (channel: NotificationChannel) => void;
  onRetry?: () => void;
}) {
  return (
    <div role="table" aria-label="Notification preferences" className="overflow-hidden rounded-xl border border-line bg-surface">
      <div role="rowgroup">
        <div role="row" className={cn(ROW, "bg-bg")}>
          <span role="columnheader" className="flex min-h-[58px] items-center pl-4 text-[12px] font-medium text-fg-3 max-[760px]:pl-2.5">
            Event
          </span>
          {CHANNEL_ORDER.map((ch) => {
            const st = columns[ch];
            return (
              <span
                key={ch}
                role="columnheader"
                data-channel={ch}
                className={cn(
                  "flex min-h-[58px] flex-col items-center justify-center gap-1.5 px-1 py-2 text-center text-[12px] font-semibold max-[760px]:px-0.5 max-[760px]:text-[10.5px]",
                  !st.usable && "text-fg-2",
                )}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-fg-3 max-[760px]:hidden">
                    <ChannelIcon channel={ch} size={13} />
                  </span>
                  <span className="max-[760px]:sr-only">{CHANNEL_NAME[ch]}</span>
                  <span aria-hidden data-short className="hidden max-[760px]:inline">
                    {CHANNEL_SHORT[ch]}
                  </span>
                </span>
                <Note state={st} name={CHANNEL_NAME[ch]} onConnect={() => onConnect?.(ch)} onRetry={onRetry} />
              </span>
            );
          })}
        </div>
      </div>
      <div role="rowgroup">
        {PREF_ROWS.map(({ event, type }) => {
          const name = EVENTS[type].pref;
          return (
            <div key={event} role="row" className={cn(ROW, "border-t border-line")}>
              <span role="rowheader" className="flex min-h-12 min-w-0 items-center gap-2.5 px-4 font-medium max-[760px]:min-h-[52px] max-[760px]:gap-2 max-[760px]:px-2.5 max-[760px]:text-[12px]">
                <span aria-hidden className="flex size-[26px] flex-none items-center justify-center rounded-[7px] border border-line bg-raised max-[760px]:hidden">
                  <EventIcon type={type} size={14} />
                </span>
                <span className="truncate max-[760px]:whitespace-normal max-[760px]:leading-[15px]">{name}</span>
              </span>
              {CHANNEL_ORDER.map((ch) => {
                const st = columns[ch];
                return (
                  <span key={ch} role="cell" className={cn("flex items-center justify-center", !st.usable && "ch-hatch")}>
                    {st.usable ? (
                      <Switch
                        aria-label={`${name}, ${CHANNEL_NAME[ch]}`}
                        checked={prefs.events[event]?.[ch] ?? false}
                        onChange={(e) => onToggle(event, ch, e.currentTarget.checked)}
                      />
                    ) : (
                      <span role="img" aria-label={`${name}, ${CHANNEL_NAME[ch]}: ${st.reason}`} title={st.reason} className="ch-tg-off" />
                    )}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
