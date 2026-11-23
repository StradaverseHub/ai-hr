/**
 * Board 8f959c7a — Direct Superior saves are answered on the card, never twice, and Employment History shows
 * the period each superior applied (From and an inclusive To). Service-level owners only; fictional fixtures.
 *
 * The staging evidence for the report showed the 01-Jul-2026 change DID commit and only its answer was lost,
 * so the resubmit after an unconfirmed save is the case that matters most: it must be refused in plain words.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { amendDirectSuperior } from '../core/information-correction';
import { createMovementEvent, movementDetail, movementHistory, reverseMovementEvent } from '../core/movement';
import { DirectSuperiorAlreadySavedError, DirectSuperiorUnchangedError, hireEmployee, ReportingCycleError, setReportingLine } from '../core/org';
import { directSuperiorHistoryFor, reportingLinesFor } from '../core/read';
import { directSuperiorPeriodOf, inclusiveSuperiorEnd } from '../lib/direct-superior-period';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addCalendarDays } from '../lib/hr-date-calendar';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let ADMIN: SessionContext;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); },
  unstable_rethrow: () => {},
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

import { setDirectSuperiorAction } from '../app/admin/personnel/[employmentId]/actions';

let base: Base;
beforeAll(async () => { await migrateTestDb(); });
beforeEach(async () => { await resetDb(); base = await seedBase(); ADMIN = adminCtx(base); });
afterAll(async () => { await closeAll(); });

const hire = (ctx: SessionContext, b: Base, name: string, hiredOn = '2026-01-01') =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}-${b.tenantId.slice(0, 6)}@fictional.test` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn,
  });
const administrative = (ctx: SessionContext, employee: string, manager: string, validFrom: string) =>
  setReportingLine(ctx, { subordinateEmploymentId: employee, managerEmploymentId: manager, lineType: 'administrative', validFrom });
const superiorChanges = async (ctx: SessionContext, employee: string) =>
  (await movementHistory(ctx, employee)).filter(row => row.kind === 'reportingLineChange');
const currentSuperior = async (ctx: SessionContext, employee: string) =>
  (await reportingLinesFor(ctx, employee, undefined, { administrativeAsOf: todayInKualaLumpur() }))
    .managers.find(m => m.lineType === 'administrative')?.employmentId ?? null;
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe('inclusive period arithmetic (pure)', () => {
  it('shows the day before the next start and keeps the current line open', () => {
    expect(inclusiveSuperiorEnd('2026-07-01')).toBe('2026-06-30');
    expect(inclusiveSuperiorEnd('2026-03-01')).toBe('2026-02-28');
    expect(inclusiveSuperiorEnd(null)).toBeNull();
    const lines = [{ validFrom: '2026-02-01', validTo: '2026-07-01' }, { validFrom: '2026-07-01', validTo: '2026-09-01' },
      { validFrom: '2026-09-01', validTo: null }, { validFrom: '2026-05-05', validTo: '2026-05-05' }];
    expect(directSuperiorPeriodOf(lines, '2026-07-01')).toEqual({ from: '2026-07-01', to: '2026-08-31' });
    expect(directSuperiorPeriodOf(lines, '2026-09-01')).toEqual({ from: '2026-09-01', to: null });
    // A change to "No Direct Superior" owns no line: it lasts until the next line starts.
    expect(directSuperiorPeriodOf(lines, '2026-05-05')).toEqual({ from: '2026-05-05', to: '2026-06-30' });
  });
});

describe('Direct Superior repeat save after an unconfirmed answer (8f959c7a)', () => {
  it('refuses the same backdated change a second time in plain words and records it once', async () => {
    const employee = (await hire(ADMIN, base, 'RepeatWorker')).employmentId;
    const first = (await hire(ADMIN, base, 'FirstBoss')).employmentId;
    const second = (await hire(ADMIN, base, 'SecondBoss')).employmentId;
    await administrative(ADMIN, employee, first, '2026-02-01');
    const change = { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01',
      managerEmploymentId: second, remarks: 'Team restructure' } as const;
    await createMovementEvent(ADMIN, change);
    await expect(createMovementEvent(ADMIN, change)).rejects.toBeInstanceOf(DirectSuperiorAlreadySavedError);
    expect((await superiorChanges(ADMIN, employee)).filter(row => !row.reversed)).toHaveLength(1);
    expect(await currentSuperior(ADMIN, employee)).toBe(second);

    // The card's action answers the repeat with the plain-language key and the date, not a redirect.
    const outcome = await setDirectSuperiorAction({ status: 'idle' }, form({ employmentId: employee, submissionId: 'sub-2',
      superiorChangeMode: 'movement', superiorEmploymentId: second, effectiveDate: '2026-07-01', reason: 'Retry' }));
    expect(outcome).toMatchObject({ status: 'refused', submissionId: 'sub-2' });
    expect(outcome.status !== 'idle' && outcome.message).toContain('directSuperiorAlreadySaved');
    expect(outcome.status !== 'idle' && outcome.message).toContain('01-Jul-2026');
  });

  it('refuses a superior who already applies on that date before planning any replay', async () => {
    const employee = (await hire(ADMIN, base, 'SameWorker')).employmentId;
    const boss = (await hire(ADMIN, base, 'SameBoss')).employmentId;
    await administrative(ADMIN, employee, boss, '2026-02-01');
    await expect(createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange',
      effectiveDate: '2026-07-01', managerEmploymentId: boss, remarks: 'No-op' })).rejects.toBeInstanceOf(DirectSuperiorUnchangedError);
    expect(await superiorChanges(ADMIN, employee)).toHaveLength(0);
  });

  it('refuses the same future-dated change while it is still pending', async () => {
    const employee = (await hire(ADMIN, base, 'FutureWorker')).employmentId;
    const first = (await hire(ADMIN, base, 'FutureFirst')).employmentId;
    const next = (await hire(ADMIN, base, 'FutureNext')).employmentId;
    await administrative(ADMIN, employee, first, '2026-02-01');
    const tomorrow = addCalendarDays(todayInKualaLumpur(), 1);
    const change = { employmentId: employee, kind: 'reportingLineChange', effectiveDate: tomorrow, managerEmploymentId: next } as const;
    await createMovementEvent(ADMIN, change);
    await expect(createMovementEvent(ADMIN, change)).rejects.toBeInstanceOf(DirectSuperiorAlreadySavedError);
    expect(await superiorChanges(ADMIN, employee)).toHaveLength(1);
  });

  it('refuses a repeated amendment whose correction already committed', async () => {
    const employee = (await hire(ADMIN, base, 'AmendWorker')).employmentId;
    const first = (await hire(ADMIN, base, 'AmendFirst')).employmentId;
    const corrected = (await hire(ADMIN, base, 'AmendCorrected')).employmentId;
    const { reportingLineId } = await administrative(ADMIN, employee, first, '2026-02-01');
    const amendment = { employmentId: employee, expectedLineId: reportingLineId, managerEmploymentId: corrected, reason: 'Typo' };
    await amendDirectSuperior(ADMIN, amendment);
    await expect(amendDirectSuperior(ADMIN, amendment)).rejects.toBeInstanceOf(DirectSuperiorAlreadySavedError);
    const corrections = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, base.tenantId),
      eq(schema.domainEvent.subjectEmploymentId, employee), eq(schema.domainEvent.eventType, 'employment.information.corrected')));
    expect(corrections).toHaveLength(1);
  });
});

describe('Direct Superior validation refusals (8f959c7a)', () => {
  it('refuses self, a reporting loop across the new period, an inactive superior and dates outside employment', async () => {
    const a = (await hire(ADMIN, base, 'LoopA')).employmentId;
    const b = (await hire(ADMIN, base, 'LoopB')).employmentId;
    const late = (await hire(ADMIN, base, 'LateJoiner', '2026-08-01')).employmentId;
    await administrative(ADMIN, a, b, '2026-02-01');
    const move = (employmentId: string, managerEmploymentId: string, effectiveDate: string) =>
      createMovementEvent(ADMIN, { employmentId, kind: 'reportingLineChange', effectiveDate, managerEmploymentId, remarks: 'Check' });
    await expect(move(a, a, '2026-07-01')).rejects.toBeInstanceOf(ReportingCycleError);
    await expect(move(b, a, '2026-07-01')).rejects.toBeInstanceOf(ReportingCycleError);
    await expect(move(a, late, '2026-07-01')).rejects.toThrow('must be active on the Effective Date');
    await expect(move(late, a, '2026-07-01')).rejects.toThrow();
    expect(await superiorChanges(ADMIN, a)).toHaveLength(0);
    expect(await superiorChanges(ADMIN, b)).toHaveLength(0);

    const self = await setDirectSuperiorAction({ status: 'idle' }, form({ employmentId: a, submissionId: 's',
      superiorChangeMode: 'movement', superiorEmploymentId: a, effectiveDate: '2026-07-01', reason: 'Self' }));
    expect(self).toMatchObject({ status: 'refused', message: 'directSuperiorSelf' });
    const loop = await setDirectSuperiorAction({ status: 'idle' }, form({ employmentId: b, submissionId: 'l',
      superiorChangeMode: 'movement', superiorEmploymentId: a, effectiveDate: '2026-07-01', reason: 'Loop' }));
    expect(loop).toMatchObject({ status: 'refused', message: 'directSuperiorCycle' });
  });

  it('refuses a caller without maintain rights and a superior from another tenant, writing nothing', async () => {
    const employee = await hire(ADMIN, base, 'ScopedWorker');
    const boss = (await hire(ADMIN, base, 'ScopedBoss')).employmentId;
    const userId = await createAppUser(base.tenantId, employee.personId, 'employee');
    const employeeCtx: SessionContext = { tenantId: base.tenantId, userId, roles: ['employee'], personId: employee.personId,
      entitlements: harnessSnapshot(base.tenantId) };
    await expect(createMovementEvent(employeeCtx, { employmentId: employee.employmentId, kind: 'reportingLineChange',
      effectiveDate: '2026-07-01', managerEmploymentId: boss, remarks: 'Self-service' })).rejects.toThrow();

    const other = await seedBase();
    const foreign = (await hire(adminCtx(other), other, 'ForeignBoss')).employmentId;
    await expect(createMovementEvent(ADMIN, { employmentId: employee.employmentId, kind: 'reportingLineChange',
      effectiveDate: '2026-07-01', managerEmploymentId: foreign, remarks: 'Cross tenant' })).rejects.toThrow();
    const lines = await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.subordinateEmploymentId, employee.employmentId));
    expect(lines).toHaveLength(0);
    expect(await superiorChanges(ADMIN, employee.employmentId)).toHaveLength(0);
  });
});

describe('Direct Superior periods, backdating, Delete and audit (8f959c7a)', () => {
  it('shows From and an inclusive To on history rows and the detail view, from the reporting-line owner', async () => {
    const employee = (await hire(ADMIN, base, 'PeriodWorker')).employmentId;
    const first = (await hire(ADMIN, base, 'PeriodFirst')).employmentId;
    const second = (await hire(ADMIN, base, 'PeriodSecond')).employmentId;
    const third = (await hire(ADMIN, base, 'PeriodThird')).employmentId;
    await administrative(ADMIN, employee, first, '2026-02-01');
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01', managerEmploymentId: second, remarks: 'Restructure' });
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-09-01', managerEmploymentId: third, remarks: 'Promotion' });
    const rows = await superiorChanges(ADMIN, employee);
    expect(rows.map(row => [row.effectiveDate, row.superiorPeriod])).toEqual([
      ['2026-07-01', { from: '2026-07-01', to: '2026-08-31' }],
      ['2026-09-01', { from: '2026-09-01', to: null }],
    ]);
    expect((await movementDetail(ADMIN, employee, rows[0].id))?.superiorPeriod).toEqual({ from: '2026-07-01', to: '2026-08-31' });
    // The stored end stays exclusive; only the screens subtract a day.
    const history = await directSuperiorHistoryFor(ADMIN, employee);
    expect(history.map(line => [line.validFrom, line.validTo])).toEqual([['2026-07-01', '2026-09-01'], ['2026-02-01', '2026-07-01']]);
  });

  it('inserts a backdated change before a later movement, keeps that movement in effect, and Delete restores the previous superior with audit', async () => {
    const employee = (await hire(ADMIN, base, 'BackdateWorker')).employmentId;
    const first = (await hire(ADMIN, base, 'BackdateFirst')).employmentId;
    const second = (await hire(ADMIN, base, 'BackdateSecond')).employmentId;
    await administrative(ADMIN, employee, first, '2026-02-01');
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'orgAssignmentChange', effectiveDate: '2026-08-01', departmentId: base.deptB, remarks: 'Team move' });
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01', managerEmploymentId: second, remarks: 'Backdated restructure' });

    const [assignment] = await owner.db.select({ departmentId: schema.assignment.departmentId }).from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, employee), eq(schema.assignment.validFrom, '2026-08-01'), isNull(schema.assignment.supersededAt)));
    expect(assignment?.departmentId).toBe(base.deptB);
    expect(await currentSuperior(ADMIN, employee)).toBe(second);
    const [change] = (await superiorChanges(ADMIN, employee)).filter(row => !row.reversed);
    expect(change.superiorPeriod).toEqual({ from: '2026-07-01', to: null });

    // The employee has two reporting-line.set events (the 1 Feb administrative line and this change), and the
    // database returns them in no fixed order, so pick the change by its new superior rather than by position.
    const sets = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, base.tenantId),
      eq(schema.domainEvent.subjectEmploymentId, employee), eq(schema.domainEvent.eventType, 'reporting-line.set')));
    const toSecond = sets.filter(event => (event.payload as { managerEmploymentId?: string } | null)?.managerEmploymentId === second);
    expect(toSecond).toHaveLength(1);
    const [set] = toSecond;
    expect(set.actorId).toBe(base.adminUserId);
    expect(set.payload).toMatchObject({ managerEmploymentId: second, previousManagerEmploymentId: first, validFrom: '2026-07-01' });

    await reverseMovementEvent(ADMIN, { employmentId: employee, movementId: change.id, reason: 'Recorded for the wrong team' });
    expect(await currentSuperior(ADMIN, employee)).toBe(first);
    const [kept] = await owner.db.select({ departmentId: schema.assignment.departmentId }).from(schema.assignment)
      .where(and(eq(schema.assignment.employmentId, employee), eq(schema.assignment.validFrom, '2026-08-01'),
        eq(schema.assignment.departmentId, base.deptB), isNull(schema.assignment.supersededAt)));
    expect(kept).toBeTruthy();
    const reversed = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, base.tenantId),
      eq(schema.domainEvent.subjectEmploymentId, employee), eq(schema.domainEvent.eventType, 'employment.movement.reversed')));
    const own = reversed.find(event => (event.payload as { movementId?: string }).movementId === change.id);
    expect(own?.actorId).toBe(base.adminUserId);
    expect(own?.payload).toMatchObject({ reason: 'Recorded for the wrong team' });
    // After Delete the deleted change shows no period, and the remaining timeline is continuous.
    const after = await superiorChanges(ADMIN, employee);
    expect(after.find(row => row.id === change.id)?.superiorPeriod).toBeUndefined();
  });
});
