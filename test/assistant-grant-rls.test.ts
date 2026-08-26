/**
 * ADR-0082 slice 2 — the assistant substrate's ACCESS CONTROL, asserted against real RLS.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT OPTIONAL. `db/migrations/0451_assistant_substrate.sql` names
 * this file, in the present tense, as the guard for its three `REVOKE DELETE`s — and the same paragraph
 * explains that nothing else CAN catch a missing one: every cluster bootstrapped through
 * `deploy/bootstrap-db.sql` runs `ALTER DEFAULT PRIVILEGES` granting `ai_hr_app` full CRUD on every
 * owner-created table, so a dropped REVOKE is invisible until somebody deletes a row in production.
 * The migration shipped citing a file that did not exist. It does now.
 *
 * The other four cases are the ones the completeness critic identified as the highest-value missing
 * assertions in the slice — each is a scope check whose removal leaves every other test green:
 *
 *   1. `core/assistant-grant.ts`'s `app_user_id` predicate. `assistant_grant_read` ORs in
 *      `app.is_admin()`, so for an hr_admin the policy matches EVERY row in the tenant. Without the
 *      explicit comparison an admin resolves `allowed: true` because SOMEBODY holds a grant. Delete the
 *      predicate and nothing else in the suite notices.
 *   2. `assistant_exchange` admin-invisibility (§2.7). An HR admin browsing what employees asked the
 *      assistant is a surveillance surface nobody asked for, so the policy has no admin branch at all.
 *      Before this file, not one row had ever been inserted into that table by any code or test.
 *   3. Tenant isolation on all four tables.
 *   4. Both gates fail CLOSED — module off, or no grant.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  AssistantNotGrantedError,
  grantAssistant,
  listAssistantGrants,
  mayUseAssistant,
  revokeAssistant,
  assertMayUseAssistant,
} from '../core/assistant-grant';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

/** An employee-scoped session: a real person, a real app_user, the `employee` role and no grants. */
async function employeeSession(b: Base, name: string): Promise<{ ctx: SessionContext; userId: string; personId: string }> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  return {
    userId,
    personId: e.personId,
    ctx: {
      tenantId: b.tenantId,
      userId,
      personId: e.personId,
      roles: ['employee'],
      grants: [{ role: 'employee', companyId: null }],
      entitlements: adminCtx(b).entitlements,
    },
  };
}

describe('ADR-0082 slice 2 — assistant grant + transcript access control', () => {
  let base: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // `assistant` is billable, so it is OFF until switched on. Every case below that expects the module
    // gate to pass turns it on explicitly.
    await setModule(base.tenantId, 'assistant', 'active');
  });

  // ── 1. the app_user_id predicate ───────────────────────────────────────────────────────────────

  it('an ADMIN does not inherit somebody else‘s grant — the app_user_id predicate is load-bearing', async () => {
    const emp = await employeeSession(base, 'Ain Rahim');
    const admin = adminCtx(base);
    await grantAssistant(admin, { appUserId: emp.userId });

    // The employee holds the only grant in the tenant.
    expect((await mayUseAssistant(emp.ctx)).allowed).toBe(true);

    // The admin holds none. `assistant_grant_read` ORs in app.is_admin(), so RLS hands the admin BOTH
    // rows; only the app_user_id comparison in mayUseAssistant keeps this false. If this case ever goes
    // green after that predicate is removed, the predicate was not what made it pass.
    const adminSelf: SessionContext = { ...admin, userId: base.adminUserId };
    const access = await mayUseAssistant(adminSelf);
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toBe('no_grant');
  });

  it('RLS really does hand the admin the other user‘s row — so the predicate is not redundant', async () => {
    const emp = await employeeSession(base, 'Bala Nair');
    await grantAssistant(adminCtx(base), { appUserId: emp.userId });

    // Read through the APP role as the admin, deliberately WITHOUT the app_user_id filter. This is the
    // query mayUseAssistant would run if its predicate were dropped. It must return a row — that is the
    // whole hazard — and this assertion is what makes the case above meaningful rather than vacuous.
    const adminSelf: SessionContext = { ...adminCtx(base), userId: base.adminUserId };
    const rows = await withTenant(adminSelf, (tx) =>
      tx.select({ id: schema.assistantGrant.id }).from(schema.assistantGrant).where(isNull(schema.assistantGrant.revokedAt)),
    );
    expect(rows.length).toBe(1);
  });

  it('an employee sees only their OWN grant row', async () => {
    const a = await employeeSession(base, 'Chan Wei');
    const c = await employeeSession(base, 'Devi Kaur');
    const admin = adminCtx(base);
    await grantAssistant(admin, { appUserId: a.userId });
    await grantAssistant(admin, { appUserId: c.userId });

    const mine = await listAssistantGrants(a.ctx);
    expect(mine.map((r) => r.appUserId)).toEqual([a.userId]);
    // The admin, by contrast, sees both — that is the admin branch of the read policy working.
    expect((await listAssistantGrants(admin)).length).toBe(2);
  });

  // ── 2. the transcript is admin-INVISIBLE (§2.7) ────────────────────────────────────────────────

  it('an hr_admin cannot read another user‘s assistant_exchange rows — there is no admin branch', async () => {
    const emp = await employeeSession(base, 'Eve Tan');
    await owner.db.insert(schema.assistantExchange).values({
      tenantId: base.tenantId,
      appUserId: emp.userId,
      question: 'How much annual leave do I have left?',
      answer: 'You have 8 days.',
    });

    // The owner wrote it, so it exists — assert that first, or an empty admin read proves nothing.
    const all = await owner.db
      .select({ id: schema.assistantExchange.id })
      .from(schema.assistantExchange)
      .where(eq(schema.assistantExchange.tenantId, base.tenantId));
    expect(all.length).toBe(1);

    const adminSelf: SessionContext = { ...adminCtx(base), userId: base.adminUserId };
    const seenByAdmin = await withTenant(adminSelf, (tx) =>
      tx.select({ id: schema.assistantExchange.id }).from(schema.assistantExchange),
    );
    expect(seenByAdmin).toEqual([]);

    // …and the author sees their own.
    const seenBySelf = await withTenant(emp.ctx, (tx) =>
      tx.select({ id: schema.assistantExchange.id }).from(schema.assistantExchange),
    );
    expect(seenBySelf.length).toBe(1);
  });

  // ── 3. tenant isolation ────────────────────────────────────────────────────────────────────────

  it('no assistant table leaks across tenants', async () => {
    const emp = await employeeSession(base, 'Faiz Omar');
    await grantAssistant(adminCtx(base), { appUserId: emp.userId });
    await owner.db.insert(schema.assistantExchange).values({
      tenantId: base.tenantId,
      appUserId: emp.userId,
      question: 'q',
    });
    await owner.db.insert(schema.assistantBudget).values({
      tenantId: base.tenantId,
      monthlyTokenCeiling: 1_000_000,
      perUserDailyQuestions: 10,
      effectiveFrom: '2026-01-01',
    });
    await owner.db.insert(schema.assistantUsage).values({ tenantId: base.tenantId, period: '2026-01' });

    // A SECOND, unrelated tenant with its own admin.
    const other = await seedBase();
    const otherAdmin: SessionContext = { ...adminCtx(other), userId: other.adminUserId };

    const counts = await withTenant(otherAdmin, async (tx) => ({
      grants: (await tx.select({ id: schema.assistantGrant.id }).from(schema.assistantGrant)).length,
      exchanges: (await tx.select({ id: schema.assistantExchange.id }).from(schema.assistantExchange)).length,
      budgets: (await tx.select({ id: schema.assistantBudget.id }).from(schema.assistantBudget)).length,
      usage: (await tx.select({ id: schema.assistantUsage.id }).from(schema.assistantUsage)).length,
    }));
    expect(counts).toEqual({ grants: 0, exchanges: 0, budgets: 0, usage: 0 });
  });

  // ── 4. both gates fail CLOSED ──────────────────────────────────────────────────────────────────

  it('module off refuses even a granted user, and the reason distinguishes it from an ungranted one', async () => {
    const emp = await employeeSession(base, 'Gita Rao');
    await grantAssistant(adminCtx(base), { appUserId: emp.userId });
    expect((await mayUseAssistant(emp.ctx)).allowed).toBe(true);

    await setModule(base.tenantId, 'assistant', 'disabled');
    // The snapshot on the context is resolved at session build time, so rebuild it the way a fresh
    // request would — otherwise this asserts against a stale entitlement and passes for the wrong reason.
    const refreshed = await seedBaseAwareCtx(base, emp.ctx);
    const access = await mayUseAssistant(refreshed);
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toBe('module_off');
  });

  it('revocation is a STAMP and immediately closes the gate', async () => {
    const emp = await employeeSession(base, 'Hafiz Lim');
    const admin = adminCtx(base);
    await grantAssistant(admin, { appUserId: emp.userId });
    await revokeAssistant(admin, { appUserId: emp.userId });

    expect((await mayUseAssistant(emp.ctx)).allowed).toBe(false);
    await expect(assertMayUseAssistant(emp.ctx)).rejects.toThrow(AssistantNotGrantedError);

    // The row SURVIVES, carrying revoked_at — "who could ask the assistant last March" stays answerable.
    const rows = await owner.db
      .select({ id: schema.assistantGrant.id, revokedAt: schema.assistantGrant.revokedAt })
      .from(schema.assistantGrant)
      .where(eq(schema.assistantGrant.appUserId, emp.userId));
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).not.toBeNull();
  });

  it('granting twice is idempotent and does not race the live-unique index', async () => {
    const emp = await employeeSession(base, 'Ira Devi');
    const admin = adminCtx(base);
    const first = await grantAssistant(admin, { appUserId: emp.userId });
    const second = await grantAssistant(admin, { appUserId: emp.userId });
    expect(second.id).toBe(first.id);

    const live = await owner.db
      .select({ id: schema.assistantGrant.id })
      .from(schema.assistantGrant)
      .where(and(eq(schema.assistantGrant.appUserId, emp.userId), isNull(schema.assistantGrant.revokedAt)));
    expect(live.length).toBe(1);
  });

  it('a non-admin cannot grant themselves the assistant', async () => {
    const emp = await employeeSession(base, 'Jaya Menon');
    await expect(grantAssistant(emp.ctx, { appUserId: emp.userId })).rejects.toThrow();
    const rows = await owner.db.select({ id: schema.assistantGrant.id }).from(schema.assistantGrant);
    expect(rows).toEqual([]);
  });

  // ── 5. THE PRIVILEGE FACT 0451 CITES THIS FILE FOR ─────────────────────────────────────────────

  it('DELETE is revoked on the three stamp/ledger tables and DELIBERATELY KEPT on the transcript', async () => {
    // A privilege fact, read out of the catalog rather than inferred. Every cluster bootstrapped through
    // deploy/bootstrap-db.sql runs ALTER DEFAULT PRIVILEGES granting ai_hr_app full CRUD on every
    // owner-created table, so a dropped REVOKE is invisible to the cleanroom AND to the rest of the
    // suite — this assertion is the only thing standing between that and a deletable audit trail.
    //
    // THE ASYMMETRY IS THE POINT, and it is pinned here so it stays deliberate rather than drifting into
    // an accident either way. `assistant_grant`, `assistant_budget` and `assistant_usage` lose DELETE
    // because "revocation is a stamp", "a budget is archived" and "the usage counter cannot be reset"
    // are otherwise only conventions. `assistant_exchange` KEEPS it: a user erasing their own history is
    // the PDPA right, and the read policy scopes the delete to their own rows. Retention LENGTH is
    // ADR-0082 §8 decision 4 and is still open — this pins the capability, not the policy.
    const rows = await owner.db.execute<{ t: string; can_delete: boolean }>(sql`
      SELECT t AS t, has_table_privilege('ai_hr_app', t, 'DELETE') AS can_delete
      FROM unnest(ARRAY['assistant_grant', 'assistant_exchange', 'assistant_budget', 'assistant_usage']) AS t
    `);
    const byTable = Object.fromEntries((rows as unknown as { t: string; can_delete: boolean }[]).map((r) => [r.t, r.can_delete]));
    expect(byTable).toEqual({
      assistant_grant: false,
      assistant_budget: false,
      assistant_usage: false,
      assistant_exchange: true,
    });
  });

  it('ai_hr_app CAN read and write those tables — the REVOKE did not overshoot', async () => {
    // The counterpart. A REVOKE that also removed SELECT or INSERT would make every case above pass for
    // entirely the wrong reason: the assistant would simply be broken.
    const rows = await owner.db.execute<{ t: string; s: boolean; i: boolean }>(sql`
      SELECT t AS t,
             has_table_privilege('ai_hr_app', t, 'SELECT') AS s,
             has_table_privilege('ai_hr_app', t, 'INSERT') AS i
      FROM unnest(ARRAY['assistant_grant', 'assistant_exchange', 'assistant_usage']) AS t
    `);
    for (const r of rows as unknown as { t: string; s: boolean; i: boolean }[]) {
      expect({ table: r.t, select: r.s, insert: r.i }).toEqual({ table: r.t, select: true, insert: true });
    }
  });
});

/** Rebuild an employee context against the tenant's CURRENT entitlement snapshot. */
async function seedBaseAwareCtx(b: Base, ctx: SessionContext): Promise<SessionContext> {
  const { entitlements } = adminCtx(b);
  return { ...ctx, entitlements };
}
