/**
 * Employee ID (employee_code) format pinning test — Employee ID feature (38668d9b).
 *
 * The reporter's "Employee ID" enhancement is display/consistency only; the code FORMAT and its
 * generation are already correct and out of scope to change. This golden test locks down the exact
 * output SHAPE of core/comp.ts `nextEmployeeCode` at counter boundaries so any future change to the
 * algorithm (e.g. a different prefix, a different pad width, a hard length cap) is caught by CI rather
 * than discovered via another contest.
 *
 * Established behaviour (pinned, NOT changed here): `EMP-` + zero-padded counter, min width 4.
 *   counter 1     -> EMP-0001   (8 chars)
 *   counter 9999  -> EMP-9999   (8 chars)
 *   counter 10000 -> EMP-10000  (9 chars — padStart is a MINIMUM width, not a cap)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeAll, migrateTestDb, owner, resetDb } from './harness';
import { tenant, tenantCounter } from '../db/schema';
import { nextEmployeeCode } from '../core/comp';

let tenantId: string;

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  const [t] = await owner.db
    .insert(tenant)
    .values({ workosOrgId: `org_ecfmt_${Date.now()}`, name: 'EmpCode Format Co' })
    .returning({ id: tenant.id });
  tenantId = t.id;
});

afterAll(async () => {
  await closeAll();
});

/**
 * Force the per-tenant counter to `previous`, then return the very next code. nextEmployeeCode does
 * `value + 1` on conflict and returns the new value, so seeding `previous = n - 1` yields the code for
 * counter `n`. Runs inside the owner transaction (bypasses RLS — this is a pure format assertion, not
 * an authorization test).
 */
async function codeForCounter(n: number): Promise<string> {
  return owner.db.transaction(async (tx) => {
    await tx
      .insert(tenantCounter)
      .values({ tenantId, kind: 'employee_code', value: n - 1 })
      .onConflictDoUpdate({
        target: [tenantCounter.tenantId, tenantCounter.kind],
        set: { value: n - 1 },
      });
    return nextEmployeeCode(tx, tenantId);
  });
}

describe('nextEmployeeCode — format pinning', () => {
  it('counter 1 → EMP-0001 (8 chars)', async () => {
    const code = await codeForCounter(1);
    expect(code).toBe('EMP-0001');
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^EMP-\d{4,}$/);
  });

  it('counter 9999 → EMP-9999 (8 chars, still min-width)', async () => {
    const code = await codeForCounter(9999);
    expect(code).toBe('EMP-9999');
    expect(code).toHaveLength(8);
  });

  it('counter 10000 → EMP-10000 (9 chars — padStart is a floor, not a cap)', async () => {
    const code = await codeForCounter(10000);
    expect(code).toBe('EMP-10000');
    expect(code).toHaveLength(9);
  });

  it('is alphanumeric with the EMP- prefix and no separators beyond the dash', async () => {
    const code = await codeForCounter(42);
    expect(code).toBe('EMP-0042');
    // letters + digits + the single prefix dash only (the reporter's "letters/numbers" contract)
    expect(code).toMatch(/^EMP-[0-9]+$/);
  });

  it('is generated (increments) on consecutive calls within a tenant', async () => {
    const result = await owner.db.transaction(async (tx) => {
      // start from a known point
      await tx
        .insert(tenantCounter)
        .values({ tenantId, kind: 'employee_code', value: 100 })
        .onConflictDoUpdate({
          target: [tenantCounter.tenantId, tenantCounter.kind],
          set: { value: 100 },
        });
      const first = await nextEmployeeCode(tx, tenantId);
      const second = await nextEmployeeCode(tx, tenantId);
      return { first, second };
    });
    expect(result.first).toBe('EMP-0101');
    expect(result.second).toBe('EMP-0102');
    expect(result.first).not.toBe(result.second);
  });

  it('leaves the counter row consistent (value matches the last issued code)', async () => {
    await codeForCounter(500);
    const [row] = await owner.db
      .select({ value: tenantCounter.value })
      .from(tenantCounter)
      .where(and(eq(tenantCounter.tenantId, tenantId), eq(tenantCounter.kind, 'employee_code')));
    expect(row.value).toBe(500);
  });
});
