/**
 * Redesign Employment Joining Date Structure (feedback 24c4d02e).
 *
 * hired_on is KEPT as the durable "Group Join Date" (relabelled in the UI, never renamed); a new nullable
 * join_date captures the current-company effective join. Covers: join_date persistence + employeeDetail
 * projection; the audited employment.info.updated event carrying join_date in before/after; the "join can't
 * precede the group join date" guard; that leaving join_date null is backward compatible; and the pure dual
 * service-length helper (group from hired_on, current-company from join_date ?? hired_on).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type SessionContext } from '../db/client';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { employeeDetail } from '../core/read';
import { serviceYearsAt, serviceYearsMonthsAt } from '../core/leave';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hire(name = 'JoinDate Test', hiredOn = '2018-01-01') {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return { id: r.employmentId };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('serviceYearsMonthsAt (pure)', () => {
  it('breaks service into whole years + residual months, consistent with serviceYearsAt', () => {
    expect(serviceYearsMonthsAt('2018-01-01', '2026-07-01')).toEqual({ years: 8, months: 6 });
    expect(serviceYearsMonthsAt('2025-01-01', '2026-07-01')).toEqual({ years: 1, months: 6 });
    // .years always equals serviceYearsAt for the same inputs.
    for (const [from, asOf] of [
      ['2018-01-01', '2026-07-01'],
      ['2025-06-15', '2026-07-15'],
      ['2026-03-31', '2026-03-30'],
    ] as const) {
      expect(serviceYearsMonthsAt(from, asOf).years).toBe(serviceYearsAt(from, asOf));
    }
  });
  it('clamps to zero when asOf precedes the start date', () => {
    expect(serviceYearsMonthsAt('2026-06-01', '2026-01-01')).toEqual({ years: 0, months: 0 });
  });
  it('drops the partial month when the day-of-month has not yet been reached', () => {
    expect(serviceYearsMonthsAt('2025-01-20', '2026-07-10')).toEqual({ years: 1, months: 5 });
  });
});

describe('setEmploymentInfo — Join Date', () => {
  it('persists join_date and projects it via employeeDetail', async () => {
    const e = await hire('Persist', '2018-01-01');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, joinDate: '2025-01-01' });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d).toBeTruthy();
    expect(d!.hiredOn).toBe('2018-01-01'); // Group Join Date unchanged.
    expect(d!.joinDate).toBe('2025-01-01');
  });

  it('appends an employment.info.updated event carrying join_date in before/after', async () => {
    const e = await hire('Audit', '2018-01-01');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, joinDate: '2025-01-01' });
    const types = await eventTypesFor(b.tenantId, e.id);
    expect(types).toContain('employment.info.updated');
    const payload = await latestEventPayload(b.tenantId, e.id, 'employment.info.updated');
    expect((payload!.fields as string[])).toContain('joinDate');
    expect((payload!.before as Record<string, unknown>).joinDate).toBeNull();
    expect((payload!.after as Record<string, unknown>).joinDate).toBe('2025-01-01');
  });

  it('rejects a join date earlier than the group join date', async () => {
    const e = await hire('Guard', '2020-06-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, joinDate: '2019-01-01' }),
    ).rejects.toThrow(/Join date/i);
  });

  it('validates join_date against a NEW group join date supplied in the same save', async () => {
    const e = await hire('Combo', '2018-01-01');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, hiredOn: '2026-01-01', joinDate: '2025-01-01' }),
    ).rejects.toThrow(/Join date/i);
  });

  it('leaves join_date null on a legacy employment (backward compatible; current service falls back to group)', async () => {
    const e = await hire('Legacy', '2018-01-01');
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.joinDate).toBeNull();
    // The UI computes current-company service from join_date ?? hired_on — with null it equals group service.
    const asOf = '2026-07-01';
    const group = serviceYearsMonthsAt(d!.hiredOn, asOf);
    const current = serviceYearsMonthsAt(d!.joinDate ?? d!.hiredOn, asOf);
    expect(current).toEqual(group);
    expect(group).toEqual({ years: 8, months: 6 });
  });

  it('an explicit blank clears join_date back to null', async () => {
    const e = await hire('Clear', '2018-01-01');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, joinDate: '2025-01-01' });
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, joinDate: '' });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.joinDate).toBeNull();
  });

  it('rejects a non-admin caller', async () => {
    const e = await hire('NonAdmin', '2018-01-01');
    const nonAdmin: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['employee'] };
    await expect(
      setEmploymentInfo(nonAdmin, { employmentId: e.id, joinDate: '2025-01-01' }),
    ).rejects.toThrow(/admin/i);
  });
});
