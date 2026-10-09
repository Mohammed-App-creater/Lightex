import { describe, expect, it } from "vitest";
import { createSseParser, readSse, type SseMessage } from "./sse-parser";

function collect(feed: (p: ReturnType<typeof createSseParser>) => void) {
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const p = createSseParser({ onMessage: (m) => messages.push(m), onComment: (c) => comments.push(c), onRetry: (r) => retries.push(r) });
  feed(p);
  return { messages, comments, retries };
}

const STREAM =
  "retry: 3000\n\n" +
  'event: hello\ndata: {"v":1,"type":"hello"}\n\n' +
  'id: 8813\nevent: task.changed\ndata: {"v":1,"type":"task.changed","id":"8813"}\n\n' +
  ": ping 2026-10-09T09:00:15Z\n\n" +
  "data: line one\ndata: line two\n\n" +
  'event: reconnect\ndata: {"reason":"lifetime"}\n\n';

describe("sse-parser", () => {
  it("parses every field: retry, event, id, data, comments", () => {
    const { messages, comments, retries } = collect((p) => p.push(STREAM));
    expect(retries).toEqual([3000]);
    expect(comments).toEqual(["ping 2026-10-09T09:00:15Z"]);
    expect(messages.map((m) => [m.event, m.id, m.data])).toEqual([
      ["hello", undefined, '{"v":1,"type":"hello"}'],
      ["task.changed", "8813", '{"v":1,"type":"task.changed","id":"8813"}'],
      ["message", undefined, "line one\nline two"],
      ["reconnect", undefined, '{"reason":"lifetime"}'],
    ]);
    // The last event id persists across events, as in EventSource.
    expect(messages.map((m) => m.lastEventId)).toEqual(["", "8813", "8813", "8813"]);
  });

  it("joins multi-line data with \\n and keeps an empty data line", () => {
    const { messages } = collect((p) => p.push("data: a\ndata:\ndata: b\n\n"));
    expect(messages[0]!.data).toBe("a\n\nb");
  });

  it("removes exactly one space after the colon; a field without a colon has an empty value", () => {
    const { messages } = collect((p) => p.push("data:  two spaces\n\ndata\n\n"));
    expect(messages.map((m) => m.data)).toEqual([" two spaces", ""]);
  });

  it("treats CRLF, LF and CR the same", () => {
    const lf = collect((p) => p.push(STREAM)).messages;
    const crlf = collect((p) => p.push(STREAM.replace(/\n/g, "\r\n"))).messages;
    const cr = collect((p) => p.push(STREAM.replace(/\n/g, "\r"))).messages;
    expect(crlf).toEqual(lf);
    expect(cr).toEqual(lf);
  });

  it("drops a leading BOM", () => {
    const { messages } = collect((p) => p.push("﻿event: hello\ndata: x\n\n"));
    expect(messages[0]).toMatchObject({ event: "hello", data: "x" });
  });

  it("ignores unknown fields, a non-numeric retry and an id containing NUL", () => {
    const { messages, retries } = collect((p) => p.push("foo: bar\nretry: 3s\nid: a\0b\ndata: x\n\n"));
    expect(retries).toEqual([]);
    expect(messages[0]).toMatchObject({ id: undefined, lastEventId: "", data: "x" });
  });

  it("dispatches nothing for an event without data (but keeps its id)", () => {
    const { messages } = collect((p) => p.push("id: 7\nevent: ping\n\ndata: y\n\n"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: "message", lastEventId: "7", data: "y" });
  });

  it("discards a partial event at the end of the stream", () => {
    const { messages } = collect((p) => {
      p.push("data: done\n\ndata: half");
      p.end();
      p.push("\n\n");
    });
    expect(messages.map((m) => m.data)).toEqual(["done"]);
  });

  it("gives the same result for a chunk split at every position (CRLF stream)", () => {
    const text = STREAM.replace(/\n/g, "\r\n");
    const whole = collect((p) => p.push(text));
    for (let i = 0; i <= text.length; i++) {
      const split = collect((p) => {
        p.push(text.slice(0, i));
        p.push(text.slice(i));
      });
      expect(split, `split at ${i}`).toEqual(whole);
    }
  });

  it("reads a byte stream split at every byte, including inside multi-byte characters", async () => {
    const text = "﻿id: 1\r\nevent: task.changed\r\ndata: {\"title\":\"Résumé ✓ 漢字\"}\r\n\r\n: ping\r\n\r\n";
    const bytes = new TextEncoder().encode(text);
    const messages: SseMessage[] = [];
    let pings = 0;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    await readSse(body, { onMessage: (m) => messages.push(m), onComment: () => (pings += 1), onBytes: () => (chunks += 1) });
    expect(chunks).toBe(bytes.length);
    expect(pings).toBe(1);
    expect(messages).toEqual([{ lastEventId: "1", id: "1", event: "task.changed", data: '{"title":"Résumé ✓ 漢字"}' }]);
  });
});
