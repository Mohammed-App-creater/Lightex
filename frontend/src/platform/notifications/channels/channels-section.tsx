"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import type { NotificationChannel, NotificationChannels, PushDevice } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { ChannelIcon, DashDot, OkGlyph, ShieldGlyph, Spin, WarnGlyph, XGlyph } from "./icons";
import { CHANNEL_NAME, pushRow, smsRow, telegramRow, type PreviewChannel, type PushView, type RowAction, type RowModel } from "./model";

/*
 * Board 38 "Channels" (design `.ch-list`): one row per channel with its status line and actions, and for
 * holders of workspace.update the "SMS for {workspace}" policy row (no permission → no row).
 */

export type ChannelHandlers = {
  onConnect: (channel: "telegram" | "sms") => void;
  onEnablePush: () => void;
  onCheckPush: () => void;
  onTest: (channel: PreviewChannel) => void;
  onRemove: (channel: "telegram" | "sms" | "push") => void;
  onRemoveDevice: (device: PushDevice) => void;
};

function StatusLine({ model, extra }: { model: RowModel; extra?: React.ReactNode }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3", model.tone === "err" && "text-danger")}>
      {model.tone === "ok" && (
        <span className="text-ok">
          <OkGlyph />
        </span>
      )}
      {model.tone === "err" && <WarnGlyph />}
      {model.tone === "off" && <DashDot />}
      {model.tone === "wait" && <Spin size={10} />}
      <span className={cn("truncate", model.mono && "font-mono")}>{model.status}</span>
      {extra}
    </span>
  );
}

function Row({
  channel,
  model,
  busy,
  onAction,
  extra,
}: {
  channel: NotificationChannel;
  model: RowModel;
  busy: RowAction | null;
  onAction: (a: RowAction) => void;
  extra?: React.ReactNode;
}) {
  const label: Record<RowAction, string> = { test: "Send test", connect: "Connect", reconnect: "Reconnect", enable: "Enable", check: "Check again", remove: model.removeLabel };
  return (
    <li className="flex min-h-14 items-center gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0" data-channel={channel}>
      <span aria-hidden className="inline-flex size-8 flex-none items-center justify-center rounded-lg border border-line-2 bg-raised text-fg">
        <ChannelIcon channel={channel} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <b className="font-semibold">{CHANNEL_NAME[channel]}</b>
        <StatusLine model={model} extra={extra} />
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {model.actions.map((a) =>
          a === "remove" ? (
            <Button key={a} variant="ghost" size="sm" icon aria-label={label.remove} tooltip={label.remove} loading={busy === a} onClick={() => onAction(a)} className="max-[760px]:size-10">
              <XGlyph />
            </Button>
          ) : (
            <Button
              key={a}
              variant={a === "test" ? "ghost" : "secondary"}
              size="sm"
              loading={busy === a}
              onClick={() => onAction(a)}
              className="max-[760px]:h-10 max-[760px]:px-2"
            >
              {label[a]}
            </Button>
          ),
        )}
      </div>
    </li>
  );
}

/** "+2 devices" → a menu of the other browsers with per-device remove (§10 #8). */
function DevicesMenu({ devices, onRemove }: { devices: PushDevice[]; onRemove: (d: PushDevice) => void }) {
  if (!devices.length) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex-none rounded text-[12px] font-medium text-accent-t hover:underline" aria-label={`Manage ${devices.length} other device${devices.length === 1 ? "" : "s"}`}>
          Devices
        </button>
      </MenuTrigger>
      <MenuContent align="start" width={240}>
        <MenuLabel>Other devices with push</MenuLabel>
        {devices.map((d) => (
          <MenuItem key={d.id} onSelect={() => onRemove(d)} meta="Remove">
            {d.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function ChannelsSection({
  channels,
  push,
  smsPolicy,
  policyRow,
  dialog,
  busy,
  handlers,
}: {
  channels: NotificationChannels;
  push: PushView;
  smsPolicy: boolean;
  /** Rendered only for workspace.update holders. */
  policyRow: { workspaceName: string; onToggle: (on: boolean) => void } | null;
  dialog: "telegram" | "sms" | null;
  /** The action in flight, per channel ("telegram:test"). */
  busy: string | null;
  handlers: ChannelHandlers;
}) {
  const b = (ch: string): RowAction | null => (busy?.startsWith(`${ch}:`) ? (busy.split(":")[1] as RowAction) : null);
  const tg = telegramRow(channels.telegram, dialog === "telegram");
  const sms = smsRow(channels.sms, smsPolicy);
  const pu = pushRow(channels.push.available, push);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <ul className="m-0 list-none p-0" aria-label="Channels">
        <Row channel="in_app" model={{ status: "Always on", tone: "ok", mono: false, actions: ["test"], removeLabel: "" }} busy={b("in_app")} onAction={() => handlers.onTest("in_app")} />
        <Row channel="email" model={{ status: channels.email.address, tone: "ok", mono: true, actions: ["test"], removeLabel: "" }} busy={b("email")} onAction={() => handlers.onTest("email")} />
        <Row
          channel="telegram"
          model={tg}
          busy={b("telegram")}
          onAction={(a) => (a === "test" ? handlers.onTest("telegram") : a === "remove" ? handlers.onRemove("telegram") : handlers.onConnect("telegram"))}
        />
        <Row
          channel="sms"
          model={sms}
          busy={b("sms")}
          onAction={(a) => (a === "test" ? handlers.onTest("sms") : a === "remove" ? handlers.onRemove("sms") : handlers.onConnect("sms"))}
        />
        <Row
          channel="push"
          model={pu}
          busy={b("push")}
          extra={<DevicesMenu devices={push.others} onRemove={handlers.onRemoveDevice} />}
          onAction={(a) =>
            a === "test" ? handlers.onTest("push") : a === "remove" ? handlers.onRemove("push") : a === "check" ? handlers.onCheckPush() : handlers.onEnablePush()
          }
        />
      </ul>
      {policyRow && (
        <label className="flex cursor-pointer items-center gap-2.5 border-t border-line bg-bg px-3.5 py-2.5 text-[12px] text-fg-2">
          <ShieldGlyph />
          <span className="flex-1">SMS for {policyRow.workspaceName}</span>
          <span className="font-mono text-[11px] text-fg-3">admin</span>
          <Switch aria-label="Allow SMS for the workspace" checked={smsPolicy} onChange={(e) => policyRow.onToggle(e.currentTarget.checked)} />
        </label>
      )}
    </div>
  );
}
