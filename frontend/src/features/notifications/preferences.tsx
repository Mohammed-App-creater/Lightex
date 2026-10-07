"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Segmented, Switch } from "@/components/ui/choice";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { NotificationChannel, NotificationEvent, NotificationPreferences } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { EVENTS, PREF_ROWS } from "./events";
import { CheckIcon, EventIcon } from "./icons";
import { usePrefs, useSavePrefs } from "./queries";

const LIVE: { key: NotificationChannel; label: string }[] = [
  { key: "in_app", label: "In-app" },
  { key: "email", label: "Email" },
];
const SOON = ["Telegram", "SMS", "Push"] as const;

const HATCH = "repeating-linear-gradient(135deg, transparent 0 7px, var(--raised) 7px 8px)";
const ROW = "grid grid-cols-[minmax(170px,1fr)_repeat(5,108px)]";

type SaveState = "idle" | "saving" | "saved";

export function NotificationPreferencesPage() {
  const me = useMe();
  const qc = useQueryClient();
  const prefsQ = usePrefs();
  const save = useSavePrefs();
  const [state, setState] = useState<SaveState>("idle");
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const token = useRef(0);
  /** Last copy the server confirmed, for rollback. */
  const confirmed = useRef<NotificationPreferences | null>(null);

  useEffect(
    () => () => {
      clearTimeout(debounce.current);
      clearTimeout(clear.current);
    },
    [],
  );

  const commit = (next: NotificationPreferences) => {
    if (!confirmed.current && prefsQ.data) confirmed.current = prefsQ.data;
    qc.setQueryData(qk.prefs(), next);
    setState("saving");
    clearTimeout(clear.current);
    clearTimeout(debounce.current);
    const mine = ++token.current;
    debounce.current = setTimeout(() => {
      save.mutate(next, {
        onSuccess: (server) => {
          confirmed.current = server;
          if (mine !== token.current) return;
          qc.setQueryData(qk.prefs(), server);
          setState("saved");
          clear.current = setTimeout(() => setState("idle"), 2050);
        },
        onError: (err) => {
          if (mine !== token.current) return;
          if (confirmed.current) qc.setQueryData(qk.prefs(), confirmed.current);
          setState("idle");
          toast.error("Couldn’t save notification settings", { body: errorMessage(err) });
        },
      });
    }, 400);
  };

  const prefs = prefsQ.data;
  const toggle = (event: NotificationEvent, channel: NotificationChannel, on: boolean) => {
    if (!prefs) return;
    commit({ ...prefs, events: { ...prefs.events, [event]: { ...prefs.events[event], [channel]: on } } });
  };

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-10 pb-10 pt-7 max-[760px]:px-4 max-[760px]:pt-5">
      <div className="flex min-h-7 items-center gap-3">
        <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.015em]">Notifications</h1>
        <span className="flex-1" />
        <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-[12px] text-fg-3">
          {state === "saving" && (
            <>
              <span aria-hidden className="size-3 animate-[spin_.7s_linear_infinite] rounded-full border-2 border-line-2 border-t-fg-2" />
              Saving
            </>
          )}
          {state === "saved" && (
            <span className="inline-flex animate-[fade-in_160ms_var(--ease)] items-center gap-1.5">
              <CheckIcon size={14} className="text-ok" />
              Saved
            </span>
          )}
        </span>
      </div>

      {prefsQ.isPending ? (
        <MatrixSkeleton />
      ) : prefsQ.isError ? (
        <ErrorState
          title="Couldn’t load notification settings"
          body="Your saved settings are unchanged."
          onRetry={() => void prefsQ.refetch()}
          retrying={prefsQ.isFetching}
        />
      ) : (
        <>
          <PreferencesMatrix prefs={prefsQ.data} onToggle={toggle} />
          <div className="flex flex-wrap items-center gap-3.5 rounded-lg border border-line bg-surface px-4 py-3.5">
            <span id="pm-delivery" className="font-medium">
              Email delivery
            </span>
            <Segmented
              label="Email delivery"
              value={prefsQ.data.emailDelivery}
              onChange={(v) => commit({ ...prefsQ.data, emailDelivery: v })}
              options={[
                { value: "instant", label: "Instant" },
                { value: "hourly", label: "Hourly" },
                { value: "daily", label: "Daily" },
              ]}
            />
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-fg-3" title="Emails go to your account address">
              {me.email}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Events × channels. In-app and Email are live switches; the other channels are "coming soon". */
export function PreferencesMatrix({
  prefs,
  onToggle,
}: {
  prefs: NotificationPreferences;
  onToggle: (event: NotificationEvent, channel: NotificationChannel, on: boolean) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <div role="table" aria-label="Notification preferences" className="min-w-[710px]">
        <div role="rowgroup">
          <div role="row" className={cn(ROW, "bg-bg")}>
            <span role="columnheader" className="flex min-h-[52px] items-center pl-4 text-[12px] font-medium text-fg-3">
              Event
            </span>
            {LIVE.map((c) => (
              <span key={c.key} role="columnheader" className="flex min-h-[52px] flex-col items-center justify-center gap-[5px] px-1.5 py-2 text-[12px] font-semibold">
                {c.label}
              </span>
            ))}
            {SOON.map((c) => (
              <span
                key={c}
                role="columnheader"
                className="flex min-h-[52px] flex-col items-center justify-center gap-[5px] px-1.5 py-2 text-[12px] font-semibold text-fg-3"
                style={{ background: HATCH }}
              >
                {c}
                <span className="rounded-[5px] border border-dashed border-line-2 px-[5px] py-[3px] font-mono text-[9.5px] font-medium uppercase leading-none tracking-[.04em] text-fg-3">
                  Coming soon
                </span>
              </span>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {PREF_ROWS.map(({ event, type }) => {
            const name = EVENTS[type].pref;
            return (
              <div key={event} role="row" className={cn(ROW, "border-t border-line")}>
                <span role="rowheader" className="flex min-h-[50px] items-center gap-2.5 px-4 font-medium">
                  <span aria-hidden className="flex size-[26px] flex-none items-center justify-center rounded-[7px] border border-line bg-raised">
                    <EventIcon type={type} size={14} />
                  </span>
                  {name}
                </span>
                {LIVE.map((c) => (
                  <span key={c.key} role="cell" className="flex items-center justify-center">
                    <Switch
                      aria-label={`${name}, ${c.label}`}
                      checked={prefs.events[event]?.[c.key] ?? false}
                      onChange={(e) => onToggle(event, c.key, e.currentTarget.checked)}
                    />
                  </span>
                ))}
                {SOON.map((c) => (
                  <span key={c} role="cell" className="flex items-center justify-center" style={{ background: HATCH }}>
                    <span
                      role="img"
                      aria-label={`${name}, ${c}: coming soon`}
                      title="Coming soon"
                      data-soon
                      className="relative h-[18px] w-8 cursor-not-allowed rounded-[9px] border border-dashed border-line-2 opacity-70"
                    >
                      <span aria-hidden className="absolute left-0.5 top-0.5 size-3 rounded-full bg-line-2" />
                    </span>
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MatrixSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading notification settings" className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="h-[52px] bg-bg" />
      {PREF_ROWS.map((r, i) => (
        <div key={r.event} className="flex h-[50px] items-center gap-2.5 border-t border-line px-4">
          <Skeleton className="size-[26px] rounded-[7px]" />
          <Skeleton className="h-2.5" style={{ width: `${[22, 16, 30, 20, 14, 18][i]}%` }} />
          <span className="flex-1" />
          <Skeleton className="h-[18px] w-8 rounded-full" />
          <Skeleton className="ml-[76px] h-[18px] w-8 rounded-full max-[760px]:hidden" />
        </div>
      ))}
    </div>
  );
}
