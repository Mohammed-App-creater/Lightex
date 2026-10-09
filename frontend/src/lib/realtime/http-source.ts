import { getTransport } from "@/lib/api/client";
import { realtime } from "@/lib/api/endpoints";
import { HttpTransport } from "@/lib/api/http-transport";
import { tokenStore } from "@/lib/api/session";
import { parseRetryAfter } from "./backoff";
import { parseEnvelope } from "./events";
import { readSse } from "./sse-parser";
import type { RealtimeSource, RunOptions, RunOutcome } from "./source";

/*
 * Live stream (spec §2.3, §7.7): fetch() with a streaming body, the normal Bearer header (no ticket,
 * nothing secret in the URL) and Last-Event-ID. Token handling:
 * - no access token in memory → refresh first (the httpOnly cookie);
 * - 401 → refresh once and retry once; still 401 → "unauthorized" (the loop goes "off");
 * - the loop calls refresh() before reconnecting after `reconnect` with reason token_expiry.
 * The client never decodes the JWT.
 */

type Fetch = typeof fetch;

export class HttpRealtimeSource implements RealtimeSource {
  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: Fetch = (...a) => fetch(...a),
    private readonly refresher: () => Promise<boolean> = async () => {
      const t = await getTransport();
      return t instanceof HttpTransport ? t.refresh() : false;
    },
  ) {}

  refresh() {
    return this.refresher();
  }

  private open(o: RunOptions) {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (o.lastEventId) headers["Last-Event-ID"] = o.lastEventId;
    return this.doFetch(`${this.baseUrl}/api/v1${realtime.streamPath(o.slug)}?v=1`, {
      method: "GET",
      headers,
      credentials: "include",
      cache: "no-store",
      signal: o.signal,
    });
  }

  async run(o: RunOptions): Promise<RunOutcome> {
    try {
      if (!tokenStore.get()) await this.refresh();
      let res = await this.open(o);
      if (res.status === 401) {
        void res.body?.cancel().catch(() => undefined);
        if (!(await this.refresh())) return { kind: "unauthorized" };
        res = await this.open(o);
        if (res.status === 401) {
          void res.body?.cancel().catch(() => undefined);
          return { kind: "unauthorized" };
        }
      }
      if (!res.ok) return classify(res, await readCode(res));
      const type = res.headers.get("content-type") ?? "";
      // A 200 that isn't an event stream (an SPA fallback page, a proxy) means no realtime here.
      if (!type.includes("text/event-stream") || !res.body) {
        void res.body?.cancel().catch(() => undefined);
        return { kind: "unavailable", retryAfterMs: null, code: "not_event_stream" };
      }
      await readSse(
        res.body,
        {
          onMessage: (m) => {
            const env = parseEnvelope(m.data);
            if (env) o.onEvent(env);
          },
          onComment: () => o.onActivity(),
          onBytes: () => o.onActivity(),
        },
        o.signal,
      );
      return o.signal.aborted ? { kind: "aborted" } : { kind: "ended" };
    } catch (e) {
      if (o.signal.aborted || (e as Error)?.name === "AbortError") return { kind: "aborted" };
      return { kind: "failed", retryAfterMs: null };
    }
  }
}

async function readCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: string };
    return body?.code;
  } catch {
    return undefined;
  }
}

/** §2.3 errors before streaming → loop outcome. */
export function classify(res: Pick<Response, "status" | "headers">, code?: string): RunOutcome {
  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
  if (res.status === 503 && (code === "realtime_unavailable" || code === "realtime_busy")) return { kind: "unavailable", retryAfterMs, code };
  // An older backend without the route, or a protocol the server doesn't speak: poll, retry slowly.
  if (res.status === 404 || res.status === 406 || res.status === 400) return { kind: "unavailable", retryAfterMs, code: code ?? String(res.status) };
  return { kind: "failed", retryAfterMs };
}
