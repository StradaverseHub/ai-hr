/**
 * 2.1.1 Payroll Policy — Monthly General Settings config (ADR-0064). Two halves:
 *
 *  A) `cleanPayrollPolicyConfig` validation (pure, no DB): rejects/clamps bad input, FLOORS a sub-s.60A OT
 *     multiplier, drops all-default sub-groups to null (so an all-default config is byte-identical).
 *
 *  B) The DEFAULT-EQUALS-LEGACY GOLDEN MATRIX (the load-bearing proof): for a full month, a prorated mid-month
 *     hire, an OT-present case, an unpaid-days case, and each rounding mode, a NULL/default config reproduces
 *     today's EXACT payslip numbers — AND a NON-DEFAULT config MEASURABLY changes them. To remove cross-period
 *     statutory drift, the legacy employee and the config employee always run in the SAME batch (same company,
 *     same period ⇒ same statutory month), exactly like the existing byte-identical regression test. This is
 *     what proves the kernel now actually reads the assigned policy (the inertness test alone cannot).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { assignPolicy, createPolicy } from '../core/payroll-policy';
import { cleanPayrollPolicyConfig, EA_S60A_WORKDAY_OT_FLOOR, unpaidTimeOffDailyRate } from '../core/payroll-policy-config';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('2.1.1 cleanPayrollPolicyConfig — validation + s.60A floor', () => {
  it('null/undefined/empty/all-default ⇒ null (an all-default config is byte-identical)', () => {
    expect(cleanPayrollPolicyConfig(null)).toBeNull();
    expect(cleanPayrollPolicyConfig(undefined)).toBeNull();
    expect(cleanPayrollPolicyConfig({})).toBeNull();
    expect(cleanPayrollPolicyConfig({ rounding: { earnings: 'none', deductions: 'none', netPay: 'none' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ proration: { divisor: 'calendar_month' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ negativeNet: 'retain' })).toBeNull();
    // All three OT day types = no restriction ⇒ dropped.
    expect(cleanPayrollPolicyConfig({ overtime: { eligibleDayTypes: ['workday', 'rest_day', 'holiday'] } })).toBeNull();
  });

  it('coerces + clamps stray values to the safe default (never throws)', () => {
    expect(cleanPayrollPolicyConfig({ rounding: { earnings: 'bogus' } })).toBeNull(); // bogus ⇒ none ⇒ dropped
    expect(cleanPayrollPolicyConfig({ proration: { divisor: 'custom_days', customDays: 99 } })).toBeNull(); // 99>31 ⇒ dropped
    // A valid non-default value is kept.
    expect(cleanPayrollPolicyConfig({ rounding: { netPay: 'up' } })).toEqual({ rounding: { netPay: 'up' } });
    expect(cleanPayrollPolicyConfig({ proration: { divisor: 'custom_days', customDays: 26 } })).toEqual({
      proration: { divisor: 'custom_days', customDays: 26 },
    });
  });

  it('FLOORS a sub-s.60A OT multiplier and keeps an above-floor one', () => {
    // A sub-statutory multiplier (1.0) is raised to the floor (1.5) — which then equals the default ⇒ dropped.
    expect(cleanPayrollPolicyConfig({ overtime: { multiplier: 1.0 } })).toBeNull();
    // Exactly the floor ⇒ dropped (no change).
    expect(cleanPayrollPolicyConfig({ overtime: { multiplier: EA_S60A_WORKDAY_OT_FLOOR } })).toBeNull();
    // Above the floor ⇒ kept.
    expect(cleanPayrollPolicyConfig({ overtime: { multiplier: 2.0 } })).toEqual({ overtime: { multiplier: 2.0 } });
  });

  it('f3148da1 Step 2 — accepts carry_forward (an unknown value still falls back to retain ⇒ dropped)', () => {
    expect(cleanPayrollPolicyConfig({ negativeNet: 'carry_forward' })).toEqual({ negativeNet: 'carry_forward' });
    expect(cleanPayrollPolicyConfig({ negativeNet: 'set_zero' })).toEqual({ negativeNet: 'set_zero' });
    expect(cleanPayrollPolicyConfig({ negativeNet: 'bogus' })).toBeNull(); // ⇒ retain ⇒ dropped
  });

  it('f3148da1 Step 3 — keeps independently-configurable new-hire / resigned proration overrides', () => {
    // A custom_days hire override + a working-day-basis resign override are both persisted independently.
    expect(
      cleanPayrollPolicyConfig({
        prorationHire: { divisor: 'custom_days', customDays: 26 },
        prorationResign: { includeSaturday: true },
      }),
    ).toEqual({
      prorationHire: { divisor: 'custom_days', customDays: 26 },
      prorationResign: { includeSaturday: true },
    });
    // An all-default (calendar) override collapses to null (byte-identical ⇒ inherits the shared proration).
    expect(cleanPayrollPolicyConfig({ prorationHire: { divisor: 'calendar_month' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ prorationResign: {} })).toBeNull();
  });

  it('keeps a proper-subset OT eligible-day restriction', () => {
    expect(cleanPayrollPolicyConfig({ overtime: { eligibleDayTypes: ['workday'] } })).toEqual({
      overtime: { eligibleDayTypes: ['workday'] },
    });
  });

  it('2.1.4 — custom-period cut-off window: keeps a valid anchorDay, drops calendar / out-of-range / non-custom', () => {
    // mode='custom' + a valid 1..28 anchorDay is kept.
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 25 } })).toEqual({
      cutOff: { mode: 'custom', anchorDay: 25 },
    });
    // Boundaries: 1 and 28 are valid; 0 and 29..31 are dropped (the month-length trap guard).
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 1 } })).toEqual({ cutOff: { mode: 'custom', anchorDay: 1 } });
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 28 } })).toEqual({ cutOff: { mode: 'custom', anchorDay: 28 } });
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 0 } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 29 } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 31 } })).toBeNull();
    // mode='custom' with a missing / non-numeric anchorDay ⇒ dropped (a custom window with no anchor is a no-op).
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'custom', anchorDay: 'bogus' } })).toBeNull();
    // mode='calendar' (the legacy default) ⇒ dropped, even if an anchorDay rides along (byte-identical to null).
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'calendar', anchorDay: 25 } })).toBeNull();
    // An unknown mode falls back to calendar ⇒ dropped.
    expect(cleanPayrollPolicyConfig({ cutOff: { mode: 'weird', anchorDay: 25 } })).toBeNull();
  });

  it('keeps a non-default leave divisor', () => {
    expect(cleanPayrollPolicyConfig({ leave: { unpaidLeaveDivisor: 'custom_days', customDays: 26 } })).toEqual({
      leave: { unpaidLeaveDivisor: 'custom_days', customDays: 26 },
    });
  });

  // f3148da1 Step 5 (R17 gap-fix reinstatement) — the Unpaid Time Off Deduction Formula round-trips through
  // the cleaner, including its per-time modes; defaults drop to null; unknown values fall back.
  it('unpaidTimeOffDivisor: keeps non-default modes (incl. custom_hours/custom_minutes), drops defaults', () => {
    expect(cleanPayrollPolicyConfig({ leave: { unpaidTimeOffDivisor: 'working_days' } })).toEqual({
      leave: { unpaidTimeOffDivisor: 'working_days' },
    });
    expect(cleanPayrollPolicyConfig({ leave: { unpaidTimeOffDivisor: 'custom_hours', customHours: 173 } })).toEqual({
      leave: { unpaidTimeOffDivisor: 'custom_hours', customHours: 173 },
    });
    expect(cleanPayrollPolicyConfig({ leave: { unpaidTimeOffDivisor: 'custom_minutes', customMinutes: 10380 } })).toEqual({
      leave: { unpaidTimeOffDivisor: 'custom_minutes', customMinutes: 10380 },
    });
    // the calendar-month default and an unknown mode both collapse back to null (byte-identical to no config)
    expect(cleanPayrollPolicyConfig({ leave: { unpaidTimeOffDivisor: 'calendar_month' } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ leave: { unpaidTimeOffDivisor: 'bogus' } })).toBeNull();
    // a zero/negative custom time value is dropped (the kernel then falls back to the pooled unpaid path)
    expect(cleanPayrollPolicyConfig({ leave: { unpaidTimeOffDivisor: 'custom_hours', customHours: 0 } })).toEqual({
      leave: { unpaidTimeOffDivisor: 'custom_hours' },
    });
  });

  it('unpaidTimeOffDailyRate: null when unconfigured; day, hour and minute modes value one time-off day', () => {
    const facts = { calendarDaysInMonth: 30, cutoffDays: 30, workingDays: 22 };
    // absent config / absent divisor ⇒ null ⇒ the caller keeps the legacy pooled unpaid-leave path
    expect(unpaidTimeOffDailyRate(3000, null, facts)).toBeNull();
    expect(unpaidTimeOffDailyRate(3000, { leave: { unpaidLeaveDivisor: 'working_days' } }, facts)).toBeNull();
    // day modes reuse the leave-divisor facts: working_days ⇒ basic/22; custom_days ⇒ basic/26
    expect(unpaidTimeOffDailyRate(3000, { leave: { unpaidTimeOffDivisor: 'working_days' } }, facts)).toBeCloseTo(3000 / 22, 10);
    expect(
      unpaidTimeOffDailyRate(3000, { leave: { unpaidTimeOffDivisor: 'custom_days', customDays: 26 } }, facts),
    ).toBeCloseTo(3000 / 26, 10);
    // custom_hours 173 ⇒ one 8h day deducts 3000/173×8; custom_minutes mirrors it per minute (×480)
    expect(
      unpaidTimeOffDailyRate(3000, { leave: { unpaidTimeOffDivisor: 'custom_hours', customHours: 173 } }, facts),
    ).toBeCloseTo((3000 / 173) * 8, 10);
    expect(
      unpaidTimeOffDailyRate(3000, { leave: { unpaidTimeOffDivisor: 'custom_minutes', customMinutes: 10380 } }, facts),
    ).toBeCloseTo((3000 / 10380) * 480, 10);
    // a custom_hours mode missing its hours value is a safe no-op (clamp-not-throw ⇒ pooled path)
    expect(unpaidTimeOffDailyRate(3000, { leave: { unpaidTimeOffDivisor: 'custom_hours' } }, facts)).toBeNull();
  });
});

// ───────────────────────────── Integration: golden matrix ─────────────────────────────

let b: Base;
let icSeq = 0;
const nextIc = () => `880202${String(220000 + icSeq++).padStart(6, '0')}`;
let periodSeq = 0;
// A fresh, never-colliding period per pair (statutory-month bound; only relative numbers within a pair matter).
const nextPeriod = () => `2026-${String((periodSeq++ % 12) + 1).padStart(2, '0')}`;

async function seedPayable(name: string, opts?: { hiredOn?: string; basic?: number; allowance?: number }) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `ppc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: opts?.hiredOn ?? '2024-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: opts?.basic ?? 5000,
    monthlyAllowance: opts?.allowance ?? 500,
    effectiveFrom: opts?.hiredOn ?? '2024-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

const NUM = ['basicSalary', 'allowance', 'overtimePay', 'bonus', 'grossPay', 'totalDeductions', 'netPay', 'employerCost'] as const;
const slipOf = async (batchId: string, employmentId: string) => {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((r) => r.employmentId === employmentId)!;
};
const numbers = (ps: Record<string, unknown>) => Object.fromEntries(NUM.map((c) => [c, ps[c]]));

/**
 * Run a LEGACY employee (null policy) and a CONFIG employee (the given config) through ONE shared batch so the
 * statutory month is identical — the only difference is the policy. Returns both payslips' numbers. `prep`
 * receives the batchId + both employmentIds (e.g. to set OT) before generation.
 */
async function runPair(
  config: schema.PayrollPolicyConfig | null,
  seed: { hiredOn?: string; basic?: number; allowance?: number; period?: string } = {},
  prep?: (batchId: string, legacyId: string, cfgId: string) => Promise<void>,
) {
  const a = adminCtx(b);
  const period = seed.period ?? nextPeriod();
  const eLegacy = await seedPayable('Legacy', seed);
  const eCfg = await seedPayable('Cfg', seed);
  if (config) {
    const { id } = await createPolicy(a, { companyId: b.companyId, name: `Cfg ${period} ${randomUUID().slice(0, 6)}`, policyType: 'monthly', config });
    await assignPolicy(a, { employmentId: eCfg.employmentId, policyId: id });
  }
  const { batchId } = await createBatch(a, {
    companyId: b.companyId,
    payPeriod: period,
    scope: { employmentIds: [eLegacy.employmentId, eCfg.employmentId] },
  });
  if (prep) await prep(batchId, eLegacy.employmentId, eCfg.employmentId);
  await generatePayslips(a, { batchId });
  return {
    legacy: numbers(await slipOf(batchId, eLegacy.employmentId)),
    cfg: numbers(await slipOf(batchId, eCfg.employmentId)),
    legacyId: eLegacy.employmentId,
    cfgId: eCfg.employmentId,
    batchId,
  };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('2.1.1 default-equals-legacy golden matrix + non-default measurably changes the payslip', () => {
  it('full month: a default (⇒ null) config reproduces the legacy numbers exactly', async () => {
    const { legacy, cfg } = await runPair(cleanPayrollPolicyConfig({ rounding: { earnings: 'none' } }));
    expect(cfg).toEqual(legacy);
    expect(Number(legacy.grossPay)).toBeCloseTo(5500, 2);
  });

  it('1a rounding: default(none)==legacy; up rounds net to a whole ringgit ≥ exact; down ≠ up', async () => {
    const seed = { basic: 5123.45, allowance: 333.33 };
    // default none ⇒ identical.
    const none = await runPair(cleanPayrollPolicyConfig({ rounding: { netPay: 'none' } }), seed);
    expect(none.cfg).toEqual(none.legacy);

    const up = await runPair(cleanPayrollPolicyConfig({ rounding: { netPay: 'up' } }), seed);
    expect(Number(up.cfg.netPay) % 1).toBeCloseTo(0, 6);
    expect(Number(up.cfg.netPay)).toBeGreaterThanOrEqual(Number(up.legacy.netPay));

    const down = await runPair(cleanPayrollPolicyConfig({ rounding: { netPay: 'down' } }), seed);
    expect(Number(down.cfg.netPay) % 1).toBeCloseTo(0, 6);
    expect(Number(down.cfg.netPay)).toBeLessThanOrEqual(Number(down.legacy.netPay));
    // up and down straddle the exact net ⇒ they differ.
    expect(Number(up.cfg.netPay)).not.toBe(Number(down.cfg.netPay));
  });

  it('1b proration: prorated mid-month hire default==legacy; custom_days(26) raises the prorated basic', async () => {
    // Hire on the 16th of the SAME month the batch runs ⇒ genuinely partial (16 of 31 days employed).
    const def = await runPair(cleanPayrollPolicyConfig({ rounding: { earnings: 'none' } }), { hiredOn: '2026-03-16', period: '2026-03' });
    expect(def.cfg).toEqual(def.legacy);
    expect(Number(def.legacy.basicSalary)).toBeLessThan(5000);

    // custom_days=26 (vs 31 calendar) ⇒ higher per-day rate ⇒ higher prorated basic than legacy. (A different
    // month so the two sub-runs in this test don't collide on one (company, period) batch.)
    const custom = await runPair(
      cleanPayrollPolicyConfig({ proration: { divisor: 'custom_days', customDays: 26 } }),
      { hiredOn: '2026-05-16', period: '2026-05' },
    );
    expect(Number(custom.cfg.basicSalary)).toBeGreaterThan(Number(custom.legacy.basicSalary));
  });

  it('1f unpaid-leave: default==legacy; custom_days(26) divisor enlarges the deduction (lower net)', async () => {
    async function approveUnpaidDay(employmentId: string, start: string) {
      let [lt] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.code, 'UNPAID_PPC'));
      if (!lt) {
        [lt] = await owner.db
          .insert(schema.leaveType)
          .values({ tenantId: b.tenantId, code: 'UNPAID_PPC', name: 'Unpaid PPC', paid: false, counting: 'calendar_days' })
          .returning();
      }
      await owner.db.insert(schema.leaveRequest).values({
        tenantId: b.tenantId,
        employmentId,
        leaveTypeId: lt.id,
        startDate: start,
        endDate: start,
        days: '1',
        status: 'approved',
      });
    }

    // default config ⇒ identical unpaid deduction (both employees get the same unpaid day in the period).
    const dflt = await runPair(cleanPayrollPolicyConfig({ rounding: { earnings: 'none' } }), {}, async (batchId, legacyId, cfgId) => {
      const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
      const d = `${batch.payPeriod}-10`;
      await approveUnpaidDay(legacyId, d);
      await approveUnpaidDay(cfgId, d);
    });
    expect(dflt.cfg.netPay).toEqual(dflt.legacy.netPay);

    // custom_days=26 ⇒ 5000/26 > 5000/31 ⇒ bigger deduction on the config employee ⇒ lower net than legacy.
    const custom = await runPair(
      cleanPayrollPolicyConfig({ leave: { unpaidLeaveDivisor: 'custom_days', customDays: 26 } }),
      {},
      async (batchId, legacyId, cfgId) => {
        const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
        const d = `${batch.payPeriod}-10`;
        await approveUnpaidDay(legacyId, d);
        await approveUnpaidDay(cfgId, d);
      },
    );
    expect(Number(custom.cfg.netPay)).toBeLessThan(Number(custom.legacy.netPay));
  });

  it('1e OT caps: default==legacy; maxAmount caps the OT figure down', async () => {
    const OT = 800;
    const setOt = async (batchId: string, legacyId: string, cfgId: string) => {
      await setPayrollInput(adminCtx(b), { batchId, employmentId: legacyId, overtimeAmount: OT });
      await setPayrollInput(adminCtx(b), { batchId, employmentId: cfgId, overtimeAmount: OT });
    };
    // default ⇒ OT unchanged on both.
    const def = await runPair(cleanPayrollPolicyConfig({ rounding: { earnings: 'none' } }), {}, setOt);
    expect(def.cfg.overtimePay).toEqual(def.legacy.overtimePay);
    expect(Number(def.legacy.overtimePay)).toBeCloseTo(OT, 2);

    // maxAmount=500 caps the config employee's 800 OT down to 500; legacy stays 800.
    const cap = await runPair(cleanPayrollPolicyConfig({ overtime: { maxAmount: 500 } }), {}, setOt);
    expect(Number(cap.legacy.overtimePay)).toBeCloseTo(OT, 2);
    expect(Number(cap.cfg.overtimePay)).toBeCloseTo(500, 2);
    expect(Number(cap.cfg.overtimePay)).toBeLessThan(OT);
  });

  it('1d negative-net set_zero: net never below 0 and equals legacy on the standard (non-negative) path', async () => {
    const { legacy, cfg } = await runPair(cleanPayrollPolicyConfig({ negativeNet: 'set_zero' }));
    expect(Number(cfg.netPay)).toBeGreaterThanOrEqual(0);
    expect(cfg.netPay).toEqual(legacy.netPay);
  });

  it('1c salary-increment proration: a mid-period raise blends two comp rows (vs single open-row legacy)', async () => {
    const a = adminCtx(b);
    const period = '2026-06'; // 30-day month; raise on the 16th ⇒ 15 old days + 15 new days = even split
    const mk = async (name: string) => {
      const e = await hireEmployee(a, {
        person: { fullName: name, primaryEmail: `ppc_${randomUUID().slice(0, 8)}@t.local` },
        companyId: b.companyId,
        departmentId: b.deptA,
        employmentType: 'full_time',
        hiredOn: '2024-01-01',
      });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
      // Raise to 6000 effective the 16th (supersedes the 4000 row).
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: `${period}-16` });
      return e;
    };
    const eLegacy = await mk('IncrLegacy');
    const eCfg = await mk('IncrCfg');
    const { id } = await createPolicy(a, { companyId: b.companyId, name: `Incr ${randomUUID().slice(0, 6)}`, policyType: 'monthly', config: cleanPayrollPolicyConfig({ salaryIncrementProration: true }) });
    await assignPolicy(a, { employmentId: eCfg.employmentId, policyId: id });
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: period, scope: { employmentIds: [eLegacy.employmentId, eCfg.employmentId] } });
    await generatePayslips(a, { batchId });

    const legacy = numbers(await slipOf(batchId, eLegacy.employmentId));
    const cfg = numbers(await slipOf(batchId, eCfg.employmentId));
    // Legacy reads only the OPEN row ⇒ basic = 6000.
    expect(Number(legacy.basicSalary)).toBeCloseTo(6000, 2);
    // Blend: 4000×15/30 + 6000×15/30 = 5000 (between the two, strictly).
    expect(Number(cfg.basicSalary)).toBeGreaterThan(4000);
    expect(Number(cfg.basicSalary)).toBeLessThan(6000);
    expect(Number(cfg.basicSalary)).toBeCloseTo(5000, 0);
  });
});
