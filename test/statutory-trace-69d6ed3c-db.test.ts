/**
 * Item 69d6ed3c — the statutory trace on REAL payslips, and the multi-run EPF fix, through the kernel.
 *
 * Fictional fixtures only. Expected figures are the KWSP Third Schedule Part A and PERKESO Act 4 / Act 800
 * rows the approved plan names (see test/statutory-trace-69d6ed3c.test.ts for the pack-level golden file):
 *
 *   Basic 3,500 + Transport 300 (EPF) + Bonus 800 (EPF + EPF Bonus 2012, SOCSO ticked) + OT 250 + Phone 150
 *   (no EPF) → EPF 4,600 at 506 / 598 (normal alone 3,800 at 418, bonus share 88); SOCSO 4,200 at
 *   20.75 / 72.65, SKBBK 31.15, EIS 8.30 / 8.30.
 *   Untick EPF on Transport, reprocess → EPF 4,300 at 473 / 559.
 *   Untick EPF Bonus 2012 on Bonus (PCB normal), reprocess → EPF stays 506 / 598; SOCSO 5,000 at
 *   24.75 / 86.65, SKBBK 37.15, EIS 9.90.
 *   Multi-run: regular 3,800; bonus run 1 pays 1,000 (EPF unticked); bonus run 2 pays 800 (EPF ticked) →
 *   run 2 adds 506 − 418 = 88 and 598 − 494 = 104. The old code gave 88 / 48.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  closeBatch,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  markRunsAffectedByPayComponent,
  reprocessSelectedEmployees,
} from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { explainStatutory } from '../core/statutory-explain';
import { runMultiRunEpfRecalcMark } from '../scripts/mark-multirun-epf-recalc-69d6ed3c';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let a: SessionContext;
const PERIOD = '2026-10';

const item = (code: string, name: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  label: name, code, name, kind: 'allowance',
  includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
  isNonPayable: false, prorates: false,
  pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: false,
  ...over,
});
const TRANSPORT = (over: Partial<PayComponentInput> = {}) => item('TRANSPORT', 'Transport', over);
const PHONE = item('PHONE', 'Phone', { includedInEpf: false });
// Legacy unclassified OT: not EPF, SOCSO/EIS yes → the overtime bucket.
const OT = item('OTX', 'Overtime', { includedInEpf: false, pcbRemunerationType: undefined, pcbExemptionCode: undefined, epfBonus2012: undefined });
const BONUS = (over: Partial<PayComponentInput> = {}) =>
  item('BNS', 'Bonus', { pcbRemunerationType: 'additional', epfBonus2012: true, ...over });

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function setup() {
  await seedPayComponentCatalog(a);
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
}

async function hire(email: string, basic: number) {
  const e = await hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  // Born 1 Jan 1990: a Malaysian citizen below 60 — KWSP Part A, SOCSO First Category, EIS eligible.
  // Subject to SKBBK must be ticked explicitly: the profile writer defaults it off.
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015401', subjectToSkbbk: true });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: basic, effectiveFrom: '2026-01-01' });
  return e;
}
const recurring = async (employmentId: string, code: string, amount: number) =>
  setEmploymentPayComponent(a, { employmentId, componentId: await idByCode(code), amount, effectiveFrom: '2026-01-01' });

async function slipOf(batchId: string, employmentId: string) {
  const [row] = await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row!;
}
type Trace = {
  epf: Record<string, unknown> & { band?: unknown; normalOnly?: Record<string, unknown> };
  socso: Record<string, unknown>; skbbk: Record<string, unknown>; eis: Record<string, unknown>;
  items: { code?: string; epf?: boolean; epfBonus2012?: boolean; epfNormal: number; epfBonus: number; socsoEis: number }[];
  run: { kind: string; own: { epfAdditional: number; socsoWageExtra: number }; earlier?: Record<string, number>; thisRun: Record<string, number> };
};
type Stat = Record<string, number> & { statutoryTrace?: Trace };
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;
const money = (st: Stat) => [st.epfEmployee, st.epfEmployer, st.socsoEmployee, st.socsoEmployer, st.socsoSkbbk, st.eisEmployee, st.eisEmployer];

/** The golden employee on a processed regular run. */
async function goldenRun() {
  await upsertPayComponent(a, TRANSPORT());
  await upsertPayComponent(a, PHONE);
  await upsertPayComponent(a, OT);
  await upsertPayComponent(a, BONUS());
  const e = await hire('golden@acme.test', 3500);
  await recurring(e.employmentId, 'TRANSPORT', 300);
  await recurring(e.employmentId, 'PHONE', 150);
  await recurring(e.employmentId, 'OTX', 250);
  const batch = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
  await setPayrollBatchComponent(a, { batchId: batch.batchId, employmentId: e.employmentId, componentId: await idByCode('BNS'), amount: 800 });
  await generatePayslips(a, { batchId: batch.batchId });
  return { e, batchId: batch.batchId };
}

/** What the Pay Item save does after a statutory-relevant edit, then the operator's reprocess. */
async function saveAndReprocess(input: PayComponentInput, batchId: string, employmentId: string) {
  await upsertPayComponent(a, input);
  await markRunsAffectedByPayComponent(a, { componentId: await idByCode(input.code), code: input.code });
  await reprocessSelectedEmployees(a, { batchId, employmentIds: [employmentId], reason: 'Pay item EPF setting changed' });
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

describe('69d6ed3c — the payslip carries the working that produced it', () => {
  it('golden: EPF 4,600 → 506 / 598 at row 4,580.01–4,600.00; SOCSO 4,200 → 20.75 / 72.65; SKBBK 31.15; EIS 8.30', async () => {
    await setup();
    const { e, batchId } = await goldenRun();
    const st = statOf(await slipOf(batchId, e.employmentId));
    expect(money(st)).toEqual([506, 598, 20.75, 72.65, 31.15, 8.3, 8.3]);

    const tr = st.statutoryTrace!;
    expect(tr, 'every newly processed payslip carries the trace').toBeDefined();
    expect(tr.epf).toMatchObject({ part: 'A', method: 'schedule_row', normalWage: 3800, bonusWage: 800, base: 4600, band: { from: 4580.01, upTo: 4600 }, employee: 506, employer: 598, employeeOnBonus: 88 });
    expect(tr.epf.normalOnly).toMatchObject({ band: { from: 3780.01, upTo: 3800 }, scheduleEmployee: 418 });
    expect(tr.socso).toMatchObject({ category: 1, wage: 4200, band: { from: 4100.01, upTo: 4200 } });
    expect(tr.skbbk).toMatchObject({ employee: 31.15 });
    expect(tr.eis).toMatchObject({ employee: 8.3, employer: 8.3 });

    // The items with their settings as THIS run read them, adding up to each wage.
    const byCode = Object.fromEntries(tr.items.filter((l) => l.code).map((l) => [l.code!, l]));
    expect(byCode.TRANSPORT).toMatchObject({ epf: true, epfNormal: 300, socsoEis: 300 });
    expect(byCode.PHONE).toMatchObject({ epf: false, epfNormal: 0, socsoEis: 150 });
    expect(byCode.OTX).toMatchObject({ epf: false, epfNormal: 0, socsoEis: 250 });
    expect(byCode.BNS).toMatchObject({ epf: true, epfBonus2012: true, epfBonus: 800, socsoEis: 0 });
    const sum = (k: 'epfNormal' | 'epfBonus' | 'socsoEis') => tr.items.reduce((s, l) => Math.round((s + l[k]) * 100) / 100, 0);
    expect([sum('epfNormal'), sum('epfBonus'), sum('socsoEis')]).toEqual([3800, 800, 4200]);
    expect(tr.run).toMatchObject({ kind: 'single', own: { epfAdditional: 800, socsoWageExtra: 0 } });

    // And the Statutory Explanation reads it, having checked it against the payslip.
    const ex = explainStatutory(st, 'regular');
    expect(ex.traceStatus).toBe('recorded');
    // The r187 bases still agree with the trace.
    expect((st as unknown as { bases: Record<string, number> }).bases).toMatchObject({ epf: 3800, epfAdditional: 800, socsoEis: 4200 });
  });

  it('untick EPF on Transport, then reprocess: EPF 4,300 → 473 / 559, following the latest saved setting', async () => {
    await setup();
    const { e, batchId } = await goldenRun();
    await saveAndReprocess(TRANSPORT({ includedInEpf: false }), batchId, e.employmentId);
    const st = statOf(await slipOf(batchId, e.employmentId));
    expect([st.epfEmployee, st.epfEmployer]).toEqual([473, 559]);
    expect(st.statutoryTrace!.epf).toMatchObject({ normalWage: 3500, base: 4300, band: { from: 4280.01, upTo: 4300 } });
    expect(st.statutoryTrace!.items.find((l) => l.code === 'TRANSPORT')).toMatchObject({ epf: false, epfNormal: 0, socsoEis: 300 });
    expect(explainStatutory(st, 'regular').traceStatus).toBe('recorded');
  });

  it('untick EPF Bonus 2012 on Bonus (PCB normal), reprocess: EPF stays 506 / 598; SOCSO 5,000 → 24.75 / 86.65, SKBBK 37.15, EIS 9.90', async () => {
    await setup();
    const { e, batchId } = await goldenRun();
    await saveAndReprocess(BONUS({ epfBonus2012: false, pcbRemunerationType: 'normal' }), batchId, e.employmentId);
    const st = statOf(await slipOf(batchId, e.employmentId));
    expect(money(st)).toEqual([506, 598, 24.75, 86.65, 37.15, 9.9, 9.9]);
    expect(st.statutoryTrace!.socso).toMatchObject({ wage: 5000, band: { from: 4900.01, upTo: 5000 } });
    expect(st.statutoryTrace!.items.find((l) => l.code === 'BNS')).toMatchObject({ epfBonus2012: false, epfNormal: 800, socsoEis: 800 });
  });
});

describe('69d6ed3c — the multi-run defect: an earlier run counts only its EPF-subject pay', () => {
  async function threeRuns(strip: 'none' | 'trace' | 'trace_and_lines') {
    await upsertPayComponent(a, TRANSPORT());
    await upsertPayComponent(a, item('B1', 'Ex gratia', { includedInEpf: false, includedInSocsoEis: false, pcbRemunerationType: 'additional' }));
    await upsertPayComponent(a, item('B2', 'Performance bonus', { includedInSocsoEis: false, pcbRemunerationType: 'additional' }));
    const e = await hire('multi@acme.test', 3500);
    await recurring(e.employmentId, 'TRANSPORT', 300);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: reg.batchId });
    const run1 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await setPayrollBatchComponent(a, { batchId: run1.batchId, employmentId: e.employmentId, componentId: await idByCode('B1'), amount: 1000 });
    await generatePayslips(a, { batchId: run1.batchId });
    if (strip !== 'none') {
      // A run processed before this item carries no trace (and a legacy one no item lines either).
      const s1 = await slipOf(run1.batchId, e.employmentId);
      const drop = strip === 'trace' ? sql`${schema.payslip.statutory} - 'statutoryTrace'` : sql`${schema.payslip.statutory} - 'statutoryTrace' - 'componentLines'`;
      await owner.db.update(schema.payslip).set({ statutory: drop }).where(eq(schema.payslip.id, s1.id));
    }
    const run2 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await setPayrollBatchComponent(a, { batchId: run2.batchId, employmentId: e.employmentId, componentId: await idByCode('B2'), amount: 800 });
    await generatePayslips(a, { batchId: run2.batchId });
    return { e, reg, run1, run2 };
  }

  it('regular 418 / 494; run 1 (not EPF) adds 0 / 0; run 2 adds 88 / 104 (the old code gave 88 / 48)', async () => {
    await setup();
    const { e, reg, run1, run2 } = await threeRuns('none');
    const r = statOf(await slipOf(reg.batchId, e.employmentId));
    const s1 = statOf(await slipOf(run1.batchId, e.employmentId));
    const s2 = statOf(await slipOf(run2.batchId, e.employmentId));
    expect([r.epfEmployee, r.epfEmployer]).toEqual([418, 494]);
    expect([s1.epfEmployee, s1.epfEmployer]).toEqual([0, 0]);
    expect(s1.statutoryTrace!.run.own).toEqual({ epfAdditional: 0, socsoWageExtra: 0 });
    expect([s2.epfEmployee, s2.epfEmployer]).toEqual([88, 104]);

    const tr = s2.statutoryTrace!;
    // The whole month: 3,800 + 800 = 4,600, read once.
    expect(tr.epf).toMatchObject({ normalWage: 3800, bonusWage: 800, base: 4600, band: { from: 4580.01, upTo: 4600 }, employee: 506, employer: 598 });
    expect(tr.run).toMatchObject({ kind: 'additional', earlier: { runs: 2, unstamped: 0, additional: 1000, epfAdditional: 0 } });
    const ex = explainStatutory(s2, 'bonus');
    expect(ex.traceStatus).toBe('recorded');
    expect(ex.trace!.run.chargedBefore).toMatchObject({ epfEmployee: 418, epfEmployer: 494 });
    expect(ex.trace!.run.before!.epf.band).toEqual({ from: 3780.01, upTo: 3800 });
    expect((s2 as unknown as { bases: Record<string, number> }).bases).toMatchObject({ epf: 3800, epfAdditional: 800 });
  });

  it('an earlier run from before the trace is read off its own pay item lines: still 88 / 104, in any order', async () => {
    await setup();
    const { e, run2 } = await threeRuns('trace');
    const s2 = statOf(await slipOf(run2.batchId, e.employmentId));
    expect([s2.epfEmployee, s2.epfEmployer]).toEqual([88, 104]);
    expect(s2.statutoryTrace!.run.earlier).toMatchObject({ unstamped: 0, fromItemLines: 1, epfAdditional: 0 });
    expect(explainStatutory(s2, 'bonus').traceStatus).toBe('recorded');
  });

  it('an earlier run with neither a trace nor item lines keeps the old reading and the trace says so', async () => {
    await setup();
    const { e, run2 } = await threeRuns('trace_and_lines');
    const s2 = statOf(await slipOf(run2.batchId, e.employmentId));
    // Old behaviour exactly — no recomputation of a payslip processed before the trace.
    expect([s2.epfEmployee, s2.epfEmployer]).toEqual([88, 48]);
    expect(s2.statutoryTrace!.run.earlier).toMatchObject({ unstamped: 1, epfAdditional: 1000 });
    expect(explainStatutory(s2, 'bonus').traceStatus).toBe('recorded');
  });
});

describe('69d6ed3c — closed months stay exactly as they are', () => {
  it('a closed payslip without a trace is never restamped or recalculated; the screen shows the pre-trace note', async () => {
    await setup();
    const { e, batchId } = await goldenRun();
    const slip = await slipOf(batchId, e.employmentId);
    // Emulate a month processed and closed before this item.
    await owner.db.update(schema.payslip).set({ statutory: sql`${schema.payslip.statutory} - 'statutoryTrace'` }).where(eq(schema.payslip.id, slip.id));
    await closeBatch(a, { batchId });
    const before = await slipOf(batchId, e.employmentId);

    await upsertPayComponent(a, TRANSPORT({ includedInEpf: false }));
    const marked = await markRunsAffectedByPayComponent(a, { componentId: await idByCode('TRANSPORT'), code: 'TRANSPORT' });
    expect(marked.map((m) => m.batchId)).not.toContain(batchId);
    await expect(reprocessSelectedEmployees(a, { batchId, employmentIds: [e.employmentId], reason: 'try a closed month' })).rejects.toThrow();

    const after = await slipOf(batchId, e.employmentId);
    expect(after.statutory).toEqual(before.statutory);
    expect(statOf(after).statutoryTrace).toBeUndefined();
    expect(money(statOf(after))).toEqual([506, 598, 20.75, 72.65, 31.15, 8.3, 8.3]);
    expect(explainStatutory(after.statutory, 'regular').traceStatus).toBe('absent');
  });
});

describe('69d6ed3c — open multi-run months processed before the fix show Reprocess Required', () => {
  const OWNER = owner.db;
  async function preFixMonth() {
    await upsertPayComponent(a, TRANSPORT());
    await upsertPayComponent(a, item('B1', 'Ex gratia', { includedInEpf: false, includedInSocsoEis: false, pcbRemunerationType: 'additional' }));
    await upsertPayComponent(a, item('B2', 'Performance bonus', { includedInSocsoEis: false, pcbRemunerationType: 'additional' }));
    const e = await hire('marked@acme.test', 3500);
    await recurring(e.employmentId, 'TRANSPORT', 300);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: reg.batchId });
    const run1 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await setPayrollBatchComponent(a, { batchId: run1.batchId, employmentId: e.employmentId, componentId: await idByCode('B1'), amount: 1000 });
    await generatePayslips(a, { batchId: run1.batchId });
    const run2 = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await setPayrollBatchComponent(a, { batchId: run2.batchId, employmentId: e.employmentId, componentId: await idByCode('B2'), amount: 800 });
    await generatePayslips(a, { batchId: run2.batchId });
    // Every slip of the month as the old code left it: no trace anywhere.
    await owner.db.update(schema.payslip).set({ statutory: sql`${schema.payslip.statutory} - 'statutoryTrace'` }).where(eq(schema.payslip.employmentId, e.employmentId));
    return { e, reg, run1, run2 };
  }
  const batchRow = async (id: string) => (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, id)))[0]!;

  it('report-only names exactly the later run, writes nothing; --apply marks it once; reprocess clears it at 88 / 104', async () => {
    await setup();
    const { e, reg, run1, run2 } = await preFixMonth();

    const report = await runMultiRunEpfRecalcMark(OWNER, { apply: false });
    expect(report.targets.map((t) => t.batchId)).toEqual([run2.batchId]);
    expect(report.targets[0].employmentIds).toEqual([e.employmentId]);
    expect((await batchRow(run2.batchId)).needsRecalcAt, 'report only').toBeNull();

    const applied = await runMultiRunEpfRecalcMark(OWNER, { apply: true });
    expect(applied.marked).toBe(1);
    const marked = await batchRow(run2.batchId);
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([e.employmentId]);
    for (const id of [reg.batchId, run1.batchId]) expect((await batchRow(id)).needsRecalcAt).toBeNull();
    const events = await owner.db.select().from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, run2.batchId), eq(schema.domainEvent.eventType, 'payroll-batch.recalc-required')));
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ changeCategory: 'statutory', addedEmploymentIds: [e.employmentId] });

    // Idempotent: running it again adds nothing and records nothing.
    expect((await runMultiRunEpfRecalcMark(OWNER, { apply: true })).marked).toBe(0);

    // Reprocessing the LATER run alone corrects it — the earlier run need not be reprocessed first.
    await reprocessSelectedEmployees(a, { batchId: run2.batchId, employmentIds: [e.employmentId], reason: 'EPF multi-run correction' });
    const s2 = statOf(await slipOf(run2.batchId, e.employmentId));
    expect([s2.epfEmployee, s2.epfEmployer]).toEqual([88, 104]);
    expect((await batchRow(run2.batchId)).needsRecalcAt, 'the reprocess clears the mark').toBeNull();
    expect((await runMultiRunEpfRecalcMark(OWNER, { apply: false })).targets).toEqual([]);
  });

  it('a closed run is never marked', async () => {
    await setup();
    const { run2 } = await preFixMonth();
    await closeBatch(a, { batchId: run2.batchId });
    expect((await runMultiRunEpfRecalcMark(OWNER, { apply: true })).targets).toEqual([]);
    expect((await batchRow(run2.batchId)).needsRecalcAt).toBeNull();
  });

  it('a month whose earlier runs paid only EPF-ticked additional pay is not marked', async () => {
    await setup();
    await upsertPayComponent(a, TRANSPORT());
    await upsertPayComponent(a, item('B2', 'Performance bonus', { includedInSocsoEis: false, pcbRemunerationType: 'additional' }));
    const e = await hire('clean@acme.test', 3500);
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: reg.batchId });
    for (const amount of [500, 800]) {
      const run = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' });
      await setPayrollBatchComponent(a, { batchId: run.batchId, employmentId: e.employmentId, componentId: await idByCode('B2'), amount });
      await generatePayslips(a, { batchId: run.batchId });
    }
    await owner.db.update(schema.payslip).set({ statutory: sql`${schema.payslip.statutory} - 'statutoryTrace'` }).where(eq(schema.payslip.employmentId, e.employmentId));
    expect((await runMultiRunEpfRecalcMark(OWNER, { apply: false })).targets).toEqual([]);
  });
});
