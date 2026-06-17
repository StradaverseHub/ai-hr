/**
 * Performance Phase B — manager 1:1 check-ins (ADR-0022, slice 2). Continuous touchpoints between a
 * manager and a report: schedule (manager-or-admin, never self) → complete/cancel, with notes, RLS-
 * scoped to the subject. Covers authz, lifecycle, reads, and peer isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import {
  cancelCheckIn,
  completeCheckIn,
  managerCheckIns,
  myCheckIns,
  PerfError,
  scheduleCheckIn,
} from '../core/performance';
import { hireEmployee, setReportingLine } from '../core/org';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('ADR-0022 — 1:1 check-ins', () => {
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

  async function people() {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Report');
    const M = await hire(a, base, 'Lead');
    const X = await hire(a, base, 'Peer');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E.personId };
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    const xCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'], personId: X.personId };
    return { a, E, M, X, eCtx, mCtx, xCtx };
  }

  it('manager schedules a 1:1 with a report; subject sees it, manager sees the counterpart name', async () => {
    const { E, mCtx, eCtx } = await people();
    const { id } = await scheduleCheckIn(mCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01', notes: 'Quarterly catch-up' });
    expect(await eventTypesFor(base.tenantId, id)).toContain('performance-checkin.scheduled');
    // Subject sees their own check-in (the manager's name is RLS-hidden upward — it's their own manager).
    const [c] = await myCheckIns(eCtx);
    expect(c).toMatchObject({ id, scheduledOn: '2026-07-01', status: 'scheduled', subject: 'Report' });
    // The manager's own view resolves both names (they can see the report + themselves).
    const { checkins } = await managerCheckIns(mCtx);
    expect(checkins.find((x) => x.id === id)).toMatchObject({ subject: 'Report', manager: 'Lead' });
  });

  it('bans self-scheduling and peer-scheduling', async () => {
    const { E, eCtx, xCtx } = await people();
    await expect(scheduleCheckIn(eCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01' })).rejects.toThrow();
    await expect(scheduleCheckIn(xCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01' })).rejects.toThrow();
  });

  it('completes a check-in with notes (+ event); only from scheduled', async () => {
    const { E, mCtx } = await people();
    const { id } = await scheduleCheckIn(mCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01' });
    await completeCheckIn(mCtx, { checkinId: id, notes: 'Discussed goals + workload' });
    const { checkins } = await managerCheckIns(mCtx);
    const c = checkins.find((x) => x.id === id)!;
    expect(c.status).toBe('completed');
    expect(c.notes).toBe('Discussed goals + workload');
    expect(c.completedAt).not.toBeNull();
    expect(await eventTypesFor(base.tenantId, id)).toContain('performance-checkin.completed');
    await expect(completeCheckIn(mCtx, { checkinId: id })).rejects.toBeInstanceOf(PerfError); // already completed
  });

  it('cancels a scheduled check-in (+ event)', async () => {
    const { E, mCtx } = await people();
    const { id } = await scheduleCheckIn(mCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01' });
    await cancelCheckIn(mCtx, { checkinId: id });
    const { checkins } = await managerCheckIns(mCtx);
    expect(checkins.find((x) => x.id === id)?.status).toBe('cancelled');
    expect(await eventTypesFor(base.tenantId, id)).toContain('performance-checkin.cancelled');
  });

  it('managerCheckIns lists the run + the direct reports for the picker', async () => {
    const { E, mCtx } = await people();
    await scheduleCheckIn(mCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01' });
    const { checkins, reports } = await managerCheckIns(mCtx);
    expect(checkins.length).toBe(1);
    expect(reports.map((r) => r.name)).toContain('Report');
  });

  it('a peer cannot see the check-in (RLS)', async () => {
    const { E, mCtx, xCtx } = await people();
    await scheduleCheckIn(mCtx, { subjectEmploymentId: E.employmentId, scheduledOn: '2026-07-01' });
    expect(await myCheckIns(xCtx)).toEqual([]);
    expect((await managerCheckIns(xCtx)).checkins).toEqual([]);
  });
});
