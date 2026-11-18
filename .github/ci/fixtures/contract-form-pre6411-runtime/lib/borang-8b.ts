/**
 * r412 (item e74af58c, step 2) — BORANG 8B (PERKESO, "CARUMAN GAJI TERKURANG BAYAR BULAN", PER. 44D): the
 * form's own model. PURE, like lib/borang-8a.ts beside it.
 *
 * ── WHAT IS FILLED, AND WHAT IS LEFT FOR THE EMPLOYER — AND WHY ──────────────────────────────────────
 * A Borang 8B pays SOCSO that was UNDER-paid for an earlier month. The system holds no record of such an
 * amount, and that is a property of the kernel rather than a gap in this form: when back pay is paid,
 * core/back-pay.ts charges its SOCSO in the month it is ACTUALLY paid (on that month's run), so there is
 * never a figure "owed for month M" to carry. Inventing one would put money on a statutory return that
 * nothing in the payroll supports. So, exactly as the approved plan says:
 *   • FILLED — the company's details and the month: No. Kod Majikan, No. MyCoID, Nama dan Alamat Majikan,
 *     CARUMAN GAJI TERKURANG BAYAR BULAN (the underpaid month the operator picks), and the signatory's
 *     name and telephone from the company's PERKESO (`socso`) statutory-authority record when one is held.
 *   • BLANK — every employee line (dates, status, IC, name, amount), "Jumlah muka surat ini", Amaun
 *     Caruman, Bil. Pekerja and Lembaran (how many sheets and people is the employer's to know), the
 *     payment method and cheque number, the signature and stamp, and the collection agent's boxes.
 *   An absent box asserts nothing; a 0.00 would assert that nothing is owed, which is the opposite of why
 *   anyone files an 8B. No digit is ever drawn in an employee line.
 *
 * ── NO DEADLINE ───────────────────────────────────────────────────────────────────────────────────────
 * PERKESO's blank 8B ends its sentence "…dibayar kepada PERKESO/EJEN PEMUNGUT yang dilantik" — no date,
 * unlike the 8A. Nothing here computes one.
 *
 * ── THE MONTH ─────────────────────────────────────────────────────────────────────────────────────────
 * The month the contribution was under-paid FOR, as chosen. Through `contributionPeriodFor`, the 8A's
 * no-offset identity, so a malformed month throws rather than printing a plausible one.
 */
import { contributionMonthLabel, contributionPeriodFor } from './borang-8a';

export type Borang8BForm = {
  /** No. Kod Majikan — company_statutory_my.socso_employer_code. */
  employerCode: string;
  /** No. MyCoID / No. Pendaftaran Perniagaan — company_statutory_my.ssm_registration_no (may be blank). */
  mycoid: string;
  employerName: string;
  employerAddress: string[];
  /** CARUMAN GAJI TERKURANG BAYAR BULAN, `MM / YYYY` — the UNDERPAID month. */
  contributionMonth: string;
  /** The `YYYY-MM` behind it. */
  contributionPeriodKey: string;
  /** Nama — the PERKESO signatory on the company's statutory-authority record, or ''. */
  signatoryName: string;
  /** No. Tel — the telephone on that same record, or ''. */
  signatoryPhone: string;
};

/** The header keys the READ (localization/my/borang-8b.ts) puts on `meta.formHeader`. One list, both halves. */
export const BORANG_8B_HEADER_KEYS = [
  'employerCode',
  'mycoid',
  'employerName',
  'employerAddress',
  'contributionMonth',
  'contributionPeriodKey',
  'signatoryName',
  'signatoryPhone',
] as const;

const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * The header fields an 8B cannot be produced without. MyCoID, the address and the signatory are excluded
 * (each prints as an empty box, the agency's own answer to a fact that is not there), exactly as the 8A
 * excludes MyCoID and the address.
 */
export function missingBorang8BHeader(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  return (['employerCode', 'employerName', 'contributionMonth', 'contributionPeriodKey'] as const).filter(
    (k) => !str(h[k]).trim(),
  );
}

/** The header values for an underpaid `YYYY-MM`. Throws on a malformed month (no plausible fallback). */
export function borang8BMonth(periodKey: string): { contributionMonth: string; contributionPeriodKey: string } {
  const p = contributionPeriodFor(periodKey);
  return { contributionMonth: contributionMonthLabel(p), contributionPeriodKey: p };
}

/** The printable form from `meta.formHeader`. Total: never throws; a gap comes back as ''. */
export function borang8BFrom(header: Record<string, unknown> | null | undefined): Borang8BForm {
  const h = header ?? {};
  return {
    employerCode: str(h.employerCode),
    mycoid: str(h.mycoid),
    employerName: str(h.employerName),
    employerAddress: str(h.employerAddress)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    contributionMonth: str(h.contributionMonth),
    contributionPeriodKey: str(h.contributionPeriodKey),
    signatoryName: str(h.signatoryName),
    signatoryPhone: str(h.signatoryPhone),
  };
}

/**
 * r412 verify D1 — an UNDER-paid month is a month whose contribution was already due: it has ENDED. The
 * current month and any later one are refused (`today` is a Kuala Lumpur calendar date, yyyy-mm-dd).
 */
export function borang8BMonthHasEnded(periodKey: string, today: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey) && periodKey < today.slice(0, 7);
}
