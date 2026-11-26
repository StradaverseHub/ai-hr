/**
 * Board 016276b7 — employees HELD FOR INCOME TAX REVIEW during payroll processing.
 *
 * Before this, one employee whose historical tax inputs could not be read (an imported month that still needs review in
 * Recalculate Income Tax Value, or saved history that changed) threw from the processing chunk's history read, the job
 * failed and the whole company's run was discarded. Now each processing chunk asks the SAME historical tax-basis reader,
 * with the SAME options and the SAME source rows its payslip calculation is about to read, which of its employees cannot
 * be calculated, and leaves exactly those out of the run. Everyone else is calculated as before.
 *
 * What does NOT change: the hold criteria (this reads the reader's own failure set and decides nothing itself), the
 * statutory engine, and every other refusal (any other error still fails and discards the whole run). A held employee
 * gets no payslip, their claims and loan reservations stay attached to the run (core/payroll.ts completeFullGenerationTx),
 * and the existing selective reprocess adds them to the same run once their history is corrected.
 *
 * The durable record is the run's `payroll-batch.processed` event (`taxHeld`). The live list is that record intersected
 * with the employees who are still eligible and still have no payslip on the run (the same source that holds Close shut).
 */
import {and, asc, eq, inArray, like, lt, max, sql, type SQL} from 'drizzle-orm';
import type {SessionContext, Tx} from '../db/client';
import {domainEvent, employment, payrollBatch, payrollEmployeeResultHistory, payrollStatusHistory, payslip, person} from '../db/schema';
import {groupTaxHoldsTx} from './payroll-group-tax-opening';
import {outstandingPaymentPredicate} from './payroll-employment-eligibility';
import {readTaxBasisFailureDetailsTx} from './payroll-tax-basis-read';

/** One held employee, as the processing chunk recorded it. `reason` is the tax-basis reader's own message. */
export type TaxHeldEmployee = {employmentId: string; period: string; reason: string};

/** Bound on the stored reason text: the reader's messages are short, fixed sentences; this only caps a surprise. */
const REASON_MAX = 400;

type HoldRun = {id: string; companyId: string; payPeriod: string; payPeriodId: string; runType: string; runSeq: number; payrollCycleId?: string | null};

/**
 * Which of a processing chunk's employees cannot have their historical tax inputs read. Mirrors the two reads
 * generatePayslipsTx makes for the chunk (core/payroll.ts — the prior-month prefix with imported sources, and, when the
 * run is additional, restates the month or pays an outstanding amount, the month's earlier runs). Bounded by the chunk.
 */
export async function processingTaxHoldsTx(
  tx: Tx, ctx: SessionContext, run: HoldRun, employmentIds: readonly string[], individualTxnPay: boolean,
): Promise<Map<string, TaxHeldEmployee>> {
  const held = new Map<string, TaxHeldEmployee>();
  if (employmentIds.length === 0) return held;
  const ids = [...employmentIds];
  const year = run.payPeriod.slice(0, 4);
  const prior = await tx.select({id: payslip.id}).from(payslip)
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(and(inArray(payslip.employmentId, ids), eq(payrollBatch.companyId, run.companyId),
      like(payrollBatch.payPeriod, `${year}-%`), lt(payrollBatch.payPeriod, run.payPeriod)));
  const record = (failures: Map<string, {reason: string; period: string}>) => {
    for (const [employmentId, f] of failures) {
      if (!held.has(employmentId)) held.set(employmentId, {employmentId, period: f.period, reason: f.reason.slice(0, REASON_MAX)});
    }
  };
  if (prior.length) record(await readTaxBasisFailureDetailsTx(tx, ctx, prior.map(r => r.id), {includeImported: true}));

  // The chunk reads the month's earlier runs for all of its employees when the run is additional, restates the month,
  // or any of them is paid an outstanding amount — the same condition, asked over the same employees.
  let sameMonth = run.runType !== 'regular' || run.runSeq > 1;
  if (!sameMonth && individualTxnPay) {
    const outstanding = await tx.select({id: employment.id}).from(employment)
      .where(and(inArray(employment.id, ids), outstandingPaymentPredicate(run, true))).limit(1);
    sameMonth = outstanding.length > 0;
  }
  if (sameMonth) {
    const earlier = await tx.select({id: payslip.id}).from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(and(inArray(payslip.employmentId, ids), eq(payrollBatch.companyId, run.companyId),
        eq(payrollBatch.payPeriodId, run.payPeriodId), lt(payrollBatch.runSeq, run.runSeq)));
    if (earlier.length) record(await readTaxBasisFailureDetailsTx(tx, ctx, earlier.map(r => r.id), {includeImported: true, sameMonth: true}));
  }
  // Board 4ce2c481 — the group opening the chunk's calculation reads (the same person's earlier months this year at the
  // group's other companies), asked through the same reader with the same arguments (core/payroll-group-tax-opening.ts).
  // A contributing month without a usable tax basis, or a TP3 that lists a group company together with an outside
  // employer, holds the employee with the month named.
  for (const [employmentId, hold] of await groupTaxHoldsTx(tx, run.companyId, run.payPeriod, ids)) {
    if (!held.has(employmentId)) held.set(employmentId, {employmentId, period: hold.period, reason: hold.reason.slice(0, REASON_MAX)});
  }
  return held;
}

/** The held list carried on a `payroll-batch.processed` payload, validated (an older event simply has none). */
export function taxHeldFromPayload(payload: unknown): TaxHeldEmployee[] {
  const raw = (payload as {taxHeld?: unknown} | null)?.taxHeld;
  if (!Array.isArray(raw)) return [];
  const out: TaxHeldEmployee[] = [];
  for (const r of raw) {
    const row = r as Partial<TaxHeldEmployee> | null;
    if (typeof row?.employmentId === 'string' && typeof row.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.period)) {
      out.push({employmentId: row.employmentId, period: row.period, reason: typeof row.reason === 'string' ? row.reason : ''});
    }
  }
  return out;
}

/** A held employee of one run, named for the screens, with whether they are still outstanding on it. */
export type TaxHeldEmployeeRow = TaxHeldEmployee & {
  batchId: string; employeeCode: string | null; name: string;
  /** Still owed on this run: no payslip on it yet and not removed from it since its latest reset. */
  outstanding: boolean;
};

/**
 * The employees each run held for income tax review, from the run's LATEST `payroll-batch.processed` event (a reset and
 * re-process writes a new one, which is the one that describes the current payslips), with whether each is still
 * outstanding. Set-based over the given runs; read-only.
 *
 * DEGRADES, NEVER FLIPS (the same rule as listSkippedEmployees): that event carries no subject employment, so under
 * ADR-0015 a reader who may not read it gets no rows. Callers treat "no rows" as "nothing to show", never as a pass for a
 * control — Close keeps its own payslip-less gate on a regular run whatever this returns.
 */
export async function taxHeldRowsTx(tx: Tx, batchIds: readonly string[]): Promise<TaxHeldEmployeeRow[]> {
  if (batchIds.length === 0) return [];
  const ids = [...new Set(batchIds)];
  const events = await tx.select({batchId: domainEvent.aggregateId, payload: domainEvent.payload}).from(domainEvent)
    .where(and(eq(domainEvent.aggregateType, 'payroll-batch'), eq(domainEvent.eventType, 'payroll-batch.processed'), inArray(domainEvent.aggregateId, ids)))
    .orderBy(asc(domainEvent.occurredAt), asc(domainEvent.id));
  const latest = new Map<string, unknown>();
  for (const e of events) latest.set(e.batchId, e.payload);
  const held = [...latest].flatMap(([batchId, payload]) => taxHeldFromPayload(payload).map(h => ({...h, batchId})));
  if (held.length === 0) return [];
  const heldBatchIds = [...new Set(held.map(h => h.batchId))];
  const employmentIds = [...new Set(held.map(h => h.employmentId))];
  // One transaction, one connection: sequential reads (a pipelined Promise.all buys nothing here).
  const slips = await tx.select({batchId: payslip.batchId, employmentId: payslip.employmentId}).from(payslip)
    .where(and(inArray(payslip.batchId, heldBatchIds), inArray(payslip.employmentId, employmentIds)));
  const resets = await tx.select({batchId: payrollStatusHistory.batchId, at: max(payrollStatusHistory.createdAt)}).from(payrollStatusHistory)
    .where(and(inArray(payrollStatusHistory.batchId, heldBatchIds), eq(payrollStatusHistory.action, 'rollback')))
    .groupBy(payrollStatusHistory.batchId);
  const removals = await tx.select({batchId: payrollEmployeeResultHistory.batchId, employmentId: payrollEmployeeResultHistory.employmentId, at: payrollEmployeeResultHistory.createdAt})
    .from(payrollEmployeeResultHistory)
    .where(and(inArray(payrollEmployeeResultHistory.batchId, heldBatchIds), inArray(payrollEmployeeResultHistory.employmentId, employmentIds),
      eq(payrollEmployeeResultHistory.action, 'remove')));
  const named = await tx.select({id: employment.id, employeeCode: employment.employeeCode, name: person.fullName}).from(employment)
    .innerJoin(person, eq(person.id, employment.personId)).where(inArray(employment.id, employmentIds));
  const key = (batchId: string, employmentId: string) => batchId + ':' + employmentId;
  const paid = new Set(slips.map(r => key(r.batchId, r.employmentId)));
  const resetAt = new Map(resets.map(r => [r.batchId, r.at ? new Date(r.at).getTime() : null]));
  const removed = new Set(removals.filter(r => {
    const at = resetAt.get(r.batchId);
    return at == null || new Date(r.at).getTime() > at;
  }).map(r => key(r.batchId, r.employmentId)));
  const byId = new Map(named.map(r => [r.id, r]));
  return held.map(h => ({
    ...h,
    // A row the reader cannot see keeps its place (the count came from the run), named by its id.
    employeeCode: byId.get(h.employmentId)?.employeeCode ?? null,
    name: byId.get(h.employmentId)?.name ?? h.employmentId,
    outstanding: !paid.has(key(h.batchId, h.employmentId)) && !removed.has(key(h.batchId, h.employmentId)),
  }));
}

/** The run outcome with each processed company's held count filled from the run's own event where the outcome lacks it
 * (a run group's narrowed job projection does not carry it). Pure. */
export function heldCountsByBatch(rows: readonly TaxHeldEmployeeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.batchId, (out.get(r.batchId) ?? 0) + 1);
  return out;
}

/**
 * a1a80747 r3 — WHO IS SKIPPED FOR INCOME TAX ON EACH OF THE GIVEN RUNS, as ONE SQL relation (batch_id uuid, eid text),
 * for the Reprocess screen's Skipped tab and the Payroll Process list's "held for income tax review" line.
 *
 * Two kinds of record say an employee is skipped for income tax on a run, and the LATEST one per employee wins:
 *   - the run's latest `payroll-batch.processed` event lists them in `taxHeld` (016276b7: processing held them);
 *   - a `payroll-batch.employee-reprocess-outcome` event written after it says `skipped` with TAX_RECALC_REQUIRED or
 *     TAX_RECALC_IN_PROGRESS (a1a80747: a Reprocess's own tax readiness check skipped them).
 * Any later outcome for the same employee (reprocessed, failed, excluded, nothing payable) ends the skip; a reset and
 * re-process writes a new processed event, which starts the record again. The relation says nothing about whether the
 * employee is still owed on the run: callers intersect it with their own owed set (the Close rule).
 *
 * Set-based over the runs (domain_event_aggregate_idx), no per-run work. Row security decides what is read: the processed
 * event has no subject employment (admin-only, ADR-0015), so a reader who may not read it sees no processing holds and
 * the employee simply stays counted as outstanding. It degrades to "not skipped", never to "nothing owed".
 */
export const TAX_SKIP_REASON_CODES = ['TAX_RECALC_REQUIRED', 'TAX_RECALC_IN_PROGRESS'] as const;
export function runTaxSkippedSql(runIds: SQL): SQL {
  return sql`(
   with tsk_processed as (
    select distinct on (e.aggregate_id) e.aggregate_id as batch_id,e.occurred_at,e.id,e.payload
    from ${domainEvent} e
    where e.aggregate_type='payroll-batch' and e.event_type='payroll-batch.processed' and e.aggregate_id in (${runIds})
    order by e.aggregate_id,e.occurred_at desc,e.id desc),
   tsk_signals as (
    select p.batch_id,h->>'employmentId' as eid,p.occurred_at as at,0 as rank,true as held
    from tsk_processed p
    cross join lateral jsonb_array_elements(case when jsonb_typeof(p.payload->'taxHeld')='array' then p.payload->'taxHeld' else '[]'::jsonb end) h
    where jsonb_typeof(h)='object' and length(coalesce(h->>'employmentId',''))>0
    union all
    select e.aggregate_id,e.subject_employment_id::text,e.occurred_at,1,
     (e.payload->>'status'='skipped' and e.payload->>'reasonCode' in ('TAX_RECALC_REQUIRED','TAX_RECALC_IN_PROGRESS'))
    from ${domainEvent} e join tsk_processed p on p.batch_id=e.aggregate_id
    where e.aggregate_type='payroll-batch' and e.event_type='payroll-batch.employee-reprocess-outcome'
     and e.subject_employment_id is not null and e.occurred_at>=p.occurred_at),
   tsk_latest as (
    select distinct on (batch_id,eid) batch_id,eid,held from tsk_signals order by batch_id,eid,at desc,rank desc)
   select batch_id,eid from tsk_latest where held)`;
}

/** a1a80747 r3 — the employments skipped for income tax on ONE run (see `runTaxSkippedSql`), not yet narrowed to owed. */
export async function runTaxSkippedIdsTx(tx: Tx, batchId: string): Promise<Set<string>> {
  const rows = await tx.execute<{eid: string}>(sql`select t.eid from ${runTaxSkippedSql(sql`${batchId}::uuid`)} t`);
  return new Set(rows.map((r) => r.eid));
}
