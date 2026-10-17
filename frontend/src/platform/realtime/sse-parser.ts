/*
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation"), written for the
 * fetch-based stream (spec §2.2, §7.7): no EventSource, so headers and Last-Event-ID stay ours.
 *
 * - Lines end with CRLF, LF or CR, including a CR at the end of one chunk and its LF at the start
 *   of the next.
 * - Fields: `event`, `data` (several lines join with "\n"), `id` (ignored when it holds NUL; it
 *   persists across events), `retry` (digits only). Unknown fields are ignored.
 * - `:` lines are comments; the server's `: ping <time>` heartbeats are reported to `onComment`.
 * - A blank line dispatches the event. An event without data lines dispatches nothing.
 * - A leading BOM is dropped. A partial event at the end of the stream is discarded.
 */

export type SseMessage = {
  /** The stream's last event id at dispatch time (it persists across events, as in EventSource). */
  lastEventId: string;
  /** The `id:` field when this event set one. */
  id: string | undefined;
  event: string;
  data: string;
};

export type SseHandlers = {
  onMessage: (m: SseMessage) => void;
  onComment?: (text: string) => void;
  onRetry?: (ms: number) => void;
};

export type SseParser = {
  /** Feeds decoded text (any split, including mid-line or between CR and LF). */
  push: (text: string) => void;
  /** End of stream: drops any partial line and any undispatched event. */
  end: () => void;
};

export function createSseParser(h: SseHandlers): SseParser {
  let line = "";
  let skipLF = false;
  let started = false;
  let data: string[] = [];
  let eventType = "";
  let lastEventId = "";
  let idThisEvent: string | undefined;

  const dispatch = () => {
    if (data.length) {
      h.onMessage({ lastEventId, id: idThisEvent, event: eventType || "message", data: data.join("\n") });
    }
    data = [];
    eventType = "";
    idThisEvent = undefined;
  };

  const processLine = (l: string) => {
    if (l === "") return dispatch();
    if (l.charCodeAt(0) === 58 /* : */) {
      h.onComment?.(l.slice(1).replace(/^ /, ""));
      return;
    }
    const colon = l.indexOf(":");
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? "" : l.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) {
          lastEventId = value;
          idThisEvent = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) h.onRetry?.(Number(value));
        break;
      default:
        break;
    }
  };

  return {
    push(text: string) {
      let s = text;
      if (!started && s.length) {
        started = true;
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      }
      let i = 0;
      while (i < s.length) {
        if (skipLF) {
          skipLF = false;
          if (s.charCodeAt(i) === 10) {
            i += 1;
            continue;
          }
        }
        // Next line break (CR or LF) from i.
        let j = i;
        while (j < s.length) {
          const c = s.charCodeAt(j);
          if (c === 10 || c === 13) break;
          j += 1;
        }
        if (j === s.length) {
          line += s.slice(i);
          break;
        }
        const full = line + s.slice(i, j);
        line = "";
        if (s.charCodeAt(j) === 13) skipLF = true;
        processLine(full);
        i = j + 1;
      }
    },
    end() {
      line = "";
      data = [];
      eventType = "";
      idThisEvent = undefined;
    },
  };
}

/**
 * Reads a fetch body as SSE: UTF-8 decoding in stream mode (multi-byte characters split across
 * chunks are fine), `onBytes` on every chunk (the watchdog), `parser.end()` at the end.
 */
export async function readSse(body: ReadableStream<Uint8Array>, h: SseHandlers & { onBytes?: () => void }, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser(h);
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      h.onBytes?.();
      if (value?.length) parser.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) parser.push(tail);
  } finally {
    parser.end();
    signal?.removeEventListener("abort", cancel);
  }
}
