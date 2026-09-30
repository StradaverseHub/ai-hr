/**
 * Security assessment 2026-09, finding H4 — migration 0492.
 *
 * The 0060 decision (compensation READ is ADMIN-OR-SELF so a manager cannot see a subordinate's pay,
 * pinned by test/comp-access.test.ts) was never applied to `payslip` or `employee_statutory_my`. Both
 * still resolved through `app.can_see_employment` / `app.can_see_person`, whose manager down-walk and
 * HOD branch handed a line manager their subordinate's NET PAY, FULL BANK ACCOUNT, IC/PASSPORT and
 * EPF/SOCSO/tax numbers. The exploit was verified by direct URL against the EA statement route.
 *
 * The remediation branch shipped the migration WITHOUT A TEST, so nothing pinned it and nothing would
 * have caught a later policy edit putting it back. This file is that pin. It deliberately mirrors
 * comp-access.test.ts arm for arm, including the last one: we restricted PAY, not the existence of the
 * person, so a manager must still be able to read their report's non-pay record. A test that only
 * asserted the refusals would pass just as well on an over-tightened policy that broke the org chart.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY, getStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, payslipDetail } from '../core/payroll';
import { employeeDetail, myPayslips } from '../core/read';
import { employeeEaStatement } from '../core/reporting';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

describe('payslip + Malaysian statutory READ — payroll-admin-or-self (security H4, migration 0492)', () => {
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

  async function setup() {
    const a = adminCtx(base);
    const hire = (name: string, email: string) =>
      hireEmployee(a, {
        person: { fullName: name, primaryEmail: email },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
    const M = await hire('Manager', 'manager.h4@acme.test');
    const E1 = await hire('Report', 'report.h4@acme.test');

    // The ADMINISTRATIVE line is the one `can_see_employment` walks down. Without it this test proves
    // nothing beyond the unrelated-peer case, which test/ea-route-abac.test.ts already covered — and
    // which is exactly why the hole survived: a peer was refused, a manager was not.
    await setReportingLine(a, {
      subordinateEmploymentId: E1.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });

    await setCompensation(a, { employmentId: E1.employmentId, basicSalary: 7000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: E1.personId,
      icNumber: '900101015555',
      taxCategory: 1,
      numChildren: 0,
    });
    // The MANAGER needs these too, and not for cosmetic symmetry: `generatePayslips` runs the
    // pre-processing checks over EVERY employee in the company scope and throws PreProcessBlockedError
    // if even one is not ready, so a manager with no compensation row fails the fixture rather than the
    // policy. (Seeded fixtures hit this too: db/seed.ts hires one employee it never sets compensation
    // for, which makes a seeded database unpayable.)
    await setCompensation(a, { employmentId: M.employmentId, basicSalary: 9000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, {
      personId: M.personId,
      icNumber: '850202025555',
      taxCategory: 1,
      numChildren: 0,
    });

    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: batch.batchId });
    // CLOSE IT. `payslipDetail` returns null for an unreleased batch whoever asks (core/payroll.ts — the
    // ESS detail page and PDF route both ride that gate), so without this the manager's refusal below
    // would pass for the wrong reason and the self case would fail. A test that cannot tell "refused by
    // policy" from "not published yet" is not pinning a policy at all.
    await closeBatch(a, { batchId: batch.batchId });
    const [own] = await myPayslips(a, [E1.employmentId]);
    expect(own, 'fixture: the admin must be able to see the payslip it just generated').toBeTruthy();

    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const mCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: uM,
      roles: ['manager'],
      personId: M.personId,
      entitlements: harnessSnapshot(base.tenantId),
    };
    const uE = await createAppUser(base.tenantId, E1.personId, 'employee');
    const eCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: uE,
      roles: ['employee'],
      personId: E1.personId,
      entitlements: harnessSnapshot(base.tenantId),
    };
    return { a, M, E1, mCtx, eCtx, payslipId: own.id };
  }

  it('the employee can read their OWN payslip', async () => {
    const { eCtx, E1, payslipId } = await setup();
    const rows = await myPayslips(eCtx, [E1.employmentId]);
    expect(rows).toHaveLength(1);
    const detail = await payslipDetail(eCtx, payslipId);
    expect(detail).toBeTruthy();
  });

  it('a MANAGER cannot read a direct report’s payslip — not the list, not the detail', async () => {
    const { mCtx, E1, payslipId } = await setup();
    // The list read is what My Payroll uses; the detail read is what the print/download view uses. Both
    // are gated only by `payslip_rls`, so both must refuse, and asserting one would leave the other open.
    expect(await myPayslips(mCtx, [E1.employmentId])).toEqual([]);
    expect(await payslipDetail(mCtx, payslipId)).toBeFalsy();
  });

  it('a payroll admin keeps the payslip read (generation and review must not break)', async () => {
    const { a, payslipId } = await setup();
    const detail = await payslipDetail(a, payslipId);
    expect(detail).toBeTruthy();
  });

  it('the employee can read their OWN Malaysian statutory row', async () => {
    const { eCtx, E1 } = await setup();
    const row = await getStatutoryProfileMY(eCtx, E1.personId);
    expect(row?.icNumber).toBe('900101015555');
  });

  it('a MANAGER cannot read a direct report’s IC / statutory row', async () => {
    const { mCtx, E1 } = await setup();
    expect(await getStatutoryProfileMY(mCtx, E1.personId)).toBeNull();
  });

  it('an admin keeps the statutory read', async () => {
    const { a, E1 } = await setup();
    expect((await getStatutoryProfileMY(a, E1.personId))?.icNumber).toBe('900101015555');
  });

  it('a MANAGER cannot pull a direct report’s EA statement (the verified exploit)', async () => {
    const { mCtx, E1 } = await setup();
    // The EA form prints the IC, the tax number and the year's full remuneration. This was the reported
    // exploit: a non-admin manager fetched it by direct URL and got 200. The page now also refuses
    // before reading (payroll-staff-or-self → notFound), but this asserts the DATA is gone, because a
    // page guard is defence in depth and the read is the thing that has to be shut.
    expect(await employeeEaStatement(mCtx, { employmentId: E1.employmentId, year: '2026' })).toBeNull();
  });

  it('but the manager can still read the report’s non-pay record (we restricted PAY, not the person)', async () => {
    const { mCtx, E1 } = await setup();
    const detail = await employeeDetail(mCtx, E1.employmentId);
    expect(detail?.name).toBe('Report');
  });
});
