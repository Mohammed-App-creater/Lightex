"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMe } from "@/features/auth/session";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { startRealtime, type RealtimeHandle } from "./client";
import { startPresenceEngine } from "./presence";

/*
 * RealtimeProvider (spec §7.1, §7.7): mounted once per workspace by app/[workspace]/layout.tsx.
 * It starts the tab's realtime client (leader election, the stream loop in the leader, event
 * application in every tab) and the tab's presence heartbeat. Screens use useRealtime() to pause
 * event application while a board card is in the air.
 */

type Ctx = { pause: (projectId: string) => void; resume: (projectId: string) => void };
const NOOP: Ctx = { pause: () => undefined, resume: () => undefined };
const RealtimeCtx = createContext<Ctx>(NOOP);

export function useRealtime() {
  return useContext(RealtimeCtx);
}

export function RealtimeProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const qc = useQueryClient();
  const me = useMe();
  const ws = useCurrentWorkspace();
  const handle = useRef<RealtimeHandle | null>(null);
  // Stable: the handle is only read when a screen calls pause / resume.
  const [value] = useState<Ctx>(() => ({
    pause: (projectId) => handle.current?.applier.pause(projectId),
    resume: (projectId) => handle.current?.applier.resume(projectId),
  }));

  useEffect(() => {
    const h = startRealtime({ slug, qc, meId: me.id, workspaceId: ws?.id });
    const presence = startPresenceEngine({ slug, qc });
    handle.current = h;
    return () => {
      presence.stop();
      h.stop();
      handle.current = null;
    };
  }, [slug, qc, me.id, ws?.id]);

  return <RealtimeCtx.Provider value={value}>{children}</RealtimeCtx.Provider>;
}
