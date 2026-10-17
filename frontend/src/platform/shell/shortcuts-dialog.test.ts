import { describe, expect, it } from "vitest";
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
