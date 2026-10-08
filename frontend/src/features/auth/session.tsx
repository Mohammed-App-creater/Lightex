"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api/endpoints";
import { authEvents, tokenStore } from "@/lib/api/session";
import type { User } from "@/lib/api/types";
import { apiMode } from "@/lib/env";

type Status = "loading" | "anonymous" | "authenticated";

type SessionValue = {
  status: Status;
  user: User | null;
  /**
   * True once authenticated requests can be sent: immediately in mock mode, and in live mode as
   * soon as the access token is restored, before /auth/me returns. Lets route data load in
   * parallel with the session check instead of after it.
   */
  ready: boolean;
  /** True after a 401 that a refresh could not fix: show the re-auth modal, keep drafts. */
  expired: boolean;
  signedIn: (result: { accessToken: string; user: User }) => void;
  signOut: () => Promise<void>;
  setUser: (user: User) => void;
  clearExpired: () => void;
};

const SessionCtx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUserState] = useState<User | null>(null);
  const [ready, setReady] = useState(apiMode !== "live");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (apiMode === "live") {
          // Access token is memory-only: restore it from the httpOnly refresh cookie.
          const { accessToken } = await api.auth.refresh();
          tokenStore.set(accessToken);
          if (!alive) return;
          setReady(true);
        }
        const me = await api.auth.me();
        if (!alive) return;
        setUserState(me);
        setStatus("authenticated");
      } catch {
        if (!alive) return;
        tokenStore.set(null);
        setReady(false);
        setStatus("anonymous");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () =>
      authEvents.on("expired", () => {
        setStatus((s) => {
          if (s === "authenticated") setExpired(true);
          return s;
        });
      }),
    [],
  );

  const signedIn = useCallback(
    (result: { accessToken: string; user: User }) => {
      tokenStore.set(result.accessToken);
      setUserState((prev) => {
        // A different user (dev role switcher, account change): drop every cached response.
        // Re-auth as the same user keeps the cache so nothing on screen is lost.
        if (prev?.id !== result.user.id) qc.clear();
        return result.user;
      });
      setExpired(false);
      setReady(true);
      setStatus("authenticated");
    },
    [qc],
  );

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* signing out locally is enough */
    }
    tokenStore.set(null);
    setUserState(null);
    setReady(apiMode !== "live");
    setStatus("anonymous");
    qc.clear();
    authEvents.emit("signed-out");
  }, [qc]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      ready,
      expired,
      signedIn,
      signOut,
      setUser: setUserState,
      clearExpired: () => setExpired(false),
    }),
    [status, user, ready, expired, signedIn, signOut],
  );

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const v = useContext(SessionCtx);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
}

/** The signed-in user; only call inside the authenticated app shell. */
export function useMe(): User {
  const { user } = useSession();
  if (!user) throw new Error("useMe called without a signed-in user");
  return user;
}
