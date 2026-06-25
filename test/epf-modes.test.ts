/**
 * Wave 2B — EPF contribution modes (statutory-aligned). Three layers:
 *   • calculator (resolveEpfRates / epf): the statutory FLOOR (i-Topup can only RAISE a rate,
 *     never lower it below the Third Schedule), exempt = 0/0, per-side election ("semi-auto").
 *   • service (setStatutoryProfileMY): rejects a below-floor election; persists a valid one.
 *   • kernel (generatePayslips): the election flows onto the payslip; exempt zeroes EPF; net moves.
 * Sourced + re-verified (KWSP i-Topup, Form 17A/18A; EPF Act s.43) in docs/wave2-payroll-design.md.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { epf, resolveEpfRates } from '../localization/my/payroll';
import { getStatutoryProfileMY, setStatutoryProfileMY, InvalidEpfElectionError } from '../localization/my/statutory';
import { mapEpfUiMode } from '../lib/epf-mode-map';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const CFG = DEFAULT_MY_STATUTORY.epf;
const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
const payslipFor = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};
const st = (ps: { statutory: unknown }) => ps.statutory as Record<string, number | string>;

describe('Wave 2B — resolveEpfRates / epf calculator', () => {
  it('auto: statutory rates, employer banded by wage (13% ≤5000, 12% >5000)', () => {
    expect(resolveEpfRates(4000, CFG, { mode: 'auto' })).toEqual({ employeeRate: 0.11, employerRate: 0.13 });
    expect(resolveEpfRates(6000, CFG, { mode: 'auto' })).toEqual({ employeeRate: 0.11, employerRate: 0.12 });
  });
  it('voluntary_excess raises one side; the other stays statutory (semi-auto)', () => {
    expect(resolveEpfRates(4000, CFG, { mode: 'voluntary_excess', employeeRate: 0.15 })).toEqual({
      employeeRate: 0.15,
      employerRate: 0.13,
    });
  });
  it('enforces the statutory FLOOR: an elected rate below statutory is raised to statutory', () => {
    // Employee elects 9% (< 11%) → floored to 11%. Employer elects 12% for a ≤RM5,000 earner (< 13%) → 13%.
    expect(resolveEpfRates(4000, CFG, { mode: 'voluntary_excess', employeeRate: 0.09, employerRate: 0.12 })).toEqual({
      employeeRate: 0.11,
      employerRate: 0.13,
    });
  });
  it('exempt: 0/0', () => {
    expect(resolveEpfRates(4000, CFG, { mode: 'exempt' })).toEqual({ employeeRate: 0, employerRate: 0 });
  });
  it('epf() applies the election with round-up to the ringgit', () => {
    expect(epf(4000, 0, CFG, { mode: 'auto' })).toEqual({ employee: 440, employer: 520 });
    expect(epf(4000, 0, CFG, { mode: 'voluntary_excess', employeeRate: 0.15 })).toEqual({ employee: 600, employer: 520 });
    expect(epf(4000, 0, CFG, { mode: 'exempt' })).toEqual({ employee: 0, employer: 0 });
  });
});

describe('Wave 2B — EPF election service + kernel', () => {
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

  it('service rejects an i-Topup election below the statutory floor', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'BelowFloor');
    await expect(
      setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: '900101011234',
        epfMode: 'voluntary_excess',
        epfEmployeeRate: 0.09, // below 11%
      }),
    ).rejects.toBeInstanceOf(InvalidEpfElectionError);
  });

  it('voluntary_excess: a higher employee rate raises EPF on the payslip and lowers net', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'Topup');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234', epfMode: 'voluntary_excess', epfEmployeeRate: 0.15 });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // Employee EPF at 15% of 4000 = 600 (vs statutory 440); employer stays statutory 13% = 520.
    expect(st(ps).epfEmployee).toBe(600);
    expect(st(ps).epfEmployer).toBe(520);
    expect(st(ps).epfMode).toBe('voluntary_excess');
    // Net = gross 4000 − (600 EPF + SOCSO + EIS + PCB). The extra RM160 EPF is withheld from net.
    expect(Number(ps.netPay)).toBeCloseTo(Number(ps.grossPay) - Number(ps.totalDeductions), 2);
  });

  it('exempt: zero EPF on both sides', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'ExemptEmp');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011235', epfMode: 'exempt' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    expect(st(ps).epfEmployee).toBe(0);
    expect(st(ps).epfEmployer).toBe(0);
    expect(st(ps).epfMode).toBe('exempt');
  });

  // ADR-0046 — the five-category UI maps down to the three lawful enum values at the server boundary.
  // These round-trip the real mapper through setStatutoryProfileMY and assert the persisted shape.
  const persistUi = async (ctx: SessionContext, personId: string, ic: string, ui: string, ee?: string, er?: string) =>
    setStatutoryProfileMY(ctx, { personId, icNumber: ic, ...mapEpfUiMode(ui, ee ?? null, er ?? null) });

  it('ADR-0046: each of the 5 UI selections persists the mapped enum value + rates', async () => {
    const a = adminCtx(base);

    // Auto → auto, both rates null.
    const auto = await hire(a, base, 'UiAuto');
    await persistUi(a, auto.personId, '900101010001', 'auto');
    let row = await getStatutoryProfileMY(a, auto.personId);
    expect(row?.epfMode).toBe('auto');
    expect(row?.epfEmployeeRate).toBeNull();
    expect(row?.epfEmployerRate).toBeNull();

    // Manual (by percentage) → voluntary_excess, both rates set.
    const pctEmp = await hire(a, base, 'UiPct');
    await persistUi(a, pctEmp.personId, '900101010002', 'manual_percentage', '15', '13');
    row = await getStatutoryProfileMY(a, pctEmp.personId);
    expect(row?.epfMode).toBe('voluntary_excess');
    expect(Number(row?.epfEmployeeRate)).toBeCloseTo(0.15, 4);
    expect(Number(row?.epfEmployerRate)).toBeCloseTo(0.13, 4);

    // Semi-Auto → voluntary_excess, employee rate set, employer rate null (stays statutory).
    const semi = await hire(a, base, 'UiSemi');
    await persistUi(a, semi.personId, '900101010003', 'semi_auto', '15', '99');
    row = await getStatutoryProfileMY(a, semi.personId);
    expect(row?.epfMode).toBe('voluntary_excess');
    expect(Number(row?.epfEmployeeRate)).toBeCloseTo(0.15, 4);
    expect(row?.epfEmployerRate).toBeNull();

    // No contribution → exempt, both rates null.
    const none = await hire(a, base, 'UiNone');
    await persistUi(a, none.personId, '900101010004', 'none', '15', '13');
    row = await getStatutoryProfileMY(a, none.personId);
    expect(row?.epfMode).toBe('exempt');
    expect(row?.epfEmployeeRate).toBeNull();
    expect(row?.epfEmployerRate).toBeNull();

    // Manual fixed (deferred) → coerced to auto, both rates null.
    const fixed = await hire(a, base, 'UiFixed');
    await persistUi(a, fixed.personId, '900101010005', 'manual_fixed', '15', '13');
    row = await getStatutoryProfileMY(a, fixed.personId);
    expect(row?.epfMode).toBe('auto');
    expect(row?.epfEmployeeRate).toBeNull();
    expect(row?.epfEmployerRate).toBeNull();
  });

  it('ADR-0046: the statutory.my event payload carries epfMode + resolved rates (substrate discipline)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, base, 'EventPayload');
    await persistUi(a, e.personId, '900101010006', 'semi_auto', '15');

    const [ev] = await owner.db
      .select({ type: schema.domainEvent.eventType, payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateType, 'employee-statutory-my'));
    const p = ev.payload as Record<string, unknown>;
    expect(ev.type).toBe('statutory.my.created');
    expect(p.epfMode).toBe('voluntary_excess');
    expect(Number(p.epfEmployeeRate)).toBeCloseTo(0.15, 4);
    expect(p.epfEmployerRate).toBeNull();
  });
});

describe('ADR-0046 — EPF 5-category UI → 3-enum mapping (pure)', () => {
  // The mapper is pure (no DB); covers every UI category → enum value + the rates to persist.
  it('maps each of the 5 UI selections onto a lawful enum value', () => {
    expect(mapEpfUiMode('auto', null, null)).toEqual({ epfMode: 'auto', epfEmployeeRate: null, epfEmployerRate: null });
    expect(mapEpfUiMode('manual_percentage', '15', '13')).toEqual({ epfMode: 'voluntary_excess', epfEmployeeRate: 0.15, epfEmployerRate: 0.13 });
    // Semi-Auto: employee rate elected, employer side forced statutory (null) even if a value is sent.
    expect(mapEpfUiMode('semi_auto', '15', '99')).toEqual({ epfMode: 'voluntary_excess', epfEmployeeRate: 0.15, epfEmployerRate: null });
    expect(mapEpfUiMode('none', '15', '13')).toEqual({ epfMode: 'exempt', epfEmployeeRate: null, epfEmployerRate: null });
    // Manual fixed is deferred (ADR-0046) → coerced to auto; an unknown value also falls through to auto.
    expect(mapEpfUiMode('manual_fixed', '15', '13')).toEqual({ epfMode: 'auto', epfEmployeeRate: null, epfEmployerRate: null });
    expect(mapEpfUiMode('garbage', '15', '13')).toEqual({ epfMode: 'auto', epfEmployeeRate: null, epfEmployerRate: null });
  });
});
