/**
 * CP39 / e-Data PCB submission text file (Layer-B, ADR-0010 §6D) — DRAFT, not for submission
 * until verified against the live e-PCB Plus portal.
 *
 * Source (verbatim): LHDN "Specification for MTD Calculations Using Computerized Calculation
 * for 2026", Exhibit 4 "Specification Format for MTD Text File Data" (pp. 43–44, incl. the
 * Exhibit-5 worked sample file). Full layout: docs/architecture/REPORT-FORMATS.md §1.
 *
 * Header (57 chars):  H | employerNo(HQ) 10N | employerNo 10N | year 4N | month 2N |
 *                     total MTD cents 10N | MTD records 5N | total CP38 cents 10N | CP38 records 5N
 * Detail (136 chars): D | TIN 11N (mandatory) | name 60A | old IC 12 | new IC 12 | passport 12 |
 *                     country 2 | MTD cents 8N | CP38 cents 8N | employee no 10A
 *
 * Line terminator: CRLF — ⚠ not specified by Exhibit 4; confirm on first live upload.
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

export type Cp39Row = {
  /** TIN digits (with or without the "IG" prefix / dashes) — MANDATORY per Exhibit 4. */
  tin: string;
  name: string;
  oldIc?: string | null;
  newIc?: string | null;
  passport?: string | null;
  countryCode?: string | null;
  /** Monthly MTD in RM (e.g. 110.00). */
  mtd: number;
  /** CP38 instalment in RM (1.2.3 — the LHDN/court instalment, distinct from MTD; 0 if none). */
  cp38?: number;
  employeeNo?: string | null;
};

const digits = (v: string) => v.replace(/\D/g, '');
/** Numeric field: right-justified, zero-padded. Throws on overflow — a silently truncated
 *  amount in a statutory file is worse than a refusal. */
const num = (v: string | number, len: number, label: string): string => {
  const s = String(v);
  if (!/^\d*$/.test(s)) throw new Error(`${label} must be numeric, got “${s}”`);
  if (s.length > len) throw new Error(`${label} exceeds ${len} digits: “${s}”`);
  return s.padStart(len, '0');
};
/** Alphanumeric field: left-justified, space-padded, hard-truncated to width. */
const alpha = (v: string | null | undefined, len: number): string =>
  (v ?? '').toUpperCase().slice(0, len).padEnd(len, ' ');
const cents = (rm: number) => Math.round(rm * 100);

/** Exhibit-4 width of the detail "employee no" field. Employee IDs may legitimately be longer in the
 *  product (feedback de2823cc lifted the 9-char cap to 30), but a statutory file must never silently
 *  truncate an identifier — over-long codes REFUSE generation, listing the employees (fail-loud). */
export const CP39_EMPLOYEE_NO_LEN = 10;

/** Employer E-number → 10-digit form (Exhibit 5: "E 908915-10" → "0090891510"). */
export const normalizeEmployerNo = (e: string): string => {
  const d = digits(e);
  if (!d || d.length > 10) throw new Error(`Employer E-number must be 1–10 digits, got “${e}”`);
  return d.padStart(10, '0');
};

export type Cp39File = {
  filename: string;
  content: string;
  totals: { mtdCents: number; mtdRecords: number; cp38Cents: number; cp38Records: number };
};

/** Pure builder — golden-tested against the Exhibit-5 sample lines. */
export function buildCp39File(p: {
  employerNo: string;
  year: number;
  month: number;
  rows: Cp39Row[];
}): Cp39File {
  const employer = normalizeEmployerNo(p.employerNo);
  const mm = String(p.month).padStart(2, '0');
  // Fail-loud on over-long employee numbers (feedback de2823cc): alpha() hard-truncates to width, which
  // would silently corrupt the identifier in a government file. Refuse instead, listing every employee.
  const overlongNos = p.rows.filter((r) => (r.employeeNo ?? '').trim().length > CP39_EMPLOYEE_NO_LEN);
  if (overlongNos.length) {
    throw new Error(
      `Employee no exceeds the ${CP39_EMPLOYEE_NO_LEN}-character CP39 field for: ` +
        overlongNos.map((r) => `${r.name} (${(r.employeeNo ?? '').trim()})`).join(', '),
    );
  }
  const lines: string[] = [];
  let mtdCents = 0;
  let mtdRecords = 0;
  let cp38Cents = 0;
  let cp38Records = 0;

  for (const r of p.rows) {
    const tin = digits(r.tin);
    if (!tin) throw new Error(`TIN is mandatory (Exhibit 4 field 11) — missing for “${r.name}”`);
    const rowMtd = cents(r.mtd);
    const rowCp38 = cents(r.cp38 ?? 0);
    mtdCents += rowMtd;
    if (rowMtd > 0) mtdRecords += 1;
    cp38Cents += rowCp38;
    if (rowCp38 > 0) cp38Records += 1;
    const line =
      'D' +
      num(tin, 11, `TIN (${r.name})`) +
      alpha(r.name, 60) +
      alpha(r.oldIc, 12) +
      alpha(r.newIc ? digits(r.newIc) : '', 12) +
      alpha(r.passport, 12) +
      alpha(r.countryCode, 2) +
      num(rowMtd, 8, `MTD (${r.name})`) +
      num(rowCp38, 8, `CP38 (${r.name})`) +
      alpha(r.employeeNo, CP39_EMPLOYEE_NO_LEN);
    if (line.length !== 136) throw new Error(`detail record is ${line.length} chars, expected 136`);
    lines.push(line);
  }

  const header =
    'H' +
    employer +
    employer +
    num(p.year, 4, 'year') +
    num(mm, 2, 'month') +
    num(mtdCents, 10, 'total MTD') +
    num(mtdRecords, 5, 'MTD records') +
    num(cp38Cents, 10, 'total CP38') +
    num(cp38Records, 5, 'CP38 records');
  if (header.length !== 57) throw new Error(`header record is ${header.length} chars, expected 57`);

  return {
    filename: `${employer}${mm}_${p.year}.txt`,
    content: [header, ...lines].join('\r\n') + '\r\n',
    totals: { mtdCents, mtdRecords, cp38Cents, cp38Records },
  };
}

export class Cp39NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Cp39NotReadyError';
  }
}

/** Build the CP39 file for a company's pay period from its generated payslips. Refuses to emit
 *  with missing identifiers (ADR-0010 readiness gate). */
export function cp39FileForBatch(
  ctx: SessionContext,
  p: { companyId: string; periodKey: string },
): Promise<Cp39File & { statutoryVersion: string }> {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): aggregate the month's MTD across ALL runs of the period — CP39 is one monthly
    // filing, so each employee's row is the SUM of their regular + bonus/off-cycle MTD. With a single
    // run this is byte-identical to before.
    const batches = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.periodKey)));
    if (batches.length === 0)
      throw new Cp39NotReadyError(`No payroll batch for ${p.periodKey} — generate payslips first.`);
    const batchIds = batches.map((x) => x.id);
    const [co] = await tx
      .select({ eNo: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, p.companyId))
      .limit(1);
    if (!co?.eNo) {
      throw new Cp39NotReadyError('Company LHDN E-number is not set (Organization → statutory identity).');
    }
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        tin: employeeStatutoryMy.taxNumber,
        ic: employeeStatutoryMy.icNumber,
        employeeNo: employment.employeeCode,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);
    // One CP39 row per employee: sum MTD across the period's runs (= the month's total MTD).
    type Agg = { name: string; tin: string | null; ic: string | null; employeeNo: string | null; mtd: number; cp38: number };
    const byEmp = new Map<string, Agg>();
    const versionSet = new Set<string>();
    for (const s of slips) {
      const v = (s.statutory as { version?: string } | null)?.version;
      if (v) versionSet.add(v);
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = { name: s.name, tin: s.tin, ic: s.ic, employeeNo: s.employeeNo, mtd: 0, cp38: 0 };
        byEmp.set(s.employmentId, r);
      }
      r.mtd = Math.round((r.mtd + Number((s.statutory as { pcb?: number } | null)?.pcb ?? 0)) * 100) / 100;
      // 1.2.3 CP38 — distinct from MTD. Stamped non-zero on the REGULAR run only (kernel), so summing across
      // the period's runs single-counts the month's one instalment (asserted by the cross-run agg test).
      r.cp38 = Math.round((r.cp38 + Number((s.statutory as { cp38?: number } | null)?.cp38 ?? 0)) * 100) / 100;
    }
    const empRows = [...byEmp.values()];
    const missing = empRows.filter((r) => !r.tin || !digits(r.tin)).map((r) => r.name);
    if (missing.length) {
      throw new Cp39NotReadyError(
        `TIN is mandatory for the CP39 file — missing for: ${missing.join(', ')}`,
      );
    }
    // Fail-closed pre-check (feedback de2823cc): the CP39 employee-no field is fixed at 10 characters.
    // Longer Employee IDs are fully valid in the product, but must not be silently truncated in a
    // statutory file — refuse with the affected employees listed so HR can shorten or hand-assign codes.
    const overlong = empRows.filter((r) => (r.employeeNo ?? '').trim().length > CP39_EMPLOYEE_NO_LEN);
    if (overlong.length) {
      throw new Cp39NotReadyError(
        `Employee ID exceeds the ${CP39_EMPLOYEE_NO_LEN} characters the LHDN CP39 format allows for: ` +
          overlong.map((r) => `${r.name} (${(r.employeeNo ?? '').trim()})`).join(', '),
      );
    }
    const [yy, mm] = p.periodKey.split('-').map(Number);
    const file = buildCp39File({
      employerNo: co.eNo,
      year: yy,
      month: mm,
      rows: empRows.map((r) => ({
        tin: r.tin!,
        name: r.name,
        newIc: r.ic,
        mtd: r.mtd,
        cp38: r.cp38,
        employeeNo: r.employeeNo,
      })),
    });
    // ADR-0020: stamp the version(s) the payslips were ACTUALLY computed with (the snapshot in each
    // payslip's `statutory` blob), not the code constant — so the file filed to LHDN reports the real figures.
    const versions = [...versionSet].sort();
    return { ...file, statutoryVersion: versions.length ? versions.join(',') : MY_STATUTORY_VERSION };
  });
}
