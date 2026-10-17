import { describe, expect, it } from "vitest";
import { fitScale, nextZoom, prevZoom } from "./attachment-viewer";

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
