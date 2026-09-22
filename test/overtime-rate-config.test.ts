/**
 * Overtime Rate Configuration & Attendance OT Breakdown (#e410da83).
 *
 * Two overtime EXCESS-hours multipliers become HR-configurable on the `ot` statutory ruleset body:
 *  - ot.restDayExcessMultiplier (EA s.60(3)(c), default 2×)
 *  - ot.holidayExcessMultiplier (EA s.60D(3)(aa), default 3×)
 * The workday 1.5× rate is deliberately NOT on the ruleset — it is owned by payroll-policy-config
 * (PayrollPolicyConfig.overtime.multiplier) and scaled once in applyOvertimeCaps. Duplicating it would
 * double-pay the workday leg; the double-apply guard below pins that it moves EXACTLY once.
 *
 * A dedicated overtimeReport surfaces per-employee categorised OT hours, the configured rates, the RM
 * amount computed via the SAME overtimePay path payroll uses (so the >RM4,000 eligibility gate yields
 * RM 0.00 with an explicit label), plus OT source/approval provenance.
 *
 * Guards (mirror the approved plan a–h):
 *  (a) Default ruleset ⇒ byte-identical golden overtimePay figures (fallback preserves 1.5/2/3).
 *  (b) A published ot override with changed excess multipliers ⇒ exact recomputed piecewise figures
 *      (only the excess leg moves; the base-day payment is unaffected; the workday leg is untouched).
 *  (c) Double-apply guard: a payroll_policy overtime.multiplier=2.0 scales the workday leg exactly once
 *      (via applyOvertimeCaps), while rest/holiday reflect only the ruleset excess multipliers.
 *  (d) validateRuleset rejects a 0 or negative multiplier; accepts a missing one (EA fallback).
 *  (e) The ruleset-published diff includes the changed ot.* multiplier fields.
 *  (f) Partial publish: edit wageCeiling only ⇒ multipliers survive; edit a multiplier only ⇒ ceiling survives.
 *  (g) Eligibility: a >RM4,000 employee ⇒ report row shows real OT hours, RM 0.00, and eligible=false.
 *  (h) Configured rates flow into overtimeReport RM amounts (rest/holiday excess reflect the override).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createPolicy, assignPolicy } from '../core/payroll-policy';
import { applyOvertimeCaps } from '../core/payroll-policy-config';
import { overtimePay } from '../localization/my/payroll';
import {
  getActiveStatutoryMY,
  saveStatutoryRulesetMY,
  setComponentOverrideMY,
  validateStatutoryRuleset,
} from '../localization/my/statutory-config';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from '../localization/my/statutory-tables';
import { overtimeReport } from '../core/reporting';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const clone = (r: StatutoryRuleset): StatutoryRuleset => JSON.parse(JSON.stringify(r));
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

describe('Overtime rate configuration (rest-day / holiday excess multipliers) + OT report', () => {
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

  async function hire(basic: number, email: string, hiredOn = '2026-01-01') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: `OT ${email}`, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: hiredOn });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    return e;
  }

  async function seedAttendance(
    employmentId: string,
    day: { date: string; dayType: 'workday' | 'rest_day' | 'holiday'; workedMinutes: number; otMinutes: number },
  ) {
    await owner.db.insert(schema.attendance).values({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: day.date,
      dayType: day.dayType,
      workedMinutes: day.workedMinutes,
      otMinutes: day.otMinutes,
    });
  }

  // (a) Default ruleset ⇒ byte-identical golden figures.
  it('(a) default multipliers reproduce the golden piecewise figures', () => {
    const wages = 2600; // orp = 100, hourly = 12.5
    const restExcessHours = 2; // 120 min beyond normal
    const res = overtimePay({
      monthlyWages: wages,
      days: [
        { dayType: 'rest_day', minutes: 480 + restExcessHours * 60 }, // full day + 2h excess
        { dayType: 'holiday', minutes: 480 + 60 }, // full day + 1h excess
      ],
    });
    const orp = round2(wages / 26); // 100
    const hourly = round2(orp / 8); // 12.5
    // rest day: 1 day ORP (100) + 2h × 2 × 12.5 = 100 + 50 = 150
    expect(res.restDay).toBe(round2(orp + 2 * 2 * hourly));
    // holiday: 2 days ORP (200) + 1h × 3 × 12.5 = 200 + 37.5 = 237.5
    expect(res.holiday).toBe(round2(2 * orp + 1 * 3 * hourly));
    // Explicit golden numbers (guards against a silent factor change).
    expect(res.restDay).toBe(150);
    expect(res.holiday).toBe(237.5);
  });

  /**
   * a96d320c — THE SAME GOLDEN FIGURES, DECOMPOSED INTO WHAT WAS MULTIPLIED BY WHAT.
   *
   * The board item asked the payslip to show the overtime rate and the hours behind it. `total` is one
   * number, so the engine now also returns the legs that produced it — and this test is the one that says
   * they are the SAME money, not a parallel calculation that could drift. Every leg is checked against
   * the reader's own arithmetic (`qty × rate === amount`), and the legs are checked to be the whole of
   * `total` rather than a subset of it. Nothing about `total`, `restDay`, `holiday` or `workday` moved:
   * guard (a) directly above still asserts the identical figures it always did.
   */
  it('(a2) the same run reports the legs behind the figure, and they are the whole of it', () => {
    const wages = 2600; // orp = 100, hourly = 12.5
    const res = overtimePay({
      monthlyWages: wages,
      days: [
        { dayType: 'workday', minutes: 120 }, //            2h at 1.5 x 12.50 = 37.50
        { dayType: 'rest_day', minutes: 480 + 120 }, //      1 day ORP (100) + 2h at 2 x 12.50 (50)
        { dayType: 'holiday', minutes: 480 + 60 }, //        2 days ORP (200) + 1h at 3 x 12.50 (37.50)
        { dayType: 'rest_day', minutes: 120 }, //            2h <= half a normal day => HALF a day's ORP
      ],
    });
    expect(res.lines).toEqual([
      { kind: 'workday', qty: 2, unit: 'hours', rate: 18.75, amount: 37.5 },
      // 1 full rest day + a half one: the day-FRACTIONS are summed, because that is how s.60(3)(b) pays.
      { kind: 'rest_day', qty: 1.5, unit: 'days', rate: 100, amount: 150 },
      { kind: 'rest_day_excess', qty: 2, unit: 'hours', rate: 25, amount: 50 },
      { kind: 'holiday', qty: 2, unit: 'days', rate: 100, amount: 200 },
      { kind: 'holiday_excess', qty: 1, unit: 'hours', rate: 37.5, amount: 37.5 },
    ]);
    // THE TWO PROPERTIES THE PAYSLIP LEANS ON, asserted here so no renderer has to re-derive them.
    for (const l of res.lines) expect(round2(l.qty * l.rate)).toBe(l.amount);
    expect(round2(res.lines.reduce((s, l) => s + l.amount, 0))).toBe(res.total);
  });

  it('(a3) an employee over the entitlement ceiling gets no legs, because there is no overtime to explain', () => {
    // The First Schedule gate already returns a zero total for a >RM4,000 earner. A decomposition of
    // nothing would be a set of hours beside no money, which is worse than silence.
    const res = overtimePay({ monthlyWages: 5000, days: [{ dayType: 'workday', minutes: 120 }] });
    expect(res.eligible).toBe(false);
    expect(res.total).toBe(0);
    expect(res.lines).toEqual([]);
  });

  // (b) Changed excess multipliers ⇒ exact recomputed figures; only the excess leg moves.
  it('(b) configured excess multipliers move ONLY the excess leg (base-day + workday unchanged)', () => {
    const wages = 2600;
    const orp = round2(wages / 26); // 100
    const hourly = round2(orp / 8); // 12.5
    const days = [
      { dayType: 'workday' as const, minutes: 120 }, // 2h workday OT
      { dayType: 'rest_day' as const, minutes: 480 + 120 }, // full day + 2h excess
      { dayType: 'holiday' as const, minutes: 480 + 60 }, // full day + 1h excess
    ];
    const custom = overtimePay({ monthlyWages: wages, days, restDayExcessMultiplier: 2.5, holidayExcessMultiplier: 4 });
    // Workday leg: 2h × 1.5 × 12.5 = 37.5 — UNCHANGED by the ruleset (owned by payroll-policy).
    expect(custom.workday).toBe(round2(2 * 1.5 * hourly));
    expect(custom.workday).toBe(37.5);
    // Rest day: 1 day ORP (100) + 2h × 2.5 × 12.5 = 100 + 62.5 = 162.5 (base-day 100 unchanged).
    expect(custom.restDay).toBe(round2(orp + 2 * 2.5 * hourly));
    expect(custom.restDay).toBe(162.5);
    // Holiday: 2 days ORP (200) + 1h × 4 × 12.5 = 200 + 50 = 250 (base-day 200 unchanged).
    expect(custom.holiday).toBe(round2(2 * orp + 1 * 4 * hourly));
    expect(custom.holiday).toBe(250);
  });

  // (c) DOUBLE-APPLY GUARD: workday scaled exactly once by payroll-policy; rest/holiday reflect only the ruleset.
  it('(c) payroll_policy multiplier scales the workday leg ONCE; rest/holiday untouched by it', () => {
    const wages = 2600;
    const hourly = round2(round2(wages / 26) / 8); // 12.5
    // Engine emits the statutory 1.5× workday leg + configured excess legs.
    const engine = overtimePay({
      monthlyWages: wages,
      days: [
        { dayType: 'workday', minutes: 120 }, // 2h
        { dayType: 'rest_day', minutes: 480 + 120 },
        { dayType: 'holiday', minutes: 480 + 60 },
      ],
      restDayExcessMultiplier: 2,
      holidayExcessMultiplier: 3,
    });
    // A per-employment policy sets workday multiplier 2.0 — applyOvertimeCaps scales ONLY the workday bucket.
    const config = { overtime: { multiplier: 2.0 } };
    const capped = applyOvertimeCaps(config, {
      workday: engine.workday,
      restDay: engine.restDay,
      holiday: engine.holiday,
      workedOtHours: (120 + (480 + 120) + (480 + 60)) / 60,
    });
    // Workday leg: engine paid 2h × 1.5 × 12.5 = 37.5; policy scales by 2.0/1.5 ⇒ 50 (2h × 2.0 × 12.5). ONCE.
    const expectedWorkday = round2(2 * 2.0 * hourly); // 50
    // Total = scaled workday + UNCHANGED rest + UNCHANGED holiday.
    expect(capped).toBe(round2(expectedWorkday + engine.restDay + engine.holiday));
    // Sanity: the workday leg did NOT move twice (a double-apply would be 2h × 1.5 × 2.0 × 12.5 = 75).
    expect(capped).not.toBe(round2(round2(2 * 1.5 * 2.0 * hourly) + engine.restDay + engine.holiday));
  });

  // (d) Validation rejects a 0/negative multiplier; a missing one is allowed (EA fallback).
  it('(d) validateRuleset rejects a 0 or negative excess multiplier; a missing one is allowed', () => {
    expect(validateStatutoryRuleset(DEFAULT_MY_STATUTORY)).toEqual([]);
    const zero = clone(DEFAULT_MY_STATUTORY);
    zero.ot.restDayExcessMultiplier = 0;
    expect(validateStatutoryRuleset(zero).some((e) => /rest-day excess/.test(e))).toBe(true);
    const neg = clone(DEFAULT_MY_STATUTORY);
    neg.ot.holidayExcessMultiplier = -1;
    expect(validateStatutoryRuleset(neg).some((e) => /public-holiday excess/.test(e))).toBe(true);
    const missing = clone(DEFAULT_MY_STATUTORY);
    delete missing.ot.restDayExcessMultiplier;
    delete missing.ot.holidayExcessMultiplier;
    expect(validateStatutoryRuleset(missing)).toEqual([]);
  });

  // (e) The ruleset-published diff includes the changed ot.* multiplier fields.
  it('(e) publishing a ruleset with changed multipliers records them in the audit diff', async () => {
    const a = adminCtx(base);
    const data = clone(DEFAULT_MY_STATUTORY);
    data.ot.restDayExcessMultiplier = 2.5;
    data.ot.holidayExcessMultiplier = 3.5;
    const { id } = await saveStatutoryRulesetMY(a, { version: 'ot-cfg', effectiveFrom: '2026-06-01', data });
    expect(await eventTypesFor(base.tenantId, id)).toContain('statutory.config.updated');
    const payload = (await latestEventPayload(base.tenantId, id, 'statutory.config.updated'))!;
    const changed = payload.changed as string[];
    expect(changed).toContain('ot.restDayExcessMultiplier');
    expect(changed).toContain('ot.holidayExcessMultiplier');
  });

  // (f) Partial publish: editing one field preserves the others (epf-style merge, mirrors the action).
  it('(f) a partial ot override preserves the non-edited fields (merge onto the active ot slice)', async () => {
    const a = adminCtx(base);
    // Establish a baseline override carrying all three fields.
    await setComponentOverrideMY(a, {
      body: 'ot',
      version: 'ot-base',
      effectiveFrom: '2026-05-01',
      data: { wageCeiling: 4500, restDayExcessMultiplier: 2.2, holidayExcessMultiplier: 3.3 },
    });
    // Now publish an override that changes ONLY the ceiling — replicate the action's merge onto current.ot.
    const current = await withTenant(a, (tx) => getActiveStatutoryMY(tx, { asOf: '2026-06-01' }));
    await setComponentOverrideMY(a, {
      body: 'ot',
      version: 'ot-ceiling-only',
      effectiveFrom: '2026-06-01',
      data: { ...current.ot, wageCeiling: 5000 },
    });
    const after = await withTenant(a, (tx) => getActiveStatutoryMY(tx, { asOf: '2026-06-30' }));
    expect(after.ot.wageCeiling).toBe(5000);
    expect(after.ot.restDayExcessMultiplier).toBe(2.2); // survived
    expect(after.ot.holidayExcessMultiplier).toBe(3.3); // survived

    // And editing a multiplier only preserves the ceiling.
    const current2 = await withTenant(a, (tx) => getActiveStatutoryMY(tx, { asOf: '2026-07-01' }));
    await setComponentOverrideMY(a, {
      body: 'ot',
      version: 'ot-mult-only',
      effectiveFrom: '2026-07-01',
      data: { ...current2.ot, restDayExcessMultiplier: 2.8 },
    });
    const after2 = await withTenant(a, (tx) => getActiveStatutoryMY(tx, { asOf: '2026-07-31' }));
    expect(after2.ot.wageCeiling).toBe(5000); // survived
    expect(after2.ot.restDayExcessMultiplier).toBe(2.8);
    expect(after2.ot.holidayExcessMultiplier).toBe(3.3); // survived
  });

  // (g) Eligibility: a >RM4,000 employee ⇒ real OT hours, RM 0.00, eligible=false.
  it('(g) a >RM4,000 employee shows real OT hours, RM 0.00, and eligible=false in the report', async () => {
    const e = await hire(5000, 'above@acme.test'); // over the RM4,000 ceiling
    await seedAttendance(e.employmentId, { date: '2026-05-06', dayType: 'workday', workedMinutes: 600, otMinutes: 120 });
    const report = await overtimeReport(adminCtx(base), { month: '2026-05', companyIds: [base.companyId] });
    const row = report.rows.find((r) => r.employmentId === e.employmentId)!;
    expect(row.normalDayOtHours).toBe(2); // real classified hours surfaced
    expect(row.otAmount).toBe(0); // no statutory OT pay above the ceiling
    expect(row.eligible).toBe(false);
    expect(row.otSource).toBe('system');
  });

  // (h) Configured rates flow into the report RM amount, reconciling with overtimePay.
  it('(h) the report RM amount reflects the configured excess multipliers', async () => {
    const a = adminCtx(base);
    // Publish an ot override raising the rest-day excess to 2.5×, effective before the report month-end.
    await setComponentOverrideMY(a, {
      body: 'ot',
      version: 'ot-rest-2.5',
      effectiveFrom: '2026-05-01',
      data: { ...DEFAULT_MY_STATUTORY.ot, restDayExcessMultiplier: 2.5 },
    });
    const e = await hire(2600, 'rest@acme.test'); // orp 100, hourly 12.5, under ceiling
    // A rest day: full day + 2h excess.
    await seedAttendance(e.employmentId, { date: '2026-05-03', dayType: 'rest_day', workedMinutes: 480 + 120, otMinutes: 480 + 120 });
    const report = await overtimeReport(a, { month: '2026-05', companyIds: [base.companyId] });
    const row = report.rows.find((r) => r.employmentId === e.employmentId)!;
    expect(row.restDayExcessMultiplier).toBe(2.5);
    // Recompute the exact expected total with the SAME overtimePay path.
    const expected = overtimePay({
      monthlyWages: 2600,
      days: [{ dayType: 'rest_day', minutes: 480 + 120 }],
      restDayExcessMultiplier: 2.5,
      holidayExcessMultiplier: 3,
    });
    expect(row.otAmount).toBe(round2(expected.total));
    expect(row.eligible).toBe(true);
    // 1 day ORP (100) + 2h × 2.5 × 12.5 = 100 + 62.5 = 162.5.
    expect(row.otAmount).toBe(162.5);
  });

  // Provenance: an approved OT correction ⇒ 'requested'; a pending one ⇒ approval status 'pending'.
  it('reports OT provenance/approval from the correction workflow', async () => {
    const a = adminCtx(base);
    const e = await hire(2600, 'prov@acme.test');
    await seedAttendance(e.employmentId, { date: '2026-05-04', dayType: 'workday', workedMinutes: 600, otMinutes: 120 });
    // A decided (approved) OT correction ⇒ employee-requested; no pending ⇒ approved.
    await owner.db.insert(schema.attendanceCorrection).values({
      tenantId: base.tenantId,
      employmentId: e.employmentId,
      attendanceDate: '2026-05-04',
      requestedOtMinutes: 120,
      approvedOtMinutes: 120,
      status: 'approved',
    });
    let report = await overtimeReport(a, { month: '2026-05', companyIds: [base.companyId] });
    let row = report.rows.find((r) => r.employmentId === e.employmentId)!;
    expect(row.otSource).toBe('requested');
    expect(row.otApprovalStatus).toBe('approved');

    // A pending OT correction on another date ⇒ approval outstanding.
    await owner.db.insert(schema.attendanceCorrection).values({
      tenantId: base.tenantId,
      employmentId: e.employmentId,
      attendanceDate: '2026-05-05',
      requestedOtMinutes: 60,
      status: 'pending',
    });
    report = await overtimeReport(a, { month: '2026-05', companyIds: [base.companyId] });
    row = report.rows.find((r) => r.employmentId === e.employmentId)!;
    expect(row.otApprovalStatus).toBe('pending');
  });

  // The payroll-policy assignment path (c) also holds end-to-end through the config service — sanity that a
  // stored policy + a published ruleset coexist without double-scaling. Uses createPolicy/assignPolicy.
  it('(c-e2e) a stored payroll policy and a published ruleset coexist without double-scaling the workday leg', async () => {
    const a = adminCtx(base);
    const e = await hire(2600, 'e2e@acme.test');
    const { id } = await createPolicy(a, { companyId: base.companyId, name: 'OT 2x', policyType: 'monthly', config: { overtime: { multiplier: 2.0 } } });
    await assignPolicy(a, { employmentId: e.employmentId, policyId: id });
    // Confirm the policy row stored the above-floor multiplier (the double-apply risk lives in the kernel,
    // exercised as a pure unit in (c); here we just confirm the two configuration surfaces are independent).
    const [policyRow] = await owner.db
      .select()
      .from(schema.employment)
      .where(and(eq(schema.employment.id, e.employmentId), eq(schema.employment.tenantId, base.tenantId)));
    expect(policyRow.payrollPolicyId).toBe(id);
    // The ruleset excess multipliers remain the EA defaults (nothing published) — no interaction.
    const ruleset = await withTenant(a, (tx) => getActiveStatutoryMY(tx, { asOf: '2026-05-31' }));
    expect(ruleset.ot.restDayExcessMultiplier).toBe(2);
    expect(ruleset.ot.holidayExcessMultiplier).toBe(3);
  });
});
