/**
 * BNM (Bank Negara Malaysia) receiving-bank codes for interbank GIRO (IBG) bulk-payment files. Every
 * Malaysian interbank disbursement detail record routes by this 2-digit code — Maybank 27, CIMB 35,
 * Public Bank 33, RHB 18, etc. The IBG Autopay layout left-justifies + zero-fills it to 7 (35 → "3500000").
 *
 * Source: the IBG Autopay bulk-payment file spec's BNM code table (UBS Software mirror, "as of 28-Apr-2014").
 * ⚠ RE-VERIFY against BNM / PayNet's live "IBG Participating Banks" directory before go-live — banks
 * onboarded after 2014 are not in this list.
 *
 * Routing salary to a wrong/missing bank code is unrecoverable, so bnmCodeForBankName() HARD-FAILS on any
 * unmapped name (the same refuse-don't-guess posture as the statutory file builders). Exact normalized
 * match only — no fuzzy contains-match, which could mis-route e.g. "Public Investment Bank" → Public Bank.
 */
import { MY_BANKS } from '@/lib/my-banks';

export type BnmBank = { code: string; canonical: string; aliases: string[] };

/**
 * R46 orgbank (84719377) — the bank DATA now lives in ONE shared master, lib/my-banks.ts, which both the
 * company Bank Account picker and the employee bank picker read. This module keeps the RESOLUTION logic
 * (normalisation + the hard-failing free-text → code lookup) and re-projects the master into the historical
 * `BnmBank` shape so existing importers are unchanged.
 */
export const BNM_BANKS: BnmBank[] = MY_BANKS.map((b) => ({ code: b.code, canonical: b.canonical, aliases: b.aliases }));

/** Normalize a bank name for matching: drop berhad/bhd/(m) + punctuation, collapse whitespace. Keeps the
 *  distinguishing token ("public bank", "cimb bank") so generic stems can't collide. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\bberhad\b|\bbhd\b|\(m\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ALIAS_TO_CODE = new Map<string, string>();
for (const b of BNM_BANKS) {
  for (const a of [b.canonical, ...b.aliases]) {
    const key = norm(a);
    if (key) ALIAS_TO_CODE.set(key, b.code);
  }
}

export class UnknownBankError extends Error {
  constructor(public readonly bankName: string) {
    super(
      `No BNM bank code for "${bankName}". Add it to the shared bank master (lib/my-banks.ts) with a ` +
        `VERIFIED BNM code, or correct the employee's bank name ` +
        `before generating an interbank file — salary cannot be routed without a verified bank code.`,
    );
    this.name = 'UnknownBankError';
  }
}

/** Resolve a free-text bank name to its 2-digit BNM code. Hard-fails on unmapped (this routes money). */
export function bnmCodeForBankName(bankName: string | null | undefined): string {
  const n = norm(bankName ?? '');
  const code = n ? ALIAS_TO_CODE.get(n) : undefined;
  if (!code) throw new UnknownBankError(bankName ?? '(empty)');
  return code;
}

/** Non-throwing probe — for readiness checks that want to list every unmapped employee at once. */
export function tryBnmCodeForBankName(bankName: string | null | undefined): string | null {
  const n = norm(bankName ?? '');
  return (n ? ALIAS_TO_CODE.get(n) : undefined) ?? null;
}
