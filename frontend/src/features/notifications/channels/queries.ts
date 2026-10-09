"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { TelegramLink } from "@/lib/api/types";

/** C1. staleTime 30 s; refetch on window focus (v1 rule) covers STOP / blocked-bot changes made elsewhere. */
export function useChannels() {
  return useQuery({ queryKey: qk.channels(), queryFn: api.channels.get, staleTime: 30_000 });
}

/**
 * C3, polled every 2 s while the dialog is open, the link pending and the tab visible. `onPoll` sees each
 * response (the dialog's reducer), so nothing is copied from query data into state in an effect.
 */
export function useTelegramLink(id: string | null, pending: boolean, onPoll: (link: TelegramLink) => void) {
  return useQuery({
    queryKey: qk.telegramLink(id ?? ""),
    queryFn: async () => {
      const link = await api.channels.telegramLink(id!);
      onPoll(link);
      return link;
    },
    enabled: Boolean(id) && pending,
    refetchInterval: pending ? 2000 : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}
