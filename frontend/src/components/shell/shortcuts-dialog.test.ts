import { describe, expect, it } from "vitest";
import { fitScale, nextZoom, prevZoom } from "@/features/tasks/attachment-viewer";
import { filterShortcuts, parseSpec } from "./shortcuts-dialog";

describe("shortcut sheet", () => {
  it("parses sequences, chords and alternatives with platform labels", () => {
    const seq = parseSpec("G>B", false);
    expect(seq.parts.map((p) => (p.kind === "key" ? p.t : p.kind))).toEqual(["G", "then", "B"]);
    expect(seq.spoken).toBe("G then B");
    const chord = parseSpec("⌘+⇧+D", true);
    expect(chord.parts.map((p) => (p.kind === "key" ? p.t : p.kind))).toEqual(["Ctrl", "Shift", "D"]);
    expect(parseSpec("+|−", false).parts.map((p) => (p.kind === "key" ? p.t : p.kind))).toEqual(["+", "or", "−"]);
    expect(parseSpec("⌥+↑|↓", false).spoken).toBe("Option Up or Down");
  });

  it("filters by label, group or exact key and reports no match", () => {
    expect(filterShortcuts("inbox", false).flatMap((g) => g.rows.map((r) => r.label))).toContain("Go to inbox");
    expect(filterShortcuts("attachments", false).map((g) => g.title)).toEqual(["Attachments"]);
    expect(filterShortcuts("ctrl", true).length).toBeGreaterThan(0);
    expect(filterShortcuts("zzz", false)).toEqual([]);
  });
});

describe("viewer zoom", () => {
  it("steps through zoom levels and falls back to fit", () => {
    expect(nextZoom(0.4)).toBe(0.5);
    expect(nextZoom(4)).toBe(4);
    expect(prevZoom(1, 0.4)).toBe(0.75);
    expect(prevZoom(0.5, 0.45)).toBeNull();
    expect(fitScale({ w: 2000, h: 1000 }, { w: 1048, h: 548 }, 48)).toBe(0.5);
    expect(fitScale({ w: 300, h: 200 }, { w: 1000, h: 800 }, 48)).toBe(1);
  });
});
