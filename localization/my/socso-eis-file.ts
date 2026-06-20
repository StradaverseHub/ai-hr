/**
 * SOCSO + EIS COMBINED contribution textfile (PERKESO ASSIST) — v2.0, with the new SKBBK / Lindung-24-Jam
 * employee column. One fixed-width file carries BOTH Act-4 (SOCSO) and Act-800 (EIS) contributions.
 *
 * Source (verbatim, sourced 2026-06-20, HIGH confidence — verified against the spec's sample line):
 *   PERKESO "Combine SOCSO + EIS Contribution Text File Format" v2.0 (13 Feb 2026):
 *   https://www.perkeso.gov.my/images/borang/lindung24jam/formatteksfail.pdf
 *   v1.0 (pre-SKBBK): https://www.perkeso.gov.my/images/panduan/280722_-_TEXTFILE_STRUCTURE_FOR_COMBINE_CONTRIBUTION_V1.pdf
 *
 * Detail-only (no header/footer; the employer code is per-row). 278-char fixed-width records; all amounts
 * are CENTS, right-justified, zero-padded. v2.0 inserts SKBBK at 239–244 and shrinks Filler 1 from 20→14
 * (245–258); total width stays 278. SKBBK mandatory 1 Oct 2026 (legacy single-Act files allowed until
 * 30 Sep 2026). EIS columns are 0 (zero-padded) for EIS-exempt members (60+/foreign); SKBBK still applies.
 *
 * Detail (278): employerCode 12A | ssm/MyCoID 20A | IC/SOCSO-FW-no 12A | name 150A | month MMYYYY 6N |
 *   salary 14N | socsoEr 6N | socsoEe 6N | eisEr 6N | eisEe 6N | skbbk 6N | filler 14 | filler 20
 *
 * Line terminator CRLF + filename/encoding are NOT in the spec — confirm on first ASSIST upload.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import { MY_STATUTORY_VERSION } from './statutory-tables';

const digits = (v: string) => v.replace(/\D/g, '');
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Numeric field: right-justified, zero-padded. Throws on overflow (a truncated statutory amount is
 *  worse than a refusal). */
const num = (v: string | number, len: number, label: string): string => {
  const s = String(v);
  if (!/^\d*$/.test(s)) throw new Error(`${label} must be numeric, got "${s}"`);
  if (s.length > len) throw new Error(`${label} exceeds ${len} digits: "${s}"`);
  return s.padStart(len, '0');
};
/** Alphanumeric field: left-justified, space-padded, hard-truncated to width. */
const alpha = (v: string | null | undefined, len: number): string =>
  (v ?? '').toUpperCase().slice(0, len).padEnd(len, ' ');
const cents = (rm: number) => Math.round(rm * 100);

export type SocsoEisRow = {
  /** Member identifier — new IC (no dashes) for Malaysians, SOCSO foreign-worker no. for foreigners. */
  ic: string;
  name: string;
  salary: number; // gross wages (RM)
  socsoEmployer: number;
  socsoEmployee: number;
  eisEmployer: number;
  eisEmployee: number;
  skbbk: number; // employee SKBBK leg (RM)
};

export type SocsoEisFile = {
  filename: string;
  content: string;
  totals: { salaryCents: number; socsoCents: number; eisCents: number; skbbkCents: number; records: number };
};

export class SocsoEisNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocsoEisNotReadyError';
  }
}

/** Pure builder — golden-tested against the v2.0 spec sample. */
export function buildSocsoEisFile(p: {
  employerCode: string;
  ssmNo?: string | null;
  year: number;
  month: number;
  rows: SocsoEisRow[];
}): SocsoEisFile {
  const mmYYYY = String(p.month).padStart(2, '0') + String(p.year).padStart(4, '0');
  const lines: string[] = [];
  let salaryCents = 0;
  let socsoCents = 0;
  let eisCents = 0;
  let skbbkCents = 0;

  for (const r of p.rows) {
    const ic = digits(r.ic);
    if (!ic) throw new Error(`Member IC / SOCSO no. is mandatory — missing for "${r.name}"`);
    const sal = cents(r.salary);
    const sEr = cents(r.socsoEmployer);
    const sEe = cents(r.socsoEmployee);
    const iEr = cents(r.eisEmployer);
    const iEe = cents(r.eisEmployee);
    const sk = cents(r.skbbk);
    salaryCents += sal;
    socsoCents += sEr + sEe;
    eisCents += iEr + iEe;
    skbbkCents += sk;
    const line =
      alpha(p.employerCode, 12) +
      alpha(p.ssmNo, 20) +
      alpha(ic, 12) +
      alpha(r.name, 150) +
      num(mmYYYY, 6, 'month') +
      num(sal, 14, `salary (${r.name})`) +
      num(sEr, 6, `SOCSO employer (${r.name})`) +
      num(sEe, 6, `SOCSO employee (${r.name})`) +
      num(iEr, 6, `EIS employer (${r.name})`) +
      num(iEe, 6, `EIS employee (${r.name})`) +
      num(sk, 6, `SKBBK (${r.name})`) +
      ' '.repeat(14) +
      ' '.repeat(20);
    if (line.length !== 278) throw new Error(`detail record is ${line.length} chars, expected 278`);
    lines.push(line);
  }

  return {
    filename: `PERKESO_${digits(p.employerCode) || 'EMP'}_${mmYYYY}.txt`,
    content: lines.join('\r\n') + '\r\n',
    totals: { salaryCents, socsoCents, eisCents, skbbkCents, records: lines.length },
  };
}

/** Build the combined SOCSO+EIS file for a company's pay period from its generated payslips. Refuses to
 *  emit with a missing employer code or member IC (ADR-0010 readiness gate). */
export function socsoEisFileForBatch(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string },
): Promise<SocsoEisFile & { statutoryVersion: string }> {
  return withTenant(ctx, async (tx) => {
    const batches = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.periodKey)));
    if (batches.length === 0)
      throw new SocsoEisNotReadyError(`No payroll batch for ${p.periodKey} — generate payslips first.`);
    const batchIds = batches.map((x) => x.id);
    const [co] = await tx
      .select({ code: companyStatutoryMy.socsoEmployerCode, ssm: companyStatutoryMy.ssmRegistrationNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    if (!co?.code) {
      throw new SocsoEisNotReadyError('Company SOCSO employer code is not set (Organization → statutory identity).');
    }
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);
    // One row per employee per month: SOCSO/EIS/SKBBK are charged once for the month (an additional run
    // adds 0, ADR-0024), so summing across the period's runs yields the monthly total; salary sums wages.
    type Agg = SocsoEisRow;
    const byEmp = new Map<string, Agg>();
    const versionSet = new Set<string>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, number> & { version?: string };
      if (st.version) versionSet.add(st.version);
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = { ic: s.ic ?? '', name: s.name, salary: 0, socsoEmployer: 0, socsoEmployee: 0, eisEmployer: 0, eisEmployee: 0, skbbk: 0 };
        byEmp.set(s.employmentId, r);
      }
      r.salary = round2(r.salary + Number(s.gross ?? 0));
      r.socsoEmployer = round2(r.socsoEmployer + Number(st.socsoEmployer ?? 0));
      r.socsoEmployee = round2(r.socsoEmployee + Number(st.socsoEmployee ?? 0));
      r.eisEmployer = round2(r.eisEmployer + Number(st.eisEmployer ?? 0));
      r.eisEmployee = round2(r.eisEmployee + Number(st.eisEmployee ?? 0));
      r.skbbk = round2(r.skbbk + Number(st.socsoSkbbk ?? 0));
    }
    const empRows = [...byEmp.values()];
    const missing = empRows.filter((r) => !digits(r.ic)).map((r) => r.name);
    if (missing.length) {
      throw new SocsoEisNotReadyError(`Member IC / SOCSO no. is mandatory — missing for: ${missing.join(', ')}`);
    }
    const [yy, mm] = p.periodKey.split('-').map(Number);
    const file = buildSocsoEisFile({ employerCode: co.code, ssmNo: co.ssm, year: yy, month: mm, rows: empRows });
    const versions = [...versionSet].sort();
    return { ...file, statutoryVersion: versions.length ? versions.join(',') : MY_STATUTORY_VERSION };
  });
}
