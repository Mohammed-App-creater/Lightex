/**
 * Fractional indexing for drag-and-drop ordering. Positions are base-62 strings compared
 * lexicographically; a key between any two keys always exists, so a move updates only the
 * moved task. (Algorithm after David Greenspan's "Implementing Fractional Indexing".)
 * Keys never end in "0", which keeps every gap open.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`fractional-index: ${a} >= ${b}`);
  if (a.endsWith("0") || (b && b.endsWith("0"))) throw new Error("fractional-index: trailing zero");
  if (b) {
    // Shared prefix: recurse on the remainder.
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  }
  // Adjacent digits.
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/** A key strictly between a and b. null means "start" / "end". */
export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  return midpoint(a ?? "", b ?? null);
}

/** n increasing keys between a and b (for seeding / bulk inserts). */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    const k = keyBetween(prev, b);
    out.push(k);
    prev = k;
  }
  return out;
}

/** Key for inserting at `index` in an already-sorted list of keys (excluding the moved item). */
export function keyForIndex(sortedKeys: string[], index: number): string {
  const before = index > 0 ? sortedKeys[index - 1]! : null;
  const after = index < sortedKeys.length ? sortedKeys[index]! : null;
  return keyBetween(before, after);
}

export const comparePosition = (a: { position: string }, b: { position: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
