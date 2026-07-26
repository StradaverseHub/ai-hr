/**
 * Operator console RLS + grants (0294/0295) — the security shape, asserted rather than assumed.
 *
 * These are the tests that catch a deleted line in the migration. As 0280 documented for job_run:
 * deploy/bootstrap-db.sql grants full CRUD on every new public table to ai_hr_app via ALTER DEFAULT
 * PRIVILEGES, and cleanroom-verify.sh reproduces that same grant — so the cleanroom MASKS a missing
 * GRANT and can NEVER catch a missing REVOKE. Nothing else in the repo would notice if the column-limited
 * grants here were replaced by a plain `GRANT SELECT`, and the activation URL would silently become
 * readable by every operator session forever after.
 *
 * Four properties, in descending order of how badly they would hurt:
 *   1. The web tier still cannot touch `tenant` at all (the untouched 0001 guarantee).
 *   2. activation_url is unreadable by SELECT, for EVERYONE, including an operator.
 *   3. A customer's group admin — the highest CUSTOMER role — reaches none of this.
 *   4. A group admin cannot mint themselves the operator role.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  claimActivationUrl,
  createProvisionRequest,
  listProvisionRequests,
  requestReissue,
  NotOperatorError,
} from '../core/operator';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/**
 * Flatten an error and its `cause` chain into one searchable string. Drizzle wraps a PostgresError in a
 * "Failed query: …" Error and hangs the original off `.cause`, so the actual RAISE text — the only part
 * that says WHY a definer function refused — is invisible to a plain toThrow(/…/) match.
 */
function causeChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

describe('0295 — operator console RLS and grants', () => {
  let base: Base;
  /** A customer's group-wide hr_admin — the highest CUSTOMER role, and still not an operator. */
  let groupAdmin: SessionContext;
  /** The installation operator. Same tenant, different tier: the grant is what differs, not the tenant. */
  let operator: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();

    const [opUser] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `op_${crypto.randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: opUser.id, companyId: null, role: 'operator' });

    groupAdmin = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    operator = {
      tenantId: base.tenantId,
      userId: opUser.id,
      roles: ['operator'],
      grants: [{ role: 'operator', companyId: null }],
    };
  });
  afterAll(async () => {
    await closeAll();
  });

  // ── 1. The untouched guarantee: the web tier cannot make a tenant ───────────────────────────────

  it('ai_hr_app cannot CREATE a tenant or see another customer, even as an operator', async () => {
    // This is why the console is a request queue at all. If the insert ever succeeds, the whole
    // out-of-band runner design has been quietly bypassed and this feature is no longer safe.
    //
    // 0001's policy is `USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id())`,
    // so a session sees exactly ONE row — its own tenant — and can never insert a row with a different
    // id. Both halves are asserted: the visibility scope AND the closed write path.
    const other = await seedBase();

    for (const ctx of [groupAdmin, operator]) {
      const rows = await withTenant(ctx, (tx) => tx.select({ id: schema.tenant.id }).from(schema.tenant));
      expect(rows.map((r) => r.id)).toEqual([ctx.tenantId]);
      expect(rows.map((r) => r.id)).not.toContain(other.tenantId);

      // Refused at the GRANT layer since ADR-0077 slice 1: migration 0313 revoked INSERT/UPDATE/DELETE
      // on `tenant` from ai_hr_app, because that migration hung the commercial columns (status, plan,
      // trial_ends_at) off this row and 0001's policy is scope-only. Before that the refusal came from
      // the policy's WITH CHECK — a fresh id can never equal current_tenant_id() — which is still true
      // and still a second layer; the grant is simply reached first.
      const err = await withTenant(ctx, (tx) =>
        tx.insert(schema.tenant).values({ workosOrgId: `org_${crypto.randomUUID()}`, name: 'Sneaky Bhd' }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      // causeChain, not toThrow: drizzle's top-level message is only "Failed query: …", and the reason
      // the write was refused lives on the wrapped PostgresError.
      expect(causeChain(err)).toMatch(/permission denied/i);
    }

    // Nothing was created by any of the attempts above.
    const names = await owner.db.select({ name: schema.tenant.name }).from(schema.tenant);
    expect(names.filter((t) => t.name === 'Sneaky Bhd')).toHaveLength(0);
  });

  // ── 2. activation_url is unreadable by SELECT, for everyone ─────────────────────────────────────

  it('SELECTing activation_url fails for an OPERATOR too — the column grant, not a policy, is the gate', async () => {
    const { id } = await createProvisionRequest(operator, {
      customerName: 'Column Grant Bhd',
      adminEmail: 'admin@colgrant.test',
    });
    await owner.db
      .update(schema.tenantProvisionRequest)
      .set({ status: 'done', activationUrl: 'https://hr.test/invite/secret-token' })
      .where(eq(schema.tenantProvisionRequest.id, id));

    // Naming the column: permission denied.
    await expect(
      withTenant(operator, (tx) =>
        tx.select({ url: schema.tenantProvisionRequest.activationUrl }).from(schema.tenantProvisionRequest),
      ),
    ).rejects.toThrow();

    // Referencing it in a predicate or an expression is the same denial — column privileges cover every
    // reference, so there is no "is it set?" side channel either.
    await expect(
      withTenant(operator, (tx) =>
        tx.execute(sql`select activation_url is not null as has from tenant_provision_request`),
      ),
    ).rejects.toThrow();

    // And an unqualified select() — the shape a future refactor would reach for — fails loudly rather
    // than leaking. core/operator.ts names its columns for exactly this reason.
    await expect(
      withTenant(operator, (tx) => tx.select().from(schema.tenantProvisionRequest)),
    ).rejects.toThrow();

    // The service's explicit column list still works, and simply has no url field to leak.
    const rows = await listProvisionRequests(operator);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('secret-token');
    expect(rows[0]).not.toHaveProperty('activationUrl');
  });

  // ── (e) Claim-once ──────────────────────────────────────────────────────────────────────────────

  it('the first claim returns the URL, the second returns null', async () => {
    const { id } = await createProvisionRequest(operator, {
      customerName: 'Claim Once Bhd',
      adminEmail: 'admin@claimonce.test',
    });
    await owner.db
      .update(schema.tenantProvisionRequest)
      .set({ status: 'done', activationUrl: 'https://hr.test/invite/one-shot' })
      .where(eq(schema.tenantProvisionRequest.id, id));

    expect(await claimActivationUrl(operator, id)).toBe('https://hr.test/invite/one-shot');
    expect(await claimActivationUrl(operator, id)).toBeNull();

    // Wiped at the source, not merely hidden from the caller.
    const [row] = await owner.db
      .select({ url: schema.tenantProvisionRequest.activationUrl })
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, id));
    expect(row.url).toBeNull();
  });

  // ── (i) Two concurrent claims, exactly one winner ───────────────────────────────────────────────

  it('two concurrent claims: exactly one receives the URL', async () => {
    const { id } = await createProvisionRequest(operator, {
      customerName: 'Race Bhd',
      adminEmail: 'admin@race.test',
    });
    await owner.db
      .update(schema.tenantProvisionRequest)
      .set({ status: 'done', activationUrl: 'https://hr.test/invite/only-once' })
      .where(eq(schema.tenantProvisionRequest.id, id));

    // Both fire before either commits. The FOR UPDATE row lock inside the definer function serializes
    // them, and the loser re-reads the committed row with the column already null.
    const [a, b] = await Promise.all([claimActivationUrl(operator, id), claimActivationUrl(operator, id)]);
    const winners = [a, b].filter((v) => v !== null);
    expect(winners).toEqual(['https://hr.test/invite/only-once']);
  });

  it('claiming an unknown request id returns null rather than throwing', async () => {
    expect(await claimActivationUrl(operator, crypto.randomUUID())).toBeNull();
  });

  // ── 3. A customer's group admin reaches none of it ──────────────────────────────────────────────

  it('a customer group admin cannot read the queue, insert into it, or claim a URL', async () => {
    await createProvisionRequest(operator, { customerName: 'Visible Bhd', adminEmail: 'a@visible.test' });

    // Service layer: fail fast.
    await expect(listProvisionRequests(groupAdmin)).rejects.toThrow(NotOperatorError);
    await expect(
      createProvisionRequest(groupAdmin, { customerName: 'Nope Bhd', adminEmail: 'a@nope.test' }),
    ).rejects.toThrow(NotOperatorError);
    await expect(requestReissue(groupAdmin, crypto.randomUUID())).rejects.toThrow(NotOperatorError);
    await expect(claimActivationUrl(groupAdmin, crypto.randomUUID())).rejects.toThrow(NotOperatorError);

    // RLS layer — the one that actually matters. Bypass the service entirely and go at the table with a
    // raw handle, exactly as a future bug or a forgotten gate would.
    const rows = await withTenant(groupAdmin, (tx) =>
      tx
        .select({ id: schema.tenantProvisionRequest.id })
        .from(schema.tenantProvisionRequest),
    );
    expect(rows).toHaveLength(0);

    await expect(
      withTenant(groupAdmin, (tx) =>
        tx
          .insert(schema.tenantProvisionRequest)
          .values({ customerName: 'Forged Bhd', adminEmail: 'forged@nope.test' }),
      ),
    ).rejects.toThrow();

    // The definer function refuses too — its own app.is_operator() check, not a policy, stops it. The
    // reason matters here (a definer function that merely found no row would also "not throw"), so
    // assert the RAISE text, which drizzle nests under .cause rather than exposing on .message.
    const err = await withTenant(groupAdmin, (tx) =>
      tx.execute(sql`select app.claim_activation_url(${crypto.randomUUID()}::uuid)`),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(causeChain(err)).toMatch(/only an operator/i);
  });

  it('an operator CAN read and insert — the mirror of the test above', async () => {
    const { id } = await createProvisionRequest(operator, {
      customerName: 'Allowed Bhd',
      adminEmail: 'admin@allowed.test',
    });
    const rows = await listProvisionRequests(operator);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0].customerName).toBe('Allowed Bhd');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].requestedBy).toBe(operator.userId);
  });

  // ── The write surface is exactly one column ─────────────────────────────────────────────────────

  it('an operator may update ONLY reissue_requested_at — not status, error, tenant_id or the URL', async () => {
    const { id } = await createProvisionRequest(operator, {
      customerName: 'Narrow Write Bhd',
      adminEmail: 'admin@narrow.test',
    });

    // The one permitted write.
    await requestReissue(operator, id);
    const [row] = await owner.db
      .select({ flag: schema.tenantProvisionRequest.reissueRequestedAt })
      .from(schema.tenantProvisionRequest)
      .where(eq(schema.tenantProvisionRequest.id, id));
    expect(row.flag).toBeInstanceOf(Date);

    // Everything else is denied by the column grant. Forging 'done' would be the worst of these — it
    // would let an operator fabricate a customer that was never created.
    for (const patch of [
      { status: 'done' },
      { error: 'nothing to see here' },
      { currentStep: 'tenant' },
      { tenantId: base.tenantId },
      { activationUrl: 'https://hr.test/invite/forged' },
      { claimedAt: new Date() },
    ]) {
      await expect(
        withTenant(operator, (tx) =>
          tx
            .update(schema.tenantProvisionRequest)
            .set(patch)
            .where(eq(schema.tenantProvisionRequest.id, id)),
        ),
        JSON.stringify(patch),
      ).rejects.toThrow();
    }

    // And no DELETE grant at all: the queue is the durable record of every attempt.
    await expect(
      withTenant(operator, (tx) =>
        tx.delete(schema.tenantProvisionRequest).where(eq(schema.tenantProvisionRequest.id, id)),
      ),
    ).rejects.toThrow();
  });

  // ── 4. The escalation path is closed ────────────────────────────────────────────────────────────

  it('a group admin cannot grant the operator role to anyone, including themselves', async () => {
    // Without 0295's tightening this would SUCCEED — the 0099 policy's group-admin branch grants any
    // role — and any customer's top HR admin could promote themselves to the installation tier.
    await expect(
      withTenant(groupAdmin, (tx) =>
        tx.insert(schema.roleAssignment).values({
          tenantId: base.tenantId,
          appUserId: base.adminUserId,
          companyId: null,
          role: 'operator',
        }),
      ),
    ).rejects.toThrow();

    // Nor by walking an existing grant up to it.
    const [own] = await owner.db
      .select({ id: schema.roleAssignment.id })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, base.adminUserId));
    await withTenant(groupAdmin, (tx) =>
      tx.update(schema.roleAssignment).set({ role: 'operator' }).where(eq(schema.roleAssignment.id, own.id)),
    ).catch(() => {});
    const [after] = await owner.db
      .select({ role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.id, own.id));
    expect(after.role).toBe('hr_admin');

    // The ordinary grants a group admin SHOULD still be able to make are unaffected by the tightening.
    await withTenant(groupAdmin, (tx) =>
      tx.insert(schema.roleAssignment).values({
        tenantId: base.tenantId,
        appUserId: base.adminUserId,
        companyId: null,
        role: 'payroll_partner',
      }),
    );
    const grants = await owner.db
      .select({ role: schema.roleAssignment.role })
      .from(schema.roleAssignment)
      .where(eq(schema.roleAssignment.appUserId, base.adminUserId));
    expect(grants.map((g) => g.role).sort()).toEqual(['hr_admin', 'payroll_partner']);
  });
});
