/**
 * Invitation privilege escalation (slice 0 — F3/F18) — the seam asserted, not assumed.
 *
 * THE HOLE THESE TESTS CLOSE. Three facts combined into a tenant-wide escalation:
 *
 *   1. `app_invitation_rls`'s WITH CHECK (0151:51-53) carries NO role conjunct — it asks only
 *      `app.is_admin_for(coalesce(company_id, id))`. So a COMPANY-SCOPED hr_admin, who may grant
 *      only `hr_admin` within its own subtree under `role_assignment_write` (0295:66-82), can write
 *      an invitation row for ANY role — `super_admin`, or even the installation-tier `operator`.
 *   2. `app.consume_invitation` is SECURITY DEFINER (0281) and inserts `v_inv.role` into
 *      `role_assignment` uncritically (0151:158-159). `role_assignment` is not FORCE-RLS, so the
 *      definer runs as owner and 0295's matrix NEVER EVALUATES.
 *   3. `role` is not the only payload — `person_id` is too. The definer's REBIND branch re-points an
 *      existing login at the accepter's subject, so an invitation with a perfectly legal role
 *      (hr_admin, own company) but the group super_admin's PERSON handed the accepter that identity
 *      outright. This half needs no forbidden role at all, and it is the one the role conjuncts miss.
 *      Note that "already activated" is only HALF of that test: a login created ahead of its human
 *      already carries its GRANTS, so a placeholder subject is not proof there is nothing to steal.
 *   4. The row is MUTABLE after issue. ai_hr_app holds UPDATE on every column and the policy's USING is
 *      tenant-wide, so a terminal invitation could be flipped back to `pending` with a token_hash of the
 *      attacker's choosing — defeating single-use, expiry and revokeInvitation in one statement.
 *
 * The role escalation is real because `app.is_group_admin()` (0016:38-44) is true for ANY `super_admin`
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
import { ROLES } from '../core/auth';
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

/**
 * The two CHECK constraints migration 0312 puts on app_invitation (its layer 2), reproduced verbatim
 * so `withoutRoleChecks` can restore the table to the exact posture the migration produced.
 */
const ROLE_CHECKS = [
  {
    name: 'app_invitation_role_customer_set',
    def: "CHECK (role IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner'))",
  },
  {
    name: 'app_invitation_super_admin_group_wide',
    def: "CHECK (role <> 'super_admin' OR company_id IS NULL)",
  },
];

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

  // ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

  /** A person employed at `companyId`, optionally with a login carrying `subject` and a grant. */
  async function seedPerson(opts: {
    name: string;
    companyId: string;
    subject?: string;
    // The full grant type, not a hand-picked subset: the partner roles sit BESIDE the
    // employee<manager<hr_admin<super_admin ladder rather than on it, and the subset tests below need
    // to build one to prove app.invitation_confers treats them as incomparable.
    grant?: { role: (typeof schema.roleAssignment.$inferInsert)['role']; companyId: string | null };
  }): Promise<{ personId: string; appUserId: string | null }> {
    const [p] = await owner.db
      .insert(schema.person)
      .values({
        tenantId: base.tenantId,
        fullName: opts.name,
        primaryEmail: `${opts.name.toLowerCase().replace(/\W+/g, '.')}@privesc.test`,
      })
      .returning({ id: schema.person.id });
    await owner.db.insert(schema.employment).values({
      tenantId: base.tenantId,
      personId: p.id,
      companyId: opts.companyId,
      hiredOn: '2026-01-01',
    });
    if (!opts.subject) return { personId: p.id, appUserId: null };

    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: opts.subject, personId: p.id })
      .returning({ id: schema.appUser.id });
    if (opts.grant) {
      await owner.db.insert(schema.roleAssignment).values({
        tenantId: base.tenantId,
        appUserId: u.id,
        companyId: opts.grant.companyId,
        role: opts.grant.role,
      });
    }
    return { personId: p.id, appUserId: u.id };
  }

  const invitationValues = (over: Partial<typeof schema.appInvitation.$inferInsert>) => ({
    tenantId: base.tenantId,
    companyId: base.companyId,
    email: `x_${crypto.randomUUID()}@privesc.test`,
    role: 'hr_admin',
    tokenHash: `h_${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdBy: base.adminUserId,
    ...over,
  });

  /**
   * Run `fn` with BOTH of 0312's CHECK constraints absent, then restore them exactly as the migration
   * wrote them.
   *
   * WHY THE DROP HAS NO `IF EXISTS`. If 0312 stopped creating these constraints, this helper must blow
   * up rather than quietly create them itself — otherwise every later assertion would be testing the
   * TEST's object, not the migration's. That is not hypothetical: an earlier version of this file used
   * `DROP … IF EXISTS` and re-added the constraint in its `finally`, which made the "the constraint
   * binds the OWNER too" test below pass with layer 2 deleted from the migration entirely.
   *
   * WHY THE RESTORE VALIDATES. Worker databases are stamped once per RUN and reused by every later test
   * file (test/global-setup.ts:109-121; harness.resetDb only TRUNCATEs). Re-adding the constraint
   * `NOT VALID` — the obvious way to get past the forged row still sitting in the table — would leave
   * every subsequent file on this worker reading a weaker object than the migration produced. So the
   * forged rows are deleted first (the same DELETE 0312 itself runs as its layer 0) and the constraints
   * come back VALIDATED, i.e. at production posture.
   *
   * WHY THE DROPS ARE INSIDE THE TRY. Worker databases are shared with every later test file, so a
   * PARTIAL drop — the first constraint gone, the second statement throwing on a name drift or a lock
   * timeout — would leave the rest of the run reading a weaker app_invitation than the migration
   * produced, silently. `dropped` records what actually came off so the finally restores exactly that.
   */
  async function withoutRoleChecks<T>(fn: () => Promise<T>): Promise<T> {
    const dropped: typeof ROLE_CHECKS = [];
    try {
      for (const c of ROLE_CHECKS) {
        await owner.db.execute(sql.raw(`ALTER TABLE app_invitation DROP CONSTRAINT ${c.name}`));
        dropped.push(c);
      }
      return await fn();
    } finally {
      if (dropped.length > 0) {
        await owner.db.execute(sql`
          DELETE FROM app_invitation
           WHERE role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner')
              OR (role = 'super_admin' AND company_id IS NOT NULL)`);
        for (const c of dropped) {
          await owner.db.execute(sql.raw(`ALTER TABLE app_invitation ADD CONSTRAINT ${c.name} ${c.def}`));
        }
      }
    }
  }

  /** Insert an invitation row as OWNER — a row forged before slice 0 existed. */
  async function forgeInvitation(
    role: string,
    companyId: string | null,
    raw: string,
    personId: string | null = null,
  ) {
    const h = await hashOf(raw);
    await owner.db.insert(schema.appInvitation).values(
      invitationValues({
        companyId,
        email: `${role}@forged.test`,
        role,
        personId,
        tokenHash: h,
      }),
    );
  }

  /**
   * Run `fn` against a forged pre-0312 invitation, with the CHECK constraints absent for the WHOLE
   * window — insert AND consume.
   *
   * The window must cover the consume, not just the insert. `consume_invitation` begins by
   * `UPDATE app_invitation SET status = 'accepted'`, and a CHECK constraint is re-evaluated on the
   * updated row — so with the constraint back in place the UPDATE itself fails and the RAISE guard
   * is never reached. An earlier version of this test restored the constraint straight after the
   * insert and passed for exactly that wrong reason: it was asserting the constraint, while claiming
   * to assert the definer. Keeping the constraints off across `fn` is what puts the guard under test.
   */
  function withLegacyInvitation<T>(
    role: string,
    companyId: string | null,
    raw: string,
    fn: () => Promise<T>,
    personId: string | null = null,
  ): Promise<T> {
    return withoutRoleChecks(async () => {
      await forgeInvitation(role, companyId, raw, personId);
      return fn();
    });
  }

  const consume = (raw: string, subject = `subj_${crypto.randomUUID()}`) =>
    owner.db.execute(sql`SELECT * FROM app.consume_invitation(${raw}, ${subject})`);

  const subjectOf = async (appUserId: string) => {
    const [u] = await owner.db
      .select({ subject: schema.appUser.workosUserId })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, appUserId));
    return u?.subject ?? null;
  };

  // ── Layer 2 is the MIGRATION's, at production posture ──────────────────────────────────────────

  it("layer 2's constraints come from migration 0312, are VALIDATED, and match core/auth.ts ROLES", async () => {
    // Declared first and asserted against the catalog on purpose. Every other layer-2 assertion in this
    // file runs inside withoutRoleChecks, which drops and re-adds these objects; this test is what pins
    // the fact that the migration created them in the first place, with the same six roles the service
    // validates against and with convalidated = true (a NOT VALID constraint would not scan the table).
    const rows = (await owner.db.execute(sql`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'app_invitation'::regclass AND contype = 'c'
       ORDER BY conname`)) as unknown as { conname: string; convalidated: boolean; def: string }[];

    const roleSet = rows.find((r) => r.conname === 'app_invitation_role_customer_set');
    expect(roleSet, 'migration 0312 must create app_invitation_role_customer_set').toBeDefined();
    expect(roleSet!.convalidated).toBe(true);
    // The three copies of the customer-role list (this constraint, app.consume_invitation, and
    // core/auth.ts ROLES) must not drift: a role added to the enum + the service but not to 0312 would
    // pass TypeScript validation and then fail at the invitee's activation click.
    const literals = [...roleSet!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(literals).toEqual([...ROLES].sort());
    expect(literals).not.toContain('operator');

    const scoped = rows.find((r) => r.conname === 'app_invitation_super_admin_group_wide');
    expect(scoped, 'migration 0312 must mirror 0020 onto app_invitation').toBeDefined();
    expect(scoped!.convalidated).toBe(true);
  });

  // ── The RLS half: the invitation row itself must obey 0295's matrix ────────────────────────────

  it('a COMPANY-SCOPED hr_admin cannot invite a super_admin at ANY scope — refused by the POLICY', async () => {
    // Today's WITH CHECK asks only is_admin_for(company_id) — which PASSES for this admin's own
    // company — so without the role conjunct this insert succeeds and the escalation is one
    // consume away.
    //
    // Asserted with layer 2 dropped, and at BOTH scopes, because an earlier version of this test was
    // satisfied entirely by the wrong layer. invitationValues() defaults companyId to base.companyId,
    // so the row it built was a COMPANY-SCOPED super_admin — which app_invitation_super_admin_group_wide
    // rejects on its own. A bare `.rejects.toThrow()` could not tell the two apart, and the whole
    // delegated-branch role logic could have been deleted from 0312 with this test still green. The
    // GROUP-WIDE case (company_id NULL) is the escalation seed proper and the combination NO constraint
    // can refuse: only the delegated branch's `role = 'hr_admin'` conjunct stands between this admin
    // and a tenant-wide super_admin.
    await withoutRoleChecks(async () => {
      for (const companyId of [base.companyId, null]) {
        const err = await withTenant(companyAdmin, (tx) =>
          tx.insert(schema.appInvitation).values(
            invitationValues({
              companyId,
              email: `escalate_${companyId ?? 'group'}@privesc.test`,
              role: 'super_admin',
              createdBy: companyAdmin.userId,
            }),
          ),
        ).catch((e) => e);
        expect(err, `super_admin at scope ${companyId ?? 'group-wide'} must be refused`).toBeInstanceOf(Error);
        expect(pgText(err)).toMatch(/row-level security policy/i);
      }
    });

    const rows = await owner.db
      .select({ role: schema.appInvitation.role })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.tenantId, base.tenantId));
    expect(rows.map((r) => r.role)).not.toContain('super_admin');
  });

  it('a COMPANY-SCOPED hr_admin cannot invite an operator — refused by the POLICY, not just the constraint', async () => {
    // Asserted with layer 2 dropped, so only the RLS `role <> 'operator'` conjunct can reject. A bare
    // `.rejects.toThrow()` with the constraint in place could not tell the two layers apart, and 0312's
    // own comment calls the conjunct "redundant against layer 2" — exactly the wording that invites a
    // future edit to delete it. This test is what makes deleting it fail.
    const err = await withoutRoleChecks(() =>
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values(
          invitationValues({ email: 'op@privesc.test', role: 'operator', createdBy: companyAdmin.userId }),
        ),
      ).catch((e) => e),
    );
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('a GROUP admin cannot invite an operator either — refused by the POLICY, not just the constraint', async () => {
    // The sharper half of the same point: for a GROUP admin the rest of the matrix would permit the
    // row, so `role <> 'operator'` is the only conjunct standing between a customer's top admin and
    // the installation tier. With layer 2 dropped, nothing else can be doing the work.
    const err = await withoutRoleChecks(() =>
      withTenant(groupAdmin, (tx) =>
        tx.insert(schema.appInvitation).values(
          invitationValues({
            companyId: null,
            email: 'op2@privesc.test',
            role: 'operator',
            createdBy: groupAdmin.userId,
          }),
        ),
      ).catch((e) => e),
    );
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('a GROUP admin cannot invite a COMPANY-SCOPED super_admin — refused by the POLICY', async () => {
    // 0020's role_assignment_super_admin_group_wide already forbids the resulting GRANT, so before this
    // slice the row was writable and simply un-consumable: the invitee's click died on a 23514 raised
    // inside a definer function and the invitation sat pending forever. The admin UI reaches this
    // combination directly (role select + an independent company-scope select), so it is a live
    // dead-invite bug. Layer 2 dropped, so the policy conjunct is what is under test.
    const err = await withoutRoleChecks(() =>
      withTenant(groupAdmin, (tx) =>
        tx.insert(schema.appInvitation).values(
          invitationValues({ email: 'sa-scoped@privesc.test', role: 'super_admin', createdBy: groupAdmin.userId }),
        ),
      ).catch((e) => e),
    );
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('a COMPANY-SCOPED hr_admin cannot invite a GROUP-WIDE hr_admin (company_id NULL)', async () => {
    // Group scope is exactly what the delegated branch of 0295 withholds: company_id IS NOT NULL.
    await expect(
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values(
          invitationValues({
            companyId: null,
            email: 'groupwide@privesc.test',
            role: 'hr_admin',
            createdBy: companyAdmin.userId,
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('a COMPANY-SCOPED hr_admin cannot invite into a company it does not administer', async () => {
    await expect(
      withTenant(companyAdmin, (tx) =>
        tx.insert(schema.appInvitation).values(
          invitationValues({
            companyId: otherCompanyId,
            email: 'sibling@privesc.test',
            role: 'hr_admin',
            createdBy: companyAdmin.userId,
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('the legitimate grant still works — a company admin may invite hr_admin into its OWN company', async () => {
    // The fix must not break the delegated branch it is modelled on. Regression guard.
    await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({ email: 'legit@privesc.test', role: 'hr_admin', createdBy: companyAdmin.userId }),
      ),
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
        tx.insert(schema.appInvitation).values(
          invitationValues({ companyId: null, email: `${role}@ok.test`, role, createdBy: groupAdmin.userId }),
        ),
      );
    }
    const rows = await owner.db
      .select({ role: schema.appInvitation.role })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.tenantId, base.tenantId));
    expect(rows).toHaveLength(5);
  });

  // ── The person_id half: an invitation is also an IDENTITY payload ──────────────────────────────

  it('a COMPANY-SCOPED hr_admin cannot aim an invitation at a person outside its subtree', async () => {
    // `person_id` is the second payload. The role here is entirely legal for this admin (hr_admin, own
    // company) — what is not legal is naming someone it does not administer, because consume's REBIND
    // branch would hand the accepter that person's login. app.can_see_person is NOT the predicate that
    // catches this: its first disjunct is the coarse app.is_admin(), true for any admin anywhere, which
    // is why 0312 adds app.can_admin_person.
    const outsider = await seedPerson({ name: 'Outside Subtree', companyId: otherCompanyId });

    // A bare `.rejects.toThrow()` here would be satisfied by an FK violation or a NOT NULL slip, and
    // this is the single most load-bearing new conjunct — so pin the layer that refuses, the way the
    // sibling tests do, and pin the predicate itself with a positive control. Without the control an
    // edit that made can_admin_person return false for EVERYONE would keep this green while breaking
    // the delegated branch entirely.
    const insider = await seedPerson({ name: 'Aim Control', companyId: base.companyId });
    const err = await withTenant(companyAdmin, async (tx) => {
      const [aim] = (await tx.execute(sql`
        SELECT app.can_admin_person(${outsider.personId}::uuid) AS outsider,
               app.can_admin_person(${insider.personId}::uuid)  AS insider`)) as unknown as {
        outsider: boolean;
        insider: boolean;
      }[];
      expect(aim.outsider, 'can_admin_person must be false for a person outside the subtree').toBe(false);
      expect(aim.insider, 'and true inside it — otherwise the refusal above proves nothing').toBe(true);
      return tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'aim@privesc.test',
          role: 'hr_admin',
          personId: outsider.personId,
          createdBy: companyAdmin.userId,
        }),
      );
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('a temp-table SHADOW cannot make app.can_admin_person say yes — pg_temp is pinned last', async () => {
    // Postgres searches the session's TEMPORARY schema FIRST whenever `pg_temp` is not named in a
    // function's search_path, so the house-standard `SET search_path = public` does NOT protect a
    // SECURITY DEFINER helper: `CREATE TEMP TABLE employment(...)` in an ai_hr_app session would make
    // app.can_admin_person read the ATTACKER's rows and answer true for anyone — defeating the person
    // conjunct, which is the fix for the identity-rebind half of the hole. `company` is shadowed too
    // because can_admin_person answers THROUGH is_admin_for → has_role_for → is_company_descendant,
    // so pinning only the new function would leave the chain shadowable one level down.
    //
    // ON COMMIT DROP: postgres-js pools connections, and a surviving temp table would silently shadow
    // the real one for every later test on that connection.
    const outsider = await seedPerson({ name: 'Shadow Target', companyId: otherCompanyId });

    const err = await withTenant(companyAdmin, async (tx) => {
      await tx.execute(sql`
        CREATE TEMP TABLE employment (id uuid, tenant_id uuid, person_id uuid, company_id uuid, terminated_on date)
        ON COMMIT DROP`);
      await tx.execute(sql`
        INSERT INTO employment (id, tenant_id, person_id, company_id, terminated_on)
        VALUES (gen_random_uuid(), ${base.tenantId}::uuid, ${outsider.personId}::uuid, ${base.companyId}::uuid, NULL)`);
      await tx.execute(sql`CREATE TEMP TABLE company (id uuid, tenant_id uuid, parent_company_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`
        INSERT INTO company (id, tenant_id, parent_company_id)
        VALUES (${otherCompanyId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid)`);

      // Prove the shadow is LIVE first, or the assertion below passes for the wrong reason: an
      // unqualified `employment` in THIS session must now resolve to the temp table, which is exactly
      // the resolution a definer function declared `SET search_path = public` would also perform.
      const [live] = (await tx.execute(sql`
        SELECT 'employment'::regclass <> 'public.employment'::regclass AS emp,
               'company'::regclass    <> 'public.company'::regclass    AS co`)) as unknown as {
        emp: boolean;
        co: boolean;
      }[];
      expect(live.emp && live.co, 'the temp shadow must actually win name resolution here').toBe(true);

      const [aim] = (await tx.execute(
        sql`SELECT app.can_admin_person(${outsider.personId}::uuid) AS shadowed`,
      )) as unknown as { shadowed: boolean }[];
      expect(aim.shadowed, 'a temp employment/company must not change the definer answer').toBe(false);

      return tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'shadow@privesc.test',
          role: 'hr_admin',
          personId: outsider.personId,
          createdBy: companyAdmin.userId,
        }),
      );
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('a COMPANY-SCOPED hr_admin may still aim at a person it DOES administer', async () => {
    // Non-over-blocking guard for the conjunct above: the delegated branch must stay usable.
    const insider = await seedPerson({ name: 'Inside Subtree', companyId: base.companyId });

    await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'inside@privesc.test',
          role: 'hr_admin',
          personId: insider.personId,
          createdBy: companyAdmin.userId,
        }),
      ),
    );
    const rows = await owner.db
      .select({ personId: schema.appInvitation.personId })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.email, 'inside@privesc.test'));
    expect(rows[0].personId).toBe(insider.personId);
  });

  it('a company admin loses aim over someone who has LEFT for a company it does not administer', async () => {
    // `app.can_admin_person` is a CURRENT-employment predicate (`terminated_on IS NULL`), not a
    // historical one. Without that filter "administrable" would be everyone who EVER worked here — so
    // this admin would keep aim over a person who has since transferred to a sibling company entirely
    // outside its subtree, and aim is exactly what the rebind half of the hole needs. The person here
    // is at this instant an employee of otherCompanyId only.
    const leaver = await seedPerson({ name: 'Left For Sibling', companyId: base.companyId });
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-03-31' })
      .where(eq(schema.employment.personId, leaver.personId));
    await owner.db.insert(schema.employment).values({
      tenantId: base.tenantId,
      personId: leaver.personId,
      companyId: otherCompanyId,
      hiredOn: '2026-04-01',
    });

    const err = await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'leaver@privesc.test',
          role: 'hr_admin',
          personId: leaver.personId,
          createdBy: companyAdmin.userId,
        }),
      ),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });

  it('an invitation cannot name a company or a person belonging to ANOTHER tenant', async () => {
    // `company_id` and `person_id` are plain FKs with no tenant composite, and neither branch of the
    // policy ties them to the row's tenant — the group branch is `is_group_admin()` and nothing else.
    // So a group admin could store a row whose payload points into a foreign tenant, and consume would
    // build an app_user in THIS tenant bound to a person in that one. Nothing leaks (every downstream
    // policy filters on the invitation's tenant_id) but the identity it creates is a lie.
    const [t2] = await owner.db
      .insert(schema.tenant)
      .values({ workosOrgId: `org_${crypto.randomUUID()}`, name: 'Other Group' })
      .returning({ id: schema.tenant.id });
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: t2.id, legalName: 'Foreign Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [p2] = await owner.db
      .insert(schema.person)
      .values({ tenantId: t2.id, fullName: 'Foreign Person', primaryEmail: 'foreign@privesc.test' })
      .returning({ id: schema.person.id });

    for (const [label, over] of [
      ['person', { personId: p2.id }],
      ['company', { companyId: c2.id }],
    ] as const) {
      const err = await withTenant(groupAdmin, (tx) =>
        tx.insert(schema.appInvitation).values(
          invitationValues({ email: `xtenant_${label}@privesc.test`, role: 'manager', createdBy: groupAdmin.userId, ...over }),
        ),
      ).catch((e) => e);
      expect(err, `a foreign ${label} must be refused`).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/row-level security policy/i);
    }

    // And the consume-side backstop for a row forged before the conjunct existed (owner bypasses RLS).
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('manager', null, raw, p2.id);
    const err = await consume(raw).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/outside its own tenant/i);
  });

  it('consuming an invitation CANNOT re-bind a login that is already activated', async () => {
    // THE HEADLINE EXPLOIT, end to end. The victim is a group-wide super_admin who is ALSO employed in
    // the attacker's own company — so the attacker passes every layer-1 conjunct including
    // can_admin_person, and the invitation it writes is, on its face, completely legitimate:
    // role hr_admin, its own company, a person it administers. The takeover is entirely in the rebind.
    const victim = await seedPerson({
      name: 'Victim Boss',
      companyId: base.companyId,
      subject: 'wos_victim_boss',
      grant: { role: 'super_admin', companyId: null },
    });
    const raw = `tok_${crypto.randomUUID()}`;
    const tokenHash = await hashOf(raw);

    await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'attacker@privesc.test',
          role: 'hr_admin',
          personId: victim.personId,
          tokenHash,
          createdBy: companyAdmin.userId,
        }),
      ),
    );

    const err = await consume(raw, 'wos_attacker_new_subject').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/already has an activated login/i);

    // The victim still owns their subject, and the attacker's subject resolves to nothing.
    expect(await subjectOf(victim.appUserId!)).toBe('wos_victim_boss');
    const resolved = (await owner.db.execute(
      sql`SELECT * FROM app.principal_by_subject(${'wos_attacker_new_subject'})`,
    )) as unknown as unknown[];
    expect(resolved).toHaveLength(0);
  });

  it('a GROUP admin cannot re-bind an activated login either — layer 3 has no admin exemption', async () => {
    // The WITH CHECK's person conjunct only narrows the DELEGATED branch (a group admin already holds
    // every customer power, so restricting whom it may invite buys nothing). The consume-side guard is
    // therefore the layer that has to be universal, and this pins that it is.
    const victim = await seedPerson({
      name: 'Peer Admin',
      companyId: base.companyId,
      subject: 'wos_peer_admin',
      grant: { role: 'super_admin', companyId: null },
    });
    const raw = `tok_${crypto.randomUUID()}`;
    const tokenHash = await hashOf(raw);

    await withTenant(groupAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({
          companyId: null,
          email: 'peer@privesc.test',
          role: 'employee',
          personId: victim.personId,
          tokenHash,
          createdBy: groupAdmin.userId,
        }),
      ),
    );

    const err = await consume(raw, 'wos_group_admin_steal').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/already has an activated login/i);
    expect(await subjectOf(victim.appUserId!)).toBe('wos_peer_admin');
  });

  it('activating a PLACEHOLDER login still re-binds it — provisioning and bootstrap are untouched', async () => {
    // The rebind branch exists for exactly this: a login created ahead of its human. db/provision.ts
    // writes `provision:<uuid>`, db/seed.ts writes `seed:<email>` and `user_dev_admin`, and 0151's own
    // header names that set. Each shape must still activate, or operator provisioning
    // (test/operator-provision.test.ts) and scripts/auth/bootstrap-invite.ts break.
    for (const [i, placeholder] of [
      `provision:${crypto.randomUUID()}`,
      'seed:pending@privesc.test',
      'user_dev_admin',
    ].entries()) {
      const pending = await seedPerson({
        name: `Pending Admin ${i}`,
        companyId: base.companyId,
        subject: placeholder,
      });
      const raw = `tok_${crypto.randomUUID()}`;
      await forgeInvitation('hr_admin', null, raw, pending.personId);

      const rows = (await consume(raw, `wos_real_${i}`)) as unknown as { app_user_id: string }[];
      // Same row, real subject — NOT a second identity. This is what the person_id binding buys.
      expect(rows[0].app_user_id).toBe(pending.appUserId);
      expect(await subjectOf(pending.appUserId!)).toBe(`wos_real_${i}`);
    }
  });

  it('consuming CANNOT re-bind a PLACEHOLDER login that already carries a grant the invitation does not confer', async () => {
    // The quadrant a placeholder check ALONE gets wrong, and the shape db/provision.ts + db/seed.ts
    // actually ship. "Nobody has ever authenticated as this login" does NOT mean "there is nothing to
    // steal": the AUTHORITY is attached to the app_user before any human touches it — db/seed.ts:167
    // and test/operator-provision.test.ts:444 both build a placeholder carrying a group-wide hr_admin.
    //
    // Everything about the attacker's invitation is legitimate on its face — role hr_admin, its own
    // company, a person it demonstrably administers — so every layer-1 conjunct passes and the INSERT
    // is accepted. The escalation is entirely in what the rebind would hand over.
    const placeholder = `provision:${crypto.randomUUID()}`;
    const pendingBoss = await seedPerson({
      name: 'Pending Group Admin',
      companyId: base.companyId,
      subject: placeholder,
      grant: { role: 'super_admin', companyId: null },
    });
    const raw = `tok_${crypto.randomUUID()}`;
    const tokenHash = await hashOf(raw);

    await withTenant(companyAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'inherit@privesc.test',
          role: 'hr_admin',
          personId: pendingBoss.personId,
          tokenHash,
          createdBy: companyAdmin.userId,
        }),
      ),
    );

    const err = await consume(raw, 'wos_grant_inheritance').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/already carries a grant this invitation does not confer/i);

    // Nothing inherited, and the pending admin's activation link still works (their placeholder stands).
    expect(await subjectOf(pendingBoss.appUserId!)).toBe(placeholder);
    const resolved = (await owner.db.execute(
      sql`SELECT * FROM app.principal_by_subject(${'wos_grant_inheritance'})`,
    )) as unknown as unknown[];
    expect(resolved).toHaveLength(0);
  });

  it('a placeholder whose grant MATCHES the invitation still activates — bootstrap-invite is untouched', async () => {
    // Why the guard above is a SUBSET rule and not "refuse any pre-existing grant".
    // scripts/auth/bootstrap-invite.ts REFUSES to run unless the target person already has an app_user
    // carrying a placeholder, and seeded placeholders carry grants (db/seed.ts:167 withRoleAssignment:
    // true). "No grants at all" would therefore have broken the one documented way a real deployment
    // mints its first real login. A grant identical to the invitation's is one the inviter was just
    // proved allowed to write — layer 1 checked exactly that (role, company_id) — so inheriting it is
    // not an escalation.
    //
    // This is the EXACT-MATCH case only, which is the one shape db/seed.ts ships for a single login
    // (`user_dev_admin`, hr_admin group-wide). The four other seeded logins carry a strictly weaker
    // grant and are covered by the next test — an earlier version of this file tested only this case
    // while its own name claimed coverage of the bootstrap path, and the weaker shapes FAILED.
    const seeded = await seedPerson({
      name: 'Seeded Admin',
      companyId: base.companyId,
      subject: 'user_dev_admin',
      grant: { role: 'hr_admin', companyId: null },
    });
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', null, raw, seeded.personId);

    const rows = (await consume(raw, 'wos_bootstrap_real')) as unknown as { app_user_id: string }[];
    expect(rows[0].app_user_id).toBe(seeded.appUserId);
    expect(await subjectOf(seeded.appUserId!)).toBe('wos_bootstrap_real');
  });

  it('a seeded placeholder carrying a WEAKER grant activates too — the rule is subset, not equality', async () => {
    // The shape db/seed.ts ACTUALLY ships for four of its five logins: `seed:<email>` carrying
    // employee (:264-268, :493-499) or manager (:262), both group-wide — while
    // scripts/auth/bootstrap-invite.ts, whose documented job is to rebind exactly those logins,
    // defaults to `--role hr_admin` with no company. Under a strict-equality guard every one of them
    // was permanently un-activatable and the invitee got a raw 500 (acceptInvitation maps only an
    // EMPTY result set to InvalidInvitationError). employee < manager < hr_admin on the authority
    // ladder, and a group-wide invitation covers every scope, so nothing is inherited that the
    // invitation does not already confer.
    for (const [i, grantRole] of (['employee', 'manager'] as const).entries()) {
      const seeded = await seedPerson({
        name: `Seeded Staff ${i}`,
        companyId: base.companyId,
        subject: `seed:staff${i}@demo.test`,
        grant: { role: grantRole, companyId: null },
      });
      const raw = `tok_${crypto.randomUUID()}`;
      await forgeInvitation('hr_admin', null, raw, seeded.personId);

      const rows = (await consume(raw, `wos_seed_real_${i}`)) as unknown as { app_user_id: string }[];
      expect(rows[0].app_user_id, `a ${grantRole} placeholder must still activate`).toBe(seeded.appUserId);
      expect(await subjectOf(seeded.appUserId!)).toBe(`wos_seed_real_${i}`);
    }
  });

  it('subset does NOT mean "any grant": stronger, wider and sideways grants are still refused', async () => {
    // The three ways a pre-existing grant escapes what the invitation confers. Each is asserted
    // separately because a single ordering bug would leave the other two green:
    //   • STRONGER on the ladder — hr_admin on an `employee` invitation.
    //   • WIDER in scope — a GROUP-WIDE grant on a COMPANY-SCOPED invitation (the escalation shape:
    //     a company admin may only write company-scoped hr_admin, so a group-wide anything is
    //     authority it never had).
    //   • SIDEWAYS — payroll_partner is not on the employee<manager<hr_admin<super_admin ladder at
    //     all, so no amount of admin rank confers it. (The role ENUM's own label order would rank the
    //     partners above super_admin, which is exactly why app.customer_role_rank is explicit.)
    const cases: { label: string; grant: { role: (typeof schema.roleAssignment.$inferInsert)['role']; companyId: string | null }; invRole: string; invCompany: string | null }[] = [
      { label: 'stronger', grant: { role: 'hr_admin', companyId: null }, invRole: 'employee', invCompany: null },
      { label: 'wider', grant: { role: 'employee', companyId: null }, invRole: 'hr_admin', invCompany: base.companyId },
      { label: 'sideways', grant: { role: 'payroll_partner', companyId: null }, invRole: 'hr_admin', invCompany: null },
    ];
    for (const [i, c] of cases.entries()) {
      const placeholder = `provision:${crypto.randomUUID()}`;
      const target = await seedPerson({
        name: `Subset Case ${i}`,
        companyId: base.companyId,
        subject: placeholder,
        grant: c.grant,
      });
      const raw = `tok_${crypto.randomUUID()}`;
      await forgeInvitation(c.invRole, c.invCompany, raw, target.personId);

      const err = await consume(raw, `wos_subset_${i}`).catch((e) => e);
      expect(err, `a ${c.label} grant must be refused`).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/already carries a grant this invitation does not confer/i);
      // The placeholder stands, so the target's own activation link still works.
      expect(await subjectOf(target.appUserId!)).toBe(placeholder);
    }
  });

  it('consuming refuses to guess when a person has TWO logins', async () => {
    // Nothing enforces one app_user per person (no unique index on (tenant_id, person_id)) and
    // app_user's policy lets any group admin INSERT another. The original lookup was `LIMIT 1` with no
    // ORDER BY, so an arbitrary row decided guard B's whole verdict — placeholder-or-not,
    // grants-or-not — and a planted grant-less `seed:` twin could be made to win it. Refusing is the
    // only safe answer: consume must not silently pick which identity the token activates.
    const target = await seedPerson({
      name: 'Two Logins',
      companyId: base.companyId,
      subject: 'wos_the_real_one',
      grant: { role: 'super_admin', companyId: null },
    });
    await withTenant(groupAdmin, (tx) =>
      tx.insert(schema.appUser).values({
        tenantId: base.tenantId,
        workosUserId: `seed:twin_${crypto.randomUUID()}@privesc.test`,
        personId: target.personId,
      }),
    );

    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', null, raw, target.personId);

    const err = await consume(raw, 'wos_twin_pick').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/logins, so there is no single login to activate/i);
    expect(await subjectOf(target.appUserId!)).toBe('wos_the_real_one');
  });

  it('re-inviting an ACTIVATED user under their OWN subject is not a takeover — it just adds the grant', async () => {
    // The false positive guard B must not have. This is reachable straight from the shipped UI:
    // app/admin/users/page.tsx:87-93 builds the person dropdown from every employee with a personId,
    // with no filter for people who already hold a login, and inviteUserAction requires a personId. The
    // "rebind" here is `SET workos_user_id = <the value it already holds>` — a literal no-op, so there
    // is no identity to steal — and it worked before this migration. Refusing it would have reached the
    // invitee as a raw 500, because acceptInvitation maps only an EMPTY result set to
    // InvalidInvitationError (core/auth.ts:288-295) and the RAISE propagates past it.
    const existing = await seedPerson({
      name: 'Existing User',
      companyId: base.companyId,
      subject: 'wos_existing_user',
      grant: { role: 'employee', companyId: null },
    });
    const raw = `tok_${crypto.randomUUID()}`;
    const tokenHash = await hashOf(raw);

    await withTenant(groupAdmin, (tx) =>
      tx.insert(schema.appInvitation).values(
        invitationValues({
          email: 'reinvite@privesc.test',
          role: 'manager',
          personId: existing.personId,
          tokenHash,
          createdBy: groupAdmin.userId,
        }),
      ),
    );

    const rows = (await consume(raw, 'wos_existing_user')) as unknown as { app_user_id: string }[];
    expect(rows[0].app_user_id).toBe(existing.appUserId);
    expect(await subjectOf(existing.appUserId!)).toBe('wos_existing_user');

    const grants = await owner.db
      .select({ role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, existing.appUserId!));
    expect(grants.map((g) => g.role).sort()).toEqual(['employee', 'manager']);
  });

  // ── The UPDATE half: every assertion above is an INSERT, and UPDATE is a second door ───────────

  const statusOf = async (email: string) => {
    const [row] = await owner.db
      .select({ status: schema.appInvitation.status, tokenHash: schema.appInvitation.tokenHash })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.email, email));
    return row;
  };

  it('an issued invitation cannot have its token, expiry or payload rewritten', async () => {
    // ai_hr_app holds column-level UPDATE on all twelve columns (0151:44) and the policy's USING is
    // tenant-wide, so before the lifecycle trigger any admin could take ANY invitation in the tenant and
    // install a token_hash it had chosen — minting a working invitation out of a row it never created.
    // A WITH CHECK cannot stop this: it sees only the resulting row, and the resulting row is fine.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);
    const chosen = await hashOf('ATTACKER_CHOSEN_TOKEN');

    const err = await withTenant(companyAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ tokenHash: chosen, expiresAt: new Date(Date.now() + 30 * 86_400_000) })
        .where(eq(schema.appInvitation.email, 'hr_admin@forged.test')),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/immutable once issued/i);

    // The chosen token was never installed, so it consumes as an unknown token (0 rows), not a login.
    expect((await statusOf('hr_admin@forged.test')).tokenHash).not.toBe(chosen);
    const rows = (await consume('ATTACKER_CHOSEN_TOKEN')) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('an UPDATE cannot walk an invitation up to a role its writer could not have created', async () => {
    // The role conjunct is in WITH CHECK, which re-evaluates on UPDATE — but the trigger's immutability
    // rule fires first (BEFORE ROW triggers run ahead of the RLS check), so the payload is pinned twice.
    // Either refusal is correct; what must never happen is the row changing.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);

    const err = await withTenant(companyAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ role: 'super_admin', companyId: null })
        .where(eq(schema.appInvitation.email, 'hr_admin@forged.test')),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/immutable once issued|row-level security policy/i);

    const [row] = await owner.db
      .select({ role: schema.appInvitation.role, companyId: schema.appInvitation.companyId })
      .from(schema.appInvitation)
      .where(eq(schema.appInvitation.email, 'hr_admin@forged.test'));
    expect(row.role).toBe('hr_admin');
    expect(row.companyId).toBe(base.companyId);
  });

  it('a REVOKED invitation cannot be re-armed — the lifecycle is one-way', async () => {
    // revokeInvitation (core/auth.ts:280-286) is only as strong as the terminal state it writes. Without
    // the trigger, `SET status='pending', accepted_at=NULL` restored a revoked invitation and its token
    // worked again.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);
    await owner.db
      .update(schema.appInvitation)
      .set({ status: 'revoked' })
      .where(eq(schema.appInvitation.email, 'hr_admin@forged.test'));

    const err = await withTenant(companyAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ status: 'pending', acceptedAt: null })
        .where(eq(schema.appInvitation.email, 'hr_admin@forged.test')),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/lifecycle is one-way/i);

    expect((await statusOf('hr_admin@forged.test')).status).toBe('revoked');
    const rows = (await consume(raw)) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('an ACCEPTED invitation cannot be re-armed — single use means once, not once per UPDATE', async () => {
    // The other half of the same rule, and the one that turns a single-use token into a reusable one:
    // consume it legitimately, flip it back to pending, consume it again. Each replay adds a grant.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('manager', base.companyId, raw);
    await consume(raw, 'wos_first_use');
    expect((await statusOf('manager@forged.test')).status).toBe('accepted');

    const err = await withTenant(groupAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ status: 'pending', acceptedAt: null })
        .where(eq(schema.appInvitation.email, 'manager@forged.test')),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/lifecycle is one-way/i);

    const replay = (await consume(raw, 'wos_second_use')) as unknown as unknown[];
    expect(replay).toHaveLength(0);
    const grants = await owner.db
      .select({ role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(and(eq(schema.roleAssignment.tenantId, base.tenantId), eq(schema.roleAssignment.role, 'manager')));
    expect(grants).toHaveLength(1);
  });

  it('the lifecycle trigger binds the OWNER too — which is the whole reason it is a trigger', async () => {
    // 0312 chooses a trigger over a policy conjunct precisely because "unlike a policy it also binds
    // ai_hr_owner, seeds and scripts". Nothing asserted that: the one owner-binding test in this file
    // covers layer 2's CHECK constraints, and the legitimate-transitions test below performs its
    // revoke through withTenant (the ai_hr_app role) while its comment claims otherwise. A future edit
    // that scoped the guard to the app role would have gone unnoticed.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);
    const chosen = await hashOf('OWNER_CHOSEN_TOKEN');

    const immutableErr = await owner.db
      .update(schema.appInvitation)
      .set({ tokenHash: chosen, expiresAt: new Date(Date.now() + 365 * 86_400_000) })
      .where(eq(schema.appInvitation.email, 'hr_admin@forged.test'))
      .catch((e) => e);
    expect(immutableErr).toBeInstanceOf(Error);
    expect(pgText(immutableErr)).toMatch(/immutable once issued/i);

    await owner.db
      .update(schema.appInvitation)
      .set({ status: 'revoked' })
      .where(eq(schema.appInvitation.email, 'hr_admin@forged.test'));
    const oneWayErr = await owner.db
      .update(schema.appInvitation)
      .set({ status: 'pending', acceptedAt: null })
      .where(eq(schema.appInvitation.email, 'hr_admin@forged.test'))
      .catch((e) => e);
    expect(oneWayErr).toBeInstanceOf(Error);
    expect(pgText(oneWayErr)).toMatch(/lifecycle is one-way/i);
    expect((await statusOf('hr_admin@forged.test')).status).toBe('revoked');
  });

  it('a SESSION may only revoke — `accepted` belongs to app.consume_invitation alone', async () => {
    // `accepted` is the definer's single-use claim. The policy's USING is tenant-wide, so without this
    // rule ANY admin could reach ANY pending invitation and burn it by flipping it straight to
    // accepted: the provisioned tenant admin's activation link (db/provision.ts mintActivationInvitation)
    // dies silently, the row reads as accepted although no login was ever created, and the terminal
    // state then blocks the legitimate revoke too.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);

    const err = await withTenant(groupAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(eq(schema.appInvitation.email, 'hr_admin@forged.test')),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/may only be revoked from a session/i);
    expect((await statusOf('hr_admin@forged.test')).status).toBe('pending');

    // And the token is still live — the burn attempt cost the invitee nothing.
    const rows = (await consume(raw, 'wos_still_works')) as unknown as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('a DELEGATED company admin cannot revoke — the trigger mirrors revokeInvitation’s assertGroupAdmin', async () => {
    // core/auth.ts revokeInvitation gates on assertGroupAdmin and writes an `app-user.invitation.revoked`
    // domain event; the raw statement did neither, and the scope-only USING let a company-scoped admin
    // pick up an in-scope row it had not created. Availability + audit rather than privilege, but the
    // service rule and the boundary rule should be the same rule.
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, raw);

    const err = await withTenant(companyAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ status: 'revoked' })
        .where(eq(schema.appInvitation.email, 'hr_admin@forged.test')),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/may only be revoked by a group administrator/i);
    expect((await statusOf('hr_admin@forged.test')).status).toBe('pending');
  });

  it('ai_hr_app holds no DELETE on app_invitation — layer 3 has no DELETE arm and depends on that', async () => {
    // The lifecycle trigger is BEFORE UPDATE only, so DELETE-then-INSERT would reinstate a consumed or
    // revoked invitation under the same token_hash with a fresh expiry. The only thing making that
    // unreachable from a session is 0151:57's REVOKE (re-issued by 0312), while
    // deploy/bootstrap-db.sql:51-52 makes the DEFAULT posture the unsafe one. 0295's header records
    // that the cleanroom "can NEVER catch a missing REVOKE" — so it is asserted here instead.
    const rows = (await owner.db.execute(sql`
      SELECT DISTINCT privilege_type
        FROM information_schema.role_table_grants
       WHERE grantee = 'ai_hr_app' AND table_schema = 'public' AND table_name = 'app_invitation'
       ORDER BY privilege_type`)) as unknown as { privilege_type: string }[];
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('the two LEGITIMATE status transitions still work — pending → revoked and pending → accepted', async () => {
    // Non-over-blocking guard for the trigger. These are the only UPDATEs the codebase performs:
    // core/auth.ts revokeInvitation + scripts/provision-runner.ts:249 (revoke), and consume's own
    // single-use claim (accept). Both must survive, including for the OWNER, which the trigger binds
    // too (unlike a policy).
    const rawA = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', base.companyId, rawA);
    await withTenant(groupAdmin, (tx) =>
      tx
        .update(schema.appInvitation)
        .set({ status: 'revoked' })
        .where(
          and(eq(schema.appInvitation.email, 'hr_admin@forged.test'), eq(schema.appInvitation.status, 'pending')),
        ),
    );
    expect((await statusOf('hr_admin@forged.test')).status).toBe('revoked');

    const rawB = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('employee', null, rawB);
    await consume(rawB);
    expect((await statusOf('employee@forged.test')).status).toBe('accepted');
  });

  // ── The consume half: rows that predate the tightening must still be refused ───────────────────

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
    //
    // The status is read INSIDE the window: withoutRoleChecks deletes the forged row on its way out
    // (that is what lets the constraints come back VALIDATED), so an assertion afterwards would be
    // reading an empty table and passing on `rows[0]` being undefined.
    const raw = `tok_${crypto.randomUUID()}`;
    await withLegacyInvitation('operator', null, raw, async () => {
      await consume(raw).catch(() => undefined);
      const rows = await owner.db
        .select({ status: schema.appInvitation.status })
        .from(schema.appInvitation)
        .where(eq(schema.appInvitation.email, 'operator@forged.test'));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
    });
  });

  it('a forged invitation carrying a role outside the enum cannot be consumed', async () => {
    // Pre-0312 `role` was free TEXT, so 'root' was storable and reached `v_inv.role::role` as a
    // runtime cast error rather than a policy decision. Now it is refused by name.
    const raw = `tok_${crypto.randomUUID()}`;
    const err = await withLegacyInvitation('root', null, raw, () => consume(raw).catch((e) => e));
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/not a valid customer role/i);
  });

  it('a forged COMPANY-SCOPED super_admin invitation is refused by name, not by 0020 forty lines later', async () => {
    // Before this slice the row died at the final role_assignment INSERT on 0020's constraint — an
    // opaque 23514 from inside a definer function, forty lines away from the actual problem. The guard
    // now names it, and does so BEFORE any app_user is created or rebound.
    const raw = `tok_${crypto.randomUUID()}`;
    const err = await withLegacyInvitation('super_admin', base.companyId, raw, () => consume(raw).catch((e) => e));
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/super_admin is group-wide only/i);
  });

  it('the CHECK constraints bind the OWNER too — such invitations are structurally unwritable', async () => {
    // Layer 2 of the fix: not merely an RLS policy (which the owner bypasses), table constraints.
    // The catalog test at the top of this file is what proves these are the MIGRATION's objects; this
    // one proves they actually reject.
    const opErr = await owner.db
      .insert(schema.appInvitation)
      .values(invitationValues({ companyId: null, email: 'owner-operator@privesc.test', role: 'operator' }))
      .catch((e) => e);
    expect(opErr).toBeInstanceOf(Error);
    expect(pgText(opErr)).toMatch(/app_invitation_role_customer_set/i);

    const saErr = await owner.db
      .insert(schema.appInvitation)
      .values(invitationValues({ email: 'owner-scoped-sa@privesc.test', role: 'super_admin' }))
      .catch((e) => e);
    expect(saErr).toBeInstanceOf(Error);
    expect(pgText(saErr)).toMatch(/app_invitation_super_admin_group_wide/i);
  });

  it('a company-scoped MANAGER invitation still consumes — the guard does not over-block', async () => {
    // Deliberate correction to the slice plan, which called for consume to refuse "company-scoped
    // rows unless hr_admin". 0295's group branch lets a group admin grant ANY customer role at ANY
    // scope — a company-scoped manager is legitimate — so that rule would have broken a real path.
    // Consume checks only facts about the ROW and the TARGET LOGIN; the inviter-context conjuncts live
    // in the WITH CHECK, which ran while the inviter's session was live. This pins the non-over-blocking.
    //
    // (super_admin is NOT the example to use here: 0020's role_assignment_super_admin_group_wide
    // already forbids a company-scoped super_admin at the grant table, so that escalation was
    // closed before this slice. `operator` and the person rebind were the ones still open.)
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

  // ── Layer 5: the invitation seam is not the only door to an identity rebind ────────────────────

  it('a GROUP admin cannot re-point a login DIRECTLY on app_user — no invitation involved at all', async () => {
    // Everything above polices the SEAM. app_user's own policy (0016:191-193) is
    //   USING (tenant_id = app.current_tenant_id())
    //   WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin())
    // and ai_hr_app holds table-level UPDATE (deploy/bootstrap-db.sql's ALTER DEFAULT PRIVILEGES), so
    // the exact statement guard B exists to police was available as a ONE-LINER to any group admin —
    // with no token, no trigger and no guard. Guard B's claim to close hole (3) "for EVERY inviter"
    // was true of the seam and false of the database.
    const victim = await seedPerson({
      name: 'Direct Rebind Victim',
      companyId: base.companyId,
      subject: 'wos_direct_victim',
      grant: { role: 'super_admin', companyId: null },
    });

    const err = await withTenant(groupAdmin, (tx) =>
      tx
        .update(schema.appUser)
        .set({ workosUserId: 'wos_attacker_direct' })
        .where(eq(schema.appUser.id, victim.appUserId!)),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/cannot be re-pointed at another subject/i);

    expect(await subjectOf(victim.appUserId!)).toBe('wos_direct_victim');
    const resolved = (await owner.db.execute(
      sql`SELECT * FROM app.principal_by_subject(${'wos_attacker_direct'})`,
    )) as unknown as unknown[];
    expect(resolved).toHaveLength(0);
  });

  it('the direct rebind is refused for the OPERATOR login too — the installation tier lives in a tenant', async () => {
    // Why layer 5 is about privilege and not only about identity. app_user.tenant_id is NOT NULL and
    // FKs to tenant, so the operator login necessarily lives inside SOME tenant — db/seed.ts:181-193
    // puts it in the same one as the customer admins. A group admin re-pointing it would resolve, on
    // the next sign-in, to grants [{"role": "operator"}]: the installation tier, reached from a
    // customer's own top admin. This is the escalation the whole slice exists to close, by the short
    // path rather than through an invitation.
    const [opUser] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: 'user_dev_operator', personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: opUser.id, companyId: null, role: 'operator' });

    const err = await withTenant(groupAdmin, (tx) =>
      tx
        .update(schema.appUser)
        .set({ workosUserId: 'wos_attacker_operator' })
        .where(eq(schema.appUser.id, opUser.id)),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/cannot be re-pointed at another subject/i);
    expect(await subjectOf(opUser.id)).toBe('user_dev_operator');
  });

  it('layer 5 does not over-block: a group admin still creates logins and writes the other columns', async () => {
    // The trigger fires only when workos_user_id CHANGES. Creating a login is exactly what app_user's
    // group-admin WITH CHECK is legitimately for (core/admin.ts, db/provision.ts), and the archive
    // flag (0279) is a live admin action — test/user-lifecycle.test.ts covers it and must keep passing.
    const created = await withTenant(groupAdmin, (tx) =>
      tx
        .insert(schema.appUser)
        .values({ tenantId: base.tenantId, workosUserId: `wos_new_${crypto.randomUUID()}`, personId: null })
        .returning({ id: schema.appUser.id }),
    );
    await withTenant(groupAdmin, (tx) =>
      tx.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, created[0].id)),
    );
    const [row] = await owner.db
      .select({ archivedAt: schema.appUser.archivedAt })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, created[0].id));
    expect(row.archivedAt).not.toBeNull();

    // And the same row written with an UNCHANGED subject is a no-op the trigger must let through —
    // core/auth.ts and core/admin.ts both write app_user rows wholesale in places.
    const subject = await subjectOf(created[0].id);
    await withTenant(groupAdmin, (tx) =>
      tx.update(schema.appUser).set({ workosUserId: subject! }).where(eq(schema.appUser.id, created[0].id)),
    );
  });

  it('consume_invitation itself may still rebind — layer 5 lets the definer through', async () => {
    // The counterpart to the three refusals above: layer 5 gates on the SCHEMA OWNER, and
    // app.consume_invitation is SECURITY DEFINER, so current_user is the owner while its rebind runs.
    // If the gate were written against the wrong role the entire activation path would be dead — which
    // is a failure mode no other test in this file would catch (they all drive owner-side inserts).
    const pending = await seedPerson({
      name: 'Definer Rebind',
      companyId: base.companyId,
      subject: `provision:${crypto.randomUUID()}`,
    });
    const raw = `tok_${crypto.randomUUID()}`;
    await forgeInvitation('hr_admin', null, raw, pending.personId);

    const rows = (await consume(raw, 'wos_definer_ok')) as unknown as { app_user_id: string }[];
    expect(rows[0].app_user_id).toBe(pending.appUserId);
    expect(await subjectOf(pending.appUserId!)).toBe('wos_definer_ok');
  });
});
