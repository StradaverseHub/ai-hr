/**
 * Shared Malaysian bank master (R46 orgbank — item 84719377).
 *
 * ONE controlled list of Malaysian banks, maintained WITH the product (the same posture as
 * lib/countries.ts). It is deliberately NOT a tenant-editable catalog (profile_option): every entry
 * carries the BNM 2-digit routing code that salary files route on, and a tenant that invented a bank
 * without a code would produce unpayable salary files. See localization/my/bank-files/bnm-codes.ts:10-12
 * for the same refuse-don't-guess posture on the resolution side.
 *
 * ⚠ The BNM codes below are the 2014-vintage IBG Autopay table (see bnm-codes.ts header). RE-VERIFY
 * against BNM / PayNet's live "IBG Participating Banks" directory before go-live — banks onboarded after
 * 2014 are not here, and at least one entry (Royal Bank of Scotland) reflects a bank that has since wound
 * down its Malaysian operations. NEVER add an entry without a verified code.
 *
 * Two identifiers per bank, and they are NOT interchangeable:
 *   - `key`  — the STABLE storage key (company_bank_profile.bank). The first four keys are byte-identical
 *     to the old `disbursement_bank` pgEnum values, so converting that column to text needed no data
 *     migration and every historical domain event still reads the same.
 *   - `code` — the BNM 2-digit interbank routing code. This is what money routes on.
 *
 * `disbursementFormat` records whether ai-hr can BUILD that bank's bulk salary-disbursement file. Widening
 * the picker without widening the builders is the trap called out in the build plan: a company could save a
 * profile here and only discover at file-build time that no format exists. Rather than hide the wider list
 * (the reporter asked for one shared list), the format is modelled explicitly so the UI can say so up front
 * and `disbursementFormatFor()` can refuse rather than guess.
 */

/** Bulk salary-disbursement file formats ai-hr knows how to emit. CIMB + Public Bank share IBG Autopay. */
export type DisbursementFormat = 'maybank_m2e' | 'ibg_autopay' | 'rhb_reflex';

export type MyBank = {
  /** Stable storage key (company_bank_profile.bank). Never renumber or reuse. */
  key: string;
  /** BNM 2-digit interbank routing code — the value salary files route on. */
  code: string;
  /** Display name. */
  canonical: string;
  /** Accepted spellings for free-text → bank resolution (employee bank names). */
  aliases: string[];
  /** The bulk-payment file format ai-hr can emit for this bank, or null if none is implemented yet. */
  disbursementFormat: DisbursementFormat | null;
};

/**
 * The master list. Order is deliberate: the four banks with implemented file formats first (they are the
 * common Malaysian payroll banks), then the rest alphabetically-ish as inherited from the BNM table.
 */
export const MY_BANKS: readonly MyBank[] = [
  { key: 'maybank', code: '27', canonical: 'Maybank', aliases: ['Maybank', 'Malayan Banking', 'Maybank Islamic', 'MBB'], disbursementFormat: 'maybank_m2e' },
  { key: 'cimb', code: '35', canonical: 'CIMB Bank', aliases: ['CIMB', 'CIMB Bank', 'CIMB Islamic'], disbursementFormat: 'ibg_autopay' },
  { key: 'public_bank', code: '33', canonical: 'Public Bank', aliases: ['Public Bank', 'Public Islamic Bank', 'PBB'], disbursementFormat: 'ibg_autopay' },
  { key: 'rhb', code: '18', canonical: 'RHB Bank', aliases: ['RHB', 'RHB Bank', 'RHB Islamic'], disbursementFormat: 'rhb_reflex' },
  { key: 'ambank', code: '08', canonical: 'AmBank', aliases: ['AmBank', 'Am Bank', 'AmBank Islamic', 'Arab-Malaysian', 'Arab Malaysian'], disbursementFormat: null },
  { key: 'alliance_bank', code: '12', canonical: 'Alliance Bank', aliases: ['Alliance', 'Alliance Bank', 'Alliance Islamic'], disbursementFormat: null },
  { key: 'affin_bank', code: '32', canonical: 'Affin Bank', aliases: ['Affin', 'Affin Bank', 'Affin Islamic'], disbursementFormat: null },
  { key: 'hong_leong_bank', code: '24', canonical: 'Hong Leong Bank', aliases: ['Hong Leong', 'Hong Leong Bank', 'Hong Leong Islamic', 'HLB'], disbursementFormat: null },
  { key: 'hsbc_bank', code: '22', canonical: 'HSBC Bank', aliases: ['HSBC', 'HSBC Bank', 'HSBC Amanah'], disbursementFormat: null },
  { key: 'ocbc_bank', code: '29', canonical: 'OCBC Bank', aliases: ['OCBC', 'OCBC Bank', 'OCBC Al-Amin'], disbursementFormat: null },
  { key: 'uob', code: '26', canonical: 'United Overseas Bank', aliases: ['UOB', 'United Overseas Bank'], disbursementFormat: null },
  { key: 'standard_chartered', code: '14', canonical: 'Standard Chartered', aliases: ['Standard Chartered', 'StanChart', 'SCB'], disbursementFormat: null },
  { key: 'citibank', code: '17', canonical: 'Citibank', aliases: ['Citibank', 'Citi'], disbursementFormat: null },
  { key: 'bank_islam', code: '45', canonical: 'Bank Islam', aliases: ['Bank Islam', 'BIMB'], disbursementFormat: null },
  { key: 'bank_muamalat', code: '41', canonical: 'Bank Muamalat', aliases: ['Bank Muamalat', 'Muamalat'], disbursementFormat: null },
  { key: 'bank_rakyat', code: '02', canonical: 'Bank Rakyat', aliases: ['Bank Rakyat'], disbursementFormat: null },
  { key: 'bsn', code: '10', canonical: 'Bank Simpanan Nasional', aliases: ['BSN', 'Bank Simpanan Nasional'], disbursementFormat: null },
  { key: 'agrobank', code: '49', canonical: 'Agrobank', aliases: ['Agrobank', 'Agro', 'Bank Pertanian'], disbursementFormat: null },
  { key: 'al_rajhi', code: '53', canonical: 'Al-Rajhi Bank', aliases: ['Al-Rajhi', 'Al Rajhi'], disbursementFormat: null },
  { key: 'icbc', code: '59', canonical: 'ICBC', aliases: ['ICBC', 'Industrial and Commercial Bank of China'], disbursementFormat: null },
  { key: 'deutsche_bank', code: '19', canonical: 'Deutsche Bank', aliases: ['Deutsche', 'Deutsche Bank'], disbursementFormat: null },
  { key: 'jp_morgan', code: '48', canonical: 'JP Morgan Chase', aliases: ['JP Morgan', 'JPMorgan'], disbursementFormat: null },
  { key: 'kuwait_finance_house', code: '47', canonical: 'Kuwait Finance House', aliases: ['Kuwait Finance House', 'KFH'], disbursementFormat: null },
  { key: 'mizuho', code: '73', canonical: 'Mizuho Bank', aliases: ['Mizuho'], disbursementFormat: null },
  { key: 'mufg', code: '52', canonical: 'MUFG Bank', aliases: ['BTMU', 'MUFG', 'Bank of Tokyo-Mitsubishi'], disbursementFormat: null },
  { key: 'sumitomo_mitsui', code: '51', canonical: 'Sumitomo Mitsui', aliases: ['Sumitomo', 'SMBC', 'Sumitomo Mitsui'], disbursementFormat: null },
  { key: 'bnp_paribas', code: '60', canonical: 'BNP Paribas', aliases: ['BNP Paribas', 'BNP'], disbursementFormat: null },
  { key: 'bank_of_america', code: '07', canonical: 'Bank of America', aliases: ['Bank of America', 'BofA'], disbursementFormat: null },
  { key: 'rbs', code: '46', canonical: 'Royal Bank of Scotland', aliases: ['RBS', 'Royal Bank of Scotland'], disbursementFormat: null },
];

const BY_KEY = new Map(MY_BANKS.map((b) => [b.key, b]));

/** Look a bank up by its stable storage key. Undefined for an unknown key (legacy/typo tolerant callers). */
export function myBankByKey(key: string | null | undefined): MyBank | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

/** Display label for a stored bank key; falls back to the raw key so a legacy value never renders blank. */
export function myBankLabel(key: string | null | undefined): string {
  return myBankByKey(key)?.canonical ?? (key ?? '');
}

/** True when `key` is in the master list. The service gate — the storage column is plain text. */
export function isMyBankKey(key: string | null | undefined): boolean {
  return !!key && BY_KEY.has(key);
}

/** Banks ai-hr can build a bulk salary-disbursement file for. */
export const DISBURSEMENT_CAPABLE_BANKS: readonly MyBank[] = MY_BANKS.filter((b) => b.disbursementFormat !== null);
/** Banks selectable as a company account but with NO salary-file format implemented yet. */
export const DISBURSEMENT_UNSUPPORTED_BANKS: readonly MyBank[] = MY_BANKS.filter((b) => b.disbursementFormat === null);

/**
 * The file format for a bank key, or null when none is implemented. Callers that are about to BUILD a file
 * must treat null as a hard stop (refuse-don't-guess): emitting the wrong layout misroutes salary.
 */
export function disbursementFormatFor(key: string | null | undefined): DisbursementFormat | null {
  return myBankByKey(key)?.disbursementFormat ?? null;
}
