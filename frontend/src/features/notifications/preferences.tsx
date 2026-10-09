"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Segmented } from "@/components/ui/choice";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useWorkspace } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { NotificationChannel, NotificationEvent, NotificationPreferences, PushDevice, QuietHours, TestableChannel, Workspace } from "@/lib/api/types";
import { lazyWithPreload, whenIdle } from "@/lib/hooks/lazy-with-preload";
import { useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { ChannelsSection } from "./channels/channels-section";
import { CheckIcon } from "./icons";
import { CHANNEL_NAME, columnStates, previewFor, testErrorCopy, toggleCell, withDefaults, type PreviewChannel } from "./channels/model";
import { PreferencesMatrix } from "./channels/preferences-matrix";
import { QuietHoursCard } from "./channels/quiet-hours";
import { useChannels } from "./channels/queries";
import { TestPreview } from "./channels/test-preview";
import { usePush } from "./channels/use-push";
import { usePrefs, useSavePrefs } from "./queries";

/*
 * Settings → Notifications (board 38 replaces the v1 page): Channels (connect / test / remove, the admin
 * SMS policy row), Preferences (6 events × 5 channels; v1's email delivery control stays under it, §10 #4)
 * and Quiet hours. Matrix and quiet-hours changes share v1's optimistic, debounced save with
 * "Saving / Saved" in the header.
 */

const TelegramDialog = lazyWithPreload(() => import("./channels/telegram-dialog").then((m) => m.TelegramDialog));
const SmsDialog = lazyWithPreload(() => import("./channels/sms-dialog").then((m) => m.SmsDialog));

type SaveState = "idle" | "saving" | "saved";

export function NotificationPreferencesPage() {
  const me = useMe();
  const scope = useCurrentWorkspace();
  // The workspace query (not only the scope's snapshot), so the optimistic SMS policy shows at once.
  const wsQ = useWorkspace(scope?.slug ?? "");
  const ws = wsQ.data ?? scope;
  const canPolicy = useCan("workspace.update", "workspace");
  const qc = useQueryClient();
  const prefsQ = usePrefs();
  const channelsQ = useChannels();
  const save = useSavePrefs();
  const [state, setState] = useState<SaveState>("idle");
  const [dialog, setDialogState] = useState<"telegram" | "sms" | null>(null);
  /** Bumped on every opening, so the Telegram dialog requests a fresh code each time (and only once). */
  const [opening, setOpening] = useState(0);
  const setDialog = (d: "telegram" | "sms" | null) => {
    // A timestamp, not a counter: unique across page mounts too (the shared request is module-level).
    if (d) setOpening(Date.now());
    setDialogState(d);
  };
  const [preview, setPreview] = useState<{ channel: PreviewChannel; key: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  useEffect(
    () =>
      whenIdle(() => {
        TelegramDialog.preload();
        SmsDialog.preload();
      }),
    [],
  );

  const channels = channelsQ.data;
  const push = usePush(channels?.push.devices ?? [], channels?.push.vapidPublicKey ?? null);
  const smsPolicy = ws?.notificationPolicy?.sms ?? true;

  const flashSaved = () => {
    setState("saved");
    clearTimeout(clear.current);
    clear.current = setTimeout(() => setState("idle"), 2050);
  };

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
          flashSaved();
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

  const prefs = prefsQ.data ? withDefaults(prefsQ.data) : undefined;
  const toggle = (event: NotificationEvent, channel: NotificationChannel, on: boolean) => {
    if (prefs) commit(toggleCell(prefs, event, channel, on));
  };
  const setQuiet = (quietHours: QuietHours) => {
    if (prefs) commit({ ...prefs, quietHours });
  };

  /* Workspace SMS policy: optimistic workspace PATCH with rollback (§4.2). */
  const togglePolicy = async (on: boolean) => {
    if (!ws) return;
    const key = qk.workspace(ws.slug);
    const before = qc.getQueryData<Workspace>(key);
    if (before) qc.setQueryData<Workspace>(key, { ...before, notificationPolicy: { sms: on } });
    setState("saving");
    try {
      const server = await api.workspaces.update(ws.slug, { notificationPolicy: { sms: on } });
      qc.setQueryData(key, server);
      flashSaved();
    } catch (e) {
      if (before) qc.setQueryData(key, before);
      setState("idle");
      toast.error(on ? "Couldn’t turn SMS on" : "Couldn’t turn SMS off", { body: errorMessage(e) });
    }
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy((b) => (b === key ? null : b));
    }
  };

  const sendTest = (channel: PreviewChannel) =>
    run(`${channel}:test`, async () => {
      if (channel !== "in_app") {
        try {
          await api.channels.test(channel as TestableChannel, ws ? { workspace: ws.slug } : undefined);
        } catch (e) {
          const copy = testErrorCopy(channel as TestableChannel, e);
          toast.error(copy.title, { body: copy.body });
          void qc.invalidateQueries({ queryKey: qk.channels() });
          return;
        }
      }
      toast.success(`Test sent · ${CHANNEL_NAME[channel]}`);
      setPreview({ channel, key: Date.now() });
    });

  const remove = (channel: "telegram" | "sms" | "push") =>
    run(`${channel}:remove`, async () => {
      try {
        if (channel === "push") {
          await push.turnOff();
          return;
        }
        if (channel === "telegram") await api.channels.disconnectTelegram();
        else await api.channels.removeSms();
        toast.success(channel === "telegram" ? "Telegram disconnected" : "Phone number removed");
      } catch (e) {
        toast.error(`Couldn’t disconnect ${CHANNEL_NAME[channel]}`, { body: errorMessage(e) });
      } finally {
        await qc.invalidateQueries({ queryKey: qk.channels() });
      }
    });

  const removeDevice = (d: PushDevice) =>
    run("push:remove", async () => {
      try {
        await api.channels.removePushDevice(d.id);
        toast.success(`Push removed from ${d.label}`);
      } catch (e) {
        toast.error("Couldn’t remove the device", { body: errorMessage(e) });
      } finally {
        await qc.invalidateQueries({ queryKey: qk.channels() });
      }
    });

  const connect = (channel: NotificationChannel) => {
    if (channel === "telegram" || channel === "sms") setDialog(channel);
    else if (channel === "push") void run("push:enable", push.enable);
  };

  const columns = columnStates({ channels, channelsError: channelsQ.isError, smsPolicy, push: push.view });
  const loading = prefsQ.isPending || (channelsQ.isPending && !channelsQ.isError);

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col px-10 pb-16 pt-7 max-[760px]:px-4 max-[760px]:pt-4">
      <div className="flex min-h-7 items-center gap-3 pb-5">
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

      {loading ? (
        <PageSkeleton />
      ) : prefsQ.isError || !prefs ? (
        <ErrorState
          title="Couldn’t load notification settings"
          body="Your saved settings are unchanged."
          onRetry={() => {
            void prefsQ.refetch();
            void channelsQ.refetch();
          }}
          retrying={prefsQ.isFetching}
        />
      ) : (
        <>
          <section aria-label="Channels" className="flex flex-col gap-3 pb-5">
            <h3 className="m-0 text-[13px] font-semibold">Channels</h3>
            {channels ? (
              <ChannelsSection
                channels={channels}
                push={push.view}
                smsPolicy={smsPolicy}
                policyRow={canPolicy && ws ? { workspaceName: ws.name, onToggle: (on) => void togglePolicy(on) } : null}
                dialog={dialog}
                busy={busy}
                handlers={{
                  onConnect: (c) => setDialog(c),
                  onEnablePush: () => void run("push:enable", push.enable),
                  onCheckPush: () => void run("push:check", push.check),
                  onTest: (c) => void sendTest(c),
                  onRemove: (c) => void remove(c),
                  onRemoveDevice: (d) => void removeDevice(d),
                }}
              />
            ) : (
              <ErrorState
                title="Couldn’t load your channels"
                body="Preferences below still save. Telegram, SMS and Push are unavailable until this loads."
                onRetry={() => void channelsQ.refetch()}
                retrying={channelsQ.isFetching}
              />
            )}
          </section>

          <section aria-label="Preferences" className="flex flex-col gap-3 border-t border-line py-5">
            <h3 className="m-0 text-[13px] font-semibold">Preferences</h3>
            <PreferencesMatrix prefs={prefs} columns={columns} onToggle={toggle} onConnect={connect} onRetry={() => void channelsQ.refetch()} />
            <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-line bg-surface px-4 py-3.5">
              <span className="font-medium">Email delivery</span>
              <Segmented
                label="Email delivery"
                value={prefs.emailDelivery}
                onChange={(v) => commit({ ...prefs, emailDelivery: v })}
                options={[
                  { value: "instant", label: "Instant" },
                  { value: "hourly", label: "Hourly" },
                  { value: "daily", label: "Daily" },
                ]}
              />
              <span className="flex-1" />
              <span className="truncate font-mono text-[11px] text-fg-3" title="Emails go to your account address">
                {me.email}
              </span>
            </div>
          </section>

          <section aria-label="Quiet hours" className="flex flex-col gap-3 border-t border-line pt-5">
            <QuietHoursCard value={prefs.quietHours} onChange={setQuiet} />
          </section>
        </>
      )}

      {dialog === "telegram" && (
        <TelegramDialog.Component
          opening={opening}
          onClose={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: qk.channels() });
          }}
          onSendTest={() => void sendTest("telegram")}
        />
      )}
      {dialog === "sms" && channels && (
        <SmsDialog.Component countries={channels.sms.countries} onClose={() => setDialog(null)} onSendTest={() => void sendTest("sms")} />
      )}
      {preview && (
        <TestPreview
          key={preview.key}
          channel={preview.channel}
          card={previewFor(preview.channel, { email: channels?.email.address, host: typeof window === "undefined" ? undefined : window.location.host })}
          onDone={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/** The design's skeleton: 5 channel rows, then 4 matrix rows. */
function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading notification settings" className="flex flex-col gap-3.5">
      <Skeleton className="h-3 w-20" />
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {[
          [60, 90],
          [48, 120],
          [76, 70],
          [40, 96],
          [44, 60],
        ].map(([w, w2], i) => (
          <div key={i} className="flex min-h-14 items-center gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex flex-1 flex-col gap-[7px]">
              <Skeleton className="h-[11px]" style={{ width: w }} />
              <Skeleton className="h-[9px]" style={{ width: w2 }} />
            </div>
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-2 h-3 w-24" />
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {[110, 80, 140, 96].map((w, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_repeat(5,104px)] border-t border-line first:border-t-0 max-[760px]:grid-cols-[minmax(0,1fr)_repeat(5,48px)]">
            <span className="flex min-h-12 items-center px-4">
              <Skeleton className="h-2.5" style={{ width: Math.min(w, 80) }} />
            </span>
            {[0, 1, 2, 3, 4].map((c) => (
              <span key={c} className="flex items-center justify-center">
                <Skeleton className="h-3.5 w-[26px] rounded-full" />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
