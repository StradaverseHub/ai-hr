/**
 * 1.2.3 CP38 Deduction (ADR-0057) — the LHDN/court instalment deducted each payroll month in addition to
 * MTD/PCB. Covers: supersede-on-write effective dating, the gist EXCLUDE concurrency backstop, RLS
 * (admin write / self read / manager-and-peer cannot read another's amount), auto-apply by payroll month,
 * the additional-run no-re-charge invariant, the cross-run CP39 single-instalment invariant, the
 * processed-period guard, and DomainEvent substrate (events appended, no cleartext amount in payload).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { expectNoLeakedValue, leafValues } from './helpers/leaf-values';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, createAdditionalRun, generatePayslips } from '../core/payroll';
import { cp39FileForBatch } from '../localization/my/cp39-file';
import {
  listCp38,
  setCp38,
  updateCp38,
  terminateCp38,
  Cp38PeriodProcessedError,
} from '../core/cp38';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

/** The payslip's statutory blob for an employment in a given period (latest batch). */
async function statutoryFor(
  ctx: SessionContext,
  employmentId: string,
  period: string,
): Promise<Record<string, number>> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ statutory: schema.payslip.statutory, other: schema.payslip.otherDeductions })
      .from(schema.payslip)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
      .where(and(eq(schema.payslip.employmentId, employmentId), eq(schema.payrollBatch.payPeriod, period)))
      .limit(1);
    return { ...((row?.statutory ?? {}) as Record<string, number>), otherDeductions: Number(row?.other ?? 0) };
  });
}

describe('1.2.3 CP38 Deduction', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('supersede-on-write: a second setCp38 closes the prior open row (no overlap)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 A');
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/1', amount: 200, validFrom: '2026-03-01' });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/2', amount: 150, validFrom: '2026-06-01' });

    const rows = await listCp38(a, { employmentId: e.employmentId });
    expect(rows).toHaveLength(2);
    // Latest-effective first.
    expect(rows[0].cp38Ref).toBe('CP38/2');
    expect(rows[0].validTo).toBeNull();
    // The prior row was closed at the new row's start so the windows don't overlap.
    const prior = rows.find((r) => r.cp38Ref === 'CP38/1')!;
    expect(prior.validTo).toBe('2026-06-01');
  });

  it('normalises any input date to month-start', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Mid');
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/MID', amount: 100, validFrom: '2026-03-17', validTo: '2026-08-20' });
    const [row] = await listCp38(a, { employmentId: e.employmentId });
    expect(row.validFrom).toBe('2026-03-01');
    expect(row.validTo).toBe('2026-08-01');
  });

  it('edit + terminate adjust the open row', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Edit');
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/E', amount: 200, validFrom: '2026-03-01' });
    await updateCp38(a, { id, amount: 250, remarks: 'revised' });
    let [row] = await listCp38(a, { employmentId: e.employmentId });
    expect(Number(row.amount)).toBe(250);
    expect(row.remarks).toBe('revised');

    await terminateCp38(a, { id });
    [row] = await listCp38(a, { employmentId: e.employmentId });
    expect(row.supersededAt).not.toBeNull();
    expect(row.validTo).not.toBeNull(); // closed, stops applying
  });

  it('gist EXCLUDE rejects a direct overlapping insert (concurrency backstop)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Overlap');
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/O', amount: 200, validFrom: '2026-03-01' });
    // Bypass supersede-on-write: insert a second OPEN row for the same employment that overlaps.
    // The DB rejects it via the gist EXCLUDE; drizzle wraps the driver error, so assert on the
    // underlying cause (which names the constraint) rather than the wrapper's "Failed query" text.
    let caught: unknown;
    try {
      await owner.db.insert(schema.employeeCp38).values({
        tenantId: base.tenantId,
        employmentId: e.employmentId,
        cp38Ref: 'CP38/DUP',
        amount: '999.00',
        validFrom: '2026-04-01',
        validTo: null,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const blob = `${(caught as Error)?.message ?? ''} ${JSON.stringify((caught as { cause?: unknown })?.cause ?? {})}`;
    expect(blob).toMatch(/employee_cp38_no_overlap|exclusion|conflicting key value/i);
  });

  it('RLS: non-admin cannot write; self can read own; manager/peer cannot read another’s amount', async () => {
    const a = adminCtx(base);
    const me = await hire(a, base, 'CP38 Self');
    const other = await hire(a, base, 'CP38 Other');
    await setCp38(a, { employmentId: me.employmentId, cp38Ref: 'CP38/SELF', amount: 300, validFrom: '2026-03-01' });
    await setCp38(a, { employmentId: other.employmentId, cp38Ref: 'CP38/OTH', amount: 400, validFrom: '2026-03-01' });

    const uSelf = await createAppUser(base.tenantId, me.personId, 'employee');
    const uMgr = await createAppUser(base.tenantId, other.personId, 'manager'); // "other" is also a manager of "me"
    await setReportingLine(a, {
      subordinateEmploymentId: me.employmentId,
      managerEmploymentId: other.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });

    const selfCtx: SessionContext = { tenantId: base.tenantId, userId: uSelf, roles: ['employee'] };
    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uMgr, roles: ['manager'] };

    // Self reads own CP38.
    const selfRows = await listCp38(selfCtx, { employmentId: me.employmentId });
    expect(selfRows.map((r) => r.cp38Ref)).toContain('CP38/SELF');

    // A manager can see a subordinate's CP38 (can_see_employment includes the admin reporting line) — but a
    // bare employee (peer) cannot read someone else's. Assert the peer leg: self cannot read OTHER's amount.
    const peerRows = await listCp38(selfCtx, { employmentId: other.employmentId });
    expect(peerRows).toHaveLength(0);

    // Non-admin write is rejected by RLS WITH CHECK (is_admin()).
    await expect(
      setCp38(mgrCtx, { employmentId: me.employmentId, cp38Ref: 'CP38/HACK', amount: 1, validFrom: '2026-07-01' }),
    ).rejects.toThrow();
  });

  it('auto-applies the correct amount by payroll month, and 0 outside the window / when terminated', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Auto');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101012222' });

    // RM200 for 2026-03..2026-05, then supersede with RM150 from 2026-06 onward.
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/200', amount: 200, validFrom: '2026-03-01', validTo: '2026-05-01' });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/150', amount: 150, validFrom: '2026-06-01' });

    // 2026-02 (before any window) → 0.
    const feb = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId: feb.batchId });
    const stFeb = await statutoryFor(a, e.employmentId, '2026-02');
    expect(stFeb.cp38 ?? 0).toBe(0);

    // 2026-04 (inside the RM200 window) → 200, reflected in otherDeductions.
    const apr = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId: apr.batchId });
    const stApr = await statutoryFor(a, e.employmentId, '2026-04');
    expect(stApr.cp38).toBe(200);
    expect(stApr.cp38Ref as unknown).toBe('CP38/200');
    expect(stApr.otherDeductions).toBeGreaterThanOrEqual(200);

    // 2026-06 (inside the RM150 window) → 150.
    const jun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: jun.batchId });
    const stJun = await statutoryFor(a, e.employmentId, '2026-06');
    expect(stJun.cp38).toBe(150);
  });

  it('terminated/closed row contributes 0 to a later month', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Term');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101013333' });
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/T', amount: 200, validFrom: '2026-01-01' });
    await terminateCp38(a, { id }); // closes at the current month (2026-06 per the harness clock baseline is "now")

    // A month well after the close (2026-12) must see 0.
    const dec = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-12' });
    await generatePayslips(a, { batchId: dec.batchId });
    const st = await statutoryFor(a, e.employmentId, '2026-12');
    expect(st.cp38 ?? 0).toBe(0);
  });

  it('additional run does NOT re-charge CP38 (regular=200, bonus=0 in the same period)', async () => {
    // ADR-0077 slice 3: multi-cycle payroll is a per-tenant entitlement row now, not a deployment env
    // flag — `createAdditionalRun` reads `isModuleEnabled(ctx, 'multi_cycle_payroll')` off the session's
    // snapshot (core/payroll.ts:667). Two consequences, both load-bearing here:
    //   1. the grant must be written BEFORE the context is built, because a snapshot is a point-in-time
    //      read (harness.ts, entitledCtx);
    //   2. it must be `entitledCtx`, not `adminCtx`. adminCtx's snapshot is derived from
    //      `legacyEnabledModulesIn(process.env)`, and test/env.ts:37 deletes MULTI_CYCLE_PAYROLL_ENABLED
    //      — so adminCtx would still answer "off" no matter what row this test writes, and the
    //      createAdditionalRun call below would throw ModuleNotEnabledError.
    // No teardown needed: the row is truncated by resetDb() in beforeEach.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'CP38 Multi');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101014444' });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/M', amount: 200, validFrom: '2026-05-01' });

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await generatePayslips(a, { batchId: bonus.batchId });

    // Read the two payslips of the period for this employment.
    const slips = await withTenant(a, (tx) =>
      tx
        .select({ runType: schema.payrollBatch.runType, statutory: schema.payslip.statutory })
        .from(schema.payslip)
        .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
        .where(and(eq(schema.payslip.employmentId, e.employmentId), eq(schema.payrollBatch.payPeriod, '2026-05'))),
    );
    const regSt = slips.find((s) => s.runType === 'regular')!.statutory as Record<string, number>;
    const bonusSt = slips.find((s) => s.runType === 'bonus')!.statutory as Record<string, number>;
    expect(regSt.cp38).toBe(200);
    expect(bonusSt.cp38 ?? 0).toBe(0);

    // Cross-run invariant: the CP39 file for the period counts ONE instalment (200), not two.
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101014444', taxNumber: 'IG 531367080' });
    await setCompanyStatutoryMY(a, { companyId: base.companyId, lhdnEmployerNo: 'E 908915-10' });
    const f = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: '2026-05' });
    expect(f.totals.cp38Cents).toBe(20000); // RM200.00 once
    expect(f.totals.cp38Records).toBe(1);
  });

  it('CP39 file carries a non-zero CP38 header + detail field end-to-end', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Cp39');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015555', taxNumber: 'IG 531367080' });
    await setCompanyStatutoryMY(a, { companyId: base.companyId, lhdnEmployerNo: 'E 908915-10' });
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/F', amount: 320.5, validFrom: '2026-01-01' });

    const jan = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: jan.batchId });

    const f = await cp39FileForBatch(a, { companyId: base.companyId, periodKey: '2026-01' });
    expect(f.totals.cp38Cents).toBe(32050); // RM320.50
    expect(f.totals.cp38Records).toBe(1);
    const [header, detail] = f.content.split('\r\n');
    // Header layout: H(1)+E(10)+E(10)+yyyy(4)+mm(2)=27, MTD cents[27..37), MTD recs[37..42), CP38 cents[42..52).
    expect(header.slice(42, 52)).toBe('0000032050'); // total CP38 cents = RM320.50
    // Detail layout: D(1)+TIN(11)=12, name[12..72), oldIC[72..84), newIC[84..96), passport[96..108),
    // country[108..110), MTD[110..118), CP38[118..126).
    expect(detail.slice(118, 126)).toBe('00032050'); // CP38 cents = RM320.50
  });

  it('processed-period guard blocks edit/terminate once a non-draft payslip covers the period', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Guard');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101016666' });
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/G', amount: 200, validFrom: '2026-03-01' });

    // Process March → the CP38 window now overlaps a processed period.
    const mar = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(a, { batchId: mar.batchId }); // batch flips to 'processed'

    await expect(updateCp38(a, { id, amount: 250 })).rejects.toThrow(Cp38PeriodProcessedError);
    await expect(terminateCp38(a, { id })).rejects.toThrow(Cp38PeriodProcessedError);
  });

  it('appends DomainEvents on add/update/terminate without the cleartext amount in the payload', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'CP38 Event');
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/EV', amount: 275, validFrom: '2026-03-01' });
    await updateCp38(a, { id, amount: 280 });
    await terminateCp38(a, { id });

    const types = await eventTypesFor(base.tenantId, id);
    expect(types).toEqual(expect.arrayContaining(['employee-cp38.added', 'employee-cp38.updated', 'employee-cp38.terminated']));

    // No cleartext amount anywhere in any of the three payloads (ADR-0030 Layer 0: the amount lives
    // on the aggregate row; the event keeps refs and dates only).
    //
    // Asserted by VALUE, not by substring-scanning the serialized blob. The previous
    // `expect(JSON.stringify(payload)).not.toContain('275')` was flaky AND weak: every payload here
    // carries an employmentId, and a random UUID's hex digits collide with a 3-digit decimal needle
    // roughly 0.73% of the time — two needles across three payloads is the ~1% clean-room failure that
    // was actually observed. It was weak because a substring scan only ever catches the one literal it
    // is handed. See test/helpers/leaf-values.ts; zakat-history.test.ts hit this first (91b2e4d).
    for (const t of ['employee-cp38.added', 'employee-cp38.updated', 'employee-cp38.terminated']) {
      const payload = await latestEventPayload(base.tenantId, id, t);
      expectNoLeakedValue(payload, 275); // the original amount
      expectNoLeakedValue(payload, 280); // the updated amount
      // …and the payload is refs/dates/field-names ONLY — a whitelist, so an amount added under ANY
      // new key fails here even though neither literal above would catch it.
      const keys = Object.keys(payload as Record<string, unknown>).sort();
      const allowed = ['after', 'before', 'cp38Ref', 'diff', 'employmentId', 'validFrom', 'validTo'];
      expect(keys.every((k) => allowed.includes(k)), `unexpected payload keys on ${t}: ${keys}`).toBe(true);
      expect(leafValues(payload)).toContain('CP38/EV'); // the reference IS allowed
    }

    // The `updated` event is the sharp case, and the distinction its design rests on: `diff` is
    // `Object.keys(patch)` (core/cp38.ts:229), so it records THAT the amount changed — the literal
    // field NAME 'amount' — while never recording WHAT it changed to. Both halves asserted, because
    // dropping the name would be a silent audit regression and adding the value would be the leak.
    {
      const updated = (await latestEventPayload(base.tenantId, id, 'employee-cp38.updated')) as {
        diff: string[];
      };
      expect(updated.diff).toContain('amount'); // the field name IS recorded
      expectNoLeakedValue(updated, 280); // the field VALUE is not
    }
  });
});
