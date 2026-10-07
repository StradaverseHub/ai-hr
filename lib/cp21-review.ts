/**
 * r415 (item 79f3f64d, step 3) — THE FIVE THINGS ONLY THE OPERATOR CAN ANSWER ON A CP21, carried in the
 * query string and NEVER STORED.
 *
 *   A3  — the date the employee is expected to leave Malaysia;
 *   A14 — the reason for leaving;
 *   A15 — the correspondence address outside Malaysia;
 *   A16 — the expected date of return, if returning;
 *   A18 — whether the employee accepted a separation scheme, Ya / Tidak (Tidak Berkenaan).
 *
 * Nothing records an intended departure, so none of these is a record: the operator is preparing a
 * document, and the plan says so ("You type the departure details"). The same shape as lib/cp22a-review.ts:
 * the preview screen is a GET form, every box rides in the URL, and the framed PDF route reads the same URL
 * through `readCp21Typed` — "what I typed" and "what I download" are one value read once.
 *
 * EACH VALUE IS CHECKED AGAINST WHAT IT MAY BE, AND A VALUE THAT FAILS IS DROPPED, NEVER ECHOED:
 *   a date must be a real calendar date (2026-02-30 is not);
 *   the return date must fall AFTER the departure date when both are given — a return before leaving is
 *     not an answer to A16;
 *   the scheme must be one of its two words;
 *   free text has its control characters removed and is length-capped (the renderer shrinks anything long
 *     to fit, so the cap is a request-size guard, not a format).
 * `cp21TypedRejections` names what was dropped, so the screen can say so instead of silently printing less.
 */
import { CP21_NO_TYPED, type Cp21Typed } from './cp21-pdf';

export const CP21_TYPED_PARAMS = {
  departureDate: 'a3',
  reason: 'a14',
  overseasAddress: 'a15',
  returnDate: 'a16',
  scheme: 'a18',
} as const;

const MAX_LEN = 200;
/** A15 prints four rows. More lines than that are folded into the last row by the renderer. */
const MAX_ADDRESS_LINES = 6;

const isRealIsoDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// Control characters (C0, DEL, C1) are not text a form can carry; a newline is only meaningful in A15.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const clean = (v: string | null, max: number): string => (v ?? '').replace(CONTROL, ' ').slice(0, max);

type Read = { typed: Cp21Typed; rejected: string[] };

function read(q: URLSearchParams): Read {
  const rejected: string[] = [];
  const dateOf = (key: string, code: string): string | null => {
    const v = clean(q.get(key), 10).trim();
    if (v === '') return null;
    if (isRealIsoDate(v)) return v;
    rejected.push(code);
    return null;
  };
  const departureDate = dateOf(CP21_TYPED_PARAMS.departureDate, 'A3');
  let returnDate = dateOf(CP21_TYPED_PARAMS.returnDate, 'A16');
  if (returnDate && departureDate && returnDate <= departureDate) {
    rejected.push('A16');
    returnDate = null;
  }
  const rawScheme = q.get(CP21_TYPED_PARAMS.scheme);
  const scheme = rawScheme === 'yes' || rawScheme === 'no' ? rawScheme : null;
  if (rawScheme && !scheme) rejected.push('A18');
  const reason = clean(q.get(CP21_TYPED_PARAMS.reason), MAX_LEN).replace(/\s+/g, ' ').trim();
  const overseasAddress = (q.get(CP21_TYPED_PARAMS.overseasAddress) ?? '')
    .slice(0, MAX_LEN * 2)
    .split(/\r?\n/)
    .map((s) => clean(s, MAX_LEN).trim())
    .filter(Boolean)
    .slice(0, MAX_ADDRESS_LINES);
  return {
    typed: { ...CP21_NO_TYPED, departureDate, returnDate, scheme, reason: reason === '' ? null : reason, overseasAddress },
    rejected,
  };
}

export function readCp21Typed(q: URLSearchParams): Cp21Typed {
  return read(q).typed;
}

/** The typed boxes whose value was present but not an allowed answer, by form code (A3, A16, A18). */
/**
 * r415 verify D2 — typed text LHDN's form cannot print. The AcroForm font is WinAnsi (Latin-1): Chinese,
 * Thai, Tamil or Vietnamese letters print as "?". Named on the preview so the operator retypes them in Latin
 * letters; the value is kept, never silently altered here.
 */
export function cp21TypedUnprintable(q: URLSearchParams): string[] {
  const bad = (v: string | null) => /[^\x20-\x7E\xA0-\xFF\r\n]/.test(v ?? '');
  const out: string[] = [];
  if (bad(q.get(CP21_TYPED_PARAMS.reason))) out.push('A14');
  if (bad(q.get(CP21_TYPED_PARAMS.overseasAddress))) out.push('A15');
  return out;
}

export function cp21TypedRejections(q: URLSearchParams): string[] {
  return read(q).rejected;
}

/** The typed values back as query pairs — the preview builds the frame and download URLs from this. */
export function cp21TypedQuery(t: Cp21Typed): URLSearchParams {
  const q = new URLSearchParams();
  const set = (k: string, v: string | null) => {
    if (v) q.set(k, v);
  };
  set(CP21_TYPED_PARAMS.departureDate, t.departureDate);
  set(CP21_TYPED_PARAMS.reason, t.reason);
  set(CP21_TYPED_PARAMS.overseasAddress, t.overseasAddress.length ? t.overseasAddress.join('\n') : null);
  set(CP21_TYPED_PARAMS.returnDate, t.returnDate);
  set(CP21_TYPED_PARAMS.scheme, t.scheme);
  return q;
}
