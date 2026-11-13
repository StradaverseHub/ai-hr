/**
 * Statutory trace v1 (item 69d6ed3c) — every processed or reprocessed payslip carries the working, through
 * the kernel, the background reprocess job and the request-path reprocess. Fictional fixtures only.
 *
 * Reported on staging, 13 Nov 2026: one Auto-EPF employee reprocessed on a regular single run had no
 * `statutory.statutoryTrace`, so the Statutory Explanation said the working was not recorded. The reprocess
 * ran as a `payroll_reprocess` background job, and the import worker that runs those jobs was still on the
 * release from before the trace (the web had moved on; the worker was updated about 18 minutes later). These
 * tests pin what the current kernel does for that shape and for the other common shapes, so a genuine code
 * path that dropped the trace would fail here:
 *
 *   · the reported shape — Basic 1,550 + Fixed allowance 440 (EPF, SOCSO/EIS) − Absence 300 (ticked EPF,
 *     SOCSO/EIS, PCB) + Overtime 1.5 60.62 on the additional stream (SOCSO/EIS yes, EPF no):
 *       EPF wages 1,690 → KWSP Part A row 1,680.01–1,700.00 → 187 / 221
 *       SOCSO/EIS wages 1,750.62 → row 1,700.01–1,800.00 → SOCSO 8.75 / 30.65, SKBBK 13.15, EIS 3.50 / 3.50
 *     processed, then reprocessed by the background job (the staging path) and by the request path;
 *   · a payslip written WITHOUT the trace (what the old worker wrote) gets it back on the next reprocess;
 *   · non-citizen, PR 60+, citizen 60+ (Part E), 75+, EPF exempt, manual percentage, voluntary excess
 *     (both sides and employee-only), top-up percentage, manual amount, SOCSO / EIS category none with
 *     SKBBK off — on one run, then all reprocessed by the background job;
 *   · a bonus run, a monthly run that restates a month a bonus run opened, and a later bonus run, on the
 *     legacy (untyped) payroll inputs;
 *   · outstanding payments after resignation, single and across two cycles.
 *
 * Each payslip must carry the trace AND the Statutory Explanation must accept it (`traceStatus` 'recorded'):
 * the reconciliation guard (the trace is shown only when it equals the payslip's own amounts) is unchanged.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY, type StatutoryInput } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips, reprocessSelectedEmployees, setPayrollInput } from '../core/payroll';
import { requestSelectiveReprocess, payrollReprocessJobHandler } from '../core/payroll-reprocess-job';
import { runBulkJobTick } from '../core/bulk-job-worker';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  setPayrollBatchComponent,
  upsertPayComponent,
  type PayComponentInput,
} from '../core/pay-components';
import { seedPayrollCycleCatalog, listPayrollCycles } from '../core/payroll-cycle';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { explainStatutory } from '../core/statutory-explain';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

let base: Base;
let a: SessionContext;
const PERIOD = '2026-11';

const item = (code: string, name: string, over: Partial<PayComponentInput> = {}): PayComponentInput => ({
  label: name, code, name, kind: 'allowance',
  includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
  isNonPayable: false, prorates: false,
  pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE', epfBonus2012: false,
  ...over,
});
const FIXED = item('FIXALW', 'Fixed allowance', { includedInHrdfBase: true });
// Absence: a deduction ticked into EPF, SOCSO/EIS and PCB, which takes it out of each base.
const ABSENCE = item('ABSENTX', 'Absence', { kind: 'deduction' });
// Overtime classified as additional remuneration and ticked "not EPF, yes SOCSO/EIS" — the reported shape.
const OT15 = item('OTX15', 'Overtime 1.5', { includedInEpf: false, pcbRemunerationType: 'additional' });
const BONUS = item('BNSX', 'Performance bonus', { includedInSocsoEis: false, pcbRemunerationType: 'additional', epfBonus2012: true });

const idByCode = async (code: string) =>
  (await listPayComponents(a, { includeArchived: true })).find((c) => c.code === code)!.id;

async function typedWorld() {
  await seedPayComponentCatalog(a);
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  a = await entitledCtx(base);
  for (const c of [FIXED, ABSENCE, OT15, BONUS]) await upsertPayComponent(a, c);
}

type Profile = Omit<StatutoryInput, 'personId' | 'icNumber'> & { icNumber?: string | null; dateOfBirth?: string };
let icSeq = 0;
/** One fictional employee on the reported pay: Basic 1,550 + Fixed allowance 440 − Absence 300. */
async function hire(name: string, profile: Profile = {}) {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@trace-shapes.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
  });
  const { dateOfBirth, icNumber, ...rest } = profile;
  icSeq += 1;
  // Subject to SKBBK is ticked explicitly unless a shape says otherwise: the profile writer defaults it off.
  await setStatutoryProfileMY(a, {
    personId: e.personId, icNumber: icNumber === undefined ? `9101010154${String(icSeq).padStart(2, '0')}` : icNumber,
    subjectToSkbbk: true, ...rest,
  });
  await owner.db.update(schema.person).set({ dateOfBirth: dateOfBirth ?? '1991-01-01' }).where(eq(schema.person.id, e.personId));
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1550, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('BASIC'), amount: 1550, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('FIXALW'), amount: 440, effectiveFrom: '2026-01-01' });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode('ABSENTX'), amount: 300, effectiveFrom: '2026-01-01' });
  return e;
}
const overtime = async (batchId: string, employmentId: string) =>
  setPayrollBatchComponent(a, { batchId, employmentId, componentId: await idByCode('OTX15'), amount: 60.62 });

async function slipOf(batchId: string, employmentId: string) {
  const [row] = await owner.db.select().from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row!;
}
type Trace = {
  epf: Record<string, unknown>; socso: Record<string, unknown>; skbbk: Record<string, unknown>; eis: Record<string, unknown>;
  run: { kind: string };
};
type Stat = Record<string, number> & { statutoryTrace?: Trace; bases?: Record<string, number> };
const statOf = (s: { statutory: unknown }) => s.statutory as Stat;
const money = (st: Stat) => [st.epfEmployee, st.epfEmployer, st.socsoEmployee, st.socsoEmployer, st.socsoSkbbk, st.eisEmployee, st.eisEmployer];
const REPORTED_MONEY = [187, 221, 8.75, 30.65, 13.15, 3.5, 3.5];

/** The trace is on the payslip and the Statutory Explanation accepts it as this payslip's working. */
function expectRecorded(st: Stat, runType: 'regular' | 'bonus' | 'off_cycle', who: string) {
  expect(st.statutoryTrace, `${who}: every processed payslip carries the trace`).toBeDefined();
  expect(explainStatutory(st, runType).traceStatus, `${who}: the explanation reconciles it with the payslip`).toBe('recorded');
}

/** Run every queued background reprocess to completion, as the import worker does. */
async function drainReprocessJobs() {
  for (let i = 0; i < 500; i++) {
    if (!await runBulkJobTick(owner.client, { handlers: [payrollReprocessJobHandler] })) {
      const [row] = await owner.client<{ n: number }[]>`select count(*)::int as n from bulk_job where kind='payroll_reprocess' and (state not in ('completed','failed','cancelled') or notified_at is null)`;
      if (!row.n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error('reprocess job did not finish');
}
async function reprocessInBackground(batchId: string, employmentIds: string[]) {
  const requested = await requestSelectiveReprocess(a, { batchId, employmentIds, reason: 'Statutory explanation check', idempotencyKey: randomUUID() });
  expect(requested.status).toBe('queued');
  await drainReprocessJobs();
  const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.id, requested.jobId));
  expect(job.status).toBe('completed');
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
  icSeq = 0;
});
afterAll(async () => {
  await closeAll();
});

describe('the reported shape: Auto EPF, regular single run, EPF 1,690, SOCSO/EIS 1,750.62', () => {
  it('processing writes the trace; the background reprocess and the request-path reprocess keep it', async () => {
    await typedWorld();
    const e = await hire('Reported Shape');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await overtime(batchId, e.employmentId);
    await generatePayslips(a, { batchId });

    const first = await slipOf(batchId, e.employmentId);
    const st = statOf(first);
    expect(money(st)).toEqual(REPORTED_MONEY);
    expect(st.bases).toMatchObject({ epf: 1690, epfAdditional: 0, socsoEis: 1750.62 });
    expect((st as unknown as { epfMode: string }).epfMode).toBe('auto');
    expectRecorded(st, 'regular', 'processed');
    expect(st.statutoryTrace!.epf).toMatchObject({ part: 'A', method: 'schedule_row', normalWage: 1690, bonusWage: 0, band: { from: 1680.01, upTo: 1700 }, employee: 187, employer: 221 });
    expect(st.statutoryTrace!.socso).toMatchObject({ category: 1, wage: 1750.62, band: { from: 1700.01, upTo: 1800 }, employee: 8.75, employer: 30.65 });
    expect(st.statutoryTrace!.skbbk).toMatchObject({ employee: 13.15 });
    expect(st.statutoryTrace!.eis).toMatchObject({ employee: 3.5, employer: 3.5 });
    expect(st.statutoryTrace!.run).toMatchObject({ kind: 'single', own: { epfAdditional: 0, socsoWageExtra: 60.62 } });

    // The staging path: the screen queues a `payroll_reprocess` job and the worker runs it.
    await reprocessInBackground(batchId, [e.employmentId]);
    const job = await slipOf(batchId, e.employmentId);
    expect(job.version).toBe(first.version + 1);
    expect(money(statOf(job))).toEqual(REPORTED_MONEY);
    expectRecorded(statOf(job), 'regular', 'background reprocess');

    // The request path runs the same per-employee transaction.
    await reprocessSelectedEmployees(a, { batchId, employmentIds: [e.employmentId], reason: 'Statutory explanation check', idempotencyKey: randomUUID() });
    const sync = await slipOf(batchId, e.employmentId);
    expect(sync.version).toBe(job.version + 1);
    expect(money(statOf(sync))).toEqual(REPORTED_MONEY);
    expectRecorded(statOf(sync), 'regular', 'request-path reprocess');
    expect(statOf(sync).statutoryTrace).toEqual(st.statutoryTrace);
  });

  it('a payslip written without the trace (by a worker on the earlier release) gets it on the next reprocess, money unchanged', async () => {
    await typedWorld();
    const e = await hire('Old Worker Slip');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    await overtime(batchId, e.employmentId);
    await generatePayslips(a, { batchId });
    const slip = await slipOf(batchId, e.employmentId);
    await owner.db.update(schema.payslip).set({ statutory: sql`${schema.payslip.statutory} - 'statutoryTrace'` }).where(eq(schema.payslip.id, slip.id));
    expect(explainStatutory((await slipOf(batchId, e.employmentId)).statutory, 'regular').traceStatus).toBe('absent');

    await reprocessInBackground(batchId, [e.employmentId]);
    const after = statOf(await slipOf(batchId, e.employmentId));
    expect(money(after)).toEqual(REPORTED_MONEY);
    expectRecorded(after, 'regular', 'reprocessed by the current worker');
  });
});

describe('every common employee shape on one regular run, and again after the background reprocess', () => {
  // Expected EPF method per shape, from the KWSP rule each one falls under (localization/my/payroll.ts).
  const SHAPES: { name: string; profile: Profile; method: string; part?: 'A' | 'E' | null; socsoCategory?: 1 | 2; off?: { socso?: string; skbbk?: string; eis?: string } }[] = [
    { name: 'Citizen auto', profile: {}, method: 'schedule_row', part: 'A', socsoCategory: 1 },
    { name: 'Non citizen', profile: { icNumber: null, epfCitizenship: 'non_citizen' }, method: 'flat_rate', part: null, socsoCategory: 2, off: { eis: 'non_citizen' } },
    { name: 'Permanent resident sixty six', profile: { icNumber: '600101015461', epfCitizenship: 'pr', dateOfBirth: '1960-01-01' }, method: 'flat_rate', part: null, socsoCategory: 2, off: { eis: 'age_60_plus' } },
    { name: 'Citizen sixty six', profile: { icNumber: '600101015462', dateOfBirth: '1960-01-01' }, method: 'schedule_row', part: 'E', socsoCategory: 2, off: { eis: 'age_60_plus' } },
    { name: 'Citizen seventy eight', profile: { icNumber: '480101015463', dateOfBirth: '1948-01-01' }, method: 'no_contribution', part: null, socsoCategory: 2, off: { eis: 'age_60_plus' } },
    { name: 'EPF exempt', profile: { epfMode: 'exempt' }, method: 'exempt', part: 'A' },
    { name: 'EPF manual percentage', profile: { epfMode: 'manual_percentage', epfEmployeeRate: 0.09, epfEmployerRate: 0.12 }, method: 'election_working' },
    { name: 'EPF voluntary excess', profile: { epfMode: 'voluntary_excess', epfEmployeeRate: 0.15, epfEmployerRate: 0.15 }, method: 'schedule_row', part: 'A' },
    { name: 'EPF voluntary excess employee only', profile: { epfMode: 'voluntary_excess', epfEmployeeRate: 0.15, epfEmployerRate: null }, method: 'election_working' },
    { name: 'EPF top up percentage', profile: { epfMode: 'topup_percentage', epfEmployeeRate: 0.02, epfEmployerRate: 0.01 }, method: 'election_working' },
    { name: 'EPF manual amount', profile: { epfMode: 'manual_amount', epfEmployeeAmount: 150, epfEmployerAmount: 180, epfManualReason: 'Fictional agreed figure' }, method: 'schedule_row', part: 'A' },
    { name: 'SOCSO and EIS none, SKBBK off', profile: { socsoCategory: 'none', eisCategory: 'none', subjectToSkbbk: false }, method: 'schedule_row', part: 'A', off: { socso: 'category_none', skbbk: 'not_subject', eis: 'category_none' } },
  ];

  it('each payslip carries a trace the explanation reconciles; SOCSO/SKBBK/EIS are traced whatever EPF does', async () => {
    await typedWorld();
    const hired: { shape: (typeof SHAPES)[number]; employmentId: string }[] = [];
    for (const shape of SHAPES) hired.push({ shape, employmentId: (await hire(shape.name, shape.profile)).employmentId });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD });
    for (const h of hired) await overtime(batchId, h.employmentId);
    await generatePayslips(a, { batchId });

    const check = async (when: string) => {
      const out: Record<string, number[]> = {};
      for (const { shape, employmentId } of hired) {
        const st = statOf(await slipOf(batchId, employmentId));
        const who = `${shape.name} (${when})`;
        expectRecorded(st, 'regular', who);
        const t = st.statutoryTrace!;
        expect(t.epf.method, who).toBe(shape.method);
        if (shape.part !== undefined) expect(t.epf.part, who).toBe(shape.part);
        if (shape.socsoCategory) expect(t.socso.category, who).toBe(shape.socsoCategory);
        expect(t.socso.notApplicable, who).toBe(shape.off?.socso);
        expect(t.skbbk.notApplicable, who).toBe(shape.off?.skbbk);
        expect(t.eis.notApplicable, who).toBe(shape.off?.eis);
        // The rows are named whenever the scheme charged anything.
        if (!shape.off?.socso) expect(t.socso.band, who).toBeDefined();
        if (!shape.off?.eis) expect(t.eis.band, who).toBeDefined();
        out[shape.name] = money(st);
      }
      return out;
    };
    const processed = await check('processed');
    // Sanity on the fixtures: the shapes really are different contributions.
    expect(processed['Citizen auto']).toEqual(REPORTED_MONEY);
    expect(processed['EPF exempt'].slice(0, 2)).toEqual([0, 0]);
    expect(processed['Citizen seventy eight'].slice(0, 2)).toEqual([0, 0]);
    expect(processed['EPF manual amount'].slice(0, 2)).toEqual([150, 180]);
    expect(processed['SOCSO and EIS none, SKBBK off'].slice(2)).toEqual([0, 0, 0, 0, 0]);

    await reprocessInBackground(batchId, hired.map((h) => h.employmentId));
    expect(await check('background reprocess')).toEqual(processed);
  });
});

describe('bonus, restating and later bonus runs on the legacy payroll inputs', () => {
  it('a bonus run that opens the month, the monthly run that restates it, and a later bonus run each carry a reconciling trace', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    a = await entitledCtx(base);
    const people: string[] = [];
    for (const [name, profile] of [['Legacy Citizen', {}], ['Legacy Non Citizen', { icNumber: null, epfCitizenship: 'non_citizen' as const }]] as const) {
      const e = await hireEmployee(a, {
        person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/ /g, '.')}@trace-shapes.test` },
        companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
      });
      icSeq += 1;
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9101010155${String(icSeq).padStart(2, '0')}`, subjectToSkbbk: true, ...profile });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1690, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      people.push(e.employmentId);
    }
    const run = async (batchId: string, ot: number, bonus: number) => {
      for (const employmentId of people) await setPayrollInput(a, { batchId, employmentId, overtimeAmount: ot, bonusAmount: bonus });
      await generatePayslips(a, { batchId });
      return batchId;
    };
    const opening = await run((await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' })).batchId, 0, 500);
    const monthly = await run((await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD })).batchId, 60.62, 0);
    const later = await run((await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'bonus' })).batchId, 0, 800);

    for (const employmentId of people) {
      const o = statOf(await slipOf(opening, employmentId));
      const m = statOf(await slipOf(monthly, employmentId));
      const l = statOf(await slipOf(later, employmentId));
      expectRecorded(o, 'bonus', 'opening bonus run');
      expectRecorded(m, 'regular', 'restating monthly run');
      expectRecorded(l, 'bonus', 'later bonus run');
      expect(m.statutoryTrace!.run.kind).toBe('restate');
      expect(l.statutoryTrace!.run.kind).toBe('additional');
    }
    // …and the background reprocess of the restating run keeps it.
    await reprocessInBackground(monthly, people);
    for (const employmentId of people) expectRecorded(statOf(await slipOf(monthly, employmentId)), 'regular', 'reprocessed restating run');
  });
});

describe('outstanding payments after resignation', () => {
  it('the first and a later cycle each carry a reconciling trace', async () => {
    await setModule(base.tenantId, 'payroll', 'active');
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    a = await entitledCtx(base);
    await seedPayrollCycleCatalog(a, base.companyId);
    const cycles = await listPayrollCycles(a, base.companyId);
    const monthly = cycles.find((c) => c.runType === 'regular')!.id;
    const off = cycles.find((c) => c.runType === 'off_cycle')!.id;
    const e = await hireEmployee(a, {
      person: { fullName: 'Fictional Leaver', primaryEmail: 'fictional.leaver@trace-shapes.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 1690, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '910101015499', subjectToSkbbk: true });
    await owner.db.update(schema.employment).set({ terminatedOn: '2026-10-13', resignationDate: '2026-10-13', lastWorkingDate: '2026-10-13' }).where(eq(schema.employment.id, e.employmentId));
    const outstanding = (cycleId: string) => createIndividualTxnsBulk(a, {
      companyId: base.companyId, payPeriod: PERIOD, intendedCycleId: cycleId, employmentIds: [e.employmentId],
      rows: [{ kind: 'overtime', txnDate: '2026-10-10', amount: 60.62 }],
    });

    await outstanding(monthly);
    const first = await createBatch(a, { companyId: base.companyId, payPeriod: PERIOD, payrollCycleId: monthly });
    await generatePayslips(a, { batchId: first.batchId });
    const f = statOf(await slipOf(first.batchId, e.employmentId));
    expect(f).toHaveProperty('postEmploymentPayment');
    expectRecorded(f, 'regular', 'first outstanding-payment cycle');

    await outstanding(off);
    const second = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: PERIOD, runType: 'off_cycle', payrollCycleId: off });
    await generatePayslips(a, { batchId: second.batchId });
    const s = statOf(await slipOf(second.batchId, e.employmentId));
    expectRecorded(s, 'off_cycle', 'later outstanding-payment cycle');
    expect(s.statutoryTrace!.run.kind).toBe('post_employment');
  });
});
