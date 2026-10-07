/**
 * Access-token storage and auth events.
 * The access token is kept in module memory only (lost on reload, restored via /auth/refresh
 * using the httpOnly refresh cookie). This is the approach the brief requires for live mode.
 */

let accessToken: string | null = null;

export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => {
    accessToken = t;
  },
};

type AuthEvent = "expired" | "signed-out";
const listeners = new Map<AuthEvent, Set<() => void>>();

export const authEvents = {
  on(event: AuthEvent, fn: () => void) {
    const set = listeners.get(event) ?? new Set();
    set.add(fn);
    listeners.set(event, set);
    return () => {
      set.delete(fn);
    };
  },
  emit(event: AuthEvent) {
    listeners.get(event)?.forEach((fn) => fn());
  },
};
