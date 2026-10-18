/*
 * Money is an ETB decimal string with two places ("250000.50"), never a float (docs/sales/api.md §1). Everything
 * here works on integer cents (BigInt) so sums and formatting never round.
 */

// The tsconfig targets ES2017, so no BigInt literals.
const B = (n: number | string) => BigInt(n);
const ZERO = B(0);
const TEN = B(10);
const HUNDRED = B(100);

const RE = /^\s*(-)?(\d*)(?:\.(\d{0,2})\d*)?\s*$/;

/** "250000.5" → 25000050 (cents). Unparseable input → 0. */
export function toCents(v: string | null | undefined): bigint {
  const m = v == null ? null : RE.exec(v);
  if (!m || (!m[2] && !m[3])) return ZERO;
  const c = BigInt(m[2] || "0") * HUNDRED + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -c : c;
}

/** 25000050 cents → "250000.50" (the wire format). */
export function fromCents(c: bigint): string {
  const neg = c < ZERO;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / HUNDRED}.${String(a % HUNDRED).padStart(2, "0")}`;
}

export const addMoney = (...vs: (string | null | undefined)[]) => fromCents(vs.reduce((s, v) => s + toCents(v), ZERO));
export const subMoney = (a: string | null | undefined, b: string | null | undefined) => fromCents(toCents(a) - toCents(b));
/** Is the string a valid money amount (≥ 0, at most two decimals)? For form validation. */
export const isMoney = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export interface MoneyFormat {
  /** Prefix "ETB " (default true). */
  currency?: boolean;
  /** "1.2M" / "350K" for tiles and board columns. */
  compact?: boolean;
  /** Always show two decimals (default: only when there are cents). */
  cents?: boolean;
}

/** "250000.50" → "ETB 250,000.50"; "1000000.00" → "ETB 1,000,000" (or "ETB 1M" compact); null → "—". */
export function formatMoney(v: string | null | undefined, opts: MoneyFormat = {}): string {
  if (v == null || v === "") return "—";
  const c = toCents(v);
  const neg = c < ZERO;
  const a = neg ? -c : c;
  let body: string;
  if (opts.compact && a >= B(100_000)) {
    const units: [bigint, string][] = [
      [B("100000000000"), "B"],
      [B(100_000_000), "M"],
      [B(100_000), "K"],
    ];
    const [div, suffix] = units.find(([d]) => a >= d)!;
    // One decimal, rounded half up, dropped when zero.
    const tenths = (a * TEN + div / B(2)) / div;
    const whole = tenths / TEN;
    const dec = tenths % TEN;
    body = `${group(String(whole))}${dec ? `.${dec}` : ""}${suffix}`;
  } else {
    const whole = group(String(a / HUNDRED));
    const rest = a % HUNDRED;
    body = rest || opts.cents ? `${whole}.${String(rest).padStart(2, "0")}` : whole;
  }
  return `${neg ? "-" : ""}${opts.currency === false ? "" : "ETB "}${body}`;
}

/** Percentages arrive as numbers with one decimal: 72.5 → "72.5%"; null → "—". */
export function formatPct(v: number | null | undefined, digits = 1): string {
  return v == null || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}%`;
}
