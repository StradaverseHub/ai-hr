/**
 * Malaysia statutory reports (ADR-0010). Layer-A (human-readable) reports derived from payroll
 * payslips, per legal entity. Each ReportDef is registered on the pack; the generic core
 * (core/reporting.ts) lists / previews / records them without naming any MY-specific report.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import {
  company,
  companyStatutoryMy,
  eaOverride,
  employeeStatutoryMy,
  employment,
  payrollBatch,
  payslip,
  person,
} from '../../db/schema';
import { MY_STATUTORY_VERSION, DEFAULT_MY_STATUTORY } from './statutory-tables';
import { coordinatedPcbForPerson } from './payroll';

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
/**
 * Where a generated form actually gets submitted, and by when (feedback 956cec85).
 *
 * SOURCED FROM THE REPORTER, NOT INVENTED. The item was parked on exactly this question and their
 * answer (feedback_request block_trail, resolved 2026-07-30) named the portals and the deadline:
 * EPF via i-Akaun (Employer); SOCSO and EIS TOGETHER via PERKESO ASSIST; PCB via LHDN e-PCB /
 * e-Data PCB / e-CP39 — all due by the 15th of the following month.
 *
 * `dueDayOfNextMonth` is null where the deadline was NOT stated. The annual Form E deadline is a real
 * statutory date, but nobody told us it, and this codebase's rule for statutory facts is that an
 * invented one is worse than an absent one — the screen says "not configured" rather than printing a
 * date somebody might file against.
 */
export type ReportSubmission = {
  /** The body the form is submitted to, as the reporter names it. */
  agency: string;
  /** The portal/channel they actually use. */
  channel: string;
  /** Day of the month FOLLOWING the period, or null when the deadline is not established. */
  dueDayOfNextMonth: number | null;
};

export type ReportDef = {
  id: string;
  label: string;
  cadence: 'monthly' | 'annual' | 'event';
  scope: 'batch' | 'period' | 'year' | 'event';
  periodKind: 'month' | 'year' | 'event';
  /** Absent for reports that are not themselves a submission (e.g. the internal overview). */
  submission?: ReportSubmission;
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
  /** Ruleset version the runs were computed with (ADR-0024 D7: one per month). Carried for report meta. */
  version?: string | null;
  st: Stat;
};
type LoadedBatch = { hasBatch: boolean; batchStatus?: string; rows: BatchRow[] };

async function loadBatchRows(ctx: SessionContext, params: ReportParams): Promise<LoadedBatch> {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): a (company, month) may now hold multiple runs (regular + bonus/off-cycle).
    // The monthly statutory return is ONE filing for the month, so aggregate across ALL runs of the
    // period. Runs store delta figures, so summing per employee yields the exact monthly total — with a
    // single run this is byte-identical to before. (Mirrors loadYearRows, scoped to one month.)
    const batches = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status })
      .from(payrollBatch)
      .where(
        and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, params.periodKey)),
      );
    if (batches.length === 0) return { hasBatch: false, rows: [] };
    const batchIds = batches.map((b) => b.id);
    // Period-level status for the report header: closed only if every run is closed; draft if any run
    // is still a draft; otherwise processed.
    const batchStatus = batches.every((b) => b.status === 'closed')
      ? 'closed'
      : batches.some((b) => b.status === 'draft')
        ? 'draft'
        : 'processed';
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
      .where(inArray(payslip.batchId, batchIds))
      .orderBy(person.fullName);
    // One row per employee: sum gross + every statutory delta across the period's runs.
    const byEmp = new Map<string, BatchRow>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat & { version?: string };
      let r = byEmp.get(s.employmentId);
      if (!r) {
        r = {
          employmentId: s.employmentId,
          name: s.name,
          ic: s.ic,
          taxNo: s.taxNo,
          epfNo: s.epfNo,
          socsoNo: s.socsoNo,
          gross: 0,
          version: st.version ?? null,
          st: {},
        };
        byEmp.set(s.employmentId, r);
      }
      r.gross = round2(r.gross + num(s.gross));
      for (const [k, v] of Object.entries(st)) {
        if (typeof v === 'number') r.st[k] = round2((r.st[k] ?? 0) + v);
      }
    }
    return {
      hasBatch: true,
      batchStatus,
      rows: [...byEmp.values()].sort((a, b) => a.name.localeCompare(b.name)),
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
  statutoryVersion: versionOf(b.rows.map((r) => ({ version: r.version }))),
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
  { key: 'socsoSkbbk', label: 'SKBBK (EE)', numeric: true },
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
    socsoSkbbk: num(r.st.socsoSkbbk), // Lindung 24 Jam / SKBBK — employee-paid leg (eff 1 Jun 2026)
    eisEmployee: num(r.st.eisEmployee),
    eisEmployer: num(r.st.eisEmployer),
  }));
  return {
    columns: SOCSO_COLS,
    rows,
    totals: sumTotals(rows, ['socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer']),
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
  'value of living accommodation, ESOS, tax-exempt allowances and zakat are not tracked in this view — add ' +
  'them in MyTax / e-CP8D before filing. (CP38 instalments are tracked and flow into the CP39 e-Data file, ' +
  'but are not summed into this annual CP8D view.)';

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
// 1.2.6 EA Data Overwrite — the 8 EA-form fields HR may amend (overlay) WITHOUT touching payroll. A plain
// const tuple (not a pgEnum), mirroring app/admin/pay-components discriminators. `gross` is independently
// overridable (HR may set a known total directly); otherwise it is recomputed from the post-overlay
// components so the printed Part B lines always sum to their own total (see the merge below).
export const EA_FIELDS = ['grossSalary', 'bonus', 'allowances', 'gross', 'mtd', 'epf', 'socso', 'eis'] as const;
export type EaField = (typeof EA_FIELDS)[number];
/** One amended EA field, surfaced so the UI/PDF can render "original vs amended" + an "Amended" badge. */
export type EaOverrideEntry = { field: EaField; original: number; amended: number; reason: string };

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
  /** Part B — employment income (cash). Untracked items (BIK, VOLA, ESOS, gratuity) are out of scope.
   *  `exemptAllowances` (feedback 09b554e9) — the year's TAX-EXEMPT allowance portions (the PCB_* exemption
   *  amounts each slip stamps as statutory.exemptionUsed), reported in the EA's exempt-allowances section.
   *  Optional + additive; the general EA line-mapping (ea_form_line consumption) remains a follow-up. */
  partB: { grossSalary: number; bonus: number; allowances: number; gross: number; exemptAllowances?: number };
  partD: { mtd: number; zakat: number }; // total deduction — MTD/PCB + the year's zakat-via-salary (Z)
  partE: { epf: number; socso: number; eis: number }; // employee's share of EPF + SOCSO/EIS
  statutoryVersion: string;
  /** EA-only amendments overlaid by HR (1.2.6). Empty = none. Additive + optional so existing consumers
   *  keep compiling; the PDF/HTML surfaces read it to badge amended lines. */
  overrides: EaOverrideEntry[];
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
    let zakat = 0;
    let epf = 0;
    let socso = 0;
    let eis = 0;
    let exemptAllowances = 0;
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Stat & { exemptionUsed?: Record<string, number> };
      grossSalary += num(s.basic) + num(s.overtime);
      bonus += num(s.bonus);
      allowances += num(s.allowance);
      gross += num(s.gross);
      mtd += num(st.pcb);
      // 1.2.4 Zakat — the year's accumulated zakat-via-salary (each payslip stamps the month's figure).
      zakat += num(st.zakat);
      epf += num(st.epfEmployee);
      socso += num(st.socsoEmployee);
      eis += num(st.eisEmployee);
      // Feedback 09b554e9 — the exempt PCB_* allowance portions accumulate to the EA exempt-allowances
      // figure (LP_* codes are optional DEDUCTIONS, not exempt income, so they are excluded here).
      if (st.exemptionUsed) {
        for (const [code, amt] of Object.entries(st.exemptionUsed)) {
          if (code.startsWith('PCB_')) exemptAllowances += num(amt);
        }
      }
    }
    // ── 1.2.6 EA Data Overwrite — overlay HR's EA-only amendments onto the payroll-derived figures ──
    // EA-ONLY: nothing above touched payroll; this only rewrites the figures the EA form renders. Read the
    // override rows for (employment, year), apply each to its field, then recompute partB.gross from the
    // post-overlay components (so the printed Part B lines always sum to their total) UNLESS an explicit
    // `gross` override exists, in which case that wins. The merge appends NO event — it is a pure read.
    const derived: Record<EaField, number> = {
      grossSalary: round2(grossSalary),
      bonus: round2(bonus),
      allowances: round2(allowances),
      gross: round2(gross),
      mtd: round2(mtd),
      epf: round2(epf),
      socso: round2(socso),
      eis: round2(eis),
    };
    const ovRows = await tx
      .select({ field: eaOverride.field, amount: eaOverride.amount, reason: eaOverride.reason })
      .from(eaOverride)
      .where(and(eq(eaOverride.employmentId, p.employmentId), eq(eaOverride.year, p.year)));
    const merged: Record<EaField, number> = { ...derived };
    const overrides: EaOverrideEntry[] = [];
    let grossOverridden = false;
    for (const r of ovRows) {
      const field = r.field as EaField;
      if (!(EA_FIELDS as readonly string[]).includes(field)) continue; // defensive: ignore unknown discriminators
      const amended = round2(num(r.amount));
      overrides.push({ field, original: derived[field], amended, reason: r.reason });
      merged[field] = amended;
      if (field === 'gross') grossOverridden = true;
    }
    // Recompute the total from the (possibly amended) components, unless HR set `gross` directly.
    if (!grossOverridden) merged.gross = round2(merged.grossSalary + merged.bonus + merged.allowances);

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
      partB: { grossSalary: merged.grossSalary, bonus: merged.bonus, allowances: merged.allowances, gross: merged.gross, exemptAllowances: round2(exemptAllowances) },
      partD: { mtd: merged.mtd, zakat: round2(zakat) },
      partE: { epf: merged.epf, socso: merged.socso, eis: merged.eis },
      statutoryVersion: versionOf(slips.map((s) => s.statutory)),
      overrides,
    };
  });
}

export const MY_REPORTS: ReportDef[] = [
  // No `submission`: an internal reconciliation view, not a form anybody files.
  { id: 'my.contributions', label: 'Monthly statutory contributions (overview)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: contributions },
  { id: 'my.cp39', label: 'CP39 — MTD / PCB (LHDN)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: cp39,
    submission: { agency: 'LHDN', channel: 'e-PCB / e-Data PCB / e-CP39', dueDayOfNextMonth: 15 } },
  { id: 'my.epf', label: 'EPF contributions (KWSP)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: epfReport,
    submission: { agency: 'EPF (KWSP)', channel: 'i-Akaun (Employer)', dueDayOfNextMonth: 15 } },
  // SOCSO and EIS go up TOGETHER through ASSIST's combined contribution function — the reporter's words.
  { id: 'my.socso-eis', label: 'SOCSO + EIS (PERKESO)', cadence: 'monthly', scope: 'batch', periodKind: 'month', generate: socsoEis,
    submission: { agency: 'PERKESO', channel: 'PERKESO ASSIST', dueDayOfNextMonth: 15 } },
  // dueDayOfNextMonth null: the annual deadline was never stated to us. See ReportSubmission.
  { id: 'my.cp8d', label: 'Form E / CP8D — annual (LHDN)', cadence: 'annual', scope: 'year', periodKind: 'year', generate: cp8d,
    submission: { agency: 'LHDN', channel: 'e-Filing (Form E)', dueDayOfNextMonth: null } },
];

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0029 — cross-employer PCB exposure (read-only diagnostic, G2 Slice 2c).
// For each person with payslips in ≥2 of the tenant's companies for a period, compare the SUMMED filed
// MTD (what per-employer filing deducts) against the COMBINED-month MTD (`coordinatedPcbForPerson`, taxed
// once). The positive delta is the monthly under-deduction the employee will face at annual assessment —
// Compliance uses it to decide a designated paymaster (scope-out) or to enable coordination. EXACT for
// no-bonus months (the dominant case); months with a bonus are indicative (the K₁/Kₜ split is approximated
// from the slip). Never mutates payroll.
// ─────────────────────────────────────────────────────────────────────────────
export type CrossEmployerPcbRow = {
  personId: string;
  personName: string;
  summedMtd: number;
  combinedMtd: number;
  delta: number;
  indicative: boolean; // true when any employment had a bonus this month (K split approximated)
  employments: { employmentId: string; company: string; filedPcb: number }[];
};

export async function crossEmployerPcbExposure(ctx: SessionContext, period: string): Promise<CrossEmployerPcbRow[]> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const month = Math.min(12, Math.max(1, parseInt(period.slice(5, 7), 10) || 1));
  return withTenant(ctx, async (tx) => {
    const slips = await tx
      .select({
        personId: employment.personId,
        personName: person.fullName,
        employmentId: payslip.employmentId,
        company: company.legalName,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        category: employeeStatutoryMy.taxCategory,
        children: employeeStatutoryMy.numChildren,
        statutory: payslip.statutory,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payrollBatch.payPeriod, period));

    type Acc = { personId: string; personName: string; category: number | null; children: number | null;
      inputs: { employmentId: string; monthlyWage: number; epfMonthly: number; additional: number; epfOnAdditional: number;
        acc: { netRemuneration: number; epfClaimed: number; pcbPaid: number } }[];
      filed: { employmentId: string; company: string; filedPcb: number }[]; indicative: boolean };
    const byPerson = new Map<string, Acc>();
    for (const s of slips) {
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; pcbMeta?: { ytdNet?: number; epfClaimed?: number; pcbPaid?: number } };
      const bonus = Number(s.bonus) || 0;
      let p = byPerson.get(s.personId);
      if (!p) p = { personId: s.personId, personName: s.personName, category: s.category, children: s.children, inputs: [], filed: [], indicative: false };
      p.inputs.push({
        employmentId: s.employmentId,
        monthlyWage: (Number(s.basic) || 0) + (Number(s.allowance) || 0) + (Number(s.overtime) || 0),
        epfMonthly: Number(st.epfEmployee) || 0, // K₁ — exact when no bonus
        additional: bonus,
        epfOnAdditional: 0,
        acc: { netRemuneration: Number(st.pcbMeta?.ytdNet) || 0, epfClaimed: Number(st.pcbMeta?.epfClaimed) || 0, pcbPaid: Number(st.pcbMeta?.pcbPaid) || 0 },
      });
      p.filed.push({ employmentId: s.employmentId, company: s.company, filedPcb: Number(st.pcb) || 0 });
      if (bonus > 0) p.indicative = true;
      byPerson.set(s.personId, p);
    }

    const out: CrossEmployerPcbRow[] = [];
    for (const p of byPerson.values()) {
      if (p.inputs.length < 2) continue; // only concurrent-employment people
      const summedMtd = r2(p.filed.reduce((a, b) => a + b.filedPcb, 0));
      const coord = coordinatedPcbForPerson(p.inputs, {
        month,
        profile: { category: (p.category ?? 1) as 1 | 2 | 3, children: p.children ?? 0 },
        pcb: DEFAULT_MY_STATUTORY.pcb,
      });
      out.push({
        personId: p.personId,
        personName: p.personName,
        summedMtd,
        combinedMtd: coord.combinedMtd,
        delta: r2(coord.combinedMtd - summedMtd),
        indicative: p.indicative,
        employments: p.filed,
      });
    }
    return out.sort((a, b) => b.delta - a.delta);
  });
}
