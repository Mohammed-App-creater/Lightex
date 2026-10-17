import { ApiError } from "./errors";
import { authEvents, tokenStore } from "./session";
import { buildQueryString, type RequestOptions, type Transport } from "./transport";

/**
 * Live transport: fetch against `${baseUrl}/api/v1`.
 * - Access token lives in memory only (tokenStore). Never in localStorage.
 * - Refresh token is an httpOnly cookie owned by the backend; we call /auth/refresh
 *   with credentials: "include".
 * - On 401: refresh once (de-duplicated across concurrent requests), retry once, then
 *   emit "expired" so the UI can show the re-auth modal without losing drafts.
 */
export class HttpTransport implements Transport {
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly baseUrl: string) {}

  async request<T>(options: RequestOptions): Promise<T> {
    const res = await this.send(options);
    if (res.status === 401 && !options.anonymous) {
      const ok = await this.refresh();
      if (ok) {
        const retry = await this.send(options);
        return this.parse<T>(retry, options);
      }
      authEvents.emit("expired");
    }
    return this.parse<T>(res, options);
  }

  /** POST /auth/refresh with the cookie; stores the new access token. */
  refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          tokenStore.set(null);
          return false;
        }
        const body = (await res.json()) as { accessToken: string };
        tokenStore.set(body.accessToken);
        return true;
      } catch {
        return false;
      } finally {
        queueMicrotask(() => {
          this.refreshing = null;
        });
      }
    })();
    return this.refreshing;
  }

  private send({ method, path, query, body, signal, anonymous, keepalive }: RequestOptions) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = tokenStore.get();
    if (token && !anonymous) headers.Authorization = `Bearer ${token}`;
    return fetch(`${this.baseUrl}/api/v1${path}${buildQueryString(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      signal,
      keepalive,
    }).catch((e: unknown) => {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new ApiError({
        code: "network_error",
        message: "You're offline or the server can't be reached.",
        status: 0,
        request: `${method} ${path}`,
      });
    });
  }

  private async parse<T>(res: Response, { method, path }: RequestOptions): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (res.ok) return data as T;
    const body = (data ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError({
      code: body.code ?? (res.status >= 500 ? "server_error" : "error"),
      message: body.message ?? res.statusText ?? "Request failed",
      details: body.details,
      status: res.status,
      ref: res.headers.get("x-request-id") ?? undefined,
      request: `${method} ${path}`,
    });
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
