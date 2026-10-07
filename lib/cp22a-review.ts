/**
 * r413 (item 79f3f64d, step 2) — THE FOUR THINGS ONLY THE OPERATOR CAN ANSWER ON A CP22A, carried in the
 * query string and NEVER STORED.
 *
 *   A5  — the date the employer was told of the employee's death (a death case only);
 *   A6  — the retirement type, Wajib / Pilihan (a retirement case only);
 *   A8  — whether the employee accepted a separation scheme, Ya / Tidak (Tidak berkenaan);
 *   A17 — the legal representative (a death case only): name, IC, relationship, address, telephone.
 *
 * The same shape as lib/cp22-review.ts: the preview screen is a GET form, every box rides in the URL, the
 * framed PDF route reads the same URL through `readCp22aTyped`, so "what I typed" and "what I download"
 * are one value read once. Nothing here writes a row: this is a document the operator is preparing, not a
 * record the system keeps, and the plan says so ("Nothing is stored").
 *
 * EACH VALUE IS ALLOWLISTED OR LENGTH-CAPPED, AND AN UNKNOWN ONE IS DROPPED, NEVER ECHOED. A date must be a
 * real ISO date; a choice must be one of its two words; free text is capped (the renderer shrinks anything
 * long to fit, so the cap is a request-size guard, not a format).
 */
import { CP22A_NO_TYPED, type Cp22aTyped } from './cp22a-pdf';

export const CP22A_TYPED_PARAMS = {
  deathNotifiedDate: 'a5',
  retirement: 'a6',
  scheme: 'a8',
  repName: 'a17a',
  repIcNo: 'a17b',
  repRelationship: 'a17c',
  repAddress: 'a17d',
  repPhone: 'a17e',
} as const;

const MAX_LEN = 200;
/** A17 d) prints five rows. More lines than that are folded into the last row by the renderer. */
const MAX_ADDRESS_LINES = 8;

const isRealIsoDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export function readCp22aTyped(q: URLSearchParams): Cp22aTyped {
  const text = (key: string): string | null => {
    const v = (q.get(key) ?? '').slice(0, MAX_LEN).trim();
    return v === '' ? null : v;
  };
  const a5 = text(CP22A_TYPED_PARAMS.deathNotifiedDate);
  const a6 = q.get(CP22A_TYPED_PARAMS.retirement);
  const a8 = q.get(CP22A_TYPED_PARAMS.scheme);
  const address = (q.get(CP22A_TYPED_PARAMS.repAddress) ?? '')
    .slice(0, MAX_LEN * 2)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ADDRESS_LINES);
  return {
    ...CP22A_NO_TYPED,
    deathNotifiedDate: a5 && isRealIsoDate(a5) ? a5 : null,
    retirement: a6 === 'compulsory' || a6 === 'optional' ? a6 : null,
    scheme: a8 === 'yes' || a8 === 'no' ? a8 : null,
    rep: {
      name: text(CP22A_TYPED_PARAMS.repName),
      icNo: text(CP22A_TYPED_PARAMS.repIcNo),
      relationship: text(CP22A_TYPED_PARAMS.repRelationship),
      address,
      phone: text(CP22A_TYPED_PARAMS.repPhone),
    },
  };
}

/** The typed values back as query pairs — the preview builds the frame and download URLs from this. */
export function cp22aTypedQuery(t: Cp22aTyped): URLSearchParams {
  const q = new URLSearchParams();
  const set = (k: string, v: string | null) => {
    if (v) q.set(k, v);
  };
  set(CP22A_TYPED_PARAMS.deathNotifiedDate, t.deathNotifiedDate);
  set(CP22A_TYPED_PARAMS.retirement, t.retirement);
  set(CP22A_TYPED_PARAMS.scheme, t.scheme);
  set(CP22A_TYPED_PARAMS.repName, t.rep.name);
  set(CP22A_TYPED_PARAMS.repIcNo, t.rep.icNo);
  set(CP22A_TYPED_PARAMS.repRelationship, t.rep.relationship);
  set(CP22A_TYPED_PARAMS.repAddress, t.rep.address.length ? t.rep.address.join('\n') : null);
  set(CP22A_TYPED_PARAMS.repPhone, t.rep.phone);
  return q;
}
