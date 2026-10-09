"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { PushDevice } from "@/lib/api/types";
import { createStore } from "@/lib/utils/store";
import { pushView, type PushView } from "./model";
import { checkAgain, enablePush, getPushPlatform, turnOffPush, type PushSupport } from "./push";
import { endpointHash } from "./sha256";

/*
 * This browser's push state for the Channels row and the matrix's Push column (spec §8.5, §8.6).
 * Support and permission are read from the platform; the local subscription's endpoint hash is loaded
 * once and after every action, then matched against C1's devices ("This browser").
 */

type Local = { hash: string | null; prompting: boolean; rev: number };
const local = createStore<Local>({ hash: null, prompting: false, rev: 0 });

async function refreshLocal() {
  try {
    const sub = await getPushPlatform().current();
    local.set((s) => ({ ...s, hash: sub ? endpointHash(sub.endpoint) : null, rev: s.rev + 1 }));
  } catch {
    local.set((s) => ({ ...s, hash: null, rev: s.rev + 1 }));
  }
}

const noop = () => () => {};

export function usePush(devices: PushDevice[], vapidKey: string | null) {
  const qc = useQueryClient();
  const state = useSyncExternalStore(local.subscribe, local.get, local.get);
  const support = useSyncExternalStore<PushSupport>(noop, () => getPushPlatform().support(), () => "unsupported");
  // Re-read after every action (rev changes), so "Check again" sees a permission changed in site settings.
  const permission = useSyncExternalStore<NotificationPermission>(local.subscribe, () => getPushPlatform().permission(), () => "default");

  useEffect(() => {
    void refreshLocal();
  }, []);

  const view: PushView = pushView({ support, permission, localHash: state.hash, devices, prompting: state.prompting });

  const done = async () => {
    await refreshLocal();
    await qc.invalidateQueries({ queryKey: qk.channels() });
  };

  const enable = async () => {
    if (!vapidKey) return;
    local.set((s) => ({ ...s, prompting: true }));
    try {
      const out = await enablePush(getPushPlatform(), vapidKey);
      if (out === "on") toast.success("Push enabled");
    } catch (e) {
      toast.error("Couldn’t turn on push", { body: errorMessage(e) });
    } finally {
      local.set((s) => ({ ...s, prompting: false }));
      await done();
    }
  };

  const check = async () => {
    if (!vapidKey) return;
    try {
      const out = await checkAgain(getPushPlatform(), vapidKey);
      if (out === "blocked") toast.info("Still blocked in browser", { body: "Unblock: lock icon in the address bar › Notifications › Allow." });
      if (out === "on") toast.success("Push enabled");
    } catch (e) {
      toast.error("Couldn’t turn on push", { body: errorMessage(e) });
    } finally {
      await done();
    }
  };

  const turnOff = async () => {
    await turnOffPush(getPushPlatform());
    toast.success("Push turned off in this browser");
    await done();
  };

  return { view, support, permission, enable, check, turnOff };
}

/** Tests: forget the cached local subscription. */
export function resetPushLocal() {
  local.set({ hash: null, prompting: false, rev: 0 });
}
