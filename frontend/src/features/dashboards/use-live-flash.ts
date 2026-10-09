"use client";

import { useEffect, useState } from "react";
import { liveUpdateToast } from "@/features/presence/live-toast";
import type { User } from "@/lib/api/types";
import { claimLiveToast, remoteMarks, type RemoteMark } from "@/lib/realtime/remote";
import { useIsLive } from "@/lib/realtime/status-store";
import { changedKeys } from "./widget-lib";

/*
 * use-live-flash (spec §7.6, §7.8): keeps the previous rows of a widget; when a refetch caused by
 * someone else's event lands (a remote mark for the scope, newer than the previous data), it
 * flashes the changed rows for 1.6 s and raises "Updated just now by Riley · Burndown" (at most
 * one toast every 4 s). Off in polling mode; the flash is static under reduced motion (CSS).
 */

const EMPTY: readonly string[] = [];

type State<T> = { at: number; rows: readonly T[]; flash: readonly string[]; mark: RemoteMark | null };

export function useLiveFlash<T>({
  scope,
  rows,
  dataUpdatedAt,
  rowKey,
  rowSig,
  label,
  who,
}: {
  /** `p:<projectId>` */
  scope: string;
  rows: readonly T[];
  dataUpdatedAt: number;
  rowKey: (t: T) => string;
  rowSig: (t: T) => string;
  /** Widget name in the toast ("Burndown"). */
  label: string;
  who: (actorId: string) => Pick<User, "name" | "hue"> | null;
}): ReadonlySet<string> {
  const live = useIsLive();
  const [s, setS] = useState<State<T>>({ at: dataUpdatedAt, rows, flash: EMPTY, mark: null });
  if (dataUpdatedAt !== s.at) {
    const mark = live && s.at ? remoteMarks.get(scope, s.at) : null;
    const keys = mark ? changedKeys(s.rows, rows, rowKey, rowSig) : EMPTY;
    setS({ at: dataUpdatedAt, rows, flash: keys, mark: keys.length ? mark : null });
  }
  useEffect(() => {
    if (!s.flash.length || !s.mark) return;
    const person = who(s.mark.actorId);
    if (person && claimLiveToast()) liveUpdateToast(person, label);
    const t = setTimeout(() => setS((x) => ({ ...x, flash: EMPTY, mark: null })), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per landed refetch
  }, [s.at]);
  return new Set(s.flash);
}
