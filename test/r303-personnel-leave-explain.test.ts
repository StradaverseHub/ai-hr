/**
 * r303 (31492f74) — "FOR HR ONLY" ON THE PERSONNEL RECORD, DECIDED BY THE VIEWER'S OWN SESSION.
 *
 * The approved plan says the Leave Summary sentences are for HR only. The Personnel record already gates its
 * HR-only parts (pay, statutory, the benefit scheme view) on `isAdmin(s)` (lib/authz.ts), and the r303 mount
 * must use the same predicate: an HR administrator's breakdown carries the per-line working and the panel gets
 * the HR switch; anybody else — a manager looking at a report — gets exactly what the base gave them: no
 * working in the payload, no switch, so the panel keeps its icons and shows no sentences (the rendered
 * consequence of an absent switch is pinned byte for byte in test/r303-leave-summary-explain.dom.test.tsx).
 *
 * Driven through app/admin/personnel/[employmentId]/leave-breakdowns.ts with REAL sessions and RLS, not grepped.
 * // substrate: read-only, no event
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { isAdmin } from '../lib/authz';
import { personnelHrExplanation, personnelLeaveBreakdowns } from '../app/admin/personnel/[employmentId]/leave-breakdowns';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;

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

const AS_OF = '2026-06-30';

const hire = (name: string, grant: boolean) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r303p_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-05',
    grantLeaveTypes: grant ? [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] : [],
  });

async function reportAndManager() {
  await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
  const report = await hire('Report', true);
  const manager = await hire('Manager', false);
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: report.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2026-01-05',
  });
  const mgrCtx: SessionContext = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, manager.personId, 'manager'),
    personId: manager.personId,
    roles: ['manager'],
    entitlements: adminCtx(b).entitlements,
  };
  return { report, mgrCtx };
}

describe('r303 — Personnel: HR sentences and working only for an HR administrator', () => {
  it('a manager viewing a report gets the breakdown with NO derivation and NO HR switch; an HR admin gets both', async () => {
    const { report, mgrCtx } = await reportAndManager();
    const hr = adminCtx(b);
    // Guard the guard: the two sessions really are on either side of the page's own predicate.
    expect(isAdmin(mgrCtx)).toBe(false);
    expect(isAdmin(hr)).toBe(true);

    const [asManager] = await personnelLeaveBreakdowns(mgrCtx, report.employmentId, [b.annualLeaveTypeId], AS_OF);
    const [asHr] = await personnelLeaveBreakdowns(hr, report.employmentId, [b.annualLeaveTypeId], AS_OF);
    // Not vacuous: the manager DOES read the report's breakdown (RLS lets a line manager see it) …
    expect(asManager, 'the manager reads the breakdown').not.toBeNull();
    expect(asManager!.currentYearEntitlement).toBeGreaterThan(0);
    // … with exactly the base's shape: no working in the payload …
    expect(Object.keys(asManager!), 'manager payload carries no derivation').not.toContain('derivation');
    // … and no HR switch, so the panel renders its icons and no sentences.
    expect(personnelHrExplanation(mgrCtx, null), 'manager gets no HR switch').toBeUndefined();

    // HR administrator: the working and the switch.
    expect(asHr!.derivation, 'HR admin payload carries the derivation').toBeTruthy();
    expect(personnelHrExplanation(hr, null)).toEqual({ sharedBalance: null });
    // The figures themselves are the same for both viewers; only the explanation layer differs.
    const { derivation: _d, ...hrFigures } = asHr!;
    expect(hrFigures).toEqual(asManager);
  });

  it('the page decides with the viewer’s own session, through the helpers — not with a literal switch', () => {
    const page = readFileSync(join(process.cwd(), 'app/admin/personnel/[employmentId]/page.tsx'), 'utf8');
    expect(page).toContain('const admin = isAdmin(s);');
    expect(page).toContain('await personnelLeaveBreakdowns(s, employmentId, balances.map((b) => b.leaveTypeId), breakdownAsOf)');
    expect(page).toContain('hrExplanation={personnelHrExplanation(s, b.sharedBalance)}');
    // No second breakdown read on the page that could carry the working past the gate.
    expect(page).not.toMatch(/leaveEntitlementBreakdown\(/);
  });
});
