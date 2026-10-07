/**
 * r411 (item 4f45f9b0) — BBCD, "BORANG BAYARAN CARUMAN BULANAN - PITA/DISKET": the one-page cover a KWSP
 * employer hands over with the month's contribution data. The form's own model, PURE — no DB, no pack, no
 * pdf-lib. The drawing is `lib/borang-bbcd-pdf.ts`; the read is NOT a read of its own (see below).
 *
 * ── ONE READ, AND IT IS BORANG A'S ────────────────────────────────────────────────────────────────
 * A BBCD is not a second calculation of the month. Its Amaun Caruman is the Borang A total for the same
 * company, payroll month and payroll cycles — the reporter's sample prints the same figure on both — and its
 * CATATAN 2 says so in as many words ("Jumlah cek mesti sama dengan jumlah Borang BBCD"). So there is NO
 * BBCD query: `borangBbcdFrom` is a PROJECTION of the `BorangAForm` that `loadBorangA` built, and the two
 * documents cannot disagree because there is only one number. A BBCD that re-summed payslips would be a
 * second source of truth for the month's EPF, and the first month they drifted the cheque would match one
 * form and not the other.
 *
 * ── WHAT IT CARRIES, AND WHERE EACH COMES FROM ────────────────────────────────────────────────────
 *   • No. Rujukan Majikan — `employerRef` (company_statutory_my.epf_employer_no), as Borang A prints it.
 *   • Bulan Caruman — the Borang A CONTRIBUTION month as MMYY, and "JADUAL CARUMAN BULAN <Month Year>".
 *     The +1 rule is Borang A's (`epfContributionPeriodFor`) and is not restated here: the sample's own
 *     pair is "September 2026" / 0926 against "potongan gaji bulan August 2026".
 *   • "untuk potongan gaji bulan <Month Year>" — the PAYROLL month the contributions were deducted from.
 *   • Amaun Caruman — `totalContribution`, employer + employee.
 *   • Nama / Alamat — the company's legal name and every address line Borang A prints.
 *   • The signatory lines — the company_statutory_authority 'epf' signatory, the same row Borang A's
 *     representative block reads: name, identity card number, position and telephone. A BBCD has no e-mail
 *     line, so an absent e-mail is not reported here.
 *
 * LEFT BLANK, ON PURPOSE: the two payment ticks and the cheque number, the signature, and Cop Agen Kutipan.
 * Payroll does not know how a payment was made or by whom it was stamped. No logo is printed.
 *
 * MONTH NAMES ARE THE SAMPLE'S, IN ENGLISH ("September 2026"), and they are fixed rather than taken from
 * the viewer's language: what a statutory form says is not a function of the screen it was opened from.
 */
import type { BorangAForm } from './borang-a';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `2026-09` → `September 2026`, the sample's own spelling. A malformed key comes back as stored. */
export function bbcdMonthName(periodKey: string): string {
  if (!PERIOD_RE.test(periodKey)) return periodKey;
  return `${MONTHS[Number(periodKey.slice(5, 7)) - 1]} ${periodKey.slice(0, 4)}`;
}

export type BbcdSignatory = { name: string; ic: string; position: string; phone: string };

export type BorangBbcdForm = {
  employerRef: string;
  employerName: string;
  employerAddress: string[];
  /** Borang A's contribution month: `YYYY-MM`, `MMYY`, and the sample's "September 2026". */
  contributionPeriodKey: string;
  contributionMonthCode: string;
  contributionMonthName: string;
  /** The payroll month the contributions were deducted from: `YYYY-MM` and "August 2026". */
  payrollPeriodKey: string;
  payrollMonthName: string;
  /** Amaun Caruman — the Borang A total, employer + employee. Never re-derived here. */
  amount: number;
  signatory: BbcdSignatory;
};

/** The BBCD for a built Borang A. A projection: every figure is the form's own. Total — never throws. */
export function borangBbcdFrom(form: BorangAForm): BorangBbcdForm {
  return {
    employerRef: form.employerRef,
    employerName: form.employerName,
    employerAddress: form.employerAddress,
    contributionPeriodKey: form.contributionPeriodKey,
    contributionMonthCode: form.contributionMonthCode,
    contributionMonthName: bbcdMonthName(form.contributionPeriodKey),
    payrollPeriodKey: form.payrollPeriodKey,
    payrollMonthName: bbcdMonthName(form.payrollPeriodKey),
    amount: form.totalContribution,
    // NAMA PENUH is marked HURUF BESAR on the form: the name prints in capitals (ms-MY casing, so Malay names
    // fold as expected); every other line prints as stored.
    signatory: { name: (form.repName ?? '').toLocaleUpperCase('ms-MY'), ic: form.repIc, position: form.repPosition, phone: form.repPhone },
  };
}

export const BBCD_SIGNATORY_FIELDS = ['name', 'ic', 'position', 'phone'] as const;
export type BbcdSignatoryField = (typeof BBCD_SIGNATORY_FIELDS)[number];

/**
 * The signatory lines the company has not set. A READINESS NOTE, NEVER A REFUSAL — the sample's lines are
 * written by hand at the counter anyway, so a company with no EPF signatory gets the form with those lines
 * empty and is told so before it downloads. Never filled with anybody plausible.
 */
export function missingBbcdSignatory(b: Pick<BorangBbcdForm, 'signatory'>): BbcdSignatoryField[] {
  return BBCD_SIGNATORY_FIELDS.filter((k) => !(b.signatory[k] ?? '').trim());
}

/**
 * The form's own words, TRANSCRIBED from the reporter's October BBCD sample — which is a filled BBCD
 * printed by another payroll system, not a KWSP page. Kept in one place, Malay only, so a KWSP original
 * can replace them word for word without touching the renderer.
 */
export const BBCD_MASTHEAD = 'KUMPULAN WANG SIMPANAN PEKERJA';
export const BBCD_CITATION = '(Peraturan-Peraturan Dan Kaedah-kaedah KWSP 1991 (Kaedah 11(1)))';
export const BBCD_TITLE = '(BORANG BAYARAN CARUMAN BULANAN - PITA/DISKET (BBCD))';
export const BBCD_SYSTEM = 'SISTEM PENGHANTARAN DATA PITA/DISKET';
export const BBCD_SCHEDULE_PREFIX = 'JADUAL CARUMAN BULAN';
/** Split around the payroll month, which the renderer places between the two halves. */
export const BBCD_PAYMENT_INSTRUCTION = [
  'Jumlah caruman untuk bulan di atas (untuk potongan gaji bulan',
  ') hendaklah dibayar kepada KWSP/Ejen Kutipan KWSP tidak lewat daripada 15 hb setiap bulan',
] as const;
export const BBCD_PAYMENT_METHODS = ['Wang Tunai', 'Cek/Kiriman Wang/Wang Pos/Draf Bank *No.'] as const;
export const BBCD_DECLARATION =
  'SAYA MENGESAHKAN DAN MEMBERI JAMINAN BAHAWA JUMLAH CARUMAN BULANAN SEPERTI YANG TERKANDUNG DI DALAM ' +
  'PITA/DISKET KOMPUTER YANG DISERTAKAN ADALAH SAMA DENGAN AMAUN YANG DIBAYAR.';
export const BBCD_CATATAN: readonly string[] = [
  'Nombor Rujukan Majikan dan bulan caruman mesti ditulis di belakang cek.',
  'Jumlah cek mesti sama dengan jumlah Borang BBCD.',
  'Sekiranya terdapat lebih dari satu nombor majikan dalam pita/disket, majikan hendaklah menggunakan ' +
    'Borang BBCD berasingan bagi setiap nombor yang berkenaan.',
];

/** `borang-bbcd-<employer ref>-<contribution period>.pdf`, the Borang A filename's sibling. */
export function borangBbcdFilename(b: Pick<BorangBbcdForm, 'employerRef' | 'contributionPeriodKey'>): string {
  const ref = (b.employerRef || 'EMP').replace(/[^A-Za-z0-9]+/g, '');
  return `borang-bbcd-${ref}-${b.contributionPeriodKey.replace('-', '')}.pdf`;
}
