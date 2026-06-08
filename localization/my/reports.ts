/**
 * Malaysia statutory reports (ADR-0010). Layer-A (human-readable) reports derived from payroll
 * payslips, per legal entity. Each ReportDef is registered on the pack; the generic core
 * (core/reporting.ts) lists / previews / records them without naming any MY-specific report.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../../db/client';
import { employeeStatutoryMy, employment, payrollBatch, payslip, person } from '../../db/schema';
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
  meta: { hasBatch: boolean; batchStatus?: string; statutoryVersion: string };
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

/**
 * Monthly statutory contribution report: one row per employee with the identifiers a remittance
 * needs (IC, tax, EPF, SOCSO no) + their EPF/SOCSO/EIS/PCB, plus employer totals. Derived from the
 * company's payroll batch for the period. Backs CP39 (PCB), KWSP and PERKESO filings.
 */
async function contributions(ctx: SessionContext, params: ReportParams): Promise<ReportResult> {
  const columns: ReportColumn[] = [
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
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status })
      .from(payrollBatch)
      .where(
        and(eq(payrollBatch.companyId, params.companyId), eq(payrollBatch.payPeriod, params.periodKey)),
      )
      .limit(1);
    if (!batch) {
      return {
        columns,
        rows: [],
        totals: {},
        readiness: [],
        meta: { hasBatch: false, statutoryVersion: MY_STATUTORY_VERSION },
      };
    }

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

    const rows: ReportRow[] = [];
    const totals = { gross: 0, epf: 0, socso: 0, eis: 0, pcb: 0 };
    const readiness: ReportReadiness[] = [];
    for (const s of slips) {
      const st = (s.statutory ?? {}) as Record<string, number>;
      const epf = num(st.epfEmployee) + num(st.epfEmployer);
      const socso = num(st.socsoEmployee) + num(st.socsoEmployer);
      const eis = num(st.eisEmployee) + num(st.eisEmployer);
      const pcb = num(st.pcb);
      rows.push({
        name: s.name,
        ic: s.ic,
        taxNo: s.taxNo,
        epfNo: s.epfNo,
        socsoNo: s.socsoNo,
        gross: num(s.gross),
        epf,
        socso,
        eis,
        pcb,
      });
      totals.gross += num(s.gross);
      totals.epf += epf;
      totals.socso += socso;
      totals.eis += eis;
      totals.pcb += pcb;
      const missing: string[] = [];
      if (!s.ic) missing.push('IC');
      if (!s.taxNo) missing.push('Tax no');
      if (!s.epfNo) missing.push('EPF no');
      if (!s.socsoNo) missing.push('SOCSO no');
      if (missing.length) readiness.push({ employmentId: s.employmentId, name: s.name, missing });
    }
    (Object.keys(totals) as (keyof typeof totals)[]).forEach((k) => (totals[k] = round2(totals[k])));
    return {
      columns,
      rows,
      totals,
      readiness,
      meta: { hasBatch: true, batchStatus: batch.status, statutoryVersion: MY_STATUTORY_VERSION },
    };
  });
}

export const MY_REPORTS: ReportDef[] = [
  {
    id: 'my.contributions',
    label: 'Monthly statutory contributions',
    cadence: 'monthly',
    scope: 'batch',
    periodKind: 'month',
    generate: contributions,
  },
];
