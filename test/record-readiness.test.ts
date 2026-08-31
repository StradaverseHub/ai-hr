/**
 * ADR-0083 §3 item 2 — RECORD READINESS, the shift-left half of the control plane.
 *
 * The claim this build rests on is economic, not technical: a fix is permanent, a review recurs. That only
 * holds if the list is one an operator trusts enough to work, so the cases below are about the ways a
 * readiness screen loses that trust rather than about the SQL.
 *
 *  1. IT MUST NOT CRY WOLF. The bank check fires only for people paid BY BANK, matching
 *     `missing-bank-profile` exactly. Flag every cash-paid employee on day one and nobody opens the page
 *     twice. This is the single most likely way this feature dies.
 *  2. EITHER IDENTITY DOCUMENT COUNTS. r220 established that an old identity card is an identity; the
 *     same reasoning covers a passport for a non-citizen. Demanding an IC would flag every foreign worker
 *     for a record that is complete.
 *  3. IT IS ABOUT PEOPLE WHOSE NEXT PAYSLIP DEPENDS ON IT. A leaver's missing SOCSO number is a
 *     historical record, not a thing to go and fix, and listing them buries the people who matter.
 *  4. THE COUNT IS THE TRUTH, THE LIST IS A SAMPLE. A page showing 25 of 200 without saying so reads as
 *     "there are 25", which is the wrong number to plan an afternoon around.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, terminateEmployment } from '../core/org';
import { setCompensation } from '../core/comp';
import { setPassportProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { recordReadiness, GAP_BLOCKS, PEOPLE_PER_GAP, type ReadinessGapId } from '../core/record-readiness';
import { CONTROL_DOMAINS } from '../core/control-domains';

describe('ADR-0083 — record readiness', () => {
  let base: Base;
  let seq = 0;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    seq = 0;
  });
  afterAll(async () => {
    await closeAll();
  });

  /** One employee, complete unless told otherwise. */
  async function hire(opts: {
    paymentMethod?: 'bank_transfer' | 'cash' | 'cheque';
    complete?: boolean;
    ic?: string | null;
    passport?: string | null;
    comp?: boolean;
  } = {}) {
    const a = adminCtx(base);
    seq++;
    const e = await hireEmployee(a, {
      person: { fullName: `Ready ${seq}`, primaryEmail: `ready.${seq}@rr.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      ...(opts.paymentMethod ? { paymentMethod: opts.paymentMethod } : {}),
    });
    if (opts.comp !== false) {
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    }
    if (opts.complete !== false) {
      await setStatutoryProfileMY(a, {
        personId: e.personId,
        icNumber: opts.ic === undefined ? `90010101${String(2000 + seq)}` : (opts.ic ?? undefined),
        taxNumber: `SG${1000 + seq}`,
        epfNumber: `E${1000 + seq}`,
        socsoNumber: `S${1000 + seq}`,
        bankName: 'Maybank',
        bankAccountNo: `1234${5000 + seq}`,
      } as never);
      // The passport is its OWN writer (setPassportProfileMY) — it is not a field on the statutory
      // profile input, and passing it there silently does nothing, which is how the first run of this
      // file "proved" that a passport does not satisfy the identity check.
      // The trio is ALL-OR-NOTHING and mandatory for a non-Malaysian (PassportRequiredError): number,
      // issue date and expiry together. A number on its own is refused, which is the product being
      // stricter than this fixture first assumed.
      if (opts.passport) {
        await setPassportProfileMY(a, {
          personId: e.personId,
          passportNumber: opts.passport,
          passportIssueDate: '2024-01-01',
          passportExpiryDate: '2034-01-01',
        });
      }
    }
    return e;
  }

  const gapIds = (v: Awaited<ReturnType<typeof recordReadiness>>) => v.gaps.map((g) => g.id);

  it('a complete record produces no gaps at all', async () => {
    await hire();
    const v = await recordReadiness(adminCtx(base));
    expect(v.employees).toBe(1);
    expect(v.ready).toBe(1);
    expect(v.gaps).toEqual([]);
  });

  it('DOES NOT flag a cash-paid employee for a missing bank account', async () => {
    // The case that decides whether anyone opens this page twice. `missing-bank-profile` fires only for
    // bank_transfer or unset; readiness matches it, or it would accuse every cash-paid employee.
    await hire({ paymentMethod: 'cash', complete: true });
    const v = await recordReadiness(adminCtx(base));
    expect(gapIds(v)).not.toContain('no_bank_account');
  });

  it('and DOES flag a bank-paid employee with no account', async () => {
    // The non-vacuity half: if the check never fired, the case above would pass for the wrong reason.
    const a = adminCtx(base);
    seq++;
    const e = await hireEmployee(a, {
      person: { fullName: 'No Bank', primaryEmail: 'no.bank@rr.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
      paymentMethod: 'bank_transfer',
    } as never);
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, effectiveFrom: '2024-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101019001' });

    const v = await recordReadiness(a);
    expect(gapIds(v)).toContain('no_bank_account');
    const gap = v.gaps.find((g) => g.id === 'no_bank_account')!;
    // The consequence is what the screen leads with, so it has to be on the data.
    expect(gap.blocks).toBe('payment');
    expect(gap.people[0]!.name).toBe('No Bank');
  });

  it('accepts a PASSPORT in place of an IC', async () => {
    // A foreign worker with a passport and no IC has a complete identity. Demanding the IC would flag
    // every one of them (r220's reasoning, applied to the other document).
    await hire({ ic: null, passport: 'A1234567' });
    const v = await recordReadiness(adminCtx(base));
    expect(gapIds(v)).not.toContain('no_identity');
  });

  it('flags an employee with NEITHER document', async () => {
    await hire({ ic: null, passport: null });
    const v = await recordReadiness(adminCtx(base));
    expect(gapIds(v)).toContain('no_identity');
    expect(v.gaps.find((g) => g.id === 'no_identity')!.blocks).toBe('statutory_filing');
  });

  it('ignores leavers entirely', async () => {
    const a = adminCtx(base);
    const leaver = await hire({ complete: false, comp: false });
    await terminateEmployment(a, { employmentId: leaver.employmentId, terminationDate: '2025-12-31' });
    const v = await recordReadiness(a);
    // Not merely absent from the gaps — absent from the DENOMINATOR, or the readiness percentage would
    // be dragged down for ever by people who left years ago.
    expect(v.employees).toBe(0);
    expect(v.gaps).toEqual([]);
  });

  it('sorts by consequence: what stops a run outranks what stops a filing', async () => {
    await hire({ comp: false, complete: false }); // no salary → blocks payroll
    await hire({ complete: false }); // has salary, no statutory profile → blocks filing
    const v = await recordReadiness(adminCtx(base));
    expect(v.gaps.length).toBeGreaterThan(1);
    expect(v.gaps[0]!.blocks).toBe('payroll');
    // Every gap after the first is a lesser consequence, never a greater one.
    const rank = { payroll: 0, payment: 1, statutory_filing: 2 } as const;
    for (let i = 1; i < v.gaps.length; i++) {
      expect(rank[v.gaps[i]!.blocks]).toBeGreaterThanOrEqual(rank[v.gaps[i - 1]!.blocks]);
    }
  });

  it('the COUNT is the total even when the list is capped', async () => {
    // A sample presented as a total is the wrong number to plan around.
    for (let i = 0; i < PEOPLE_PER_GAP + 3; i++) await hire({ complete: false });
    const v = await recordReadiness(adminCtx(base));
    const gap = v.gaps.find((g) => g.id === 'no_epf_number')!;
    expect(gap.count).toBe(PEOPLE_PER_GAP + 3);
    expect(gap.people.length).toBe(PEOPLE_PER_GAP);
    expect(v.ready).toBe(0);
  });

  it('the registry says readiness is live, and its check count matches the gaps', () => {
    const d = CONTROL_DOMAINS.find((x) => x.id === 'readiness')!;
    expect(d.status).toBe('live');
    // The count is a LITERAL in the registry because the gaps are a union type with nothing to measure.
    // This is the pin that stops it drifting the day a seventh gap is added.
    const ids = Object.keys(GAP_BLOCKS) as ReadinessGapId[];
    expect(d.detectorCount, 'CONTROL_DOMAINS readiness count vs GAP_BLOCKS').toBe(ids.length);
    // Not payroll-gated: a missing IC blocks a statutory return whether or not payroll is bought.
    expect(d.module).toBeNull();
  });
});
