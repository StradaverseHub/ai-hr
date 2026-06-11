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
import { and, eq } from 'drizzle-orm';
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
  /** CP38 instalment in RM (we do not track CP38 — 0). */
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
      alpha(r.employeeNo, 10);
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
    const [b] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.periodKey)))
      .limit(1);
    if (!b) throw new Cp39NotReadyError(`No payroll batch for ${p.periodKey} — generate payslips first.`);
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
      .where(eq(payslip.batchId, b.id))
      .orderBy(person.fullName);
    const missing = slips.filter((s) => !s.tin || !digits(s.tin)).map((s) => s.name);
    if (missing.length) {
      throw new Cp39NotReadyError(
        `TIN is mandatory for the CP39 file — missing for: ${missing.join(', ')}`,
      );
    }
    const [yy, mm] = p.periodKey.split('-').map(Number);
    const file = buildCp39File({
      employerNo: co.eNo,
      year: yy,
      month: mm,
      rows: slips.map((s) => ({
        tin: s.tin!,
        name: s.name,
        newIc: s.ic,
        mtd: Number((s.statutory as { pcb?: number } | null)?.pcb ?? 0),
        employeeNo: s.employeeNo,
      })),
    });
    return { ...file, statutoryVersion: MY_STATUTORY_VERSION };
  });
}
