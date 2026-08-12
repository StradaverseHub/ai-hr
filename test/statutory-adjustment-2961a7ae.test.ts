/**
 * Feedback 2961a7ae — Payroll : Statutory Adjustment with full manual override.
 *
 * EVERY MONEY ASSERTION IS ON A GENERATED, STORED PAYSLIP. A row-shape assertion would prove the row was
 * written and nothing about what anyone is paid, which is how a double-pay bug shipped here before.
 *
 * The load-bearing design decision under test: the override is stored as an INPUT (a row the generator
 * reads), not as a result stamped onto the payslip. A stamped result would be destroyed by the next
 * reprocess, and this reporter reprocesses constantly — their 2026-01 run was reprocessed twice in one
 * month. Idempotence across a reprocess is therefore the first thing proven.
 *
 * MEASURED READ-ONLY ON PRODUCTION 2026-08-12 — A0013 / 2026-01, the worked example in the mock-up:
 *   gross 7552.00 · total_deductions 1476.30 · net 6075.70 · employer_cost 8640.57
 *   epfEmployee 836 · epfEmployer 912 · socsoEmployee 29.75 · socsoEmployer 104.15 · socsoSkbbk 0
 *   eisEmployee 11.9 · eisEmployer 11.9 · pcb 429.05 · hrdf 60.52
 * (Those EPF figures are the PRE-r187 ones; item 017d9c25 in this same round moves them to 660/720. The
 * fixture below therefore pins its own arithmetic rather than re-asserting the stale production pair.)
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  applyStatutoryAdjustment,
  createBatch,
  generatePayslips,
  getStatutoryAdjustmentDetail,
  listAdjustableBatches,
  listAdjustmentEmployees,
  parseAdjustmentAmount,
  previewStatutoryAdjustment,
  revertStatutoryAdjustment,
  saveStatutoryAdjustment,
  StatutoryAdjustmentAmountInvalidError,
  StatutoryAdjustmentBatchNotOpenError,
  StatutoryAdjustmentNotFoundError,
  StatutoryAdjustmentReasonRequiredError,
  STATUTORY_ADJUSTMENT_LINES,
} from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
let a: SessionContext;

async function hire(email: string, ic: string, basic = 5000) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  return e;
}

async function slipOf(batchId: string, employmentId: string) {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((r) => r.employmentId === employmentId)!;
}
const adjRowOf = async (batchId: string, employmentId: string) =>
  (
    await owner.db
      .select()
      .from(schema.payrollStatutoryAdjustment)
      .where(eq(schema.payrollStatutoryAdjustment.batchId, batchId))
  ).find((r) => r.employmentId === employmentId) ?? null;

type Stat = Record<string, number> & { adjustment?: { reason: string; lines: Record<string, { system: number; applied: number }> } };
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;

/** Process a fresh run for one employee and return the batch id. */
async function processedRun(employmentId: string, payPeriod = '2026-03') {
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod });
  await generatePayslips(a, { batchId });
  const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  expect(b.status).toBe('processed');
  expect(await slipOf(batchId, employmentId)).toBeTruthy();
  return batchId;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

describe('2961a7ae — blank vs zero (pure)', () => {
  it('parseAdjustmentAmount: blank is null, "0" is 0, negative is refused', () => {
    expect(parseAdjustmentAmount('', 'pcb')).toBeNull();
    expect(parseAdjustmentAmount('   ', 'pcb')).toBeNull();
    expect(parseAdjustmentAmount(undefined, 'pcb')).toBeNull();
    expect(parseAdjustmentAmount('0', 'pcb')).toBe(0);
    expect(parseAdjustmentAmount('0.00', 'pcb')).toBe(0);
    expect(parseAdjustmentAmount('300.50', 'pcb')).toBe(300.5);
    // Identity, not just "it threw": rejects.toThrow() passes on the WRONG throw.
    const err = (() => { try { parseAdjustmentAmount('-1', 'pcb'); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(StatutoryAdjustmentAmountInvalidError);
    expect((err as StatutoryAdjustmentAmountInvalidError).line).toBe('pcb');
  });

  it('applyStatutoryAdjustment returns the SAME object when there is no override', () => {
    const computed = { pcb: 250, epfEmployee: 550 };
    expect(applyStatutoryAdjustment(computed, null)).toBe(computed);
    // An override set with every line blank is also a no-op — blank means "keep the system figure".
    expect(applyStatutoryAdjustment(computed, { values: { pcb: null, epfEmployee: null }, reason: 'x' })).toBe(computed);
  });

  it('applyStatutoryAdjustment keeps the three values: system, applied, reason', () => {
    const out = applyStatutoryAdjustment(
      { pcb: 250, epfEmployee: 550, epfEmployer: 650 },
      { values: { pcb: 0, epfEmployee: null, epfEmployer: 700 }, reason: 'EPF office confirmation' },
    );
    expect(out.pcb).toBe(0); // zero IS an override
    expect(out.epfEmployee).toBe(550); // blank left alone
    expect(out.epfEmployer).toBe(700);
    expect(out.adjustment).toEqual({
      reason: 'EPF office confirmation',
      lines: { pcb: { system: 250, applied: 0 }, epfEmployer: { system: 650, applied: 700 } },
    });
  });
});

describe('2961a7ae — the override reaches the payslip, in ringgit', () => {
  it('overriding PCB moves total deductions and net pay by exactly the difference', async () => {
    const e = await hire('pcb@acme.test', '900101015301');
    const batchId = await processedRun(e.employmentId);
    const before = await slipOf(batchId, e.employmentId);
    const systemPcb = Number(statOf(before).pcb);
    const beforeDeductions = Number(before.totalDeductions);
    const beforeNet = Number(before.netPay);

    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: e.employmentId,
      values: { pcb: systemPcb + 50 },
      reason: 'LHDN confirmation letter dated 2026-03-01',
    });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });

    const after = await slipOf(batchId, e.employmentId);
    expect(Number(statOf(after).pcb)).toBeCloseTo(systemPcb + 50, 2);
    expect(Number(after.totalDeductions)).toBeCloseTo(beforeDeductions + 50, 2);
    expect(Number(after.netPay)).toBeCloseTo(beforeNet - 50, 2);
    // Gross never moves — a statutory line is not a gross-pay component.
    expect(Number(after.grossPay)).toBeCloseTo(Number(before.grossPay), 2);
    // The payslip itself carries system → applied → reason.
    expect(statOf(after).adjustment!.lines.pcb).toEqual({ system: systemPcb, applied: systemPcb + 50 });
    expect(statOf(after).adjustment!.reason).toContain('LHDN confirmation');
  });

  it('ZERO is an override, not a blank: EPF employee 550 → 0.00 on the payslip', async () => {
    const e = await hire('zero@acme.test', '900101015302');
    const batchId = await processedRun(e.employmentId);
    const before = await slipOf(batchId, e.employmentId);
    const systemEpf = Number(statOf(before).epfEmployee);
    expect(systemEpf).toBeGreaterThan(0); // the fixture must actually have EPF to zero

    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: e.employmentId,
      values: { epfEmployee: 0 },
      reason: 'KWSP exemption confirmed',
    });
    // The STORED column is 0.00, not NULL — the distinction the whole feature rests on.
    const row = await adjRowOf(batchId, e.employmentId);
    expect(row!.epfEmployee).toBe('0.00');
    expect(row!.pcb).toBeNull(); // an untouched line stays NULL

    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });
    const after = await slipOf(batchId, e.employmentId);
    expect(Number(statOf(after).epfEmployee)).toBe(0);
    expect(Number(after.netPay)).toBeCloseTo(Number(before.netPay) + systemEpf, 2);
  });

  it('an EMPLOYER-side override moves employer cost and leaves net pay untouched to the cent', async () => {
    const e = await hire('er@acme.test', '900101015303');
    const batchId = await processedRun(e.employmentId);
    const before = await slipOf(batchId, e.employmentId);
    const systemEmployer = Number(statOf(before).epfEmployer);

    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: e.employmentId,
      values: { epfEmployer: systemEmployer + 50 },
      reason: 'employer share correction',
    });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });

    const after = await slipOf(batchId, e.employmentId);
    expect(Number(statOf(after).epfEmployer)).toBeCloseTo(systemEmployer + 50, 2);
    expect(Number(after.employerCost)).toBeCloseTo(Number(before.employerCost) + 50, 2);
    expect(Number(after.netPay)).toBeCloseTo(Number(before.netPay), 2);
    expect(Number(after.totalDeductions)).toBeCloseTo(Number(before.totalDeductions), 2);
  });

  it('overriding EPF does NOT re-derive PCB — the no-cascade rule, on the payslip', async () => {
    const e = await hire('cascade@acme.test', '900101015304');
    const batchId = await processedRun(e.employmentId);
    const before = await slipOf(batchId, e.employmentId);
    const systemPcb = Number(statOf(before).pcb);

    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: e.employmentId,
      values: { epfEmployee: 0 },
      reason: 'no cascade check',
    });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });

    const after = await slipOf(batchId, e.employmentId);
    expect(Number(statOf(after).epfEmployee)).toBe(0);
    // PCB is exactly what it was. A quietly-moved figure nobody typed is how a screen like this loses trust.
    expect(Number(statOf(after).pcb)).toBeCloseTo(systemPcb, 2);
  });

  it('multiple lines in one save: the combined effect lands once', async () => {
    const e = await hire('multi@acme.test', '900101015305');
    const batchId = await processedRun(e.employmentId);
    const before = await slipOf(batchId, e.employmentId);
    const st = statOf(before);

    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: e.employmentId,
      values: { pcb: 0, epfEmployee: 100, epfEmployer: 200 },
      reason: 'agency reconciliation',
    });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });

    const after = await slipOf(batchId, e.employmentId);
    const employeeDelta = 0 - Number(st.pcb) + (100 - Number(st.epfEmployee));
    expect(Number(after.totalDeductions)).toBeCloseTo(Number(before.totalDeductions) + employeeDelta, 2);
    expect(Number(after.netPay)).toBeCloseTo(Number(before.netPay) - employeeDelta, 2);
    expect(Number(after.employerCost)).toBeCloseTo(
      Number(before.employerCost) + (200 - Number(st.epfEmployer)),
      2,
    );
  });
});

describe('2961a7ae — it survives a reprocess (the whole reason it is an input)', () => {
  it('generate → adjust → reprocess → reprocess again: still applied, and System Amount is still the computed one', async () => {
    const e = await hire('idem@acme.test', '900101015306');
    const batchId = await processedRun(e.employmentId);
    const systemPcb = Number(statOf(await slipOf(batchId, e.employmentId)).pcb);

    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values: { pcb: 111.11 }, reason: 'r1' });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });
    const v2 = await slipOf(batchId, e.employmentId);
    expect(Number(statOf(v2).pcb)).toBeCloseTo(111.11, 2);

    // A SECOND reprocess would have wiped a stamped result. It does not wipe an input.
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });
    const v3 = await slipOf(batchId, e.employmentId);
    expect(v3.version).toBeGreaterThan(v2.version);
    expect(Number(statOf(v3).pcb)).toBeCloseTo(111.11, 2);
    // "System Amount" is still the COMPUTED figure, not the previously-applied one — the reporter's
    // rule 9 (original / adjustment / final are all retained) has to survive repeated reprocessing.
    expect(statOf(v3).adjustment!.lines.pcb.system).toBeCloseTo(systemPcb, 2);
    const detail = await getStatutoryAdjustmentDetail(a, { batchId, employmentId: e.employmentId });
    expect(detail!.system.pcb).toBeCloseTo(systemPcb, 2);
  });

  it('revert removes the override and the next run brings every line back to the computed figure', async () => {
    const e = await hire('revert@acme.test', '900101015307');
    const batchId = await processedRun(e.employmentId);
    const original = await slipOf(batchId, e.employmentId);
    const st = statOf(original);

    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values: { pcb: 0, epfEmployee: 0 }, reason: 'x' });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });
    expect(Number(statOf(await slipOf(batchId, e.employmentId)).pcb)).toBe(0);

    await revertStatutoryAdjustment(a, { batchId, employmentId: e.employmentId });
    expect(await adjRowOf(batchId, e.employmentId)).toBeNull();
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });

    const after = await slipOf(batchId, e.employmentId);
    for (const k of STATUTORY_ADJUSTMENT_LINES) {
      expect(Number(statOf(after)[k] ?? 0)).toBeCloseTo(Number(st[k] ?? 0), 2);
    }
    expect(Number(after.netPay)).toBeCloseTo(Number(original.netPay), 2);
    expect(Number(after.totalDeductions)).toBeCloseTo(Number(original.totalDeductions), 2);
    expect(statOf(after).adjustment).toBeUndefined();
  });
});

describe('2961a7ae — the preview the Review step shows matches what Apply produces', () => {
  it('previewStatutoryAdjustment predicts deductions, net and employer cost to the cent', async () => {
    const e = await hire('preview@acme.test', '900101015308');
    const batchId = await processedRun(e.employmentId);
    const detail = (await getStatutoryAdjustmentDetail(a, { batchId, employmentId: e.employmentId }))!;
    const before = await slipOf(batchId, e.employmentId);

    const values = { pcb: 0, epfEmployee: 123.45, epfEmployer: 456.78 };
    const p = previewStatutoryAdjustment({
      statutory: before.statutory as Record<string, unknown>,
      grossPay: detail.grossPay,
      totalDeductions: detail.totalDeductions,
      netPay: detail.netPay,
      employerCost: detail.employerCost,
      values,
      employerBears: detail.employerBears,
    });

    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values, reason: 'preview check' });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });
    const after = await slipOf(batchId, e.employmentId);

    expect(Number(after.totalDeductions)).toBeCloseTo(p.deductionsAfter, 2);
    expect(Number(after.netPay)).toBeCloseTo(p.netAfter, 2);
    expect(Number(after.employerCost)).toBeCloseTo(p.employerCostAfter, 2);
    expect(Number(after.grossPay)).toBeCloseTo(p.grossAfter, 2);
    expect(p.grossBefore).toBe(p.grossAfter);
    expect(p.netFloorReached).toBe(false);
  });
});

describe('2961a7ae — the window: processed and not closed', () => {
  it('a DRAFT run is refused, by error identity', async () => {
    const e = await hire('draft@acme.test', '900101015309');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    const err = await saveStatutoryAdjustment(a, {
      batchId, employmentId: e.employmentId, values: { pcb: 10 }, reason: 'x',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(StatutoryAdjustmentBatchNotOpenError);
  });

  it('a CLOSED run is refused BEFORE the trigger fires, by error identity', async () => {
    const e = await hire('closed@acme.test', '900101015310');
    const batchId = await processedRun(e.employmentId);
    // Close it the way the app does not expose here — directly, as the owner, so the guard under test is
    // the SERVICE's, not the trigger's. (0011_payroll_immutability.sql is the backstop behind it.)
    await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));

    const err = await saveStatutoryAdjustment(a, {
      batchId, employmentId: e.employmentId, values: { pcb: 10 }, reason: 'x',
    }).catch((x) => x);
    expect(err).toBeInstanceOf(StatutoryAdjustmentBatchNotOpenError);
    // …and so is revert.
    const err2 = await revertStatutoryAdjustment(a, { batchId, employmentId: e.employmentId }).catch((x) => x);
    expect(err2).toBeInstanceOf(StatutoryAdjustmentBatchNotOpenError);
    // Nothing was written.
    expect(await adjRowOf(batchId, e.employmentId)).toBeNull();
  });

  it('a reason is mandatory, including for an adjustment to zero', async () => {
    const e = await hire('reason@acme.test', '900101015311');
    const batchId = await processedRun(e.employmentId);
    for (const reason of ['', '   ']) {
      const err = await saveStatutoryAdjustment(a, {
        batchId, employmentId: e.employmentId, values: { pcb: 0 }, reason,
      }).catch((x) => x);
      expect(err).toBeInstanceOf(StatutoryAdjustmentReasonRequiredError);
    }
    expect(await adjRowOf(batchId, e.employmentId)).toBeNull();
  });

  it('reverting when there is nothing to revert is refused by identity, not silently', async () => {
    const e = await hire('norevert@acme.test', '900101015312');
    const batchId = await processedRun(e.employmentId);
    const err = await revertStatutoryAdjustment(a, { batchId, employmentId: e.employmentId }).catch((x) => x);
    expect(err).toBeInstanceOf(StatutoryAdjustmentNotFoundError);
  });
});

describe('2961a7ae — the run is marked, so Close cannot happen on stale figures', () => {
  it('saving marks the run and names the employee; reverting marks it again', async () => {
    const e = await hire('mark@acme.test', '900101015313');
    const other = await hire('mark2@acme.test', '900101015314');
    const batchId = await processedRun(e.employmentId);
    const batchRow = async () =>
      (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
    expect((await batchRow()).needsRecalcAt).toBeNull();

    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values: { pcb: 5 }, reason: 'x' });
    expect((await batchRow()).needsRecalcAt).not.toBeNull();
    expect((await batchRow()).recalcEmploymentIds).toEqual([e.employmentId]);
    expect((await batchRow()).recalcEmploymentIds).not.toContain(other.employmentId);

    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [e.employmentId] } });
    await revertStatutoryAdjustment(a, { batchId, employmentId: e.employmentId });
    expect((await batchRow()).recalcEmploymentIds).toEqual([e.employmentId]);
  });

  it('an audit event records who typed what, with the reason and both figures', async () => {
    const e = await hire('audit@acme.test', '900101015315');
    const batchId = await processedRun(e.employmentId);
    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values: { pcb: 0 }, reason: 'zeroed per LHDN' });
    await revertStatutoryAdjustment(a, { batchId, employmentId: e.employmentId });

    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, batchId));
    const saved = events.find((x) => x.eventType === 'payroll-batch.statutory-adjusted');
    const reverted = events.find((x) => x.eventType === 'payroll-batch.statutory-adjustment-reverted');
    expect(saved).toBeTruthy();
    expect(reverted).toBeTruthy();
    const payload = saved!.payload as { reason: string; lines: { line: string; system: number; applied: number }[] };
    expect(payload.reason).toBe('zeroed per LHDN');
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].line).toBe('pcb');
    expect(payload.lines[0].applied).toBe(0);
    expect(payload.lines[0].system).toBeGreaterThan(0);
  });
});

describe('2961a7ae — the selection screens', () => {
  it('listAdjustableBatches offers PROCESSED runs only, and filters by company / year / month', async () => {
    const e = await hire('list@acme.test', '900101015316');
    const processed = await processedRun(e.employmentId, '2026-03');
    const { batchId: draft } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });

    const all = await listAdjustableBatches(a, {});
    expect(all.map((b) => b.batchId)).toContain(processed);
    expect(all.map((b) => b.batchId)).not.toContain(draft);

    expect((await listAdjustableBatches(a, { companyId: base.companyId })).map((b) => b.batchId)).toContain(processed);
    expect((await listAdjustableBatches(a, { year: '2026', month: '03' })).map((b) => b.batchId)).toContain(processed);
    expect((await listAdjustableBatches(a, { year: '2026', month: '04' })).map((b) => b.batchId)).not.toContain(processed);
    expect((await listAdjustableBatches(a, { year: '2025' }))).toEqual([]);
  });

  it('listAdjustmentEmployees searches by code and by name, and shows who is already adjusted', async () => {
    const e = await hire('searchme@acme.test', '900101015317');
    const batchId = await processedRun(e.employmentId);
    const all = await listAdjustmentEmployees(a, { batchId });
    expect(all.map((r) => r.employmentId)).toContain(e.employmentId);
    expect(all.find((r) => r.employmentId === e.employmentId)!.adjustedAt).toBeNull();

    expect(await listAdjustmentEmployees(a, { batchId, q: 'searchme' })).toHaveLength(1);
    expect(await listAdjustmentEmployees(a, { batchId, q: 'nobody-by-this-name' })).toHaveLength(0);
    const code = all.find((r) => r.employmentId === e.employmentId)!.employeeCode;
    if (code) expect((await listAdjustmentEmployees(a, { batchId, q: code })).length).toBeGreaterThan(0);

    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values: { pcb: 1 }, reason: 'x' });
    const after = await listAdjustmentEmployees(a, { batchId });
    expect(after.find((r) => r.employmentId === e.employmentId)!.adjustedAt).not.toBeNull();
  });

  it('the detail read surfaces the system figures, the current override and the downstream warnings', async () => {
    const e = await hire('detail@acme.test', '900101015318');
    const batchId = await processedRun(e.employmentId);
    const d = (await getStatutoryAdjustmentDetail(a, { batchId, employmentId: e.employmentId }))!;
    expect(d.status).toBe('processed');
    expect(d.current).toBeNull();
    expect(d.system.epfEmployee).toBeGreaterThan(0);
    expect(d.grossPay).toBeGreaterThan(0);
    // batchDownstreamWarnings is REUSED, so the same three facts the unlock and transaction screens show.
    expect(d.paymentDisbursed).toBe(false);
    expect(d.statutoryFiled).toBe(false);

    await saveStatutoryAdjustment(a, { batchId, employmentId: e.employmentId, values: { pcb: 0 }, reason: 'why' });
    const d2 = (await getStatutoryAdjustmentDetail(a, { batchId, employmentId: e.employmentId }))!;
    expect(d2.current!.pcb).toBe(0);
    expect(d2.current!.epfEmployee).toBeNull(); // blank stays blank on the way back out
    expect(d2.reason).toBe('why');
  });
});
