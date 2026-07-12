/**
 * GSM-7 vs UCS-2 — the thing that silently triples a church's SMS bill.
 *
 *   GSM-7 : 160 chars per page  (153 in a multi-page message)
 *   UCS-2 :  70 chars per page  ( 67 in a multi-page message)
 *
 * ONE character outside the GSM-7 alphabet flips the WHOLE message to UCS-2.
 * A curly apostrophe pasted from Word — the one Word inserts automatically —
 * takes a 158-character message from 1 page to 3. The church pays three times
 * as much and never knows why.
 *
 * So: count honestly, warn loudly, and offer to fix it.
 */

// The GSM 03.38 basic alphabet.
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001BÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

// These exist in GSM-7 but cost TWO characters each (escape + char).
const GSM7_EXTENDED = "^{}\\[~]|€";

const BASIC = new Set(GSM7.split(""));
const EXT = new Set(GSM7_EXTENDED.split(""));

/** Characters Word and phones insert that are NOT GSM-7, and their plain twins. */
export const SUBSTITUTIONS: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",   // curly single quotes
  "\u201C": '"', "\u201D": '"', "\u201E": '"',                  // curly double quotes
  "\u2013": "-", "\u2014": "-", "\u2015": "-",                  // en / em dashes
  "\u2026": "...",                                              // ellipsis
  "\u00A0": " ",                                                // non-breaking space
  "\u2022": "*",                                                // bullet
  "\u2032": "'", "\u2033": '"',                                 // primes
  "\u00AB": '"', "\u00BB": '"',
};

/** Replace the sneaky characters with GSM-7 equivalents. Idempotent. */
export function toGsm7(s: string): string {
  let out = "";
  for (const c of s) out += SUBSTITUTIONS[c] ?? c;
  return out;
}

export type Count = {
  encoding: "GSM7" | "UCS2";
  chars: number;          // billable characters (extended GSM chars count as 2)
  units: number;          // SMS pages — what the church actually pays for
  perUnit: number;
  remaining: number;      // chars left in the current page
  offenders: string[];    // the characters that forced UCS-2
  fixable: boolean;       // would normalising bring it back to GSM-7?
};

export function count(body: string): Count {
  const chars = [...body];

  const bad = chars.filter((c) => !BASIC.has(c) && !EXT.has(c));
  const isGsm = bad.length === 0;

  if (isGsm) {
    // extended characters (^ { } [ ] ~ | \ €) cost two
    const len = chars.reduce((n, c) => n + (EXT.has(c) ? 2 : 1), 0);
    const perUnit = len <= 160 ? 160 : 153;
    const units = len === 0 ? 0 : Math.ceil(len / perUnit);
    return {
      encoding: "GSM7", chars: len, units, perUnit,
      remaining: units <= 1 ? 160 - len : units * perUnit - len,
      offenders: [], fixable: false,
    };
  }

  // UCS-2. Astral characters (emoji) take TWO UTF-16 code units each.
  const len = body.length;              // .length IS the UTF-16 unit count
  const perUnit = len <= 70 ? 70 : 67;
  const units = Math.ceil(len / perUnit);

  const fixedBad = [...toGsm7(body)].filter((c) => !BASIC.has(c) && !EXT.has(c));

  return {
    encoding: "UCS2", chars: len, units, perUnit,
    remaining: units * perUnit - len,
    offenders: [...new Set(bad)],
    fixable: fixedBad.length === 0,     // normalising would rescue it
  };
}

/** Merge fields: {{first_name}}, {{church}}, {{service}} */
export function render(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? "").toString());
}
