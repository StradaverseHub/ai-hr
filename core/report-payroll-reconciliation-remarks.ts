import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { payrollReconciliationRemark as remark } from '../db/schema';
import { MasterReportAccessError } from './employee-master-access';
import { executePayrollComparisonTx, payrollComparisonSpec, type PayrollComparisonExecution } from './report-payroll-comparison';
import { payrollComparisonAccessTx } from './report-payroll-access';
import { DEFAULT_PAYROLL_COMPARISON, validatePayrollComparisonDefinition } from '../lib/payroll-period-comparison';
import type { ComparisonRow } from '../lib/payroll-comparison-result';

function scopeDigest(run: PayrollComparisonExecution, row: ComparisonRow) {
  return createHash('sha256').update(JSON.stringify([row.payItemCode??run.definition.payItemCode,
    run.filters.runType, [...(run.filters.cycleIds ?? [])].sort(), row.currency, ...(run.filters.previousCycleIds?.length?[[...run.filters.previousCycleIds].sort()]:[])])).digest('hex');
}

function keys(run: PayrollComparisonExecution, row: ComparisonRow) {
  return { companyId: row.companyId, employmentId: row.employmentId, previousPeriod: run.filters.previousPeriod!,
    currentPeriod: run.filters.currentPeriod!, scopeDigest: scopeDigest(run, row) };
}

export function builtInPayrollReconciliationSpec(payItemCode: unknown) {
  return payrollComparisonSpec(payItemCode === undefined ? undefined
    : validatePayrollComparisonDefinition({ ...DEFAULT_PAYROLL_COMPARISON, payItemCode }));
}

export async function attachPayrollReconciliationRemarks(tx: Tx, ctx: SessionContext, run: PayrollComparisonExecution) {
  if (!run.result.available || !run.result.rows.length) return;
  const rows = run.result.rows;
  const subjects = [...new Set(rows.map(row => row.employmentId))];
  const scopes = [...new Set(rows.map(row => scopeDigest(run, row)))];
  const current = await tx.selectDistinctOn([remark.companyId, remark.employmentId, remark.scopeDigest], {
    companyId: remark.companyId, employmentId: remark.employmentId, scopeDigest: remark.scopeDigest,
    body: remark.body, revision: remark.revision,
  }).from(remark).where(and(eq(remark.tenantId, ctx.tenantId), inArray(remark.companyId, run.companyIds),
    inArray(remark.employmentId, subjects), inArray(remark.scopeDigest, scopes),
    eq(remark.previousPeriod, run.filters.previousPeriod!), eq(remark.currentPeriod, run.filters.currentPeriod!)))
    .orderBy(remark.companyId, remark.employmentId, remark.scopeDigest, desc(remark.revision));
  const id = (row: { companyId: string; employmentId: string; scopeDigest: string }) => [row.companyId, row.employmentId, row.scopeDigest].join(':');
  const byRow = new Map(current.map(row => [id(row), row]));
  for (const row of rows) {
    const match = byRow.get(id(keys(run, row)));
    if (match) row.hrRemark = { body: match.body, revision: match.revision };
  }
}

export class PayrollReconciliationRemarkConflict extends Error {}

export async function savePayrollReconciliationRemark(ctx: SessionContext, scope: readonly string[], input: {
  filters: Record<string, unknown>; companyId: string; employmentId: string; currency: string | null; rowPayItem?: string; revision: number; body: string;
}) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!ctx.userId || !scope.includes(input.companyId) || !uuid.test(input.employmentId) ||
    !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= 2147483647 || input.body.length > 1000)
    throw new MasterReportAccessError();
  const { payItemCode, ...filters } = input.filters;
  const spec = builtInPayrollReconciliationSpec(payItemCode);
  await withTenant(ctx, async tx => {
    await payrollComparisonAccessTx(tx, ctx, spec, 'edit', [input.companyId]);
    const run = await executePayrollComparisonTx(tx, ctx, spec, scope, filters, 'view');
    const row = run.result.available && run.result.rows.find(row => row.companyId === input.companyId &&
      row.employmentId === input.employmentId && row.currency === input.currency && row.payItemCode === input.rowPayItem);
    if (!row) throw new MasterReportAccessError();
    const key = keys(run, row);
    const lock = JSON.stringify(['payroll-reconciliation-remark', ctx.tenantId, key]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
    const [latest] = await tx.select({ revision: remark.revision }).from(remark)
      .where(and(eq(remark.tenantId, ctx.tenantId), eq(remark.companyId, key.companyId), eq(remark.employmentId, key.employmentId),
        eq(remark.previousPeriod, key.previousPeriod), eq(remark.currentPeriod, key.currentPeriod), eq(remark.scopeDigest, key.scopeDigest)))
      .orderBy(desc(remark.revision)).limit(1);
    if ((latest?.revision ?? 0) !== input.revision) throw new PayrollReconciliationRemarkConflict();
    if (!latest && !input.body.trim()) return;
    await tx.insert(remark).values({ ...key, tenantId: ctx.tenantId, actorUserId: ctx.userId!,
      revision: input.revision + 1, body: input.body.trim() });
  });
}
