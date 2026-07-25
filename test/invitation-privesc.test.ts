/**
 * Invitation privilege escalation (slice 0 — F3/F18) — the seam asserted, not assumed.
 *
 * THE HOLE THESE TESTS CLOSE. Two facts combined into a tenant-wide escalation:
 *
 *   1. `app_invitation_rls`'s WITH CHECK (0151:51-53) carries NO role conjunct — it asks only
 *      `app.is_admin_for(coalesce(company_id, id))`. So a COMPANY-SCOPED hr_admin, who may grant
 *      only `hr_admin` within its own subtree under `role_assignment_write` (0295:66-82), can write
 *      an invitation row for ANY role — `super_admin`, or even the installation-tier `operator`.
 *   2. `app.consume_invitation` is SECURITY DEFINER (0281) and inserts `v_inv.role` into
 *      `role_assignment` uncritically (0151:158-159). `role_assignment` is not FORCE-RLS, so the
 *      definer runs as owner and 0295's matrix NEVER EVALUATES.
 *
 * The escalation is real because `app.is_group_admin()` (0016:38-44) is true for ANY `super_admin`
 * grant regardless of company scope — so a company-scoped admin who mints itself a company-scoped
 * `super_admin` has become a GROUP admin.
 *
 * `core/auth.ts` guards the TypeScript path (ROLES set + assertGroupAdmin), which is why this is not
 * exploitable through the app's own invite screen today. That guard is one call site; the database is
 * the boundary. These tests assert the boundary.
 *
 * Structure: every test drives the DB directly as `ai_hr_app` (never through core/auth.ts) — the
 * point is precisely what the database refuses when the TypeScript layer is bypassed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/**
 * Flatten an error, its `cause` chain, and the postgres error fields into one searchable string.
 *
 * Drizzle wraps a PostgresError in a "Failed query: …" Error, so a plain `toThrow(/…/)` only ever
 * sees the wrapper. Walking `.cause` alone is still not enough here: a CHECK-constraint violation
 * carries the useful identity in `constraint_name`/`detail`, and a plpgsql RAISE surfaces through
 * `where`, none of which appear in `.message`.
 */
function pgText(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    for (const k of ['message', 'detail', 'hint', 'constraint_name', 'where']) {
      if (typeof rec[k] === 'string') parts.push(rec[k] as string);
    }
    cur = rec.cause;
  }
  return parts.join(' | ');
}

const hashOf = async (raw: string) => {
  // `execute` yields the row array directly in this repo (dashboard-fixed-row.test.ts:350 precedent).
  const rows = (await owner.db.execute(
    sql`SELECT encode(sha256(convert_to(${raw}, 'UTF8')), 'hex') AS h`,
  )) as unknown as { h: string }[];
  return rows[0].h;
};

describe('slice 0 — invitation seam cannot mint a grant the inviter could not make directly', () => {
  let base: Base;
  /** Group-wide hr_admin — the highest CUSTOMER role. */
  let groupAdmin: SessionContext;
  /** hr_admin scoped to ONE company — may grant only hr_admin inside its own subtree. */
  let companyAdmin: SessionContext;
  /** A second company in the same tenant, outside companyAdmin's scope. */
  let otherCompanyId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();

    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });
    otherCompanyId = other.id;

    const [caUser] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `ca_${crypto.randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: caUser.id, companyId: base.companyId, role: 'hr_admin' });

    groupAdmin = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    companyAdmin = {
      tenantId: base.tenantId,
      userId: caUser.id,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: base.companyId }],
    };
  });

  afterAll(async () => {
    await closeAll();
  });

  // ── The RLS half: the invitation row itself must obey 0295's matrix ────────────────────────────

  it('a COMPANY-SCOPED hr_admin cannot invite a super_admin (the escalation seed)', async () => {
    // Today's WITH CHECK asks only is_admin_for(company_id) — which PASSES for this admin's own
    // company — so without the role conjunct this insert succeeds and the escalation is one
    // consume away.
    await expect(
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values({
          tenantId: base.tenantId,
          companyId: base.companyId,
          email: 'escalate@privesc.test',
          role: 'super_admin',
          tokenHash: `h_${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: companyAdmin.userId,
        }),
      ),
    ).rejects.toThrow();

    const rows = await owner.db
      .select({ role: schema.appInvitation.role })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.tenantId, base.tenantId));
    expect(rows.map((r) => r.role)).not.toContain('super_admin');
  });

  it('a COMPANY-SCOPED hr_admin cannot invite an operator — the installation tier', async () => {
    await expect(
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values({
          tenantId: base.tenantId,
          companyId: base.companyId,
          email: 'op@privesc.test',
          role: 'operator',
          tokenHash: `h_${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: companyAdmin.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a GROUP admin cannot invite an operator either — no customer role reaches the operator tier', async () => {
    await expect(
      withTenant(groupAdmin, (tx) =>
        tx.insert(schema.appInvitation).values({
          tenantId: base.tenantId,
          companyId: null,
          email: 'op2@privesc.test',
          role: 'operator',
          tokenHash: `h_${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: groupAdmin.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a COMPANY-SCOPED hr_admin cannot invite a GROUP-WIDE hr_admin (company_id NULL)', async () => {
    // Group scope is exactly what the delegated branch of 0295 withholds: company_id IS NOT NULL.
    await expect(
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values({
          tenantId: base.tenantId,
          companyId: null,
          email: 'groupwide@privesc.test',
          role: 'hr_admin',
          tokenHash: `h_${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: companyAdmin.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a COMPANY-SCOPED hr_admin cannot invite into a company it does not administer', async () => {
    await expect(
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values({
          tenantId: base.tenantId,
          companyId: otherCompanyId,
          email: 'sibling@privesc.test',
          role: 'hr_admin',
          tokenHash: `h_${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: companyAdmin.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('the legitimate grant still works — a company admin may invite hr_admin into its OWN company', async () => {
    // The fix must not break the delegated branch it is modelled on. Regression guard.
    await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.appInvitation).values({
        tenantId: base.tenantId,
        companyId: base.companyId,
        email: 'legit@privesc.test',
        role: 'hr_admin',
        tokenHash: `h_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdBy: companyAdmin.userId,
      }),
    );
    const rows = await owner.db
      .select({ email: schema.appInvitation.email })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.email, 'legit@privesc.test'));
    expect(rows).toHaveLength(1);
  });

  it('a GROUP admin may still invite any customer role — the group branch is untouched', async () => {
    for (const role of ['employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner']) {
      await withTenant(groupAdmin, (tx) =>
        tx.insert(schema.appInvitation).values({
          tenantId: base.tenantId,
          companyId: null,
          email: `${role}@ok.test`,
          role,
          tokenHash: `h_${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: groupAdmin.userId,
        }),
      );
    }
    const rows = await owner.db
      .select({ role: schema.appInvitation.role })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.tenantId, base.tenantId));
    expect(rows).toHaveLength(5);
  });

  // ── The consume half: rows that predate the tightening must still be refused ───────────────────

  /**
   * Insert an invitation row as OWNER — a row forged before slice 0 existed.
   *
   * `legacy: true` drops the 0312 CHECK constraint around the insert and restores it after. That is
   * not a workaround: 0312's constraint binds every writer INCLUDING the owner, so a row carrying
   * `operator` or a garbage role is structurally unwritable once it exists. The only way to exercise
   * the consume-side guard — whose entire purpose is rows that predate the constraint on a
   * deployment this migration has not reached — is to reproduce a pre-constraint row exactly.
   */
  async function forgeInvitation(role: string, companyId: string | null, raw: string) {
    const h = await hashOf(raw);
    await owner.db.insert(schema.appInvitation).values({
      tenantId: base.tenantId,
      companyId,
      email: `${role}@forged.test`,
      role,
      tokenHash: h,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdBy: base.adminUserId,
    });
  }

  /**
   * Run `fn` against a forged pre-0312 invitation, with the CHECK constraint absent for the WHOLE
   * window — insert AND consume — then restore it.
   *
   * The window must cover the consume, not just the insert. `consume_invitation` begins by
   * `UPDATE app_invitation SET status = 'accepted'`, and a CHECK constraint is re-evaluated on the
   * updated row — so with the constraint back in place the UPDATE itself fails and the RAISE guard
   * is never reached. An earlier version of this test restored the constraint straight after the
   * insert and passed for exactly that wrong reason: it was asserting the constraint, while claiming
   * to assert the definer. Keeping the constraint off across `fn` is what puts the guard under test.
   */
  async function withLegacyInvitation<T>(
    role: string,
    companyId: string | null,
    raw: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await owner.db.execute(
      sql`ALTER TABLE app_invitation DROP CONSTRAINT IF EXISTS app_invitation_role_customer_set`,
    );
    try {
      await forgeInvitation(role, companyId, raw);
      return await fn();
    } finally {
      // NOT VALID: the forged row is precisely what the constraint forbids, so a validating re-add
      // would fail. New writes are still checked, which is all the restore needs to hold.
      await owner.db.execute(
        sql`ALTER TABLE app_invitation ADD CONSTRAINT app_invitation_role_customer_set
            CHECK (role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner')) NOT VALID`,
      );
    }
  }

  const consume = (raw: string) =>
    owner.db.execute(sql`SELECT * FROM app.consume_invitation(${raw}, ${'subj_' + crypto.randomUUID()})`);

  it('a PRE-EXISTING forged operator invitation cannot be consumed', async () => {
    // A row written before slice 0 reached this deployment. The definer is the last line of defence.
    const raw = `tok_${crypto.randomUUID()}`;
    const err = await withLegacyInvitation('operator', null, raw, () => consume(raw).catch((e) => e));
    expect(err).toBeInstanceOf(Error);
    // Must be the DEFINER's refusal, not a constraint violation — assert the RAISE text itself.
    expect(pgText(err)).toMatch(/the operator role is not grantable by invitation/i);

    const grants = await owner.db
      .select({ role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.tenantId, base.tenantId));
    expect(grants.map((g) => g.role)).not.toContain('operator');
  });

  it('a refused invitation is left PENDING, not silently burned', async () => {
    // The guard RAISEs, so the `status = 'accepted'` flip rolls back with it. A burned row would
    // hide the attempt and make the failure look like a lost invitation.
    const raw = `tok_${crypto.randomUUID()}`;
    await withLegacyInvitation('operator', null, raw, () => consume(raw).catch(() => undefined));

    const rows = await owner.db
      .select({ status: schema.appInvitation.status })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.email, 'operator@forged.test'));
    expect(rows[0].status).toBe('pending');
  });

  it('a forged invitation carrying a role outside the enum cannot be consumed', async () => {
    // Pre-0312 `role` was free TEXT, so 'root' was storable and reached `v_inv.role::role` as a
    // runtime cast error rather than a policy decision. Now it is refused by name.
    const raw = `tok_${crypto.randomUUID()}`;
    const err = await withLegacyInvitation('root', null, raw, () => consume(raw).catch((e) => e));
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/not a valid customer role/i);
  });

  it('the CHECK constraint binds the OWNER too — operator invitations are structurally unwritable', async () => {
    // Layer 2 of the fix: not merely an RLS policy (which the owner bypasses), a table constraint.
    const err = await owner.db
      .insert(schema.appInvitation)
      .values({
        tenantId: base.tenantId,
        companyId: null,
        email: 'owner-operator@privesc.test',
        role: 'operator',
        tokenHash: `h_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdBy: base.adminUserId,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/app_invitation_role_customer_set/i);
  });

  it('a company-scoped MANAGER invitation still consumes — the guard does not over-block', async () => {
    // Deliberate correction to the slice plan, which called for consume to refuse "company-scoped
    // rows unless hr_admin". 0295's group branch lets a group admin grant ANY customer role at ANY
    // scope — a company-scoped manager is legitimate — so that rule would have broken a real path.
    // Consume checks only STATIC facts; the inviter-context conjuncts live in the WITH CHECK, which
    // ran while the inviter's session was live. This test pins the non-over-blocking.
    //
    // (super_admin is NOT the example to use here: 0020's role_assignment_super_admin_group_wide
    // already forbids a company-scoped super_admin at the grant table, so that escalation was
    // closed before this slice. `operator` was the one still open.)
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('manager', base.companyId, raw);

    await consume(raw);

    const grants = await owner.db
      .select({ role: schema.roleAssignment.role, companyId: schema.roleAssignment.companyId })
      .from(schema.roleAssignment)
      .where(and(eq(schema.roleAssignment.tenantId, base.tenantId), eq(schema.roleAssignment.role, 'manager')));
    expect(grants).toHaveLength(1);
    expect(grants[0].companyId).toBe(base.companyId);
  });

  it('a legitimate group-scoped invitation still consumes and grants correctly', async () => {
    // Regression guard for the definer change: the happy path must be untouched.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('manager', null, raw);

    await consume(raw);

    const grants = await owner.db
      .select({ role: schema.roleAssignment.role, companyId: schema.roleAssignment.companyId })
      .from(schema.roleAssignment)
      .where(and(eq(schema.roleAssignment.tenantId, base.tenantId), eq(schema.roleAssignment.role, 'manager')));
    expect(grants).toHaveLength(1);
    expect(grants[0].companyId).toBeNull();
  });

  it('a legitimate company-scoped hr_admin invitation still consumes and grants correctly', async () => {
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);

    await consume(raw);

    const grants = await owner.db
      .select({ role: schema.roleAssignment.role, companyId: schema.roleAssignment.companyId })
      .from(schema.roleAssignment)
      .where(and(eq(schema.roleAssignment.tenantId, base.tenantId), eq(schema.roleAssignment.role, 'hr_admin')));
    // seedBase already grants a group-wide hr_admin; the consumed one is the company-scoped addition.
    expect(grants.some((g) => g.companyId === base.companyId)).toBe(true);
  });
});
