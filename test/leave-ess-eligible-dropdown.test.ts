/**
 * ad965821 — the Request Leave dropdown offers only what the employee qualifies for, and says nothing
 * about what it left out.
 *
 * The eligibility ENGINE was already built and already right (test/leave-eligibility.test.ts,
 * test/leave-eligibility-config.test.ts, test/leave-org-criteria.test.ts, test/leave-dashboard.test.ts,
 * test/leave-type-employee-visibility.test.ts all pin it). What was missing was the HIDING: /leave's apply
 * dropdown was mapped off the whole catalogue, so a male employee saw Maternity Leave, filled in dates,
 * attached a document, and only found out at Submit. So this file deliberately does NOT re-prove
 * gender / marital / org-criterion filtering on `listEligibleLeaveTypesFor`. It covers what is new:
 *
 *   1. PROBATION now narrows the read. It was the one configured condition the read did not apply — the
 *      rule lives in its own column (`leave_type.probation_eligibility`) and the read projected only the
 *      eligibility JSONB, so a confirmed_only type stayed in the dropdown for a probationer until the
 *      submit refused it. `requestLeave` merged the column in; the read now merges it the same way.
 *   2. `balanceSourceTypeId` reaches the option. The /leave option maps it into `borrowsBalance`, so a
 *      missing projection would silently re-show Emergency Leave's decomposition controls.
 *   3. `eligibleLeaveTypeIdsFor` — the on-behalf-of map — answers with the SAME predicate, per employment.
 *   4. The dropdown is defence in depth ONLY: `requestLeave` still throws for a posted ineligible type.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { LeaveIneligibleError, requestLeave } from '../core/leave';
import { eligibleLeaveTypeIdsFor, listEligibleLeaveTypesFor } from '../core/read';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const uniq = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;

async function hire(opts: { gender?: string | null; marital?: string | null; hiredOn?: string } = {}) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Ess', primaryEmail: `ess_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2024-01-01',
  });
  if (opts.gender !== undefined || opts.marital !== undefined) {
    await owner.db
      .update(schema.person)
      .set({ gender: opts.gender ?? null, maritalStatus: opts.marital ?? null })
      .where(eq(schema.person.id, e.personId));
  }
  return e;
}

/** An active, calendar-counted leave type. Every gate input is settable so one helper covers all four. */
async function leaveType(
  code: string,
  opts: {
    eligibility?: unknown;
    probationEligibility?: 'confirmed_only' | 'probation_only' | null;
    employeeCanApply?: boolean | null;
    visibleToEmployee?: boolean | null;
    balanceSourceTypeId?: string | null;
  } = {},
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true,
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      eligibility: opts.eligibility ?? null,
      probationEligibility: opts.probationEligibility ?? null,
      employeeCanApply: opts.employeeCanApply ?? null,
      visibleToEmployee: opts.visibleToEmployee ?? null,
      balanceSourceTypeId: opts.balanceSourceTypeId ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** BOTH confirmation columns, so onProbationAsOf (finalConfirmationDate ?? confirmationDate) is decided. */
const setConfirmation = (employmentId: string, date: string | null) =>
  owner.db
    .update(schema.employment)
    .set({ confirmationDate: date, finalConfirmationDate: date })
    .where(eq(schema.employment.id, employmentId));

const idsFor = async (employmentId: string) =>
  (await listEligibleLeaveTypesFor(adminCtx(b), employmentId)).map((t) => t.id);

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

describe('ad965821 · the probation condition finally reaches the dropdown', () => {
  // Dates chosen so the read's asOf (today, MYT) and requestLeave's asOf (the start date) agree whatever
  // day the suite runs: 2020 is behind both, 2099 is ahead of both.
  it('confirmed_only is hidden from a probationer and offered to a confirmed employee', async () => {
    const t = await leaveType(uniq('CONFONLY'), { probationEligibility: 'confirmed_only' });
    const confirmed = await hire();
    const probationer = await hire();
    await setConfirmation(confirmed.employmentId, '2020-01-01');
    await setConfirmation(probationer.employmentId, '2099-01-01');

    expect(await idsFor(confirmed.employmentId)).toContain(t);
    expect(await idsFor(probationer.employmentId)).not.toContain(t);
  });

  it('probation_only is the exact inverse', async () => {
    const t = await leaveType(uniq('PROBONLY'), { probationEligibility: 'probation_only' });
    const confirmed = await hire();
    const probationer = await hire();
    await setConfirmation(confirmed.employmentId, '2020-01-01');
    await setConfirmation(probationer.employmentId, '2099-01-01');

    expect(await idsFor(probationer.employmentId)).toContain(t);
    expect(await idsFor(confirmed.employmentId)).not.toContain(t);
  });

  it('the seeded open type is unaffected — a probation rule on ONE type narrows only that type', async () => {
    await leaveType(uniq('CONFONLY'), { probationEligibility: 'confirmed_only' });
    const probationer = await hire();
    await setConfirmation(probationer.employmentId, '2099-01-01');
    expect(await idsFor(probationer.employmentId)).toContain(b.annualLeaveTypeId);
  });
});

describe('ad965821 · minimum service narrows the same list', () => {
  it('a reachable minimum is offered, an unreachable one is not', async () => {
    const reachable = await leaveType(uniq('SHORTSERVE'), { eligibility: { minServiceMonths: 1 } });
    const unreachable = await leaveType(uniq('LONGSERVE'), { eligibility: { minServiceMonths: 600 } });
    const emp = await hire({ hiredOn: '2024-01-01' });
    const ids = await idsFor(emp.employmentId);
    expect(ids).toContain(reachable);
    expect(ids).not.toContain(unreachable);
  });
});

describe('ad965821 · the option carries what the form reads off it', () => {
  it('projects balanceSourceTypeId, so borrowsBalance is not silently false', async () => {
    const borrower = await leaveType(uniq('BORROW'), { balanceSourceTypeId: b.annualLeaveTypeId });
    const plain = await leaveType(uniq('PLAIN'));
    const emp = await hire();
    const types = await listEligibleLeaveTypesFor(adminCtx(b), emp.employmentId);
    expect(types.find((t) => t.id === borrower)?.balanceSourceTypeId).toBe(b.annualLeaveTypeId);
    expect(types.find((t) => t.id === plain)?.balanceSourceTypeId).toBeNull();
  });
});

describe('ad965821 · eligibleLeaveTypeIdsFor — the on-behalf-of map', () => {
  it('answers per employment, and includes the applicant’s own set', async () => {
    const mat = await leaveType(uniq('MAT'), { eligibility: { gender: ['female'] } });
    const pat = await leaveType(uniq('PAT'), {
      eligibility: { gender: ['male'], maritalStatus: ['married'] },
    });
    const manager = await hire({ gender: 'male', marital: 'married' });
    const reportF = await hire({ gender: 'female', marital: 'single' });
    const reportM = await hire({ gender: 'male', marital: 'single' });

    const map = await eligibleLeaveTypeIdsFor(adminCtx(b), [
      manager.employmentId,
      reportF.employmentId,
      reportM.employmentId,
    ]);

    // The manager's own set is in the map — the selector lists them alongside their reports.
    expect(map[manager.employmentId]).toContain(pat);
    expect(map[manager.employmentId]).not.toContain(mat);
    // …and the two reports differ from each other AND from the manager.
    expect(map[reportF.employmentId]).toContain(mat);
    expect(map[reportF.employmentId]).not.toContain(pat);
    expect(map[reportM.employmentId]).not.toContain(mat);
    expect(map[reportM.employmentId]).not.toContain(pat); // male but single
    // The open seed type is on everyone's list.
    for (const id of [manager.employmentId, reportF.employmentId, reportM.employmentId]) {
      expect(map[id]).toContain(b.annualLeaveTypeId);
    }
  });

  it('agrees with listEligibleLeaveTypesFor for the same employment — ONE predicate, two callers', async () => {
    // Every gate input at once: a condition, a closed-to-employees type and a hidden-placement type.
    await leaveType(uniq('MAT'), { eligibility: { gender: ['female'] } });
    const noApply = await leaveType(uniq('NOAPPLY'), { employeeCanApply: false });
    const hidden = await leaveType(uniq('HIDDEN'), { visibleToEmployee: false });
    const probation = await leaveType(uniq('CONFONLY'), { probationEligibility: 'confirmed_only' });
    const emp = await hire({ gender: 'male', marital: 'married' });
    await setConfirmation(emp.employmentId, '2099-01-01');

    const single = (await idsFor(emp.employmentId)).sort();
    const map = await eligibleLeaveTypeIdsFor(adminCtx(b), [emp.employmentId]);
    expect([...map[emp.employmentId]].sort()).toEqual(single);
    // …and all four gates actually bit, so the agreement above is not agreement on "everything".
    for (const dropped of [noApply, hidden, probation]) expect(single).not.toContain(dropped);
  });

  it('an empty request is an empty map; an employment the caller cannot see gets an EMPTY list, not the catalogue', async () => {
    const stranger = await hire();
    const viewer = await hire();
    const uViewer = await createAppUser(b.tenantId, viewer.personId, 'employee');
    const viewerCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: uViewer,
      roles: ['employee'],
      personId: viewer.personId,
    };

    expect(await eligibleLeaveTypeIdsFor(adminCtx(b), [])).toEqual({});
    const map = await eligibleLeaveTypeIdsFor(viewerCtx, [viewer.employmentId, stranger.employmentId]);
    expect(map[viewer.employmentId]).toContain(b.annualLeaveTypeId);
    expect(map[stranger.employmentId]).toEqual([]);
  });

  it('a manager reads their report’s set — the on-behalf-of case for real', async () => {
    const mat = await leaveType(uniq('MAT'), { eligibility: { gender: ['female'] } });
    const manager = await hire({ gender: 'male', marital: 'married' });
    const report = await hire({ gender: 'female', marital: 'married' });
    const uMgr = await createAppUser(b.tenantId, manager.personId, 'manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: report.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const mgrCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: uMgr,
      roles: ['manager'],
      personId: manager.personId,
    };

    const map = await eligibleLeaveTypeIdsFor(mgrCtx, [manager.employmentId, report.employmentId]);
    expect(map[report.employmentId]).toContain(mat);
    expect(map[manager.employmentId]).not.toContain(mat);
  });
});

describe('ad965821 · hiding is a courtesy; refusing is the control', () => {
  it('requestLeave still throws LeaveIneligibleError for a type the dropdown no longer offers', async () => {
    const mat = await leaveType(uniq('MAT'), { eligibility: { gender: ['female'] } });
    const male = await hire({ gender: 'male', marital: 'married' });
    expect(await idsFor(male.employmentId)).not.toContain(mat);
    await expect(
      requestLeave(adminCtx(b), {
        employmentId: male.employmentId,
        leaveTypeId: mat,
        startDate: '2026-07-01',
        endDate: '2026-07-01',
      }),
    ).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('…and for a probation-gated type, which is the gate this round added to the read', async () => {
    const t = await leaveType(uniq('CONFONLY'), { probationEligibility: 'confirmed_only' });
    const probationer = await hire();
    await setConfirmation(probationer.employmentId, '2099-01-01');
    expect(await idsFor(probationer.employmentId)).not.toContain(t);
    await expect(
      requestLeave(adminCtx(b), {
        employmentId: probationer.employmentId,
        leaveTypeId: t,
        startDate: '2026-07-01',
        endDate: '2026-07-01',
      }),
    ).rejects.toBeInstanceOf(LeaveIneligibleError);
  });
});
