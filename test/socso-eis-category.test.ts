/**
 * Item a7271737 — persisted SOCSO / EIS contribution-category override.
 *
 * The category is the single per-scheme control on the SOCSO & EIS card. It is DERIVED per-employee in the
 * kernel today (age + EPF citizenship); these tests prove the persisted override:
 *   • 'auto' (the default) reproduces the current derivation byte-for-byte;
 *   • 'first' / 'second' force the SOCSO band;
 *   • 'none' zeroes the respective scheme (like the legacy subject_to_socso=false / eis_eligible=false);
 *   • employer-bears still funds the employee share on top of a forced category;
 *   • the setter derives the legacy booleans from the category and records the category before/after on the event.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { socso, eis } from '../localization/my/payroll';
import { createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let icSeq = 0;
const nextIc = () => `9002020${String(30000 + icSeq++).slice(-5)}`;

type Flags = {
  socsoCategory?: 'auto' | 'first' | 'second' | 'none';
  eisCategory?: 'auto' | 'none';
  subjectToSocso?: boolean;
  subjectToSkbbk?: boolean;
  eisEligible?: boolean;
  employerBearsSocso?: boolean;
  employerBearsEis?: boolean;
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
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc(), subjectToSkbbk: true, ...flags });
  return e;
};

const slipOf = async (employmentId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
  return ps;
};

describe('Item a7271737 — SOCSO / EIS category override (kernel)', () => {
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

  // Reference schedule figures at RM3,000 (citizen under 60 ⇒ auto category 1).
  const s1 = socso(3000, 1);
  const s2 = socso(3000, 2);
  const eisRef = eis(3000);

  it("'auto' (default) reproduces today's derivation byte-identical; category 1 for a citizen under 60", async () => {
    const a = adminCtx(base);
    const auto = await hire(base, 'CatAuto', 3000, {}); // no category ⇒ default 'auto'
    const first = await hire(base, 'CatFirst', 3000, { socsoCategory: 'first' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const stAuto = (await slipOf(auto.employmentId)).statutory as Record<string, number>;
    const stFirst = (await slipOf(first.employmentId)).statutory as Record<string, number>;

    expect(stAuto.socsoEmployee).toBe(s1.employee);
    expect(stAuto.socsoEmployer).toBe(s1.employer);
    expect(stAuto.eisEmployee).toBe(eisRef.employee);
    // For this employee auto === first (both category 1).
    expect(stFirst.socsoEmployee).toBe(stAuto.socsoEmployee);
    expect(stFirst.socsoEmployer).toBe(stAuto.socsoEmployer);
    // sanity: legs are non-zero so the "off" assertions elsewhere are meaningful.
    expect(stAuto.socsoEmployee).toBeGreaterThan(0);
    expect(stAuto.eisEmployee).toBeGreaterThan(0);
  });

  it("'second' forces Second Category (Injury-only) — different band from category 1", async () => {
    const a = adminCtx(base);
    const second = await hire(base, 'CatSecond', 3000, { socsoCategory: 'second' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const st = (await slipOf(second.employmentId)).statutory as Record<string, number>;

    expect(st.socsoEmployee).toBe(s2.employee);
    expect(st.socsoEmployer).toBe(s2.employer);
    // Category 2 genuinely differs from the auto/category-1 band.
    expect(s2.employee).not.toBe(s1.employee);
  });

  it("'none' zeroes the SOCSO legs; SKBBK is gated independently and stays on", async () => {
    const a = adminCtx(base);
    const none = await hire(base, 'CatNone', 3000, { socsoCategory: 'none' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const st = (await slipOf(none.employmentId)).statutory as Record<string, number>;

    expect(st.socsoEmployee).toBe(0);
    expect(st.socsoEmployer).toBe(0);
    // SKBBK stays on its own switch (subjectToSkbbk: true), and is non-zero at RM3,000.
    expect(st.socsoSkbbk).toBe(s1.skbbk);
    expect(st.socsoSkbbk).toBeGreaterThan(0);
  });

  it("EIS category 'none' zeroes the EIS legs; SOCSO untouched", async () => {
    const a = adminCtx(base);
    const none = await hire(base, 'EisNone', 3000, { eisCategory: 'none' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const st = (await slipOf(none.employmentId)).statutory as Record<string, number>;

    expect(st.eisEmployee).toBe(0);
    expect(st.eisEmployer).toBe(0);
    expect(st.socsoEmployee).toBe(s1.employee); // SOCSO stays on 'auto'
  });

  it('employer-bears still applies on top of a forced category (net + reported invariants hold)', async () => {
    const a = adminCtx(base);
    const plain = await hire(base, 'CatFirstPlain', 3000, { socsoCategory: 'first' });
    const bears = await hire(base, 'CatFirstBears', 3000, { socsoCategory: 'first', employerBearsSocso: true });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psPlain = await slipOf(plain.employmentId);
    const psBears = await slipOf(bears.employmentId);
    const stPlain = psPlain.statutory as Record<string, number>;
    const stBears = psBears.statutory as Record<string, number>;

    // Reported SOCSO employee share is identical (still computed + reported in full).
    expect(stBears.socsoEmployee).toBe(stPlain.socsoEmployee);
    expect(stBears.socsoEmployee).toBeGreaterThan(0);
    // Employee net rises by exactly the borne SOCSO employee share.
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psPlain.netPay) + stPlain.socsoEmployee, 2);
  });

  it("category 'none' persists subject_to_socso=false / eis_eligible=false and appears on the event before/after", async () => {
    const a = adminCtx(base);
    const e = await hire(base, 'DeriveCtrl', 3000, { socsoCategory: 'auto', eisCategory: 'auto' });
    // flip to none on a second save so a before/after diff exists
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900202099999',
      socsoCategory: 'none',
      eisCategory: 'none',
      subjectToSkbbk: true,
    });

    const [row] = await owner.db
      .select({
        subjectToSocso: schema.employeeStatutoryMy.subjectToSocso,
        eisEligible: schema.employeeStatutoryMy.eisEligible,
        socsoCategory: schema.employeeStatutoryMy.socsoCategory,
        eisCategory: schema.employeeStatutoryMy.eisCategory,
      })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, e.personId));
    // Legacy booleans are DERIVED from the category (= category !== 'none').
    expect(row.socsoCategory).toBe('none');
    expect(row.eisCategory).toBe('none');
    expect(row.subjectToSocso).toBe(false);
    expect(row.eisEligible).toBe(false);

    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateType, 'employee-statutory-my'));
    const withCat = rows
      .map((r) => r.payload as Record<string, unknown>)
      .map((p) => (p?.statutoryControls as { after?: { socsoCategory?: string } } | undefined)?.after)
      .filter((aft): aft is { socsoCategory?: string; eisCategory?: string } => !!aft && aft.socsoCategory != null);
    expect(withCat.some((aft) => aft.socsoCategory === 'none' && aft.eisCategory === 'none')).toBe(true);
  });
});
