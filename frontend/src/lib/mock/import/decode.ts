/*
 * Board 40 mock: encoding detection (docs/v2/40-import-wizard.md §7.2), identical on both sides.
 * 1. A raw ZIP / OLE prefix is an Excel workbook ("excel"), checked before decoding.
 * 2. BOM: EF BB BF → UTF-8; FF FE / FE FF → UTF-16 LE / BE. The BOM is dropped.
 * 3. Otherwise strict UTF-8; on failure Windows-1252 (undefined bytes → U+FFFD).
 * 4. Any NUL after decoding → "binary".
 * Written by hand (no chardet-style dependency, no reliance on the runtime's legacy decoders).
 */

export type Encoding = "utf-8" | "utf-16" | "windows-1252";
export type DecodeResult = { ok: true; text: string; encoding: Encoding } | { ok: false; reason: "excel" | "binary" };

/** Windows-1252 0x80–0x9F; null = undefined in the code page (→ U+FFFD). */
const CP1252_HIGH: (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const cp = b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] ?? 0xfffd) : b;
    out += String.fromCharCode(cp);
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const unit = littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
    out += String.fromCharCode(unit);
  }
  return out;
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

export function decodeBytes(bytes: Uint8Array): DecodeResult {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return { ok: false, reason: "excel" };
  let text: string;
  let encoding: Encoding;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    text = decodeUtf8Strict(bytes.subarray(3)) ?? new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(3));
    encoding = "utf-8";
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    text = decodeUtf16(bytes.subarray(2), true);
    encoding = "utf-16";
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    text = decodeUtf16(bytes.subarray(2), false);
    encoding = "utf-16";
  } else {
    const utf8 = decodeUtf8Strict(bytes);
    if (utf8 !== null) {
      text = utf8;
      encoding = "utf-8";
    } else {
      text = decodeWindows1252(bytes);
      encoding = "windows-1252";
    }
  }
  if (text.includes("\u0000")) return { ok: false, reason: "binary" };
  return { ok: true, text, encoding };
}
