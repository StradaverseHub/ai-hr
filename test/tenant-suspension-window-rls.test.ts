/**
 * 0465 — READINESS 1.7: `tenant_suspension_window` was the one table of 173 with row-level security
 * OFF, and `ai_hr_app` held full CRUD on it. This file is the reason a future edit cannot quietly
 * re-open it.
 *
 * WHY A TEST AT ALL, AND WHY IT READS THE CATALOG. `deploy/bootstrap-db.sql:72-75` and
 * `test/global-setup.ts:187` both run ALTER DEFAULT PRIVILEGES granting ai_hr_app full CRUD on every
 * table ai_hr_owner creates. As `test/operator-rls.test.ts` puts it for 0295: that arrangement MASKS a
 * missing GRANT and can NEVER catch a missing REVOKE. Nothing else in this repo would notice if the two
 * statements in 0465 were deleted — the app has no code path through this table, so no feature test
 * would go red. So the assertions here read `pg_class`, `pg_policy` and `information_schema`, plus the
 * app role's actual behaviour. Grepping the .sql file would prove only that somebody wrote a file.
 *
 * WHAT IS PINNED, and why each one is a decision and not a description:
 *   1. RLS is ENABLED                — the backstop that survives the grant coming back.
 *   2. RLS is NOT FORCED             — forcing would lock out ai_hr_owner, which is what apply-dunning,
 *                                      reactivate-tenant and the closure fixtures run as.
 *   3. There is NO policy            — the platform_user shape (0313/0351). A tenant policy here would
 *                                      invent an app-side reader that does not exist.
 *   4. ai_hr_app holds NO privilege  — the revoke.
 *   5. ai_hr_app cannot see a row that exists, and cannot write one.
 *   6. The RLS layer holds ON ITS OWN, proven by handing the grant back inside one test and watching
 *      the app role still see nothing. That is the re-bootstrap scenario 0465 argues about.
 *   7. ai_hr_owner is NOT locked out — the cron/script path still works.
 *
 * (3) and (7) are pins on decisions rather than discoveries of a defect: reverting 0465 leaves both
 * true. They are here so that a later "let's just FORCE it" or "let's add a tenant policy" has to
 * argue with an assertion. (1), (4), (5) and (6) all fail against the pre-0465 database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const TABLE = 'tenant_suspension_window';
const APP_ROLE = 'ai_hr_app';

/** Flatten an error and its `cause` chain — drizzle hides the PostgresError behind "Failed query: …". */
function causeChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

let b: Base;
let admin: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  admin = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});

/** One real suspension window for the seeded tenant, written by the owner (as the real writers do). */
async function seedWindow(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.tenantSuspensionWindow)
    .values({ tenantId: b.tenantId, suspendedAt: '2026-06-01', reason: 'past_due' })
    .returning({ id: schema.tenantSuspensionWindow.id });
  return row.id;
}

describe('0465 — tenant_suspension_window is control-plane: RLS on, no grant to the app role', () => {
  it('has row-level security ENABLED, and deliberately NOT forced', async () => {
    const [row] = await owner.db.execute<{ rls: boolean; forced: boolean }>(
      sql`select relrowsecurity as rls, relforcerowsecurity as forced
            from pg_class
           where oid = ${TABLE}::regclass`,
    );
    expect(row.rls, `${TABLE} must have RLS enabled — it was the one table of 173 without it`).toBe(true);
    expect(
      row.forced,
      'NOT forced: ai_hr_owner runs apply-dunning, reactivate-tenant and the closure fixtures, and FORCE ' +
        'with no policy would deny the table owner too',
    ).toBe(false);
  });

  it('carries NO policy — the platform_user shape, not a tenant policy', async () => {
    const rows = await owner.db.execute<{ polname: string }>(
      sql`select polname from pg_policy where polrelid = ${TABLE}::regclass`,
    );
    expect(
      rows.map((r) => r.polname),
      'RLS with zero policies denies every row to every non-owner role. A tenant policy would have to ' +
        'invent an app-side reader; nothing in app/, core/, lib/ or packs/ touches this table.',
    ).toEqual([]);
  });

  it('grants ai_hr_app nothing at all — not SELECT, INSERT, UPDATE or DELETE', async () => {
    const rows = await owner.db.execute<{ privilege_type: string }>(
      sql`select privilege_type
            from information_schema.role_table_grants
           where table_name = ${TABLE} and grantee = ${APP_ROLE}`,
    );
    expect(
      rows.map((r) => r.privilege_type).sort(),
      'the ALTER DEFAULT PRIVILEGES grant from bootstrap/global-setup must be revoked on this table',
    ).toEqual([]);

    // has_table_privilege as well as the catalogue view: the view misses privileges held via a role
    // membership, and "no row in role_table_grants" is not the same statement as "cannot".
    const [can] = await owner.db.execute<Record<string, boolean>>(
      sql`select has_table_privilege(${APP_ROLE}, ${TABLE}, 'SELECT') as sel,
                 has_table_privilege(${APP_ROLE}, ${TABLE}, 'INSERT') as ins,
                 has_table_privilege(${APP_ROLE}, ${TABLE}, 'UPDATE') as upd,
                 has_table_privilege(${APP_ROLE}, ${TABLE}, 'DELETE') as del`,
    );
    expect({ ...can }).toEqual({ sel: false, ins: false, upd: false, del: false });
  });

  it('hides a row that really exists from a tenant session, and refuses a write', async () => {
    const id = await seedWindow();

    // The row is there — asserted as the owner, so a later "0 rows" cannot mean "nothing was written".
    const asOwner = await owner.db
      .select({ id: schema.tenantSuspensionWindow.id })
      .from(schema.tenantSuspensionWindow)
      .where(eq(schema.tenantSuspensionWindow.id, id));
    expect(asOwner, 'fixture precondition: the owner wrote and can see the window').toHaveLength(1);

    // Read as the app role. Denied at the grant layer today; were the grant ever restored, RLS with no
    // policy returns zero rows. Both are "cannot see it", and this accepts either rather than pinning
    // which layer happens to be reached first.
    const read = await withTenant(admin, (tx) =>
      tx.select({ id: schema.tenantSuspensionWindow.id }).from(schema.tenantSuspensionWindow),
    ).catch((e: unknown) => e);
    if (read instanceof Error) {
      expect(causeChain(read)).toMatch(/permission denied/i);
    } else {
      expect(read, 'a tenant session must not read another plane’s suspension history').toEqual([]);
    }

    // And it cannot write one for itself, or for anybody else.
    const wrote = await withTenant(admin, (tx) =>
      tx
        .insert(schema.tenantSuspensionWindow)
        .values({ tenantId: b.tenantId, suspendedAt: '2026-07-01', reason: 'self-inflicted' }),
    ).catch((e: unknown) => e);
    expect(wrote, 'a tenant session cannot record its own suspension').toBeInstanceOf(Error);
    expect(causeChain(wrote)).toMatch(/permission denied|row-level security|violates/i);

    const after = await owner.db.select().from(schema.tenantSuspensionWindow);
    expect(after, 'nothing the app role attempted was written').toHaveLength(1);
  });

  it('still hides the row when the grant is handed back — RLS is a second, independent layer', async () => {
    const id = await seedWindow();
    // THE RE-BOOTSTRAP SCENARIO 0465 ARGUES ABOUT. The grant exists on production only because ALTER
    // DEFAULT PRIVILEGES hands it out, so it can come back silently. This proves the revoke is not the
    // only thing standing between a tenant session and cross-tenant control-plane data.
    await owner.db.execute(sql`grant select, insert, update, delete on ${sql.raw(TABLE)} to ${sql.raw(APP_ROLE)}`);
    try {
      const [can] = await owner.db.execute<{ sel: boolean }>(
        sql`select has_table_privilege(${APP_ROLE}, ${TABLE}, 'SELECT') as sel`,
      );
      expect(can.sel, 'precondition: the grant really is back, so the next assertion means something').toBe(
        true,
      );

      const rows = await withTenant(admin, (tx) =>
        tx.select({ id: schema.tenantSuspensionWindow.id }).from(schema.tenantSuspensionWindow),
      );
      expect(rows, 'RLS with no policy denies every row even to a fully-granted app role').toEqual([]);

      // The owner can still see it, so "zero rows" above is RLS filtering and not an empty table.
      const asOwner = await owner.db
        .select({ id: schema.tenantSuspensionWindow.id })
        .from(schema.tenantSuspensionWindow)
        .where(eq(schema.tenantSuspensionWindow.id, id));
      expect(asOwner).toHaveLength(1);
    } finally {
      // Worker databases outlive a single file, so this MUST be restored or a later file inherits a
      // grant this repo has decided against.
      await owner.db.execute(
        sql`revoke all privileges on ${sql.raw(TABLE)} from ${sql.raw(APP_ROLE)}`,
      );
    }

    const [can] = await owner.db.execute<{ sel: boolean }>(
      sql`select has_table_privilege(${APP_ROLE}, ${TABLE}, 'SELECT') as sel`,
    );
    expect(can.sel, 'the temporary grant was taken away again').toBe(false);
  });

  it('does NOT lock out ai_hr_owner — the six cron jobs and the two runners keep working', async () => {
    // None of the six cron jobs touches this table, but apply-dunning and reactivate-tenant do, and both
    // connect with MIGRATION_DATABASE_URL. ENABLE (not FORCE) is what keeps that true; this is the
    // assertion a future "let's FORCE it for symmetry with platform_user" has to argue with.
    const id = await seedWindow();
    await owner.db
      .update(schema.tenantSuspensionWindow)
      .set({ resumedAt: '2026-06-20' })
      .where(eq(schema.tenantSuspensionWindow.id, id));

    const [row] = await owner.db
      .select({ resumedAt: schema.tenantSuspensionWindow.resumedAt })
      .from(schema.tenantSuspensionWindow)
      .where(eq(schema.tenantSuspensionWindow.id, id));
    expect(row.resumedAt, 'reactivate-tenant closes an open window as the owner; RLS must not stop it').toBe(
      '2026-06-20',
    );

    await owner.db
      .delete(schema.tenantSuspensionWindow)
      .where(eq(schema.tenantSuspensionWindow.id, id));
    expect(await owner.db.select().from(schema.tenantSuspensionWindow)).toHaveLength(0);
  });
});
