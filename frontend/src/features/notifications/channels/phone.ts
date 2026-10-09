import type { SmsCountry } from "@/lib/api/types";

/*
 * Phone numbers for SMS (board 38, spec §5.6). Pure: the SMS dialog formats with these, and the mock
 * validates with the same table the backend uses (vectors in phone-vectors.json).
 */

export type CountryRule = SmsCountry & {
  /** A leading trunk "0" is stripped before counting (GB, DE). */
  trunkZero: boolean;
  /** The mobile-number rule, applied to the normalised national digits. */
  mobile: (national: string) => boolean;
};

/** The server table (§5.6). IN is off on the backend by default (DLT registration, §11 #2); the mock lists it. */
export const SMS_COUNTRY_RULES: CountryRule[] = [
  {
    code: "US",
    dial: "+1",
    label: "US +1",
    digits: 10,
    pattern: "(XXX) XXX-XXXX",
    trunkZero: false,
    // NANP: area code and exchange both start with 2–9.
    mobile: (n) => /^[2-9]\d{2}[2-9]\d{6}$/.test(n),
  },
  { code: "GB", dial: "+44", label: "UK +44", digits: 10, pattern: "XXXX XXXXXX", trunkZero: true, mobile: (n) => n.startsWith("7") },
  { code: "DE", dial: "+49", label: "DE +49", digits: 11, pattern: "XXX XXXXXXXX", trunkZero: true, mobile: (n) => /^1[567]/.test(n) },
  { code: "IN", dial: "+91", label: "IN +91", digits: 10, pattern: "XXXXX XXXXX", trunkZero: false, mobile: (n) => /^[6-9]/.test(n) },
];

/** The backend's default `SMS_COUNTRIES` (§2.5). The mock allows every row (the design shows four). */
export const DEFAULT_SMS_COUNTRIES = ["US", "GB", "DE"] as const;

export const countryRule = (code: string) => SMS_COUNTRY_RULES.find((c) => c.code === code);

/** Strips everything but digits. */
export const digitsOnly = (raw: string) => raw.replace(/\D/g, "");

/**
 * What the national-number input keeps while typing: digits only, the trunk "0" dropped where the
 * country uses one, and never more than the country's digit count.
 */
export function nationalDigits(country: Pick<SmsCountry, "code" | "digits">, raw: string): string {
  let d = digitsOnly(raw);
  if (countryRule(country.code)?.trunkZero) d = d.replace(/^0+/, "");
  return d.slice(0, country.digits);
}

/** Formats digits into the country's pattern as far as they go: "41555" → "(415) 55". */
export function formatNational(digits: string, pattern: string): string {
  let out = "";
  let i = 0;
  for (const ch of pattern) {
    if (i >= digits.length) break;
    if (ch === "X") out += digits[i++];
    else out += ch;
  }
  return out;
}

/** The input placeholder: the pattern with zeros ("(000) 000-0000"). */
export const placeholderFor = (pattern: string) => pattern.replace(/X/g, "0");

export const isComplete = (country: Pick<SmsCountry, "digits">, digits: string) => digits.length === country.digits;

/** "+1 (415) 555-0132" */
export const displayNumber = (country: Pick<SmsCountry, "dial" | "pattern">, digits: string) =>
  `${country.dial} ${formatNational(digits, country.pattern)}`;

export type PhoneCheck =
  | { ok: true; e164: string; national: string; display: string }
  | { ok: false; field: "country" | "nationalNumber"; error: string };

/**
 * The server's validation (§5.6): normalise to digits, drop the trunk 0, count, check the mobile rule,
 * then E.164 = dial + national. `allowed` is the deployment's country allow-list.
 */
export function validateNational(countryCode: string, raw: string, allowed: readonly string[] = DEFAULT_SMS_COUNTRIES): PhoneCheck {
  const rule = countryRule(countryCode);
  if (!rule || !allowed.includes(rule.code)) return { ok: false, field: "country", error: "SMS isn’t available for this country" };
  let d = digitsOnly(raw);
  if (rule.trunkZero) d = d.replace(/^0+/, "");
  if (d.length !== rule.digits) return { ok: false, field: "nationalNumber", error: `Enter ${rule.digits} digits` };
  if (!rule.mobile(d)) return { ok: false, field: "nationalNumber", error: "Enter a mobile number" };
  return { ok: true, e164: `${rule.dial}${d}`, national: d, display: displayNumber(rule, d) };
}

/** Help text under the number input (design): "10 digits" → "Valid number". */
export function phoneHelp(country: Pick<SmsCountry, "digits">, digits: string): { text: string; tone: "muted" | "ok" } {
  return isComplete(country, digits) ? { text: "Valid number", tone: "ok" } : { text: `${country.digits} digits`, tone: "muted" };
}
