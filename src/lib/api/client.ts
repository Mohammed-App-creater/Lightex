import { apiMode, apiUrl } from "@/lib/env";
import { HttpTransport } from "./http-transport";
import type { ListQuery, RequestOptions, Transport } from "./transport";

/*
 * The single place that decides where requests go. Mock mode loads the in-browser backend
 * lazily (its own chunk), so live builds never download it.
 */

let transportPromise: Promise<Transport> | null = null;

export function getTransport(): Promise<Transport> {
  transportPromise ??=
    apiMode === "live"
      ? Promise.resolve(new HttpTransport(apiUrl))
      : import("@/lib/mock/transport").then((m) => new m.MockTransport());
  return transportPromise;
}

/** For tests: inject a transport. */
export function setTransport(t: Transport) {
  transportPromise = Promise.resolve(t);
}

type Opts = Pick<RequestOptions, "signal" | "anonymous">;

async function request<T>(options: RequestOptions) {
  const t = await getTransport();
  return t.request<T>(options);
}

export const http = {
  get: <T>(path: string, query?: ListQuery, opts?: Opts) => request<T>({ method: "GET", path, query, ...opts }),
  post: <T>(path: string, body?: unknown, opts?: Opts) => request<T>({ method: "POST", path, body, ...opts }),
  patch: <T>(path: string, body?: unknown, opts?: Opts) => request<T>({ method: "PATCH", path, body, ...opts }),
  put: <T>(path: string, body?: unknown, opts?: Opts) => request<T>({ method: "PUT", path, body, ...opts }),
  del: <T = void>(path: string, body?: unknown, opts?: Opts) => request<T>({ method: "DELETE", path, body, ...opts }),
};

export const enc = encodeURIComponent;
