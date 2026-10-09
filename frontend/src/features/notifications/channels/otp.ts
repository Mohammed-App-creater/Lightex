/*
 * The 6-box OTP input's editing rules (board 38 design, spec §8.5). Pure, so they're unit-tested:
 * typing a digit moves on; 3+ digits at once (paste, SMS autofill) spread from the box, and 6 start at
 * box 1; Backspace in an empty box clears and focuses the previous one.
 */

export type OtpEdit = { code: string[]; focus: number };

const clamp = (n: number) => Math.max(0, Math.min(5, n));

function spread(code: string[], index: number, digits: string): OtpEdit {
  const s = digits.slice(0, 6);
  const next = s.length === 6 ? ["", "", "", "", "", ""] : [...code];
  const start = s.length === 6 ? 0 : index;
  for (let k = 0; k < s.length && start + k < 6; k++) next[start + k] = s[k]!;
  return { code: next, focus: clamp(start + s.length) };
}

/** An input event in box `index` with the box's new raw value. */
export function typeInto(code: string[], index: number, raw: string): OtpEdit {
  const d = raw.replace(/\D/g, "");
  if (d.length >= 3) return spread(code, index, d);
  const next = [...code];
  next[index] = d ? d[d.length - 1]! : "";
  return { code: next, focus: d ? clamp(index + 1) : index };
}

/** A paste into box `index`; null when the text has no digits. */
export function pasteInto(code: string[], index: number, text: string): OtpEdit | null {
  const d = text.replace(/\D/g, "");
  if (!d) return null;
  if (d.length >= 3) return spread(code, index, d);
  let next = [...code];
  let at = index;
  for (const ch of d) {
    next = typeInto(next, at, ch).code;
    at = clamp(at + 1);
  }
  return { code: next, focus: at };
}

/** Backspace in box `index`: an empty box clears and focuses the previous one; null = let the input handle it. */
export function backspaceAt(code: string[], index: number): OtpEdit | null {
  if (code[index] || index === 0) return null;
  const next = [...code];
  next[index - 1] = "";
  return { code: next, focus: index - 1 };
}
