import { describe, expect, it } from "vitest";
import { keyBetween, keyForIndex, keysBetween } from "./fractional-index";

describe("fractional index", () => {
  it("orders keys between neighbours", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const mid = keyBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    const first = keyBetween(null, a);
    expect(first < a).toBe(true);
  });

  it("survives many inserts at the same spot without collisions", () => {
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo && k < hi).toBe(true);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      lo = k;
    }
  });

  it("generates n increasing keys and inserts by index", () => {
    const keys = keysBetween(null, null, 10);
    expect([...keys].sort()).toEqual(keys);
    const k = keyForIndex(keys, 3);
    expect(k > keys[2]! && k < keys[3]!).toBe(true);
    expect(keyForIndex(keys, 0) < keys[0]!).toBe(true);
    expect(keyForIndex(keys, 10) > keys[9]!).toBe(true);
  });
});
