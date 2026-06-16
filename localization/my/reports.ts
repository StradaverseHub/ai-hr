/**
 * Malaysia statutory reports (ADR-0010). Layer-A (human-readable) reports derived from payroll
 * payslips, per legal entity. Each ReportDef is registered on the pack; the generic core
 * (core/reporting.ts) lists / previews / records them without naming any MY-specific report.
 */
import { and, eq, like } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  company,
  companyStatutoryMy,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import { MY_STATUTORY_VERSION } from './statutory-tables';

export type ReportColumn = { key: string; label: string; numeric?: boolean };
export type ReportRow = Record<string, string | number | null>;
export type ReportReadiness = { employmentId: string; name: string; missing: string[] };
export type ReportResult = {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number>;
  /** Employees missing a field a remittance needs. Empty array = fully ready. */
  readiness: ReportReadiness[];
  meta: {
    hasBatch: boolean;
    batchStatus?: string;
    statutoryVersion: string;
    /** Headline counts shown above the table (e.g. Form E Part A). */
    summary?: { label: string; value: string | number }[];
    /** Caveats for this report (e.g. fields the payroll system does not track). */
    notes?: string[];
  };
};
export type ReportParams = { companyId: string; periodKey: string };
export type ReportDef = {
  id: string;
  label: string;
  cadence: 'monthly' | 'annual' | 'event';
  scope: 'batch' | 'period' | 'year' | 'event';
  periodKind: 'month' | 'year' | 'event';
  generate: (ctx: SessionContext, params: ReportParams) => Promise<ReportResult>;
};

const num = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Shared batch loader ─────────────────────────────────────────────────────
// Every monthly report reads the same source — the company's payroll batch for the period — then
// each maps it to its own columns / totals / readiness. Loaded once here, mapped per report.
type Stat = Record<string, number>;
type BatchRow = {
  employmentId: string;
  name: string;
  ic: string | null;
  taxNo: string | null;
  epfNo: string | null;
  socsoNo: string | null;
  gross: number;
  st: Stat;
};
type LoadedBatch = { hasBatch: boolean; batchStatus?: string; rows: BatchRow[] };

async function loadBatchRows(ctx: SessionContext, params: ReportParams): Promise<LoadedBatch> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status })
      .from(payrollBatch)
      .where(
        and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, params.periodKey)),
      )
      .limit(1);
    if (!batch) return { hasBatch: false, rows: [] };
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payslip.batchId, batch.id))
      .orderBy(person.fullName);
    return {
      hasBatch: true,
      batchStatus: batch.status,
      rows: slips.map((s) => ({
        employmentId: s.employmentId,
        name: s.name,
        ic: s.ic,
        taxNo: s.taxNo,
        epfNo: s.epfNo,
        socsoNo: s.socsoNo,
        gross: num(s.gross),
        st: (s.statutory ?? {}) as Stat,
      })),
    };
  });
}

type IdFields = {
  employmentId: string;
  name: string;
  ic: string | null;
  taxNo: string | null;
  epfNo: string | null;
  socsoNo: string | null;
};

/** Per-employee readiness: which required identifier fields are blank. */
function readinessFor(
  rows: IdFields[],
  checks: { field: 'ic' | 'taxNo' | 'epfNo' | 'socsoNo'; label: string }[],
): ReportReadiness[] {
  const out: ReportReadiness[] = [];
  for (const r of rows) {
    const missing = checks.filter((c) => !r[c.field]).map((c) => c.label);
    if (missing.length) out.push({ employmentId: r.employmentId, name: r.name, missing });
  }
  return out;
}

function sumTotals(rows: ReportRow[], keys: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const k of keys) totals[k] = round2(rows.reduce((acc, r) => acc + num(r[k]), 0));
  return totals;
}

/**
 * Stamp the statutory version(s) the payslips were ACTUALLY computed with (ADR-0020): read the snapshot in
 * each payslip's `statutory` blob — NOT the code constant, which would misreport once a pack/override lands.
 * Multiple versions (an annual report spanning a mid-year change) are joined; legacy payslips with no stamped
 * version fall back to the code constant.
 */
function versionOf(blobs: unknown[]): string {
  const vs = [
    ...new Set(blobs.map((b) => ((b ?? {}) as { version?: string }).version).filter((v): v is string => !!v)),
  ].sort();
  return vs.length ? vs.join(',') : MY_STATUTORY_VERSION;
}

const meta = (b: LoadedBatch) => ({
  hasBatch: b.hasBatch,
  batchStatus: b.batchStatus,
  statutoryVersion: versionOf(b.rows.map((r) => r.st)),
});

const empty = (columns: ReportColumn[], b: LoadedBatch): ReportResult => ({
  columns,
  rows: [],
  totals: {},
  readiness: [],
  meta: meta(b),
});

// ── Reports ─────────────────────────────────────────────────────────────────

const CONTRIB_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'ic', label: 'IC' },
  { key: 'taxNo', label: 'Tax no' },
  { key: 'epfNo', label: 'EPF no' },
  { key: 'socsoNo', label: 'SOCSO no' },
  { key: 'gross', label: 'Gross', numeric: true },
  { key: 'epf', label: 'EPF (EE+ER)', numeric: true },
  { key: 'socso', label: 'SOCSO (EE+ER)', numeric: true },
  { key: 'eis', label: 'EIS (EE+ER)', numeric: true },
  { key: 'pcb', label: 'PCB', numeric: true },
];

/** Combined overview: every contribution at a glance. Backs the per-agency reports below. */
async function contributions(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(CONTRIB_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({
    name: r.name,
    ic: r.ic,
    taxNo: r.taxNo,
    epfNo: r.epfNo,
    socsoNo: r.socsoNo,
    gross: r.gross,
    epf: round2(num(r.st.epfEmployee) + num(r.st.epfEmployer)),
    socso: round2(num(r.st.socsoEmployee) + num(r.st.socsoEmployer)),
    eis: round2(num(r.st.eisEmployee) + num(r.st.eisEmployer)),
    pcb: num(r.st.pcb),
  }));
  return {
    columns: CONTRIB_COLS,
    rows,
    totals: sumTotals(rows, ['gross', 'epf', 'socso', 'eis', 'pcb']),
    readiness: readinessFor(b.rows, [
      { field: 'ic', label: 'IC' },
      { field: 'taxNo', label: 'Tax no' },
      { field: 'epfNo', label: 'EPF no' },
      { field: 'socsoNo', label: 'SOCSO no' },
    ]),
    meta: meta(b),
  };
}

const CP39_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'taxNo', label: 'Tax no' },
  { key: 'ic', label: 'IC' },
  { key: 'pcb', label: 'MTD / PCB', numeric: true },
];

/** CP39 — LHDN monthly tax deduction (MTD/PCB) statement. */
async function cp39(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(CP39_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({
    name: r.name,
    taxNo: r.taxNo,
    ic: r.ic,
    pcb: num(r.st.pcb),
  }));
  return {
    columns: CP39_COLS,
    rows,
    totals: sumTotals(rows, ['pcb']),
    readiness: readinessFor(b.rows, [{ field: 'taxNo', label: 'Tax no' }]),
    meta: meta(b),
  };
}

const EPF_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'epfNo', label: 'EPF no' },
  { key: 'ic', label: 'IC' },
  { key: 'gross', label: 'Gross', numeric: true },
  { key: 'employee', label: 'Employee', numeric: true },
  { key: 'employer', label: 'Employer', numeric: true },
  { key: 'total', label: 'Total', numeric: true },
];

/** EPF / KWSP monthly contribution (Borang A basis). */
async function epfReport(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(EPF_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => {
    const ee = num(r.st.epfEmployee);
    const er = num(r.st.epfEmployer);
    return { name: r.name, epfNo: r.epfNo, ic: r.ic, gross: r.gross, employee: ee, employer: er, total: round2(ee + er) };
  });
  return {
    columns: EPF_COLS,
    rows,
    totals: sumTotals(rows, ['gross', 'employee', 'employer', 'total']),
    readiness: readinessFor(b.rows, [{ field: 'epfNo', label: 'EPF no' }]),
    meta: meta(b),
  };
}

const SOCSO_COLS: ReportColumn[] = [
  { key: 'name', label: 'Employee' },
  { key: 'socsoNo', label: 'SOCSO no' },
  { key: 'ic', label: 'IC' },
  { key: 'socsoEmployee', label: 'SOCSO (EE)', numeric: true },
  { key: 'socsoEmployer', label: 'SOCSO (ER)', numeric: true },
  { key: 'eisEmployee', label: 'EIS (EE)', numeric: true },
  { key: 'eisEmployer', label: 'EIS (ER)', numeric: true },
];

/** SOCSO + EIS — PERKESO monthly contribution (ASSIST basis). */
async function socsoEis(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const b = await loadBatchRows(ctx, params);
  if (!b.hasBatch) return empty(SOCSO_COLS, b);
  const rows: ReportRow[] = b.rows.map((r) => ({
    name: r.name,
    socsoNo: r.socsoNo,
    ic: r.ic,
    socsoEmployee: num(r.st.socsoEmployee),
    socsoEmployer: num(r.st.socsoEmployer),
    eisEmployee: num(r.st.eisEmployee),
    eisEmployer: num(r.st.eisEmployer),
  }));
  return {
    columns: SOCSO_COLS,
    rows,
    totals: sumTotals(rows, ['socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer']),
    readiness: readinessFor(b.rows, [{ field: 'socsoNo', label: 'SOCSO no' }]),
    meta: meta(b),
  };
}

// ── Annual (Form E / CP8D) ──────────────────────────────────────────────────
// Aggregates a tax year's payslips per employee. periodKey is the year, e.g. '2026'.
type YearRow = IdFields & {
  category: number | null;
  children: number | null;
  gross: number;
  epf: number;
  socso: number;
  eis: number;
  pcb: number;
};

async function loadYearRows(
  ctx: SessionContext,
  year: string,
  companyId: string,
): Promise<{ rows: YearRow[]; versions: string[] }> {
  return withTenant(ctx, async (tx) => {
    const versions = new Set<string>();
    const slips = await tx
      .select({
        employmentId: payslip.employmentId,
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(and(eq(payrollBatch.companyId, companyId), like(payrollBatch.payPeriod, `${year}-%`)));

    const byEmp = new Map<string, YearRow>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat;
      const v = (s.statutory as { version?: string } | null)?.version;
      if (v) versions.add(v);
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = {
          employmentId: s.employmentId,
          name: s.name,
          ic: s.ic,
          taxNo: s.taxNo,
          epfNo: s.epfNo,
          socsoNo: s.socsoNo,
          category: s.category,
          children: s.children,
          gross: 0,
          epf: 0,
          socso: 0,
          eis: 0,
          pcb: 0,
        };
        byEmp.set(s.employmentId, r);
      }
      r.gross = round2(r.gross + num(s.gross));
      r.epf = round2(r.epf + num(st.epfEmployee));
      r.socso = round2(r.socso + num(st.socsoEmployee));
      r.eis = round2(r.eis + num(st.eisEmployee));
      r.pcb = round2(r.pcb + num(st.pcb));
    }
    return {
      rows: [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name)),
      versions: [...versions].sort(),
    };
  });
}

/** Form E Part A headcounts for the year (employment-based, computed in JS over the company set). */
async function formECounts(
  ctx: SessionContext,
  year: string,
  companyId: string,
  subjectToMtd: number,
): Promise<{ label: string; value: number }[]> {
  return withTenant(ctx, async (tx) => {
    const emps = await tx
      .select({ hiredOn: employment.hiredOn, terminatedOn: employment.terminatedOn })
      .from(employment)
      .where(eq(employment.companyId, companyId));
    const yStart = `${year}-01-01`;
    const yEnd = `${year}-12-31`;
    const activeAtEnd = emps.filter((e) => e.hiredOn <= yEnd && (!e.terminatedOn || e.terminatedOn >= yEnd)).length;
    const newHires = emps.filter((e) => e.hiredOn >= yStart && e.hiredOn <= yEnd).length;
    const ceased = emps.filter((e) => e.terminatedOn && e.terminatedOn >= yStart && e.terminatedOn <= yEnd).length;
    return [
      { label: `Active at 31 Dec ${year}`, value: activeAtEnd },
      { label: 'Subject to MTD', value: subjectToMtd },
      { label: `New hires (${year})`, value: newHires },
      { label: `Ceased (${year})`, value: ceased },
    ];
  });
}

const CP8D_COLS: ReportColumn[] = [
  { key: 'no', label: 'No.' },
  { key: 'name', label: 'Employee' },
  { key: 'taxNo', label: 'TIN' },
  { key: 'ic', label: 'IC' },
  { key: 'category', label: 'Cat.' },
  { key: 'children', label: 'Children' },
  { key: 'gross', label: 'Gross remuneration', numeric: true },
  { key: 'epf', label: 'EPF', numeric: true },
  { key: 'pcb', label: 'MTD / PCB', numeric: true },
  { key: 'socso', label: 'SOCSO', numeric: true },
];

const CP8D_NOTE =
  'Covers payroll-derived figures only: gross cash remuneration, EPF, SOCSO and MTD/PCB. Benefits-in-kind, ' +
  'value of living accommodation, ESOS, tax-exempt allowances, zakat and CP38 are not tracked here — add them ' +
  'in MyTax / e-CP8D before filing.';

/** Form E / CP8D — annual employer return (per-employee remuneration + Part A headcounts). */
async function cp8d(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const year = params.periodKey;
  const { rows: yr, versions } = await loadYearRows(ctx, year, params.companyId);
  const rows: ReportRow[] = yr.map((r, i) => ({
    no: i + 1,
    employmentId: r.employmentId, // not a column — lets the UI deep-link each row to its EA statement
    name: r.name,
    taxNo: r.taxNo,
    ic: r.ic,
    category: r.category ?? 1,
    children: r.children ?? 0,
    gross: r.gross,
    epf: r.epf,
    pcb: r.pcb,
    socso: r.socso,
  }));
  const subjectToMtd = yr.filter((r) => r.pcb > 0).length;
  const summary = await formECounts(ctx, year, params.companyId, subjectToMtd);
  return {
    columns: CP8D_COLS,
    rows,
    totals: sumTotals(rows, ['gross', 'epf', 'pcb', 'socso']),
    readiness: readinessFor(yr, [
      { field: 'taxNo', label: 'Tax no' },
      { field: 'epfNo', label: 'EPF no' },
      { field: 'socsoNo', label: 'SOCSO no' },
    ]),
    meta: {
      hasBatch: yr.length > 0,
      statutoryVersion: versions.length ? versions.join(',') : MY_STATUTORY_VERSION,
      summary,
      notes: [CP8D_NOTE],
    },
  };
}

// ── EA statement (C.P.8A) — per employee ────────────────────────────────────
export type EaStatement = {
  year: string;
  employer: { name: string; eNumber: string | null };
  employee: {
    name: string;
    ic: string | null;
    taxNo: string | null;
    epfNo: string | null;
    socsoNo: string | null;
    category: number;
    children: number;
    hiredOn: string;
    terminatedOn: string | null;
  };
  /** Part B — employment income (cash). Untracked items (BIK, VOLA, ESOS, gratuity) are out of scope. */
  partB: { grossSalary: number; bonus: number; allowances: number; gross: number };
  partD: { mtd: number }; // total deduction — MTD/PCB (zakat/CP38 untracked)
  partE: { epf: number; socso: number; eis: number }; // employee's share of EPF + SOCSO/EIS
  statutoryVersion: string;
};

/** Per-employee EA (C.P.8A) statement for a tax year, from the year's payslips. */
export async function eaStatement(
  ctx: SessionContext,
  p: { employmentId: string; year: string },
): Promise<EaStatement | null> {
  return withTenant(ctx, async (tx) => {
    const [info] = await tx
      .select({
        name: person.fullName,
        ic: employeeStatutoryMy.icNumber,
        taxNo: employeeStatutoryMy.taxNumber,
        epfNo: employeeStatutoryMy.epfNumber,
        socsoNo: employeeStatutoryMy.socsoNumber,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        companyId: employment.companyId,
        companyName: company.legalName,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!info) return null;
    const [stat] = await tx
      .select({ eNumber: companyStatutoryMy.lhdnEmployerNo })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, info.companyId))
      .limit(1);
    const slips = await tx
      .select({
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(and(eq(payslip.employmentId, p.employmentId), like(payrollBatch.payPeriod, `${p.year}-%`)));

    let grossSalary = 0;
    let bonus = 0;
    let allowances = 0;
    let gross = 0;
    let mtd = 0;
    let epf = 0;
    let socso = 0;
    let eis = 0;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat;
      grossSalary += num(s.basic) + num(s.overtime);
      bonus += num(s.bonus);
      allowances += num(s.allowance);
      gross += num(s.gross);
      mtd += num(st.pcb);
      epf += num(st.epfEmployee);
      socso += num(st.socsoEmployee);
      eis += num(st.eisEmployee);
    }
    return {
      year: p.year,
      employer: { name: info.companyName, eNumber: stat?.eNumber ?? null },
      employee: {
        name: info.name,
        ic: info.ic,
        taxNo: info.taxNo,
        epfNo: info.epfNo,
        socsoNo: info.socsoNo,
        category: info.category ?? 1,
        children: info.children ?? 0,
        hiredOn: info.hiredOn,
        terminatedOn: info.terminatedOn,
      },
      partB: { grossSalary: round2(grossSalary), bonus: round2(bonus), allowances: round2(allowances), gross: round2(gross) },
      partD: { mtd: round2(mtd) },
      partE: { epf: round2(epf), socso: round2(socso), eis: round2(eis) },
      statutoryVersion: versionOf(slips.map((s) => s.statutory)),
    };
  });
}

export const MY_REPORTS: ReportDef[] = [
  { id: 'my.contributions', label: 'Monthly statutory contributions (overview)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: contributions },
  { id: 'my.cp39', label: 'CP39 — MTD / PCB (LHDN)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: cp39 },
  { id: 'my.epf', label: 'EPF contributions (KWSP)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: epfReport },
  { id: 'my.socso-eis', label: 'SOCSO + EIS (PERKESO)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: socsoEis },
  { id: 'my.cp8d', label: 'Form E / CP8D — annual (LHDN)', cadence: 'annual', scope: 'year', periodKind: 'year', generate: cp8d },
];
