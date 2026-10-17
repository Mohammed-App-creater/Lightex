"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderInfo } from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { DEV_ICON, DevGlyph, ProviderLogo } from "./icons";
import { PR_NOUN } from "./lib/dev-lib";

export type TileState = "idle" | "waiting" | "choosing";

/**
 * A provider that isn't connected yet (design "Not connected" / "Connecting"): name, the three
 * chips, and Connect, the "Waiting for authorization…" busy state with Cancel, or the lock note
 * for people without `integration.manage` (§11 #5: no role names).
 */
export function ProviderTile({
  info,
  canManage,
  state,
  onConnect,
  onCancel,
}: {
  info: ProviderInfo;
  canManage: boolean;
  state: TileState;
  onConnect: () => void;
  onCancel: () => void;
}) {
  const busy = state !== "idle";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-3.5 transition-[border-color,box-shadow] duration-150",
        busy && "border-accent shadow-[0_0_0_3px_var(--accent-s)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderLogo provider={info.provider} />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{info.name}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {["Branches", "Commits", PR_NOUN[info.provider].long].map((c) => (
          <span key={c} className="inline-flex h-[22px] items-center rounded-[6px] border border-line bg-raised px-2 font-mono text-[11.5px] font-medium text-fg-2">
            {c}
          </span>
        ))}
      </div>
      <div className="flex min-h-7 items-center gap-2">
        {!canManage ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-3">
            <DevGlyph d={DEV_ICON.lock} />
            Can’t connect · needs Manage integrations
          </span>
        ) : state === "waiting" ? (
          <>
            <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap text-[12px] text-fg-2">
              <Spinner />
              Waiting for authorization…
            </span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : state === "choosing" ? (
          <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap text-[12px] text-fg-2">
            <Spinner />
            Choosing repositories…
          </span>
        ) : (
          <Button size="sm" onClick={onConnect} disabledReason={info.available ? undefined : `${info.name} isn’t set up on this server.`}>
            Connect {info.name}
          </Button>
        )}
      </div>
    </div>
  );
}
