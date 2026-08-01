/**
 * ADR-0077 slice 5, step 1 — the COUNTRY dimension on leave_type (migration 0344).
 *
 * leave_type carries GENERIC codes ('ANNUAL', 'SICK') seeded by the country pack. Under 0031's
 * `(tenant_id, lower(code)) WHERE archived_at IS NULL`, a second pack seeding its own 'ANNUAL' for the
 * same tenant would be REFUSED — a legitimate SG row rejected because an MY row already holds the code.
 * The dimension ships now, before a second pack exists, so the index changes once rather than being
 * retrofitted under live multi-country data.
 *
 * These assertions are the whole reason the migration is safe to leave with a column DEFAULT: they prove
 * the index turns a forgotten `country` into a LOUD collision rather than a silently mis-attributed row.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

const insert = (tenantId: string, code: string, country?: string) =>
  owner.db.insert(schema.leaveType).values({
    tenantId,
    code,
    name: `${code} ${country ?? 'default'} ${randomUUID().slice(0, 6)}`,
    paid: true,
    counting: 'working_days',
    ...(country ? { country } : {}),
  });

describe('leave_type is unique per (tenant, country, code)', () => {
  it('lets two countries hold the SAME code for one tenant — the point of the change', async () => {
    await insert(b.tenantId, 'ANNUAL_X', 'MY');
    await insert(b.tenantId, 'ANNUAL_X', 'SG');
    const rows = await owner.db.select().from(schema.leaveType);
    const mine = rows.filter((r) => r.code === 'ANNUAL_X');
    expect(mine.map((r) => r.country).sort()).toEqual(['MY', 'SG']);
  });

  it('still refuses a duplicate code WITHIN one country', async () => {
    await insert(b.tenantId, 'DUP_X', 'MY');
    await expect(insert(b.tenantId, 'DUP_X', 'MY')).rejects.toThrow();
  });

  // Case-insensitivity came from 0031 and must survive the replacement.
  it('is still case-insensitive on the code', async () => {
    await insert(b.tenantId, 'CASE_X', 'MY');
    await expect(insert(b.tenantId, 'case_x', 'MY')).rejects.toThrow();
  });

  // THE ASSERTION THAT JUSTIFIES THE COLUMN DEFAULT. A seeder that forgets `country` does not write a
  // quietly mis-attributed row: it lands on 'MY' and collides with the row already there.
  it('makes an omitted country collide loudly rather than mis-attribute', async () => {
    await insert(b.tenantId, 'OMIT_X', 'MY');
    await expect(insert(b.tenantId, 'OMIT_X')).rejects.toThrow();
  });

  it('defaults an omitted country to MY', async () => {
    await insert(b.tenantId, 'DEFAULT_X');
    const [row] = (await owner.db.select().from(schema.leaveType)).filter((r) => r.code === 'DEFAULT_X');
    expect(row.country).toBe('MY');
  });

  // The partial predicate is what makes archive-then-recreate work, and 0031's comment says so. Losing it
  // in the replacement would break a supported flow silently.
  it('frees the code once the row is archived', async () => {
    await insert(b.tenantId, 'ARCH_X', 'MY');
    await owner.db
      .update(schema.leaveType)
      .set({ archivedAt: new Date() })
      .where(eq(schema.leaveType.code, 'ARCH_X'));
    await expect(insert(b.tenantId, 'ARCH_X', 'MY')).resolves.toBeTruthy();
  });
});
