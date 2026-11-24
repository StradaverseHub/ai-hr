/**
 * Board 8f959c7a r2 — Direct Superior periods are corrected from the Direct Superior card: Edit (superior,
 * start, end), clearing an end date (the next period goes and this one carries on), and Remove. Neighbours
 * move with the change so periods never overlap; a period a "Changed Direct Superior" movement created is
 * corrected THROUGH that movement, so Employment History agrees with the card. Fictional fixtures only.
 *
 * The reporter's case (contest r1): the same superior split into two periods after a dated change was later
 * corrected back with "Just Amendment". The amendment used to make that change impossible to edit or delete
 * ("a later information-only correction protects managerEmploymentId"); clearing the end date now joins them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { amendDirectSuperior, informationCorrectionHistory } from '../core/information-correction';
import { correctDirectSuperiorPeriod, DirectSuperiorPeriodError } from '../core/direct-superior-periods';
import { createMovementEvent, movementHistory, reverseMovementEvent } from '../core/movement';
import { hireEmployee, ReportingCycleError, setReportingLine } from '../core/org';
import { directSuperiorPeriodsFor, reportingLinesFor } from '../core/read';
import { joinableSuperiorLineIds } from '../lib/direct-superior-period';
import { todayInKualaLumpur } from '../lib/hr-date';
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

import { correctDirectSuperiorPeriodAction } from '../app/admin/personnel/[employmentId]/actions';

let base: Base;
beforeAll(async () => { await migrateTestDb(); });
beforeEach(async () => { await resetDb(); base = await seedBase(); ADMIN = adminCtx(base); });
afterAll(async () => { await closeAll(); });

const hire = (b: Base, name: string, hiredOn = '2026-01-01') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}-${b.tenantId.slice(0, 6)}@fictional.test` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn,
  });
const line = (employee: string, manager: string, validFrom: string) =>
  setReportingLine(ADMIN, { subordinateEmploymentId: employee, managerEmploymentId: manager, lineType: 'administrative', validFrom });
/** Live periods oldest first, as [manager, from, exclusive to]. */
const periods = async (employee: string) =>
  (await directSuperiorPeriodsFor(ADMIN, employee)).periods.slice().reverse().map(p => [p.managerEmploymentId, p.validFrom, p.validTo]);
const card = async (employee: string) => {
  const read = await directSuperiorPeriodsFor(ADMIN, employee);
  const oldestFirst = read.periods.slice().reverse();
  return { revision: read.revision, at: (i: number) => oldestFirst[i] };
};
const currentSuperior = async (employee: string) =>
  (await reportingLinesFor(ADMIN, employee, undefined, { administrativeAsOf: todayInKualaLumpur() }))
    .managers.find(m => m.lineType === 'administrative')?.employmentId ?? null;
const superiorChanges = async (employee: string) =>
  (await movementHistory(ADMIN, employee)).filter(row => row.kind === 'reportingLineChange');
const corrections = (employee: string) => owner.db.select().from(schema.domainEvent).where(and(
  eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.subjectEmploymentId, employee),
  eq(schema.domainEvent.eventType, 'employment.information.corrected')));
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe('the reporter’s split period (8f959c7a r2)', () => {
  it('joins a superior split by a dated change that was amended back, through the card, and Employment History agrees', async () => {
    const employee = (await hire(base, 'SplitWorker')).employmentId;
    const kept = (await hire(base, 'KeptBoss')).employmentId;
    const wrong = (await hire(base, 'WrongBoss')).employmentId;
    await line(employee, kept, '2026-02-01');
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01',
      managerEmploymentId: wrong, remarks: 'Entered by mistake' });
    const open = (await reportingLinesFor(ADMIN, employee)).managers.find(m => m.lineType === 'administrative')!;
    await amendDirectSuperior(ADMIN, { employmentId: employee, expectedLineId: open.id, managerEmploymentId: kept, reason: 'Back to the right boss' });
    expect(await periods(employee)).toEqual([[kept, '2026-02-01', '2026-07-01'], [kept, '2026-07-01', null]]);

    const read = await directSuperiorPeriodsFor(ADMIN, employee);
    const first = read.periods.at(-1)!;
    expect([...joinableSuperiorLineIds(read.periods)]).toEqual([first.id]);

    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: read.revision, lineId: first.id,
      reason: 'Join the split period', operation: 'edit', managerEmploymentId: kept, validFrom: '2026-02-01', validToInclusive: null });
    expect(await periods(employee)).toEqual([[kept, '2026-02-01', null]]);
    expect(await currentSuperior(employee)).toBe(kept);
    const [change] = await superiorChanges(employee);
    expect(change.reversed).toBe(true);
  });

  it('lets Employment History Delete a dated change whose own period was later amended', async () => {
    const employee = (await hire(base, 'AmendedChangeWorker')).employmentId;
    const first = (await hire(base, 'AmendedFirst')).employmentId;
    const second = (await hire(base, 'AmendedSecond')).employmentId;
    const third = (await hire(base, 'AmendedThird')).employmentId;
    await line(employee, first, '2026-02-01');
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01', managerEmploymentId: second });
    const open = (await reportingLinesFor(ADMIN, employee)).managers.find(m => m.lineType === 'administrative')!;
    await amendDirectSuperior(ADMIN, { employmentId: employee, expectedLineId: open.id, managerEmploymentId: third, reason: 'Typo' });
    const [change] = await superiorChanges(employee);
    await reverseMovementEvent(ADMIN, { employmentId: employee, movementId: change.id, reason: 'Wrong change' });
    expect(await periods(employee)).toEqual([[first, '2026-02-01', null]]);
  });
});

describe('periods no movement owns (hire, import, amendment) are corrected directly', () => {
  async function threePeriods() {
    const employee = (await hire(base, 'DirectWorker')).employmentId;
    const a = (await hire(base, 'DirectA')).employmentId;
    const b = (await hire(base, 'DirectB')).employmentId;
    const c = (await hire(base, 'DirectC')).employmentId;
    const d = (await hire(base, 'DirectD')).employmentId;
    await line(employee, a, '2026-02-01');
    await line(employee, b, '2026-05-01');
    await line(employee, c, '2026-08-01');
    return { employee, a, b, c, d };
  }

  it('moves the next start when an end date changes, and the previous end when a start changes', async () => {
    const { employee, a, b, c } = await threePeriods();
    let view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(0).id, reason: 'Ended earlier',
      operation: 'edit', managerEmploymentId: a, validFrom: '2026-02-01', validToInclusive: '2026-03-31' });
    expect(await periods(employee)).toEqual([[a, '2026-02-01', '2026-04-01'], [b, '2026-04-01', '2026-08-01'], [c, '2026-08-01', null]]);

    view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(1).id, reason: 'Started later',
      operation: 'edit', managerEmploymentId: b, validFrom: '2026-04-15', validToInclusive: '2026-07-31' });
    expect(await periods(employee)).toEqual([[a, '2026-02-01', '2026-04-15'], [b, '2026-04-15', '2026-08-01'], [c, '2026-08-01', null]]);
  });

  it('changes a past superior with an audit record of before, after, reason and actor', async () => {
    const { employee, a, b, c, d } = await threePeriods();
    const view = await card(employee);
    const original = view.at(1);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: original.id, reason: 'Wrong person recorded',
      operation: 'edit', managerEmploymentId: d, validFrom: '2026-05-01', validToInclusive: '2026-07-31' });
    expect(await periods(employee)).toEqual([[a, '2026-02-01', '2026-05-01'], [d, '2026-05-01', '2026-08-01'], [c, '2026-08-01', null]]);
    const [event] = await corrections(employee);
    expect(event.actorId).toBe(base.adminUserId);
    expect(event.payload).toMatchObject({ source: 'direct-superior', operation: 'period-edit', reason: 'Wrong person recorded',
      before: { managerEmploymentId: b }, after: { managerEmploymentId: d } });
    expect((event.payload as { reportingLines: { supersededId: string }[] }).reportingLines.map(r => r.supersededId)).toEqual([original.id]);
    const [audit] = await informationCorrectionHistory(ADMIN, employee);
    expect(audit.payload).toMatchObject({ reason: 'Wrong person recorded' });
    // The superseded line is kept, not deleted.
    const [kept] = await owner.db.select().from(schema.reportingLine).where(eq(schema.reportingLine.id, original.id));
    expect(kept.supersededAt).not.toBeNull();
  });

  it('removes a middle period (the one before carries on), the first period (the next starts earlier) and the current one', async () => {
    const { employee, a, b, c } = await threePeriods();
    let view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(1).id, reason: 'Never happened', operation: 'remove' });
    expect(await periods(employee)).toEqual([[a, '2026-02-01', '2026-08-01'], [c, '2026-08-01', null]]);
    view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(0).id, reason: 'Wrong from the start', operation: 'remove' });
    expect(await periods(employee)).toEqual([[c, '2026-02-01', null]]);
    view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(0).id, reason: 'No superior', operation: 'remove' });
    expect(await periods(employee)).toEqual([]);
    void b;
  });

  it('refuses unsafe corrections in plain words and writes nothing', async () => {
    const { employee, a, b } = await threePeriods();
    const view = await card(employee);
    const before = await periods(employee);
    const edit = (lineId: string, patch: { managerEmploymentId: string; validFrom: string; validToInclusive: string | null }, revision = view.revision) =>
      correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision, lineId, reason: 'Check', operation: 'edit', ...patch });
    await expect(edit(view.at(0).id, { managerEmploymentId: a, validFrom: '2025-12-01', validToInclusive: '2026-04-30' })).rejects.toThrow('on or after the hiring date');
    await expect(edit(view.at(0).id, { managerEmploymentId: a, validFrom: '2026-02-01', validToInclusive: '2026-09-30' })).rejects.toThrow('whole next period');
    await expect(edit(view.at(1).id, { managerEmploymentId: b, validFrom: '2026-01-15', validToInclusive: '2026-07-31' })).rejects.toThrow('whole previous period');
    await expect(edit(view.at(0).id, { managerEmploymentId: a, validFrom: '2026-02-01', validToInclusive: null })).rejects.toThrow('later periods first');
    await expect(edit(view.at(0).id, { managerEmploymentId: employee, validFrom: '2026-02-01', validToInclusive: '2026-04-30' })).rejects.toBeInstanceOf(ReportingCycleError);
    await expect(edit(view.at(0).id, { managerEmploymentId: a, validFrom: '2026-02-01', validToInclusive: '2026-04-30' }, 'stale')).rejects.toThrow('changed after this page opened');
    await expect(edit(view.at(0).id, { managerEmploymentId: a, validFrom: '2026-02-01', validToInclusive: '2026-04-30' })).rejects.toBeInstanceOf(DirectSuperiorPeriodError);
    expect(await periods(employee)).toEqual(before);
    expect(await corrections(employee)).toHaveLength(0);
  });
});

describe('periods a "Changed Direct Superior" movement owns are corrected through the movement', () => {
  it('edits the change’s start and superior, then removes it, keeping Employment History in step', async () => {
    const employee = (await hire(base, 'OwnedWorker')).employmentId;
    const first = (await hire(base, 'OwnedFirst')).employmentId;
    const second = (await hire(base, 'OwnedSecond')).employmentId;
    const third = (await hire(base, 'OwnedThird')).employmentId;
    await line(employee, first, '2026-02-01');
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01', managerEmploymentId: second, remarks: 'Restructure' });

    let view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(1).id, reason: 'Wrong date and person',
      operation: 'edit', managerEmploymentId: third, validFrom: '2026-07-15', validToInclusive: null });
    expect(await periods(employee)).toEqual([[first, '2026-02-01', '2026-07-15'], [third, '2026-07-15', null]]);
    const live = (await superiorChanges(employee)).filter(row => !row.reversed);
    expect(live.map(row => [row.effectiveDate, row.superiorChange?.after])).toEqual([['2026-07-15', { kind: 'named', name: 'OwnedThird' }]]);
    // A movement-owned correction is recorded on the movement itself, not as a separate information correction.
    expect(await corrections(employee)).toHaveLength(0);

    view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(1).id, reason: 'Not needed', operation: 'remove' });
    expect(await periods(employee)).toEqual([[first, '2026-02-01', null]]);
    expect((await superiorChanges(employee)).every(row => row.reversed)).toBe(true);
  });

  it('moves a change’s date when the period before it gets a new end date', async () => {
    const employee = (await hire(base, 'EndWorker')).employmentId;
    const first = (await hire(base, 'EndFirst')).employmentId;
    const second = (await hire(base, 'EndSecond')).employmentId;
    await line(employee, first, '2026-02-01');
    await createMovementEvent(ADMIN, { employmentId: employee, kind: 'reportingLineChange', effectiveDate: '2026-07-01', managerEmploymentId: second });
    const view = await card(employee);
    await correctDirectSuperiorPeriod(ADMIN, { employmentId: employee, revision: view.revision, lineId: view.at(0).id, reason: 'Handover was later',
      operation: 'edit', managerEmploymentId: first, validFrom: '2026-02-01', validToInclusive: '2026-08-31' });
    expect(await periods(employee)).toEqual([[first, '2026-02-01', '2026-09-01'], [second, '2026-09-01', null]]);
    expect((await superiorChanges(employee)).filter(row => !row.reversed).map(row => row.effectiveDate)).toEqual(['2026-09-01']);
  });
});

describe('authority and the card action', () => {
  it('refuses a caller without maintain rights, and a superior from another tenant, writing nothing', async () => {
    const worker = await hire(base, 'ScopedPeriodWorker');
    const boss = (await hire(base, 'ScopedPeriodBoss')).employmentId;
    await line(worker.employmentId, boss, '2026-02-01');
    const view = await card(worker.employmentId);
    const userId = await createAppUser(base.tenantId, worker.personId, 'employee');
    const employeeCtx: SessionContext = { tenantId: base.tenantId, userId, roles: ['employee'], personId: worker.personId,
      entitlements: harnessSnapshot(base.tenantId) };
    await expect(correctDirectSuperiorPeriod(employeeCtx, { employmentId: worker.employmentId, revision: view.revision,
      lineId: view.at(0).id, reason: 'Self-service', operation: 'remove' })).rejects.toThrow();

    const other = await seedBase();
    const foreign = (await hire(other, 'ForeignPeriodBoss')).employmentId;
    await expect(correctDirectSuperiorPeriod(ADMIN, { employmentId: worker.employmentId, revision: view.revision, lineId: view.at(0).id,
      reason: 'Cross tenant', operation: 'edit', managerEmploymentId: foreign, validFrom: '2026-02-01', validToInclusive: null })).rejects.toThrow();
    expect(await periods(worker.employmentId)).toEqual([[boss, '2026-02-01', null]]);
  });

  it('answers on the card: refusals in plain words, a saved correction with its message', async () => {
    const employee = (await hire(base, 'ActionWorker')).employmentId;
    const a = (await hire(base, 'ActionA')).employmentId;
    const b = (await hire(base, 'ActionB')).employmentId;
    await line(employee, a, '2026-02-01');
    await line(employee, b, '2026-06-01');
    const view = await card(employee);
    const fields = { employmentId: employee, submissionId: 'sub-1', periodRevision: view.revision, periodLineId: view.at(0).id,
      periodOperation: 'edit', superiorEmploymentId: a, validFrom: '2026-02-01', validToInclusive: '2026-06-30' };
    const missingReason = await correctDirectSuperiorPeriodAction({ status: 'idle' }, form({ ...fields, reason: '' }));
    expect(missingReason).toMatchObject({ status: 'refused', message: 'directSuperiorReasonRequired' });
    const backwards = await correctDirectSuperiorPeriodAction({ status: 'idle' }, form({ ...fields, reason: 'Typo', validToInclusive: '2026-01-15' }));
    expect(backwards).toMatchObject({ status: 'refused' });
    expect(backwards.status !== 'idle' && backwards.message).toContain('on or after the Start Date');
    const self = await correctDirectSuperiorPeriodAction({ status: 'idle' }, form({ ...fields, reason: 'Self', superiorEmploymentId: employee }));
    expect(self).toMatchObject({ status: 'refused', message: 'directSuperiorSelf' });
    const saved = await correctDirectSuperiorPeriodAction({ status: 'idle' }, form({ ...fields, reason: 'Handover later' }));
    expect(saved).toMatchObject({ status: 'saved', submissionId: 'sub-1', message: 'directSuperiorPeriodSaved' });
    expect(await periods(employee)).toEqual([[a, '2026-02-01', '2026-07-01'], [b, '2026-07-01', null]]);
  });
});
