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
export type BnmBank = { code: string; canonical: string; aliases: string[] };

/** 2-digit BNM codes. The four Chin Hin banks first; the rest for completeness. */
export const BNM_BANKS: BnmBank[] = [
  { code: '27', canonical: 'Maybank', aliases: ['Maybank', 'Malayan Banking', 'Maybank Islamic', 'MBB'] },
  { code: '35', canonical: 'CIMB Bank', aliases: ['CIMB', 'CIMB Bank', 'CIMB Islamic'] },
  { code: '33', canonical: 'Public Bank', aliases: ['Public Bank', 'Public Islamic Bank', 'PBB'] },
  { code: '18', canonical: 'RHB Bank', aliases: ['RHB', 'RHB Bank', 'RHB Islamic'] },
  { code: '08', canonical: 'AmBank', aliases: ['AmBank', 'Am Bank', 'AmBank Islamic', 'Arab-Malaysian', 'Arab Malaysian'] },
  { code: '12', canonical: 'Alliance Bank', aliases: ['Alliance', 'Alliance Bank', 'Alliance Islamic'] },
  { code: '32', canonical: 'Affin Bank', aliases: ['Affin', 'Affin Bank', 'Affin Islamic'] },
  { code: '24', canonical: 'Hong Leong Bank', aliases: ['Hong Leong', 'Hong Leong Bank', 'Hong Leong Islamic', 'HLB'] },
  { code: '22', canonical: 'HSBC Bank', aliases: ['HSBC', 'HSBC Bank', 'HSBC Amanah'] },
  { code: '29', canonical: 'OCBC Bank', aliases: ['OCBC', 'OCBC Bank', 'OCBC Al-Amin'] },
  { code: '26', canonical: 'United Overseas Bank', aliases: ['UOB', 'United Overseas Bank'] },
  { code: '14', canonical: 'Standard Chartered', aliases: ['Standard Chartered', 'StanChart', 'SCB'] },
  { code: '17', canonical: 'Citibank', aliases: ['Citibank', 'Citi'] },
  { code: '45', canonical: 'Bank Islam', aliases: ['Bank Islam', 'BIMB'] },
  { code: '41', canonical: 'Bank Muamalat', aliases: ['Bank Muamalat', 'Muamalat'] },
  { code: '02', canonical: 'Bank Rakyat', aliases: ['Bank Rakyat'] },
  { code: '10', canonical: 'Bank Simpanan Nasional', aliases: ['BSN', 'Bank Simpanan Nasional'] },
  { code: '49', canonical: 'Agrobank', aliases: ['Agrobank', 'Agro', 'Bank Pertanian'] },
  { code: '53', canonical: 'Al-Rajhi Bank', aliases: ['Al-Rajhi', 'Al Rajhi'] },
  { code: '59', canonical: 'ICBC', aliases: ['ICBC', 'Industrial and Commercial Bank of China'] },
  { code: '19', canonical: 'Deutsche Bank', aliases: ['Deutsche', 'Deutsche Bank'] },
  { code: '48', canonical: 'JP Morgan Chase', aliases: ['JP Morgan', 'JPMorgan'] },
  { code: '47', canonical: 'Kuwait Finance House', aliases: ['Kuwait Finance House', 'KFH'] },
  { code: '73', canonical: 'Mizuho Bank', aliases: ['Mizuho'] },
  { code: '52', canonical: 'MUFG Bank', aliases: ['BTMU', 'MUFG', 'Bank of Tokyo-Mitsubishi'] },
  { code: '51', canonical: 'Sumitomo Mitsui', aliases: ['Sumitomo', 'SMBC', 'Sumitomo Mitsui'] },
  { code: '60', canonical: 'BNP Paribas', aliases: ['BNP Paribas', 'BNP'] },
  { code: '07', canonical: 'Bank of America', aliases: ['Bank of America', 'BofA'] },
  { code: '46', canonical: 'Royal Bank of Scotland', aliases: ['RBS', 'Royal Bank of Scotland'] },
];

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
      `No BNM bank code for "${bankName}". Add it to bnm-codes.ts or correct the employee's bank name ` +
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
