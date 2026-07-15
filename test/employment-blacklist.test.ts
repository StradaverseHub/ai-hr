/**
 * Employee Status redesign (R43 c26c3ce5) — Blacklist is the one stored, event-driven override on top of the
 * otherwise date-derived Employee Status. This suite proves setEmploymentBlacklist: sets/clears the stored
 * flag, audits each transition (employment.blacklisted / employment.blacklist.cleared), is idempotent
 * (no duplicate event on a repeat), and the derived status reflects the override.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setEmploymentBlacklist } from '../core/org';
import { deriveEmploymentStatus } from '../core/employment-status';
import * as schema from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `bl_${randomUUID().slice(0, 8)}@t.local`;

async function hireOne() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Blacklist Test', primaryEmail: email() },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

async function empRow(employmentId: string) {
  const [row] = await owner.db
    .select({ blacklistedAt: schema.employment.blacklistedAt, blacklistReason: schema.employment.blacklistReason })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1);
  return row;
}

describe('setEmploymentBlacklist', () => {
  it('sets the blacklist flag + reason and audits employment.blacklisted', async () => {
    const hire = await hireOne();
    const res = await setEmploymentBlacklist(adminCtx(b), {
      employmentId: hire.employmentId,
      blacklisted: true,
      reason: 'Integrity breach',
    });
    expect(res.changed).toBe(true);
    expect(res.blacklisted).toBe(true);

    const row = await empRow(hire.employmentId);
    expect(row.blacklistedAt).not.toBeNull();
    expect(row.blacklistReason).toBe('Integrity breach');
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).toContain('employment.blacklisted');

    // The derived status now returns 'blacklisted', overriding the date-based bucket.
    expect(deriveEmploymentStatus(row, '2026-07-15')).toBe('blacklisted');
  });

  it('clearing removes the flag and audits employment.blacklist.cleared', async () => {
    const hire = await hireOne();
    await setEmploymentBlacklist(adminCtx(b), { employmentId: hire.employmentId, blacklisted: true });
    const res = await setEmploymentBlacklist(adminCtx(b), { employmentId: hire.employmentId, blacklisted: false });
    expect(res.changed).toBe(true);
    expect(res.blacklisted).toBe(false);

    const row = await empRow(hire.employmentId);
    expect(row.blacklistedAt).toBeNull();
    expect(row.blacklistReason).toBeNull();
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).toContain('employment.blacklist.cleared');
  });

  it('is a no-op (no event) when clearing an already-clear employment', async () => {
    const hire = await hireOne();
    const res = await setEmploymentBlacklist(adminCtx(b), { employmentId: hire.employmentId, blacklisted: false });
    expect(res.changed).toBe(false);
    expect(await eventTypesFor(b.tenantId, hire.employmentId)).not.toContain('employment.blacklist.cleared');
  });

  it('is a no-op when re-blacklisting with the same reason', async () => {
    const hire = await hireOne();
    await setEmploymentBlacklist(adminCtx(b), { employmentId: hire.employmentId, blacklisted: true, reason: 'x' });
    const before = await empRow(hire.employmentId);
    const res = await setEmploymentBlacklist(adminCtx(b), { employmentId: hire.employmentId, blacklisted: true, reason: 'x' });
    expect(res.changed).toBe(false);
    // The stored blacklistedAt date is unchanged (not bumped) by the repeat call.
    expect((await empRow(hire.employmentId)).blacklistedAt).toBe(before.blacklistedAt);
  });
});
