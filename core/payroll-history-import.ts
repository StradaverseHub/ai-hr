/**
 * 1.2.5 Import Payroll History — bulk-load PRE-COMPUTED historical payroll for data migration.
 *
 * Why this exists: a customer migrating onto the platform mid-life needs prior periods on file so the
 * EA form, Form E / CP8D and the monthly statutory returns are complete at year-end. Those readers
 * (localization/my/reports.ts) read `payslip ⋈ payroll_batch` directly — anything stored outside that
 * join is invisible to year-end — so imported rows MUST land as real payslip rows under a real batch.
 * No parallel table.
 *
 * DESIGN (load-bearing decisions; verified against the codebase):
 *
 *  1. Records live in payslip + payroll_batch — same source the year-end/monthly readers consume.
 *
 *  2. Import-only-into-EMPTY months. The importer refuses any (company, period) that already has ANY
 *     batch — every row for such a period counts toward `skipped` with a clear reason. Rationale: a
 *     migration imports PRIOR history for months the live system never ran (the empty-month case); a
 *     month with an existing calculated batch is exactly the double-count trap, since loadBatchRows
 *     (reports.ts) SUMS payslips across every batch for the month and loadYearRows/eaStatement filter
 *     only by `like(pay_period, '${year}-%')` with no run_type/status filter. Refusing it is correct.
 *     With at most one batch per imported (company, period), dedup collapses to "does this period
 *     already have a batch?" — no across-all-batches (employmentId, period) scan needed.
 *
 *  3. The importer owns its batch insert — it does NOT call createBatch (which throws on any existing
 *     batch for the period and always creates run_type='regular', colliding with the partial unique
 *     index payroll_batch_one_regular_uq). It inserts run_type='adjustment', run_seq=1 directly,
 *     find-or-creating the pay_period parent inline. 'adjustment' sidesteps the regular-uniqueness
 *     index without a new enum; the additional-remuneration "increment" math lives ONLY in
 *     generatePayslips (which the importer never calls — it inserts payslips directly), so there is no
 *     EA distortion: the EA reader reads stored payslip scalars regardless of run_type.
 *
 *  4. Create batch status='draft', insert payslips, set counters, THEN flip to 'closed'. The 0011
 *     immutability triggers are BEFORE UPDATE/DELETE only, so creating 'closed' up front would make
 *     employee_count/totals un-backfillable. Order: insert draft → insert payslips → UPDATE counters →
 *     UPDATE status='closed' → UPDATE pay_period status='closed' (so the period isn't orphaned 'open').
 *     The importer never calls closeBatch (it requires status='processed' and runs period-close logic).
 *
 *  5. Statutory figures are taken VERBATIM from the file (migration data is whatever the prior system
 *     paid — no MY recompute). The statutory JSONB carries every key the readers consume
 *     (epfEmployee/Employer, socsoEmployee/Employer, socsoSkbbk, eisEmployee/Employer, pcb, lp, zakat)
 *     plus a `version` stamp set to MY_STATUTORY_VERSION so versionOf reports the import provenance.
 *
 *  6. Employee resolution by EMAIL (matching commitEmployeeImport and importBatchComponents);
 *     employee_code is an optional secondary disambiguator only.
 *
 * Shape mirrors core/import.ts: one PRIVATE analyze(), two public exports
 * (validatePayrollHistoryImport dry-run, commitPayrollHistoryImport). Not atomic across periods: each
 * period writes in its OWN withTenant transaction so one failing period can't strand the others (a
 * single shared tx aborts on first failed insert).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { employment, payPeriod, payrollBatch, payslip, person } from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
import { MY_STATUTORY_VERSION } from '../localization/my/statutory-tables';
import {
  PAYROLL_HISTORY_COLUMNS,
  type PayrollHistoryRecord,
  type HistoryRowResult,
  type HistoryImportPreview,
  type HistoryImportResult,
} from '../lib/payroll-history-import-schema';

export { PAYROLL_HISTORY_COLUMNS };
export type { PayrollHistoryRecord, HistoryRowResult, HistoryImportPreview, HistoryImportResult };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONEY_TOL = 0.02;

const norm = (s: string | undefined) => (s ?? '').trim();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Statutory blob stored on each imported payslip (file scalars, verbatim) + provenance version. */
type ImportedStat = {
  epfEmployee: number;
  epfEmployer: number;
  socsoEmployee: number;
  socsoEmployer: number;
  socsoSkbbk: number;
  eisEmployee: number;
  eisEmployer: number;
  pcb: number;
  lp: number;
  zakat: number;
  version: string;
};

type ResolvedRow = {
  result: HistoryRowResult;
  employmentId: string;
  period: string;
  // payslip scalars (verbatim from the file)
  basicSalary: number;
  allowance: number;
  overtimePay: number;
  bonus: number;
  grossPay: number;
  otherDeductions: number;
  totalDeductions: number;
  netPay: number;
  employerCost: number;
  statutory: ImportedStat;
};

/** Parse a money cell, stripping thousands separators. Returns NaN on non-numeric (caller errors). */
function money(raw: string | undefined): number {
  const s = norm(raw).replace(/[,_]/g, '');
  if (s === '') return 0;
  return Number(s);
}

/**
 * Read the company employments + the existing-batch period set once, then validate every record in
 * memory (RLS-scoped reads only; writes nothing). Returns the preview + the resolved rows the commit
 * path replays. PRIVATE — the two public exports are the only surface.
 */
async function analyze(
  ctx: SessionContext,
  companyId: string,
  records: PayrollHistoryRecord[],
): Promise<{ preview: HistoryImportPreview; resolved: ResolvedRow[] }> {
  const { byEmail, occupiedPeriods } = await withTenant(ctx, async (tx) => {
    const emps = await tx
      .select({ employmentId: employment.id, email: person.primaryEmail, code: employment.employeeCode })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.companyId, companyId));
    const periods = [...new Set(records.map((r) => norm(r.period)).filter((p) => PERIOD_RE.test(p)))];
    // Which of the file's periods already have ANY batch (the period-level skip set).
    const existing = periods.length
      ? await tx
          .select({ period: payrollBatch.payPeriod })
          .from(payrollBatch)
          .where(and(eq(payrollBatch.companyId, companyId), inArray(payrollBatch.payPeriod, periods)))
      : [];
    return {
      byEmail: new Map(emps.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e])),
      occupiedPeriods: new Set(existing.map((e) => e.period)),
    };
  });

  const presentColumns = new Set(records.length ? Object.keys(records[0]) : []);
  const missingColumns = PAYROLL_HISTORY_COLUMNS.required.filter((c) => !presentColumns.has(c));

  // (email, period) duplicate detection within the file.
  const seen = new Set<string>();
  const resolved: ResolvedRow[] = [];

  records.forEach((rec, idx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const email = norm(rec.email);
    const period = norm(rec.period);

    // Email → employment (the canonical resolution path).
    let employmentId = '';
    if (!email) errors.push('Missing email');
    else if (!EMAIL_RE.test(email)) errors.push(`Invalid email "${email}"`);
    else {
      const emp = byEmail.get(email.toLowerCase());
      if (!emp) errors.push(`Unknown employee "${email}"`);
      else {
        employmentId = emp.employmentId;
        // employee_code is a secondary disambiguator only — warn on mismatch, never block.
        const code = norm(rec.employee_code);
        if (code && emp.code && code.toLowerCase() !== emp.code.toLowerCase()) {
          warnings.push(`employee_code "${code}" does not match "${emp.code}" — matched by email`);
        }
      }
    }

    // Period format.
    if (!period) errors.push('Missing period');
    else if (!PERIOD_RE.test(period)) errors.push(`period must be YYYY-MM (got "${period}")`);

    // Money fields: every required+optional money column must be numeric ≥ 0 when present.
    const moneyCols = [
      'basic_salary', 'gross_pay', 'epf_employee', 'epf_employer', 'socso_employee',
      'socso_employer', 'eis_employee', 'eis_employer', 'pcb', 'net_pay',
      'allowance', 'overtime_pay', 'bonus', 'socso_skbbk', 'lp', 'zakat',
      'other_deductions', 'employer_cost', 'total_deductions',
    ];
    for (const col of moneyCols) {
      const raw = norm(rec[col]);
      if (raw === '') {
        if (PAYROLL_HISTORY_COLUMNS.required.includes(col as never)) errors.push(`Missing ${col}`);
        continue;
      }
      const v = money(raw);
      if (!Number.isFinite(v) || v < 0) errors.push(`Invalid ${col} "${rec[col]}"`);
    }

    const basicSalary = money(rec.basic_salary);
    const allowance = money(rec.allowance);
    const overtimePay = money(rec.overtime_pay);
    const bonus = money(rec.bonus);
    const grossPay = money(rec.gross_pay);
    const epfEmployee = money(rec.epf_employee);
    const epfEmployer = money(rec.epf_employer);
    const socsoEmployee = money(rec.socso_employee);
    const socsoEmployer = money(rec.socso_employer);
    const socsoSkbbk = money(rec.socso_skbbk);
    const eisEmployee = money(rec.eis_employee);
    const eisEmployer = money(rec.eis_employer);
    const pcb = money(rec.pcb);
    const lp = money(rec.lp);
    const zakat = money(rec.zakat);
    const otherDeductions = money(rec.other_deductions);
    const netPay = money(rec.net_pay);
    const employerCostRaw = norm(rec.employer_cost);

    // Net-pay arithmetic: gross − (employee deductions) ≈ net (verbatim figures, just consistency).
    if (errors.length === 0) {
      const eeDeductions = epfEmployee + socsoEmployee + socsoSkbbk + eisEmployee + pcb + otherDeductions;
      const expectedNet = round2(grossPay - eeDeductions);
      if (Math.abs(expectedNet - netPay) > MONEY_TOL) {
        errors.push(`net_pay ${netPay.toFixed(2)} ≠ gross − deductions ${expectedNet.toFixed(2)}`);
      }
      // Employer-cost consistency (warning — HRDF / other employer adds vary).
      if (employerCostRaw !== '') {
        const expectedCost = round2(grossPay + epfEmployer + socsoEmployer + eisEmployer);
        if (Math.abs(expectedCost - money(employerCostRaw)) > MONEY_TOL) {
          warnings.push(`employer_cost differs from gross + employer contributions (${expectedCost.toFixed(2)})`);
        }
      }
      // EA-breakdown warning: gross > basic but no allowance/overtime/bonus ⇒ the EA line-item
      // breakdown will land entirely in "basic".
      if (grossPay > basicSalary + MONEY_TOL && allowance + overtimePay + bonus <= MONEY_TOL) {
        warnings.push('gross exceeds basic but allowance/overtime/bonus are 0 — EA breakdown lands entirely in basic');
      }
    }

    // Duplicate (email, period) in-file.
    const dupKey = `${email.toLowerCase()}|${period}`;
    if (email && period && errors.length === 0) {
      if (seen.has(dupKey)) errors.push('Duplicate (email, period) in this file');
      else seen.add(dupKey);
    }

    // Period-level skip: the period already has a batch (the double-count trap) ⇒ skip every row for it.
    const skipped = errors.length === 0 && PERIOD_RE.test(period) && occupiedPeriods.has(period);
    if (skipped) warnings.push('period already has payroll — skipped');

    const ok = errors.length === 0 && !skipped;
    const result: HistoryRowResult = { rowNum: idx + 1, email, period, ok, skipped, errors, warnings };
    resolved.push({
      result,
      employmentId,
      period,
      basicSalary,
      allowance,
      overtimePay,
      bonus,
      grossPay,
      otherDeductions,
      totalDeductions: norm(rec.total_deductions) !== '' ? money(rec.total_deductions) : round2(grossPay - netPay),
      netPay,
      employerCost: employerCostRaw !== '' ? money(employerCostRaw) : round2(grossPay + epfEmployer + socsoEmployer + eisEmployer),
      statutory: {
        epfEmployee, epfEmployer, socsoEmployee, socsoEmployer, socsoSkbbk,
        eisEmployee, eisEmployer, pcb, lp, zakat, version: MY_STATUTORY_VERSION,
      },
    });
  });

  const preview: HistoryImportPreview = {
    companyId,
    total: records.length,
    validCount: resolved.filter((r) => r.result.ok).length,
    skippedCount: resolved.filter((r) => r.result.skipped).length,
    rows: resolved.map((r) => r.result),
    missingColumns,
  };
  return { preview, resolved };
}

/** Dry run: validate the records against the company + existing batches; writes nothing. */
export async function validatePayrollHistoryImport(
  ctx: SessionContext,
  p: { companyId: string; records: PayrollHistoryRecord[] },
): Promise<HistoryImportPreview> {
  const { preview } = await analyze(ctx, p.companyId, p.records);
  return preview;
}

/**
 * Commit the valid rows. Re-analyzes server-side (never trusts a client preview), groups valid rows by
 * period, and writes EACH period in its OWN transaction (per decision: a shared tx aborts on first
 * failed insert). Each period: find-or-create pay_period → insert draft batch (run_type='adjustment')
 * → insert one payslip per row → UPDATE batch counters → UPDATE batch status='closed' → UPDATE
 * pay_period status='closed'. A failing period collects into `failed` without stranding the rest.
 */
export async function commitPayrollHistoryImport(
  ctx: SessionContext,
  p: { companyId: string; records: PayrollHistoryRecord[] },
): Promise<HistoryImportResult> {
  const { resolved } = await analyze(ctx, p.companyId, p.records);
  const valid = resolved.filter((r) => r.result.ok);
  const skipped = resolved.filter((r) => r.result.skipped).length;
  const failed: HistoryImportResult['failed'] = [];
  let imported = 0;

  // Group valid rows by period — one batch per (company, period).
  const byPeriod = new Map<string, ResolvedRow[]>();
  for (const r of valid) {
    const arr = byPeriod.get(r.period) ?? [];
    arr.push(r);
    byPeriod.set(r.period, arr);
  }

  for (const [period, rows] of byPeriod) {
    try {
      await withTenant(ctx, async (tx) => {
        // Find-or-create the pay_period parent (mirror createBatch). Status starts 'open' here; it is
        // flipped to 'closed' below within the same tx.
        const [existingPeriod] = await tx
          .select({ id: payPeriod.id })
          .from(payPeriod)
          .where(and(eq(payPeriod.companyId, p.companyId), eq(payPeriod.period, period)))
          .limit(1);
        let periodId = existingPeriod?.id;
        if (!periodId) {
          const [created] = await tx
            .insert(payPeriod)
            .values({ tenantId: ctx.tenantId, companyId: p.companyId, period, status: 'open', statutoryVersion: MY_STATUTORY_VERSION })
            .returning({ id: payPeriod.id });
          periodId = created.id;
        }

        // Insert the historical batch as a DRAFT adjustment run (so counters are backfillable, and it
        // never collides with payroll_batch_one_regular_uq).
        const [batch] = await tx
          .insert(payrollBatch)
          .values({
            tenantId: ctx.tenantId,
            companyId: p.companyId,
            payPeriodId: periodId,
            runSeq: 1,
            runType: 'adjustment',
            payPeriod: period,
            batchDate: `${period}-28`,
            status: 'draft',
            remarks: 'Imported payroll history',
          })
          .returning({ id: payrollBatch.id });

        // Insert one payslip per row (file scalars + full statutory blob).
        const totals = { gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0 };
        for (const r of rows) {
          await tx.insert(payslip).values({
            tenantId: ctx.tenantId,
            batchId: batch.id,
            employmentId: r.employmentId,
            basicSalary: r.basicSalary.toFixed(2),
            allowance: r.allowance.toFixed(2),
            overtimePay: r.overtimePay.toFixed(2),
            bonus: r.bonus.toFixed(2),
            grossPay: r.grossPay.toFixed(2),
            statutory: r.statutory,
            otherDeductions: r.otherDeductions.toFixed(2),
            totalDeductions: r.totalDeductions.toFixed(2),
            netPay: r.netPay.toFixed(2),
            employerCost: r.employerCost.toFixed(2),
          });
          totals.gross = round2(totals.gross + r.grossPay);
          totals.net = round2(totals.net + r.netPay);
          totals.epfEmployee = round2(totals.epfEmployee + r.statutory.epfEmployee);
          totals.epfEmployer = round2(totals.epfEmployer + r.statutory.epfEmployer);
          totals.socsoEmployee = round2(totals.socsoEmployee + r.statutory.socsoEmployee);
          totals.socsoEmployer = round2(totals.socsoEmployer + r.statutory.socsoEmployer);
          totals.eisEmployee = round2(totals.eisEmployee + r.statutory.eisEmployee);
          totals.eisEmployer = round2(totals.eisEmployer + r.statutory.eisEmployer);
          totals.pcb = round2(totals.pcb + r.statutory.pcb);
          imported += 1;
        }

        // Backfill counters while still draft-and-mutable (the 0011 trigger only fires once closed).
        await tx
          .update(payrollBatch)
          .set({ employeeCount: rows.length, totals })
          .where(eq(payrollBatch.id, batch.id));
        // Then flip batch + period to closed (immutability + out of the live draft→process→close UI).
        await tx.update(payrollBatch).set({ status: 'closed' }).where(eq(payrollBatch.id, batch.id));
        await tx.update(payPeriod).set({ status: 'closed' }).where(eq(payPeriod.id, periodId));
      });
    } catch (e) {
      // The whole period failed — none of its rows imported. Undo the optimistic per-row increment.
      imported -= rows.length;
      if (imported < 0) imported = 0;
      for (const r of rows) {
        failed.push({ rowNum: r.result.rowNum, email: r.result.email, period, message: (e as Error).message });
      }
    }
  }

  // Substrate: one completion event summarizes the import (mirrors commitEmployeeImport). Per-payslip /
  // per-batch inserts are intentionally NOT individually evented — they're the body of this one
  // import flow, summarized here (documented skip, consistent with the employee importer).
  await withTenant(ctx, (tx) =>
    appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-history-import',
      aggregateId: p.companyId,
      eventType: 'payroll-history-import.completed',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, imported, failed: failed.length, skipped, periods: [...byPeriod.keys()] },
    }),
  );

  return { companyId: p.companyId, imported, failed, skipped };
}
