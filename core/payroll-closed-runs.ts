import { and, eq, inArray } from 'drizzle-orm';
import { type Tx } from '../db/client';
import { companyPayrollConfig, payrollBatch, payslip } from '../db/schema';
import { resolveAssignedPolicy } from './payroll-policy';
import { cutOffWindowFor, type CompanyCutOffConfig } from './payroll-policy-config';

/**
 * r424 (50ed39e1) — the CLOSED sibling of `batchesCoveringAttendanceDates` (core/payroll.ts), with the same
 * ownership test: a payslip on the run AND the date inside that employment's attendance cut-off window. A
 * clocking import must not add to a day a closed run has already paid — a closed run cannot be written or
 * marked — so the import refuses that day and lists its lines instead. Read-only; no DomainEvent.
 *
 * A separate module rather than a parameter on the processed read: core/payroll.ts is pinned byte-identical
 * by the r415 EA guard, and only the company cut-off DAYS are needed here (the attendance window reads the
 * employment's assigned policy, then those days), so the private loadBatchCutOffSchedule is not required.
 * `entries` names the exact (employment, date) pairs each run owns, because the import refuses per DAY.
 */
export async function closedBatchesCoveringAttendanceDates(
  tx: Tx,
  p: { companyId: string; entries: { employmentId: string; date: string }[] },
): Promise<{ batchId: string; payPeriod: string; batchDate: string; employmentIds: string[]; entries: { employmentId: string; date: string }[] }[]> {
  if (p.entries.length === 0) return [];
  const batches = await tx
    .select({ id: payrollBatch.id, payPeriod: payrollBatch.payPeriod, batchDate: payrollBatch.batchDate })
    .from(payrollBatch)
    .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.status, 'closed')))
    .orderBy(payrollBatch.payPeriod);
  if (batches.length === 0) return [];
  const slips = await tx
    .select({ batchId: payslip.batchId, employmentId: payslip.employmentId })
    .from(payslip)
    .where(inArray(payslip.batchId, batches.map((b) => b.id)));
  const onRun = new Set(slips.map((s) => `${s.batchId}|${s.employmentId}`));
  const [cpc] = await tx
    .select({
      cutOffDay: companyPayrollConfig.cutOffDay,
      overtimeCutOffDay: companyPayrollConfig.overtimeCutOffDay,
      claimCutOffDay: companyPayrollConfig.claimCutOffDay,
      unpaidLeaveCutOffDay: companyPayrollConfig.unpaidLeaveCutOffDay,
      attendanceCutOffDay: companyPayrollConfig.attendanceCutOffDay,
    })
    .from(companyPayrollConfig)
    .where(eq(companyPayrollConfig.companyId, p.companyId))
    .limit(1);
  const companyCfg: CompanyCutOffConfig | null = cpc ?? null;
  const windows = new Map<string, { start: string; end: string }>();
  const windowFor = async (employmentId: string, payPeriod: string) => {
    const key = `${employmentId}|${payPeriod}`;
    const hit = windows.get(key);
    if (hit) return hit;
    const cfg = (await resolveAssignedPolicy(tx, employmentId))?.config ?? null;
    const w = cutOffWindowFor('attendance', cfg, companyCfg, payPeriod);
    windows.set(key, w);
    return w;
  };
  const out: { batchId: string; payPeriod: string; batchDate: string; employmentIds: string[]; entries: { employmentId: string; date: string }[] }[] = [];
  for (const b of batches) {
    const hit = new Set<string>();
    const entries: { employmentId: string; date: string }[] = [];
    for (const e of p.entries) {
      if (!onRun.has(`${b.id}|${e.employmentId}`)) continue;
      const w = await windowFor(e.employmentId, b.payPeriod);
      if (e.date >= w.start && e.date <= w.end) {
        hit.add(e.employmentId);
        entries.push(e);
      }
    }
    if (hit.size > 0) out.push({ batchId: b.id, payPeriod: b.payPeriod, batchDate: b.batchDate, employmentIds: [...hit].sort(), entries });
  }
  return out;
}
