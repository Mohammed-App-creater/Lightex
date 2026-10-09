import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "@/lib/api/session";
import type { RealtimeEnvelope } from "./events";
import { HttpRealtimeSource, classify } from "./http-source";

/* fetch-based SSE (spec §2.3, §7.7): Bearer header, Last-Event-ID, refresh once on 401, errors before streaming. */

const sse = (text: string, status = 200) =>
  new Response(text, { status, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function run(src: HttpRealtimeSource, lastEventId: string | null = null) {
  const events: RealtimeEnvelope[] = [];
  const ac = new AbortController();
  const p = src.run({ slug: "platform", lastEventId, signal: ac.signal, onEvent: (e) => events.push(e), onActivity: () => undefined });
  return { p, events, ac };
}

afterEach(() => tokenStore.set(null));

describe("HttpRealtimeSource", () => {
  it("opens GET /workspaces/:slug/stream?v=1 with Accept, Bearer and Last-Event-ID, and parses the stream", async () => {
    tokenStore.set("tok-1");
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => sse('event: hello\ndata: {"v":1,"type":"hello","data":{}}\n\nid: 9\nevent: task.changed\ndata: {"v":1,"type":"task.changed","id":"9","data":{}}\n\n'));
    const src = new HttpRealtimeSource("https://api.test", fetchFn as typeof fetch, async () => true);
    const r = run(src, "8");
    await expect(r.p).resolves.toEqual({ kind: "ended" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/v1/workspaces/platform/stream?v=1");
    expect(init?.headers).toEqual({ Accept: "text/event-stream", Authorization: "Bearer tok-1", "Last-Event-ID": "8" });
    expect(init?.credentials).toBe("include");
    expect(r.events.map((e) => e.type)).toEqual(["hello", "task.changed"]);
  });

  it("refreshes first when there is no access token in memory", async () => {
    const refresh = vi.fn(async () => {
      tokenStore.set("fresh");
      return true;
    });
    const fetchFn = vi.fn(async () => sse(""));
    await run(new HttpRealtimeSource("", fetchFn as typeof fetch, refresh)).p;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: "Bearer fresh" });
  });

  it("refreshes once on 401 and retries once", async () => {
    tokenStore.set("old");
    const fetchFn = vi.fn().mockResolvedValueOnce(json(401, { code: "token_not_valid" })).mockResolvedValueOnce(sse(""));
    const refresh = vi.fn(async () => {
      tokenStore.set("new");
      return true;
    });
    await expect(run(new HttpRealtimeSource("", fetchFn as unknown as typeof fetch, refresh)).p).resolves.toEqual({ kind: "ended" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("is unauthorized after a 401 twice (or a failed refresh)", async () => {
    tokenStore.set("old");
    const twice = vi.fn().mockResolvedValue(json(401, {}));
    await expect(run(new HttpRealtimeSource("", twice as unknown as typeof fetch, async () => true)).p).resolves.toEqual({ kind: "unauthorized" });
    const once = vi.fn().mockResolvedValue(json(401, {}));
    await expect(run(new HttpRealtimeSource("", once as unknown as typeof fetch, async () => false)).p).resolves.toEqual({ kind: "unauthorized" });
    expect(once).toHaveBeenCalledTimes(1);
  });

  it("reports network errors as failed and aborts as aborted", async () => {
    tokenStore.set("t");
    const down = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(run(new HttpRealtimeSource("", down as unknown as typeof fetch)).p).resolves.toEqual({ kind: "failed", retryAfterMs: null });
    const never = vi.fn((_u: unknown, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")))));
    const r = run(new HttpRealtimeSource("", never as unknown as typeof fetch));
    r.ac.abort();
    await expect(r.p).resolves.toEqual({ kind: "aborted" });
  });

  it("treats a 200 that isn't an event stream as unavailable", async () => {
    tokenStore.set("t");
    const html = vi.fn(async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await expect(run(new HttpRealtimeSource("", html as unknown as typeof fetch)).p).resolves.toMatchObject({ kind: "unavailable" });
  });
});

describe("classify (errors before streaming, §2.3)", () => {
  const res = (status: number, retryAfter?: string) => ({ status, headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : {}) });
  it("maps 503 realtime_unavailable / realtime_busy to unavailable with Retry-After", () => {
    expect(classify(res(503, "300"), "realtime_unavailable")).toEqual({ kind: "unavailable", retryAfterMs: 300_000, code: "realtime_unavailable" });
    expect(classify(res(503, "60"), "realtime_busy")).toEqual({ kind: "unavailable", retryAfterMs: 60_000, code: "realtime_busy" });
  });
  it("maps a 404 (an older backend) to unavailable", () => {
    expect(classify(res(404), "not_found")).toMatchObject({ kind: "unavailable" });
  });
  it("maps 429 and 5xx to failed (429 with its Retry-After)", () => {
    expect(classify(res(429, "20"), "throttled")).toEqual({ kind: "failed", retryAfterMs: 20_000 });
    expect(classify(res(502))).toEqual({ kind: "failed", retryAfterMs: null });
  });
});
