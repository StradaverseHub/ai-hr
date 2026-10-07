/**
 * r412 (item e74af58c, step 2) — THE EIS (SIP) MONTHLY CONTRIBUTION SCHEDULE: the form's own model, its
 * pagination and the one mapping from the Borang 8A read. PURE — no DB, no pack, no pdf-lib — for the same
 * reason lib/borang-8a.ts is: every rule here is pinned without a database.
 *
 * ── WHAT THIS DOCUMENT IS, AND IS NOT ─────────────────────────────────────────────────────────────────
 * The reporter's sample ("SIP Contribution Sample", board item e74af58c) is a REPORT printed from another
 * payroll system — "JADUAL CARUMAN BAGI SISTEM INSURANS PEKERJAAN (SIP)" under PERKESO's name — and not a
 * PERKESO form. We follow its LAYOUT: a two-line employer block (NAMA MAJIKAN / KOD MAJIKAN) and one table
 * of BIL · KOD MAJIKAN · NO. KAD PENGENALAN · NAMA PEKERJA (Mengikut Kad Pengenalan) · BULAN CARUM ·
 * JUMLAH CARUMAN, with a Total. It has NO declaration and NO signature block, and the approved plan says
 * we will not add sections it does not have — so this model has no field for either.
 *   ADDED, and only these two: a "Jumlah muka surat ini" per sheet and "Lembaran n/N", because a schedule
 *   that runs to more than one sheet has to be reconcilable sheet by sheet (the approved build notes).
 * Fidelity is `figures` — "laid out our way, not on the agency's own document" — never `agency-layout`
 * (whose shared caption claims the agency's own form) and never `official`: no government page is behind it.
 *
 * ── THE FIGURE IS TAKEN, NEVER CALCULATED ─────────────────────────────────────────────────────────────
 * JUMLAH CARUMAN is `eisEmployer + eisEmployee` off the rows the Borang 8A READ already produced
 * (localization/my/borang-8a.ts), which summed them across the selected runs off the payslips. There is no
 * EIS arithmetic anywhere in this file beyond adding the two legs the read kept apart, and the read is the
 * one place the cycle selection is applied — so this schedule and the 8A can never describe two months.
 *
 * ── WHO IS ON IT ──────────────────────────────────────────────────────────────────────────────────────
 * Everyone the selected runs charged EIS on. A person the runs paid but charged NO EIS (an exempt
 * employee — aged 60 or over with no prior contribution, for instance) is left OFF the schedule rather
 * than listed at 0.00: a 0.00 line on an EIS schedule asserts a contributor whose contribution was
 * nothing. They are returned separately (`omitted`) so the review screen names them; nothing is hidden.
 * The money total is unaffected either way — a zero adds nothing.
 */
import { contributionPeriodFor } from './borang-8a';

/** One line of the schedule. `contribution` is RM, the two EIS legs added. */
export type SipRow = {
  /** Not printed — the key the review screen and the readiness list address a person by. */
  employmentId: string;
  /** KOD MAJIKAN — the company's SOCSO employer code, REPEATED on every row, as the sample prints it. */
  employerCode: string;
  /** NO. KAD PENGENALAN. */
  ic: string;
  /** NAMA PEKERJA (Mengikut Kad Pengenalan). */
  name: string;
  /** BULAN CARUM — `MMYYYY`, no separator, the sample's own format. */
  contributionMonth: string;
  /** JUMLAH CARUMAN — EIS employer + employee, RM. */
  contribution: number;
};

/** One printed sheet. `firstBil` is the running BIL number of its first line (BIL runs across sheets). */
export type SipPage = { sheet: number; of: number; firstBil: number; rows: SipRow[]; pageTotal: number };

export type SipHeader = {
  /** KOD MAJIKAN — company_statutory_my.socso_employer_code. */
  employerCode: string;
  /** NAMA MAJIKAN — the company's legal name. */
  employerName: string;
  /** BULAN CARUM, `MMYYYY`. */
  contributionMonth: string;
  /** The `YYYY-MM` behind it — the payroll month, unshifted (the Borang 8A no-offset rule). */
  contributionPeriodKey: string;
  payrollPeriodKey: string;
};

export type SipForm = SipHeader & { pages: SipPage[]; total: number; employees: number };

/**
 * The header keys the READ puts on `ReportResult.meta.formHeader` and this file reads back. One list, so
 * both halves of that contract are pinned against it (test/r412-sip-borang-8b.test.ts).
 */
export const SIP_HEADER_KEYS = [
  'employerCode',
  'employerName',
  'contributionMonth',
  'contributionPeriodKey',
  'payrollPeriodKey',
] as const;

/** Lines per printed sheet. Ours (the sample is a single sheet of 11): what one A4 page holds legibly. */
export const SIP_ROWS_PER_PAGE = 30;

const round2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown): string => (v == null ? '' : String(v));

/** `2026-07` → `072026`. Through `contributionPeriodFor`, so the 8A no-offset rule is the only rule. */
export function sipContributionMonth(periodKey: string): string {
  const p = contributionPeriodFor(periodKey);
  return `${p.slice(5, 7)}${p.slice(0, 4)}`;
}

/** The EIS figure of one Borang 8A read row: the two legs, added. Nothing else. */
export function sipAmountOf(row: Record<string, unknown>): number {
  return round2((Number(row.eisEmployer) || 0) + (Number(row.eisEmployee) || 0));
}

/**
 * The schedule's rows from the Borang 8A read's rows — the ONE mapping. Keeps the read's order (by name).
 * A row with no EIS charged is returned in `omitted`, never as a 0.00 line (see WHO IS ON IT).
 */
export function sipRowsFrom(
  rows8a: readonly Record<string, unknown>[],
  p: { employerCode: string; contributionMonth: string },
): { rows: SipRow[]; omitted: { employmentId: string; name: string }[] } {
  const rows: SipRow[] = [];
  const omitted: { employmentId: string; name: string }[] = [];
  for (const r of rows8a) {
    const amount = sipAmountOf(r);
    if (Math.round(amount * 100) === 0) {
      omitted.push({ employmentId: str(r.employmentId), name: str(r.name) });
      continue;
    }
    rows.push({
      employmentId: str(r.employmentId),
      employerCode: p.employerCode,
      ic: str(r.ic),
      name: str(r.name),
      contributionMonth: p.contributionMonth,
      contribution: amount,
    });
  }
  return { rows, omitted };
}

/**
 * Split into sheets. Each sheet's total is summed from ITS rows, never apportioned, so the sheets' totals
 * add to the form total at one, two and three sheets. An empty schedule is one empty sheet ("1/1"), never
 * zero sheets — though the loader refuses to draw an empty one at all.
 */
export function paginateSip(rows: SipRow[], perPage = SIP_ROWS_PER_PAGE): SipPage[] {
  if (perPage < 1) throw new Error('SIP schedule: rows per page must be at least 1');
  const chunks: SipRow[][] = [];
  for (let i = 0; i < rows.length; i += perPage) chunks.push(rows.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((chunk, i) => ({
    sheet: i + 1,
    of: chunks.length,
    firstBil: i * perPage + 1,
    rows: chunk,
    pageTotal: round2(chunk.reduce((a, r) => a + (Number(r.contribution) || 0), 0)),
  }));
}

/** The header fields the schedule cannot be produced without. A report, never a throw (the 8A lesson). */
export function missingSipHeader(header: Record<string, unknown> | null | undefined): string[] {
  const h = header ?? {};
  return SIP_HEADER_KEYS.filter((k) => !str(h[k]).trim());
}

/** Assemble the printable schedule from what `reportPreview` returned. Total: it never throws. */
export function sipFrom(p: {
  header: Record<string, unknown> | null | undefined;
  rows: readonly Record<string, unknown>[];
  perPage?: number;
}): SipForm {
  const h = p.header ?? {};
  const rows: SipRow[] = p.rows.map((r) => ({
    employmentId: str(r.employmentId),
    employerCode: str(r.employerCode),
    ic: str(r.ic),
    name: str(r.name),
    contributionMonth: str(r.contributionMonth),
    contribution: round2(Number(r.contribution) || 0),
  }));
  const pages = paginateSip(rows, p.perPage);
  return {
    employerCode: str(h.employerCode),
    employerName: str(h.employerName),
    contributionMonth: str(h.contributionMonth),
    contributionPeriodKey: str(h.contributionPeriodKey),
    payrollPeriodKey: str(h.payrollPeriodKey),
    pages,
    total: round2(pages.reduce((a, pg) => a + pg.pageTotal, 0)),
    employees: rows.length,
  };
}
