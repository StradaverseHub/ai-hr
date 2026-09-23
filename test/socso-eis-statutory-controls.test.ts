/**
 * Item 5a461b99 — SOCSO & EIS statutory controls.
 *
 * Two layers:
 *  1. Calculator gating (pure): "Subject to SOCSO"/"Subject to SKBBK"/"Subject to EIS" off ⇒ that scheme's
 *     REPORTED contribution is zero; each is independent; defaults (no opts) stay byte-identical.
 *  2. Kernel employer-bears (integration): "Employer bears X" keeps the contribution computed + reported in
 *     full but funds the EMPLOYEE share from employer cost — so employee net is UNCHANGED by that share and
 *     employer cost rises by exactly it, while the reported/submitted figures are identical to the baseline.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { statutory, socso, eis } from '../localization/my/payroll';
import { createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const profile = { category: 1 as const, children: 0 };

describe('Item 5a461b99 — SOCSO & EIS statutory-control calculator gating', () => {
  const base = statutory(3000, profile, 0, 0, { month: 1 });

  it('defaults (no opts) are byte-identical to the raw schedules', () => {
    expect(base.socsoEmployee).toBe(socso(3000).employee);
    expect(base.socsoEmployer).toBe(socso(3000).employer);
    expect(base.socsoSkbbk).toBe(socso(3000).skbbk);
    expect(base.eisEmployee).toBe(eis(3000).employee);
    // sanity: all three legs are non-zero at RM3,000 so the "off" assertions below are meaningful
    expect(base.socsoEmployee).toBeGreaterThan(0);
    expect(base.socsoSkbbk).toBeGreaterThan(0);
    expect(base.eisEmployee).toBeGreaterThan(0);
  });

  it('Subject to SOCSO off ⇒ SOCSO legs zero, SKBBK + EIS untouched (independent)', () => {
    const r = statutory(3000, profile, 0, 0, { month: 1 }, { subjectToSocso: false });
    expect(r.socsoEmployee).toBe(0);
    expect(r.socsoEmployer).toBe(0);
    expect(r.socsoSkbbk).toBe(base.socsoSkbbk); // SKBBK gated separately
    expect(r.eisEmployee).toBe(base.eisEmployee);
  });

  it('Subject to SKBBK off ⇒ SKBBK zero, SOCSO Injury/Invalidity untouched', () => {
    const r = statutory(3000, profile, 0, 0, { month: 1 }, { subjectToSkbbk: false });
    expect(r.socsoSkbbk).toBe(0);
    expect(r.socsoEmployee).toBe(base.socsoEmployee);
    expect(r.socsoEmployer).toBe(base.socsoEmployer);
  });

  it('Subject to EIS off ⇒ EIS legs zero, SOCSO untouched', () => {
    const r = statutory(3000, profile, 0, 0, { month: 1 }, { eisEligible: false });
    expect(r.eisEmployee).toBe(0);
    expect(r.eisEmployer).toBe(0);
    expect(r.socsoEmployee).toBe(base.socsoEmployee);
  });
});

let icSeq = 0;
const nextIc = () => `9001010${String(20000 + icSeq++).slice(-5)}`;

type Flags = {
  subjectToSocso?: boolean;
  subjectToSkbbk?: boolean;
  eisEligible?: boolean;
  employerBearsSocso?: boolean;
  employerBearsEis?: boolean;
  employerBearsSkbbk?: boolean;
};

const hire = async (b: Base, name: string, basic: number, flags: Flags) => {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: basic,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc(), ...flags });
  return e;
};

const slip = async (batchId: string, employmentId: string) => {
  const [ps] = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.employmentId, employmentId));
  void batchId;
  return ps;
};

describe('Item 5a461b99 — kernel employer-bears + subject-to wiring', () => {
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

  it('employer-bears leaves the employee net + reported figures unchanged and raises employer cost', async () => {
    const a = adminCtx(base);
    // Both employees: subject to SOCSO + SKBBK + EIS. `bears` additionally has the employer absorb all three.
    const baseline = await hire(base, 'CtrlBaseline', 3000, {
      subjectToSocso: true,
      subjectToSkbbk: true,
      eisEligible: true,
    });
    const bears = await hire(base, 'CtrlBears', 3000, {
      subjectToSocso: true,
      subjectToSkbbk: true,
      eisEligible: true,
      employerBearsSocso: true,
      employerBearsEis: true,
      employerBearsSkbbk: true,
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psBase = await slip(batchId, baseline.employmentId);
    const psBears = await slip(batchId, bears.employmentId);
    const stBase = psBase.statutory as Record<string, number>;
    const stBears = psBears.statutory as Record<string, number>;

    // Reported/submitted employee shares are IDENTICAL (SOCSO/EIS reports + PERKESO file unchanged).
    expect(stBears.socsoEmployee).toBe(stBase.socsoEmployee);
    expect(stBears.eisEmployee).toBe(stBase.eisEmployee);
    expect(stBears.socsoSkbbk).toBe(stBase.socsoSkbbk);
    expect(stBears.socsoEmployer).toBe(stBase.socsoEmployer);

    const borne = Number((stBase.socsoEmployee + stBase.eisEmployee + stBase.socsoSkbbk).toFixed(2));
    expect(borne).toBeGreaterThan(0);

    // Employee net RISES by exactly the borne shares (those shares are no longer deducted from the employee).
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psBase.netPay) + borne, 2);
    // Employer cost RISES by exactly the borne shares.
    expect(Number(psBears.employerCost)).toBeCloseTo(Number(psBase.employerCost) + borne, 2);
    // Payslip invariant still holds.
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psBears.grossPay) - Number(psBears.totalDeductions), 2);

    // Provenance snapshot present on the bears slip, absent on the baseline slip (byte-identical default).
    const eb = psBears.statutory as Record<string, unknown>;
    // Item 8b5334db extended the snapshot with a `tax` leg (employer-bears-tax); false here (not set).
    expect(eb.employerBears).toEqual({ socso: true, eis: true, skbbk: true, tax: false, epf: false });
    expect((eb.employerBorne as { total: number }).total).toBeCloseTo(borne, 2);
    expect((psBase.statutory as Record<string, unknown>).employerBears).toBeUndefined();
  });

  it('subject-to-SOCSO off ⇒ zero SOCSO on the payslip and a higher net; SKBBK stays on independently', async () => {
    const a = adminCtx(base);
    const on = await hire(base, 'SocsoOn', 3000, { subjectToSocso: true, subjectToSkbbk: true });
    const off = await hire(base, 'SocsoOff', 3000, { subjectToSocso: false, subjectToSkbbk: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psOn = await slip(batchId, on.employmentId);
    const psOff = await slip(batchId, off.employmentId);
    const stOn = psOn.statutory as Record<string, number>;
    const stOff = psOff.statutory as Record<string, number>;

    expect(stOff.socsoEmployee).toBe(0);
    expect(stOff.socsoEmployer).toBe(0);
    // SKBBK is gated on its own flag, so it is still charged.
    expect(stOff.socsoSkbbk).toBe(stOn.socsoSkbbk);
    expect(stOff.socsoSkbbk).toBeGreaterThan(0);
    // Net is higher by exactly the removed employee SOCSO leg.
    expect(Number(psOff.netPay)).toBeCloseTo(Number(psOn.netPay) + stOn.socsoEmployee, 2);
  });

  /**
   * a96d320c rev 2 — THE RUN NOW RECORDS THE SKBBK ELECTION, because the payslip could not say whether
   * it had one.
   *
   * Four surfaces printed the SKBBK line on `socsoSkbbk > 0`, which conflates "this employee has no
   * SKBBK" with "has SKBBK, contributed 0.00 this run" — and on the second of those the zero is the
   * assertion, exactly as it is for the EPF / SOCSO / EIS / PCB lines beside it (CLAUDE.md §8).
   * docs/audits/0085-delta-keys-sign-inventory.md calls that Class B: the class where a line VANISHES
   * from a money document. The election was on `employee_statutory_my` and NOWHERE on the payslip, and
   * reading today's row to decide what last January's document says is the re-derivation every module in
   * this family exists to refuse. So the run stamps it.
   *
   * UNCONDITIONAL, unlike `employerBears` above: a reader must be able to tell `false` from ABSENT, and
   * ABSENT is what sends the four renderers back to the amount test on every payslip written before this.
   */
  it('stamps the SKBBK ELECTION on every payslip, true AND false, so absent means "predates the stamp"', async () => {
    const a = adminCtx(base);
    const on = await hire(base, 'SkbbkOn', 3000, { subjectToSkbbk: true });
    const off = await hire(base, 'SkbbkOff', 3000, { subjectToSkbbk: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psOn = (await slip(batchId, on.employmentId)).statutory as Record<string, unknown>;
    const psOff = (await slip(batchId, off.employmentId)).statutory as Record<string, unknown>;

    expect(psOn.skbbkSubject).toBe(true);
    expect(psOff.skbbkSubject).toBe(false);
    // The stamp is the ELECTION, not the amount, and this is the pair that proves the two differ: the
    // opted-out employee contributes 0.00 and still carries an explicit `false` rather than a silence.
    expect(Number(psOn.socsoSkbbk)).toBeGreaterThan(0);
    expect(Number(psOff.socsoSkbbk)).toBe(0);
    // NOTHING ELSE MOVED. This stamp is provenance; it may not touch a figure.
    expect(Number(psOff.socsoEmployee)).toBe(Number(psOn.socsoEmployee));
    expect(Number(psOff.socsoEmployer)).toBe(Number(psOn.socsoEmployer));
  });

  it('the statutory save records the control flags before/after on the domain event', async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'EventCtrl', 3000, { subjectToSocso: true });
    // second save flips employer-bears on so a before/after diff exists
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101099999',
      subjectToSocso: true,
      employerBearsSocso: true,
    });
    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateType, 'employee-statutory-my'));
    const withControls = rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p && (p.statutoryControls as { after?: unknown })?.after);
    expect(withControls.length).toBeGreaterThanOrEqual(1);
    const latest = withControls.find(
      (p) => (p.statutoryControls as { after: { employerBearsSocso: boolean } }).after.employerBearsSocso === true,
    );
    expect(latest).toBeTruthy();
  });
});
