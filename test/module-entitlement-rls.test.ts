/**
 * ADR-0077 slice 1 — the entitlement substrate's privilege shape, asserted rather than assumed.
 *
 * WHY THIS FILE IS THE SLICE'S REAL DELIVERABLE
 * ---------------------------------------------
 * `deploy/bootstrap-db.sql:50-54` issues ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE/DELETE
 * on every table ai_hr_owner creates to ai_hr_app. So a new table is born FULLY WRITABLE by the
 * application role, and "grant only SELECT by omission" does not exist. Migration 0313 therefore
 * carries an explicit REVOKE per table.
 *
 * And `cleanroom-verify.sh:47-52` reproduces the same ALTER DEFAULT PRIVILEGES — so the clean-room
 * gate MASKS a missing GRANT and can NEVER catch a missing REVOKE. Delete a REVOKE line from 0313 and
 * every other test in the repo still passes while any hr_admin can grant themselves Payroll. This
 * file is the only thing that would notice, which is why it reads information_schema directly instead
 * of inferring privileges from behaviour.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import {
  CORE_MODULE_CODES,
  LEGACY_ENABLED_MODULE_CODES,
  LEGACY_ENABLED_SETTINGS,
  LEGACY_MODULE_ENV_GATES,
  LEGACY_SETTING_ENV_GATES,
  MODULE_CATALOG,
  SETTING_CATALOG,
} from '../packs/catalog';
import { seedCatalogs } from '../scripts/seed-catalogs';

/**
 * The one tenant-scoped key in the catalog, and therefore the only fixture the write-policy cases can
 * use. It is ALSO a parity setting (INDIVIDUAL_TXN_PAY_ENABLED is set by deploy/enable-demo-flags.sh),
 * so seedBase writes a row for it on any box that carries the deployment's flags — which is exactly
 * what made three of the cases below pass only because this dev box happens to leave that var unset.
 * The nested describe clears the tenant's setting rows in its own beforeEach; see the note there.
 */
const TENANT_SCOPED_KEY = 'payroll.individual_txn_pay_enabled';

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

/** The privileges ai_hr_app actually holds on a table, straight from the catalog. */
async function grantsOn(table: string): Promise<string[]> {
  const rows = (await owner.db.execute(
    sql`SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'ai_hr_app' AND table_name = ${table}`,
  )) as unknown as { privilege_type: string }[];
  return rows.map((r) => r.privilege_type).sort();
}

describe('slice 1 — entitlement substrate privileges and policies', () => {
  let base: Base;
  let admin: SessionContext;
  let employee: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    admin = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    const [eu] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `emp_${crypto.randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: eu.id, companyId: null, role: 'employee' });
    employee = { tenantId: base.tenantId, userId: eu.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  });

  afterAll(async () => {
    await closeAll();
  });

  // ── The privilege matrix — the thing the clean-room structurally cannot check ──────────────────

  it('the app role holds exactly the privileges 0313 grants — every table it touches, no exceptions', async () => {
    // ONE MAP, NOT A LIST OF LOOPS. The first version of this test iterated six hardcoded table names
    // and checked two more separately, which left `tenant_provision_request_module` and `tenant`
    // unasserted — the two tables in the migration that keep a WRITE privilege, i.e. exactly the ones
    // where a deleted REVOKE matters most. A map forces a new table in 0313 to be answered for here.
    const EXPECTED: Record<string, string[]> = {
      // The catalogs and the entitlement/commercial record: readable, never writable by a customer.
      module: ['SELECT'],
      setting_definition: ['SELECT'],
      tenant_module: ['SELECT'],
      subscription: ['SELECT'],
      subscription_line: ['SELECT'],
      usage_snapshot: ['SELECT'],
      // Stradaverse staff — no grant at all, not even SELECT.
      platform_user: [],
      // Deliberately different from its siblings: a customer admin genuinely may write tenant-scoped
      // settings. Revoking here would have made the scope policy unreachable and untestable.
      tenant_setting: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      // Operator intake writes it once, at request time, and the runner reads it back. No UPDATE and no
      // DELETE: a picked module list is a record of what was sold, not a mutable draft.
      tenant_provision_request_module: ['INSERT', 'SELECT'],
      // 0313 §5 revoked the app role's writes on `tenant`. The commercial columns (status, plan,
      // trial_ends_at) hang off this row, and 0001's policy is scope-only — without the REVOKE any
      // authenticated principal, including an ordinary employee, could rewrite them. Asserted here
      // because nothing else in the gate would notice that line disappearing.
      tenant: ['SELECT'],
    };

    // THE MAP IS PINNED TO THE MIGRATION, not merely hand-maintained. The comment above claimed a map
    // "forces a new table in 0313 to be answered for", and it did not: the loop iterates EXPECTED, so a
    // table nobody added here was simply never asserted — and because bootstrap-db.sql's ALTER DEFAULT
    // PRIVILEGES grants full CRUD on every new table, it would be born writable with the gate green.
    // Read the migration, the same read-the-file ratchet the drift test uses.
    //
    // TWO SOURCES, UNIONED. CREATE TABLE alone covers only tables 0313 creates — `tenant` is merely
    // ALTERed and reached EXPECTED because a human typed it, which is the failure mode this ratchet is
    // supposed to remove, and it is the entry where a deleted REVOKE hurts most (0001's policy is
    // scope-only, so any employee could rewrite status/plan). Parsing the REVOKE targets as well covers
    // ALTERed tables automatically. The CREATE pattern is also formatting-tolerant now: `IF NOT EXISTS`
    // and a missing space before `(` used to match nothing at all, silently.
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../db/migrations/0313_module_entitlements.sql'),
      'utf8',
    );
    const created = [...migration.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/gm)].map((m) => m[1]);
    expect(created.length, '0313 creates no tables — the parser has drifted from the file').toBeGreaterThan(0);
    const revoked = [...migration.matchAll(/^REVOKE .*? ON (\w+) FROM ai_hr_app/gm)].map((m) => m[1]);
    expect(revoked.length, '0313 revokes nothing — the parser has drifted from the file').toBeGreaterThan(0);
    expect(revoked, 'the tenant REVOKE is the one this ratchet exists to hold').toContain('tenant');
    for (const t of new Set([...created, ...revoked])) {
      expect(
        Object.prototype.hasOwnProperty.call(EXPECTED, t),
        `0313 creates or re-privileges '${t}' but this test does not say what ai_hr_app may do with ` +
          'it — add it to EXPECTED',
      ).toBe(true);
    }

    for (const [t, expected] of Object.entries(EXPECTED)) {
      expect(await grantsOn(t), `${t} privileges for ai_hr_app`).toEqual(expected);
    }
  });

  it('an ordinary EMPLOYEE cannot rewrite their tenant\'s commercial columns', async () => {
    // The privilege assertion above says the grant is gone; this says what that grant was protecting.
    // `tenant_isolation` (0001) is scope-only — `USING (id = current_tenant_id())` with the same WITH
    // CHECK — so it would happily let an employee un-suspend the account or award themselves a plan.
    const err = await withTenant(employee, (tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'active', plan = 'enterprise', trial_ends_at = '2099-01-01'
            WHERE id = ${base.tenantId}`,
      ),
    ).catch((e) => e);
    expect(err, 'the UPDATE must be refused outright').toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/permission denied/i);
    const [row] = await owner.db
      .select({ status: schema.tenant.status, plan: schema.tenant.plan })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, base.tenantId));
    expect(row.plan, 'no plan may have been self-awarded').toBeNull();
    expect(row.status).toBe('active');
  });

  it('the 0295 column grant still withholds activation_url while carrying the new intake columns', async () => {
    const rows = (await owner.db.execute(
      sql`SELECT column_name FROM information_schema.column_privileges
          WHERE grantee = 'ai_hr_app' AND table_name = 'tenant_provision_request' AND privilege_type = 'SELECT'`,
    )) as unknown as { column_name: string }[];
    const cols = rows.map((r) => r.column_name);
    expect(cols, 'country must be readable or the console Retry path breaks').toContain('country');
    expect(cols, 'plan must be readable').toContain('plan');
    expect(cols, 'activation_url must stay unreadable — the point of the column grant').not.toContain('activation_url');
  });

  // ── tenant_module: readable, never writable by a customer ──────────────────────────────────────

  it('an admin can READ their own entitlements, and they match what this process\'s GATES resolve to', async () => {
    const rows = await withTenant(admin, (tx) =>
      tx.select({ code: schema.tenantModule.moduleCode }).from(schema.tenantModule),
    );
    const got = new Set(rows.map((r) => r.code));

    // WHAT THIS CAN AND CANNOT SEE, stated plainly, because the previous version overstated it. It
    // asserted `rows === legacyEnabledModulesIn(process.env)` — the very function seedBase had just
    // called with the very same argument — so it was a round-trip of one pure function dressed up as a
    // parity check. Rewriting it from LEGACY_MODULE_ENV_GATES does NOT make it independent of the
    // catalog (the gate map is that function's own input); what it does is say what each row means, so a
    // failure names the module and the flag instead of printing two arrays, and it now iterates the gate
    // map rather than the parity set, so codes deliberately EXCLUDED from parity — `toil` — are checked
    // to be ABSENT instead of ignored.
    //
    // The independence lives in two ratchets in test/module-catalog-drift.test.ts, and this test is only
    // the third leg of that tripod:
    //   - 'the parity sets equal the flags this repository actually ships' pins LEGACY_ENABLED_MODULE_CODES
    //     against .env.example / deploy/enable-demo-flags.sh, so the SET cannot quietly change;
    //   - 'every named legacy gate is an env var the APPLICATION actually reads' greps the application
    //     source for each gate NAME, so the map cannot name a var nothing is gated on.
    // Given those two, what remains for this test is that the rows actually LANDED, per code.
    for (const [code, gate] of Object.entries(LEGACY_MODULE_ENV_GATES)) {
      const shouldHaveRow = LEGACY_ENABLED_MODULE_CODES.includes(code) && (gate === null || process.env[gate] === 'true');
      expect(
        got.has(code),
        shouldHaveRow
          ? `'${code}' is on in this process (${gate ?? 'no gate at all'}) but seedBase wrote no row — ` +
            'slice 3 would switch it off'
          : `'${code}' is off in this process (${gate ?? 'no gate at all'}) but seedBase wrote a row — ` +
            'slice 3 would switch it on',
      ).toBe(shouldHaveRow);
    }
    // …and nothing outside the gate map may have appeared, or a module is being entitled by a route
    // the parity argument never accounted for.
    for (const code of got) {
      expect(code in LEGACY_MODULE_ENV_GATES, `unexpected entitlement '${code}'`).toBe(true);
    }
    // The four with no gate ANYWHERE (F20) are the load-bearing case: nothing can switch them off, so a
    // missing row here is unambiguously a parity regression rather than an environment difference.
    for (const code of ['payroll', 'attendance', 'claims', 'performance']) {
      expect(got.has(code), `'${code}' has no env gate anywhere — every tenant must have its row`).toBe(true);
    }
  });

  it('an admin can READ their own SETTINGS, and they match what this process\'s GATES resolve to', async () => {
    // THE SETTING AXIS HAD NO READ ASSERTION AT ALL. Under this suite's env `legacyEnabledSettingsIn`
    // returns the EMPTY set — test/env.ts deletes all nine tracked gates, which it did NOT do until the
    // slice-3 review: it stopped after five, and .env.example ships PAYROLL_UNLOCK_ENABLED uncommented,
    // so a developer's box could carry rows CI did not. So no test tenant carries a single
    // tenant_setting row — a fact that was true, load-bearing for the "slice 3 is a no-op" claim, and
    // asserted nowhere. Same shape as the module case: computed from LEGACY_SETTING_ENV_GATES so it
    // stays true on a box that DOES carry the deployment's flags instead of pinning today's emptiness.
    const rows = await withTenant(admin, (tx) =>
      tx.select({ key: schema.tenantSetting.key }).from(schema.tenantSetting),
    );
    const got = new Set(rows.map((r) => r.key));
    for (const s of SETTING_CATALOG) {
      const gate = LEGACY_SETTING_ENV_GATES[s.key];
      // r237 — a `null` gate means the setting never came from a deployment flag, so no env value can
      // give it a row. Written as `gate != null && …` rather than skipped, because the assertion still
      // has to fire: such a setting must have NO row, and a stray one would mean a backfill switched it
      // on for a tenant that never asked.
      const shouldHaveRow = s.key in LEGACY_ENABLED_SETTINGS && gate != null && process.env[gate] === 'true';
      expect(got.has(s.key), `'${s.key}' row presence must follow ${gate ?? 'no gate (never env-flagged)'}`).toBe(
        shouldHaveRow,
      );
    }
  });

  it('an admin CANNOT grant themselves a module', async () => {
    const err = await withTenant(admin, (tx) =>
      tx.insert(schema.tenantModule).values({ tenantId: base.tenantId, moduleCode: 'toil', status: 'active' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const after = await owner.db
      .select({ code: schema.tenantModule.moduleCode })
      .from(schema.tenantModule)
      .where(and(eq(schema.tenantModule.tenantId, base.tenantId), eq(schema.tenantModule.moduleCode, 'toil')));
    expect(after, 'no toil row may exist').toHaveLength(0);
  });

  it('an admin CANNOT delete or update an entitlement to extend it', async () => {
    const del = await withTenant(admin, (tx) => tx.delete(schema.tenantModule)).catch((e) => e);
    expect(del).toBeInstanceOf(Error);
    const upd = await withTenant(admin, (tx) =>
      tx.update(schema.tenantModule).set({ expiresAt: new Date('2099-01-01') }),
    ).catch((e) => e);
    expect(upd).toBeInstanceOf(Error);
  });

  it('a tenant cannot see another tenant\'s entitlements', async () => {
    const other = await seedBase();
    const rows = await withTenant(admin, (tx) =>
      tx.select({ tid: schema.tenantModule.tenantId }).from(schema.tenantModule),
    );
    expect(rows.every((r) => r.tid === base.tenantId)).toBe(true);
    expect(rows.map((r) => r.tid)).not.toContain(other.tenantId);
  });

  // ── The core-module trigger: binds every writer, including the owner ───────────────────────────

  it('a core module can never be given a row — even by the owner connection', async () => {
    for (const code of CORE_MODULE_CODES) {
      const err = await owner.db
        .insert(schema.tenantModule)
        .values({ tenantId: base.tenantId, moduleCode: code, status: 'active' })
        .catch((e) => e);
      expect(err, `${code} must be refused`).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/core module .* is always enabled/i);
    }
  });

  it('a core code can still be DELETED — the guard refuses rows, it does not make them immortal', async () => {
    // The invariant is "a core module has no tenant_module row". DELETE only ever moves the table
    // towards that, so refusing it would invert the guard. This is reachable without any SQL: flip a
    // billable module to isCore in packs/catalog.ts and the seeder's ON CONFLICT DO UPDATE flips
    // `module.is_core`, at which point every existing row for that code must still be removable.
    await setModule(base.tenantId, 'toil', 'active');
    await owner.db.execute(sql`UPDATE module SET is_core = true, billable = false WHERE code = 'toil'`);
    try {
      const err = await owner.db
        .update(schema.tenantModule)
        .set({ status: 'disabled' })
        .where(eq(schema.tenantModule.moduleCode, 'toil'))
        .catch((e) => e);
      expect(err, 'UPDATE of a now-core row is still refused').toBeInstanceOf(Error);

      await owner.db.execute(sql`DELETE FROM tenant_module WHERE module_code = 'toil'`);
      const left = await owner.db
        .select({ id: schema.tenantModule.id })
        .from(schema.tenantModule)
        .where(eq(schema.tenantModule.moduleCode, 'toil'));
      expect(left, 'the row must be deletable, or there is no way back to the invariant').toHaveLength(0);
    } finally {
      // The catalog is template-seeded and NOT truncated by resetDb (see harness ALL_TABLES), so this
      // edit would otherwise leak into every later test in the file.
      await owner.db.execute(sql`UPDATE module SET is_core = false, billable = true WHERE code = 'toil'`);
    }
  });

  it('the core guard is ENABLE ALWAYS, so it binds replication apply too — not just ordinary writers', async () => {
    // The migration's stated reason for choosing a TRIGGER over a POLICY is that a trigger binds every
    // writer, including a future BYPASSRLS platform role. The BYPASSRLS half is true of any trigger; the
    // ABSOLUTE claim needs `ENABLE ALWAYS`. A trigger created normally is `ENABLE ORIGIN` (tgenabled
    // 'O') and does NOT fire under session_replication_role='replica' — logical-replication apply, or a
    // restore tool. Asserting the catalog letter is what keeps the comment honest for the next reader.
    const rows = (await owner.db.execute(
      sql`SELECT tgenabled FROM pg_trigger
          WHERE tgrelid = 'tenant_module'::regclass AND tgname = 'tenant_module_core_guard' AND NOT tgisinternal`,
    )) as unknown as { tgenabled: string }[];
    expect(rows, 'the core guard trigger must exist').toHaveLength(1);
    expect(rows[0].tgenabled, "tgenabled must be 'A' (ALWAYS), not 'O' (ORIGIN)").toBe('A');
  });

  it('core modules can never be rows at all, so an empty entitlement table has cost the tenant nothing', async () => {
    // RENAMED, because the old name ("a tenant with ZERO rows still keeps its core modules") promised a
    // property slice 1 has no reader to demonstrate: after deleting the rows it asserted only that
    // CORE_MODULE_CODES contains 'leave' and 'ess', which is a restatement of packs/catalog.ts and
    // cannot fail unless someone edits the catalog. What IS checkable today is the mechanism the
    // guarantee rests on: a core code can never occupy a row, so "delete every row" and "the tenant
    // never had a Leave row" are the same state. The resolver assertion (zero rows →
    // isModuleEnabled(tenant,'leave') === true) belongs in slice 2, the moment isModuleEnabled exists.
    await owner.db.execute(sql`DELETE FROM tenant_module WHERE tenant_id = ${base.tenantId}`);
    const rows = await owner.db
      .select({ id: schema.tenantModule.id })
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.tenantId, base.tenantId));
    expect(rows).toHaveLength(0);

    for (const code of CORE_MODULE_CODES) {
      const err = await owner.db
        .insert(schema.tenantModule)
        .values({ tenantId: base.tenantId, moduleCode: code, status: 'active' })
        .catch((e) => e);
      expect(err, `a row for core module '${code}' must be impossible, not merely absent`).toBeInstanceOf(Error);
    }
  });

  // ── tenant_setting: the scope join is the load-bearing line ────────────────────────────────────

  describe('tenant_setting write policy', () => {
    // THE FIXTURE HAS TO BE ENVIRONMENT-INDEPENDENT, and it was not. `payroll.individual_txn_pay_enabled`
    // is the catalog's ONLY tenant-scoped key, so every write-policy case below must use it — and it is
    // simultaneously a PARITY setting (deploy/enable-demo-flags.sh sets INDIVIDUAL_TXN_PAY_ENABLED=true
    // on the running deployment), so seedBase writes a row for it on any box whose env matches
    // production. Three of these cases then failed on `tenant_setting_pkey` or on a surviving row rather
    // than on the policy they name: verified by running this file with INDIVIDUAL_TXN_PAY_ENABLED=true,
    // which turned 3 of 26 red before this beforeEach existed.
    //
    // Clearing the tenant's rows is the right fix rather than picking a different key: what these cases
    // test is the POLICY, which needs a known starting state, and the parity rows themselves are
    // asserted by the two READ tests above. The DELETE runs on the owner connection because the policy
    // under test would (correctly) refuse a customer DELETE of a platform-scoped row.
    beforeEach(async () => {
      await owner.db.execute(sql`DELETE FROM tenant_setting WHERE tenant_id = ${base.tenantId}`);
    });

    it('an admin CAN write a tenant-scoped setting', async () => {
      await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: true,
        }),
      );
      const rows = await owner.db
        .select({ v: schema.tenantSetting.value })
        .from(schema.tenantSetting)
        .where(
          and(eq(schema.tenantSetting.tenantId, base.tenantId), eq(schema.tenantSetting.key, TENANT_SCOPED_KEY)),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].v).toBe(true);
    });

    it('an admin CANNOT store a value of the wrong TYPE in a setting', async () => {
      // `value_type` is declared per row in the catalog and, before this conjunct, enforced by nothing:
      // the write policy checked tenant, group-admin and scope only. A group admin could put an arbitrary
      // JSON object into a boolean setting and slice 2's resolver would read whatever shape it found. For
      // booleans that fails safe-ish; the first `number` or `json` setting inherits the hole outright.
      const err = await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: { nested: ['arbitrary', 1, 2, 3] },
        }),
      ).catch((e) => e);
      expect(err, 'an object in a boolean setting must be refused').toBeInstanceOf(Error);
      // The refusal must come from the POLICY, not from a jsonb parse error further down: the mechanism
      // under test is the value_type conjunct in WITH CHECK.
      expect(pgText(err)).toMatch(/row-level security policy/i);

      const after = await owner.db
        .select({ v: schema.tenantSetting.value })
        .from(schema.tenantSetting)
        .where(
          and(
            eq(schema.tenantSetting.tenantId, base.tenantId),
            eq(schema.tenantSetting.key, TENANT_SCOPED_KEY),
          ),
        );
      expect(after, 'no row may survive the refused write').toHaveLength(0);
    });

    it('an admin CANNOT write a PLATFORM-scoped setting — the audit chain is not theirs to switch off', async () => {
      const err = await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: 'audit.hash_chain_enabled',
          value: false,
        }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/row-level security policy/i);
    });

    // Three separate routes onto a platform-scoped row the platform already wrote. The first version of
    // this block was one test named "delete or overwrite" whose body only ran the DELETE — the two
    // overwrite routes it advertised were never executed, and an UPDATE arm regression would have gone
    // unseen. Each route now asserts BOTH its failure mode and the surviving row.

    async function platformSetsHashChain(): Promise<void> {
      await owner.db.insert(schema.tenantSetting).values({
        tenantId: base.tenantId,
        key: 'audit.hash_chain_enabled',
        value: true,
        source: 'platform',
      });
    }

    async function hashChainRow() {
      return owner.db
        .select({ v: schema.tenantSetting.value, source: schema.tenantSetting.source })
        .from(schema.tenantSetting)
        .where(
          and(eq(schema.tenantSetting.tenantId, base.tenantId), eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
        );
    }

    it('an admin CANNOT DELETE a platform-scoped setting the platform already set', async () => {
      await platformSetsHashChain();
      const del = await withTenant(admin, (tx) =>
        tx.delete(schema.tenantSetting).where(eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
      ).catch((e) => e);
      // A DELETE filtered out by USING removes zero rows rather than raising — assert the ROW, which is
      // what actually matters, instead of the error that may or may not appear.
      void del;
      const still = await hashChainRow();
      expect(still, 'the platform-scoped row must survive a customer DELETE').toHaveLength(1);
      expect(still[0].v).toBe(true);
    });

    it('an admin CANNOT UPDATE a platform-scoped setting to a value of their choosing', async () => {
      await platformSetsHashChain();
      await withTenant(admin, (tx) =>
        tx
          .update(schema.tenantSetting)
          .set({ value: false })
          .where(eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
      ).catch(() => undefined);
      // Like DELETE, an UPDATE the USING arm filters out matches zero rows — silence, not an error. The
      // row is the assertion.
      const still = await hashChainRow();
      expect(still).toHaveLength(1);
      expect(still[0].v, 'the audit chain is not the customer\'s to switch off').toBe(true);
    });

    it('an admin CANNOT upsert over a platform-scoped setting via ON CONFLICT DO UPDATE', async () => {
      // The route a real settings screen would take, and the one a USING/WITH CHECK asymmetry would open:
      // the INSERT arm is refused by WITH CHECK before the conflict is ever resolved.
      await platformSetsHashChain();
      const err = await withTenant(admin, (tx) =>
        tx
          .insert(schema.tenantSetting)
          .values({ tenantId: base.tenantId, key: 'audit.hash_chain_enabled', value: false })
          .onConflictDoUpdate({
            target: [schema.tenantSetting.tenantId, schema.tenantSetting.key],
            set: { value: false },
          }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/row-level security policy/i);
      const still = await hashChainRow();
      expect(still[0].v).toBe(true);
    });

    it('a COMPANY-SCOPED admin cannot write a tenant-wide setting', async () => {
      // tenant_setting is keyed (tenant_id, key) — it has no company dimension, so every value governs
      // the whole group. The policy therefore gates on app.is_group_admin(), not the coarse
      // app.is_admin() ("admin somewhere", 0016), which is true for an hr_admin delegated to ONE
      // subsidiary. Without this case the distinction is invisible: every other fixture in this file is
      // a null-scoped (group) admin, which passes either predicate.
      const scoped: SessionContext = {
        tenantId: base.tenantId,
        userId: base.adminUserId,
        roles: ['hr_admin'],
        grants: [{ role: 'hr_admin', companyId: base.companyId }],
      };
      const err = await withTenant(scoped, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: true,
        }),
      ).catch((e) => e);
      expect(err, 'an admin over one company must not reconfigure the group').toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/row-level security policy/i);
    });

    it('an admin cannot forge PROVENANCE — source=platform and a chosen updated_by are both refused', async () => {
      // `source` is what the settings screen renders as "Stradaverse manages this", and ai_hr_app holds
      // full CRUD on this table by design — so without a WITH CHECK conjunct a customer admin can stamp
      // their own value as platform-managed. Same for `updated_by`, which has no FK and would otherwise
      // accept any uuid, including a real platform_user id.
      const forgedSource = await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: true,
          source: 'platform',
        }),
      ).catch((e) => e);
      expect(forgedSource).toBeInstanceOf(Error);
      expect(pgText(forgedSource)).toMatch(/row-level security policy/i);

      const forgedActor = await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: true,
          updatedBy: '99999999-9999-9999-9999-999999999999',
        }),
      ).catch((e) => e);
      expect(forgedActor).toBeInstanceOf(Error);
      expect(pgText(forgedActor)).toMatch(/row-level security policy/i);

      // …and the honest write, stamped with the session's own user id, still goes through — with a
      // backdated `updated_at` that the trigger must overwrite. The timestamp is the column an auditor
      // reads to establish WHEN a behaviour changed, and the policy has no reason to constrain it, so it
      // is stamped rather than trusted.
      await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: true,
          updatedBy: base.adminUserId,
          updatedAt: new Date('1999-01-01T00:00:00Z'),
        }),
      );
      const rows = await owner.db
        .select({
          source: schema.tenantSetting.source,
          updatedBy: schema.tenantSetting.updatedBy,
          updatedAt: schema.tenantSetting.updatedAt,
        })
        .from(schema.tenantSetting)
        .where(
          and(
            eq(schema.tenantSetting.tenantId, base.tenantId),
            eq(schema.tenantSetting.key, TENANT_SCOPED_KEY),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('customer');
      expect(rows[0].updatedBy).toBe(base.adminUserId);
      expect(
        rows[0].updatedAt.getUTCFullYear(),
        'a backdated updated_at must be overwritten by the stamp trigger',
      ).toBeGreaterThan(2000);
    });

    it('a NON-admin cannot write even a tenant-scoped setting', async () => {
      const err = await withTenant(employee, (tx) =>
        tx.insert(schema.tenantSetting).values({
          tenantId: base.tenantId,
          key: TENANT_SCOPED_KEY,
          value: true,
        }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
    });

    it('an UNKNOWN setting key fails closed on the SCOPE JOIN, not merely on the foreign key', async () => {
      // Test-validity fix. This previously asserted only `toBeInstanceOf(Error)`, and tenant_setting.key
      // also carries `REFERENCES setting_definition(key)` — so the test passed on the FK and would have
      // kept passing with the EXISTS clause deleted from the policy, which is the mechanism the migration
      // header credits for the guarantee. On the app-role path RLS is evaluated first and raises 42501;
      // matching that message is what makes this test fail if the scope join is ever removed.
      const err = await withTenant(admin, (tx) =>
        tx.insert(schema.tenantSetting).values({ tenantId: base.tenantId, key: 'payroll.reset_enabld', value: true }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(pgText(err)).toMatch(/row-level security policy/i);
    });

    it('a customer can READ a platform-scoped setting — visibility is not the boundary', async () => {
      await owner.db.insert(schema.tenantSetting).values({
        tenantId: base.tenantId,
        key: 'audit.hash_chain_enabled',
        value: true,
        source: 'platform',
      });
      const rows = await withTenant(admin, (tx) =>
        tx
          .select({ k: schema.tenantSetting.key })
          .from(schema.tenantSetting)
          .where(eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')),
      );
      expect(rows, 'the customer must be able to SEE what the platform manages for them').toHaveLength(1);
    });
  });

  // ── the backfill: the only reason slice 3 is a no-op OUTSIDE this suite ────────────────────────

  it('0313\'s backfill grants the parity set to a tenant that has none, skips the system tenant, and is re-runnable', async () => {
    // THE MIGRATION'S BACKFILL CANNOT TEST ITSELF. It runs once, against the template, which holds no
    // tenants at all — so "it applied cleanly" only proves the SQL parses. What it is FOR is the
    // populated database: the demo deployment and every customer provisioned before this slice. Read
    // the statement the migration actually ships and run it here against real rows, the same
    // read-the-file ratchet test/module-catalog-drift.test.ts uses for the codes.
    const sql_ = fs.readFileSync(path.resolve(__dirname, '../db/migrations/0313_module_entitlements.sql'), 'utf8');
    const start = sql_.indexOf('INSERT INTO tenant_module (tenant_id, module_code, status)');
    expect(start, '0313 no longer contains the backfill statement').toBeGreaterThan(-1);
    const backfill = sql_.slice(start, sql_.indexOf(';', start));
    const settingStart = sql_.indexOf('INSERT INTO tenant_setting (tenant_id, key, value, source)');
    expect(settingStart, '0313 no longer contains the SETTING backfill statement').toBeGreaterThan(-1);
    const settingBackfill = sql_.slice(settingStart, sql_.indexOf(';', settingStart));

    // A tenant with NO entitlement rows — what every pre-slice-1 customer looks like.
    const [bare] = await owner.db
      .insert(schema.tenant)
      .values({ workosOrgId: `org_${crypto.randomUUID()}`, name: 'Pre-Entitlement Bhd' })
      .returning({ id: schema.tenant.id });

    await owner.db.execute(sql.raw(backfill));

    const granted = await owner.db
      .select({
        code: schema.tenantModule.moduleCode,
        companyId: schema.tenantModule.companyId,
        status: schema.tenantModule.status,
      })
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.tenantId, bare.id));
    expect(granted.map((r) => r.code).sort(), 'the existing tenant must end up with the parity set').toEqual(
      [...LEGACY_ENABLED_MODULE_CODES].sort(),
    );
    expect(granted.every((r) => r.companyId === null), 'the grants are tenant-wide, not per-company').toBe(true);
    expect(granted.every((r) => r.status === 'active')).toBe(true);

    // The reserved system tenant (0151 §4) is not a customer — it holds no companies, people or
    // employments, and entitling it would put a fake account in every platform report.
    const system = await owner.db
      .select({ id: schema.tenantModule.id })
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.tenantId, '00000000-0000-0000-0000-000000000000'));
    expect(system, 'the auth-audit system tenant must not be entitled').toHaveLength(0);

    // THE SETTING HALF. Three payroll behaviours are env flags that are ON in this deployment, and every
    // setting_definition.default_value is `false` — so without these rows slice 3 switches payroll
    // reset, unlock and individual-transaction pay OFF on the one live deployment. Same argument as the
    // modules, one table over, and it was missing entirely until round 2 said so.
    await owner.db.execute(sql.raw(settingBackfill));
    const settings = await owner.db
      .select({
        key: schema.tenantSetting.key,
        value: schema.tenantSetting.value,
        source: schema.tenantSetting.source,
      })
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.tenantId, bare.id));
    expect(settings.map((r) => r.key).sort(), 'the existing tenant must keep the settings it has on').toEqual(
      Object.keys(LEGACY_ENABLED_SETTINGS).sort(),
    );
    expect(settings.every((r) => r.value === true), 'every backfilled setting carries its live value').toBe(true);
    expect(
      settings.every((r) => r.source === 'platform'),
      'a deploy-script decision is provenance platform, not customer',
    ).toBe(true);
    const systemSettings = await owner.db
      .select({ key: schema.tenantSetting.key })
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.tenantId, '00000000-0000-0000-0000-000000000000'));
    expect(systemSettings, 'the auth-audit system tenant takes no settings either').toHaveLength(0);

    // Re-runnable: ON CONFLICT DO NOTHING over the grain index (and over tenant_setting's primary key),
    // so a tenant that already has the rows — every seedBase tenant, and any tenant a partial re-run
    // already touched — gains no duplicates and keeps the value it already had.
    await owner.db.execute(sql.raw(backfill));
    await owner.db.execute(sql.raw(settingBackfill));
    const again = await owner.db
      .select({ code: schema.tenantModule.moduleCode })
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.tenantId, base.tenantId));
    expect(again, 'a second run must not duplicate an existing tenant\'s rows').toHaveLength(
      LEGACY_ENABLED_MODULE_CODES.length,
    );
    const settingsAgain = await owner.db
      .select({ key: schema.tenantSetting.key })
      .from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.tenantId, bare.id));
    expect(settingsAgain, 'a second run must not duplicate the setting rows').toHaveLength(
      Object.keys(LEGACY_ENABLED_SETTINGS).length,
    );
  });

  // ── the grain ─────────────────────────────────────────────────────────────────────────────────

  it('tenant-wide and company-scoped entitlements are DIFFERENT grains, and each is unique', async () => {
    await setModule(base.tenantId, 'toil', 'active'); // tenant-wide
    await setModule(base.tenantId, 'toil', 'active', base.companyId); // company-scoped
    const rows = await owner.db
      .select({ c: schema.tenantModule.companyId })
      .from(schema.tenantModule)
      .where(and(eq(schema.tenantModule.tenantId, base.tenantId), eq(schema.tenantModule.moduleCode, 'toil')));
    expect(rows).toHaveLength(2);

    const dup = await owner.db
      .insert(schema.tenantModule)
      .values({ tenantId: base.tenantId, moduleCode: 'toil', companyId: base.companyId, status: 'active' })
      .catch((e) => e);
    expect(dup, 'a second row at the same grain must be refused').toBeInstanceOf(Error);
    expect(pgText(dup)).toMatch(/tenant_module_grain_uq/i);
  });

  it('a company-scoped entitlement cannot name ANOTHER tenant\'s company', async () => {
    // `company_id uuid REFERENCES company(id)` on its own is satisfied by any company in the
    // installation. A row naming a foreign tenant's company passes the FK, occupies its own grain, and
    // is then never matched by slice 2's per-company resolution — so the entitlement is silently INERT
    // rather than rejected, which is the worst possible shape for a commercial record. The composite FK
    // `(company_id, tenant_id) REFERENCES company (id, tenant_id)` is what refuses it. usage_snapshot
    // carries the same constraint, where both columns are NOT NULL and it is the billing evidence.
    const other = await seedBase();
    const err = await owner.db
      .insert(schema.tenantModule)
      .values({ tenantId: base.tenantId, moduleCode: 'toil', companyId: other.companyId, status: 'active' })
      .catch((e) => e);
    expect(err, "another tenant's company must not be entitleable").toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/tenant_module_company_same_tenant_fk/i);

    const usage = await owner.db
      .insert(schema.usageSnapshot)
      .values({ tenantId: base.tenantId, companyId: other.companyId, capturedOn: '2026-01-01' })
      .catch((e) => e);
    expect(usage, 'a usage row for another tenant\'s company would misattribute a bill').toBeInstanceOf(Error);
    expect(pgText(usage)).toMatch(/usage_snapshot_company_same_tenant_fk/i);

    // …and the legitimate company-scoped row still goes through, or the constraint has over-reached.
    await owner.db
      .insert(schema.tenantModule)
      .values({ tenantId: base.tenantId, moduleCode: 'toil', companyId: base.companyId, status: 'active' });
  });

  it('the tenant-wide sentinel cannot be aliased by a company carrying the all-zero uuid', async () => {
    // The grain index stands the all-zero uuid in for a NULL company_id. "company.id is
    // gen_random_uuid() so it can never collide" is a claim about a DEFAULT, not a constraint — and an
    // explicit id is insertable. This installation already mints that uuid for a real row (0151's
    // reserved system tenant), so the collision is not hypothetical: a company with that id turns
    // `ON CONFLICT (…, COALESCE(company_id, sentinel)) DO UPDATE` aimed at ONE company into a silent
    // rewrite of the TENANT-WIDE grant. The CHECK constraint is what makes the sentinel true.
    const SENTINEL = '00000000-0000-0000-0000-000000000000';
    await owner.db.insert(schema.company).values({
      id: SENTINEL,
      tenantId: base.tenantId,
      legalName: 'Sentinel Collision Bhd',
      country: 'MY',
      currency: 'MYR',
    });
    const err = await owner.db
      .insert(schema.tenantModule)
      .values({ tenantId: base.tenantId, moduleCode: 'toil', companyId: SENTINEL, status: 'active' })
      .catch((e) => e);
    expect(err, 'a company-scoped row at the sentinel id must be refused').toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/tenant_module_company_not_sentinel_check/i);
  });

  // ── the seeder's two fail-loud guards ─────────────────────────────────────────────────────────
  //
  // Both refuse a CATALOG EDIT that would silently maim rows customers already hold, and until round 3
  // neither was reachable from a test — the rows they refuse can only be produced by editing
  // packs/catalog.ts, so there was nothing to point a test at. `seedCatalogs` now takes the catalog as a
  // parameter (defaulting to the real one) purely so a test can say "someone flipped this row" without a
  // source edit. Worse, the setting guard's comment CLAIMED the module-axis guard already existed; it
  // did not, so a billable→core flip went straight through ON CONFLICT DO UPDATE.

  it('the seeder REFUSES to flip a module to core while customers hold entitlements for it', async () => {
    // The consequence, proven separately by 'a core code can still be DELETED' above: 0313's core guard
    // is a trigger on INSERT and UPDATE, so once `module.is_core` flips, every existing tenant_module
    // row for that code is frozen — in force, un-expirable, un-disableable, removable only by DELETE.
    await setModule(base.tenantId, 'toil', 'active');
    const promoted = MODULE_CATALOG.map((m) => (m.code === 'toil' ? { ...m, isCore: true, billable: false } : m));

    try {
      const err = await seedCatalogs(owner.db, { modules: promoted, settings: SETTING_CATALOG }).catch((e) => e);
      expect(err, 'the flip must be refused, not applied').toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Refusing to promote toil to is_core/);

      // The guard runs BEFORE the upsert loop, so nothing may have landed — otherwise it would report a
      // refusal while having already frozen the rows it was refusing to freeze.
      const [row] = await owner.db
        .select({ isCore: schema.module_.isCore })
        .from(schema.module_)
        .where(eq(schema.module_.code, 'toil'));
      expect(row.isCore, 'module.is_core must be untouched by a refused seed').toBe(false);
    } finally {
      // ALWAYS re-seed the real catalog, including on failure. `module` is template-seeded and NOT
      // truncated by resetDb (see harness ALL_TABLES), so a promoted row surviving this test would
      // corrupt every later file in the worker — and the case where the guard is BROKEN is exactly the
      // case where the promotion landed. Doubles as the happy-path assertion: the ordinary bootstrap
      // run must still succeed with that entitlement row present, or the guard is an outage.
      await expect(seedCatalogs(owner.db)).resolves.toBeDefined();
    }
  });

  it('the seeder REFUSES to promote a setting to platform scope while customer values exist', async () => {
    // `tenant_setting`'s write policy evaluates scope at WRITE time and never again, so a key that
    // gains scope='platform' leaves every value a customer already chose in force AND unremovable —
    // their DELETE is filtered out by the USING arm.
    //
    // Cleared first for the same reason the write-policy block clears: on a box carrying the
    // deployment's INDIVIDUAL_TXN_PAY_ENABLED flag, seedBase has already written a PLATFORM-sourced row
    // for this key, and what this case needs is a CUSTOMER-sourced one.
    await owner.db.execute(sql`DELETE FROM tenant_setting WHERE tenant_id = ${base.tenantId}`);
    await owner.db.insert(schema.tenantSetting).values({
      tenantId: base.tenantId,
      key: TENANT_SCOPED_KEY,
      value: true,
      source: 'customer',
    });
    const promoted = SETTING_CATALOG.map((s) =>
      s.key === TENANT_SCOPED_KEY ? { ...s, scope: 'platform' as const } : s,
    );

    try {
      const err = await seedCatalogs(owner.db, { modules: MODULE_CATALOG, settings: promoted }).catch((e) => e);
      expect(err, 'the promotion must be refused, not applied').toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(new RegExp(`Refusing to promote ${TENANT_SCOPED_KEY}`));

      const [def] = await owner.db
        .select({ scope: schema.settingDefinition.scope })
        .from(schema.settingDefinition)
        .where(eq(schema.settingDefinition.key, TENANT_SCOPED_KEY));
      expect(def.scope, 'setting_definition.scope must be untouched by a refused seed').toBe('tenant');

      // Provenance is the discriminator, not mere existence: a row the PLATFORM wrote is the platform's
      // to reprovenance, so the guard must ignore it or every bootstrap after the 0313 backfill would
      // refuse to run. This call DOES apply the promotion; the finally puts the catalog back.
      await owner.db.execute(sql`DELETE FROM tenant_setting WHERE tenant_id = ${base.tenantId}`);
      await owner.db.insert(schema.tenantSetting).values({
        tenantId: base.tenantId,
        key: TENANT_SCOPED_KEY,
        value: true,
        source: 'platform',
      });
      await expect(seedCatalogs(owner.db, { modules: MODULE_CATALOG, settings: promoted })).resolves.toBeDefined();
    } finally {
      // Same reason as the module guard's finally: setting_definition is template-seeded and never
      // truncated by resetDb, so a promoted scope surviving this test would silently change what
      // tenant_setting's write policy allows for every later file in the worker.
      await owner.db.execute(sql`DELETE FROM tenant_setting WHERE tenant_id = ${base.tenantId}`);
      await seedCatalogs(owner.db);
    }
  });
});
