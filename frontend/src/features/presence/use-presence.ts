"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { PresenceLocation } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { presenceClaims, type PresenceClaim } from "@/lib/realtime/presence";
import { mergeRoster, type CachedRoster } from "@/lib/realtime/roster";

/*
 * usePresence (spec §7.6): a screen claims where this tab is (board, dashboard, task) with its
 * state, field and typing flag. The tab's presence engine (RealtimeProvider) turns the most
 * specific claim into the heartbeat PUT, debounced 300 ms after a change, every 20 s while
 * visible, DELETE after 30 s hidden or on pagehide.
 */

export type PresenceInput = {
  projectId: string;
  location: PresenceLocation;
  state?: "viewing" | "editing";
  field?: string | null;
  typing?: boolean;
  composer?: boolean;
};

export function usePresence(input: PresenceInput | null) {
  const [id] = useState(() => presenceClaims.newId());
  const key = input ? JSON.stringify(input) : "";
  useEffect(() => {
    if (!key) {
      presenceClaims.remove(id);
      return;
    }
    const c = JSON.parse(key) as PresenceInput;
    const claim: PresenceClaim = {
      projectId: c.projectId,
      location: c.location,
      state: c.state ?? "viewing",
      field: c.state === "editing" ? (c.field ?? null) : null,
      typing: Boolean(c.typing),
      composer: c.composer,
    };
    presenceClaims.set(id, claim);
  }, [id, key]);
  useEffect(() => () => presenceClaims.remove(id), [id]);
}

/**
 * The project's presence roster (qk.presence). Live: presence.updated events keep it fresh and every
 * hello refetches it; polling: the heartbeat response writes it every 20 s.
 */
export function useRoster(projectId: string | undefined) {
  const ws = useCurrentWorkspace();
  const qc = useQueryClient();
  const slug = ws?.slug ?? "";
  return useQuery({
    queryKey: qk.presence(slug, projectId ?? ""),
    queryFn: async () => mergeRoster(qc.getQueryData<CachedRoster>(qk.presence(slug, projectId!)), await api.presence.roster(slug, projectId!)),
    enabled: Boolean(slug && projectId),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
