/**
 * job_run RLS (migration 0280) — the read gate and, more importantly, the ABSENCE of a write path.
 *
 * The write assertions here are the ONLY thing in the repo that catches a dropped REVOKE. The cluster's
 * ALTER DEFAULT PRIVILEGES (deploy/bootstrap-db.sql line 51) auto-grants full CRUD on every new public
 * table to ai_hr_app, and cleanroom-verify.sh lines 26-27 reproduce that same grant — so the cleanroom
 * MASKS a missing GRANT and can never detect a missing REVOKE. If someone deletes the REVOKE line from
 * 0280, these are the tests that go red.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { listRecentJobRuns, recordJobRun } from '../core/job-run';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('0280 — job_run RLS', () => {
  let base: Base;
  // Group-wide hr_admin (grant.companyId null) — what app.is_group_admin() admits.
  let groupAdmin: SessionContext;
  // Company-scoped hr_admin — the ordinary delegated admin, which is_group_admin() must NOT admit.
  let scopedAdmin: SessionContext;
  let employee: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    groupAdmin = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: null }] };
    scopedAdmin = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: base.companyId }],
    };
    employee = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    // Seed one run as the owner role — the only role that can write.
    await recordJobRun(owner.db, {
      jobKey: 'leave.accrue',
      startedAt: Date.now(),
      tenantsProcessed: 2,
      tenantsFailed: 0,
      result: { granted: 12 },
    });
  });
  afterAll(async () => {
    await closeAll();
  });

  it('a group admin reads the run log', async () => {
    const rows = await listRecentJobRuns(groupAdmin);
    expect(rows).toHaveLength(1);
    expect(rows[0].jobKey).toBe('leave.accrue');
    expect(rows[0].result).toEqual({ granted: 12 });
  });

  it('a company-scoped hr_admin sees zero rows', async () => {
    expect(await listRecentJobRuns(scopedAdmin)).toHaveLength(0);
  });

  it('an ordinary employee sees zero rows', async () => {
    expect(await listRecentJobRuns(employee)).toHaveLength(0);
  });

  // ── No write path from the web tier. The REVOKE, not a policy, is what stops these. ──

  it('the app role cannot INSERT, even as a group admin', async () => {
    await expect(
      withTenant(groupAdmin, (tx) =>
        tx.insert(schema.jobRun).values({ jobKey: 'leave.accrue', outcome: 'success', tenantsProcessed: 0, tenantsFailed: 0 }),
      ),
    ).rejects.toThrow();
  });

  it('the app role cannot UPDATE an existing run', async () => {
    await expect(
      withTenant(groupAdmin, (tx) =>
        tx.update(schema.jobRun).set({ outcome: 'failed' }).where(eq(schema.jobRun.jobKey, 'leave.accrue')),
      ),
    ).rejects.toThrow();
    // The row is untouched: a forged outcome must not be reachable from the app at all.
    const [row] = await owner.db.select().from(schema.jobRun);
    expect(row.outcome).toBe('success');
  });

  it('the app role cannot DELETE a run', async () => {
    await expect(
      withTenant(groupAdmin, (tx) => tx.delete(schema.jobRun).where(eq(schema.jobRun.jobKey, 'leave.accrue'))),
    ).rejects.toThrow();
    expect(await owner.db.select().from(schema.jobRun)).toHaveLength(1);
  });

  // The reason there is no write path at all: app.is_group_admin() reads the CURRENT SESSION's grants
  // and has no tenant dimension, so it cannot tell one customer's top HR admin from another's. This test
  // documents that fact rather than asserting a wish — a group admin of tenant B reads tenant A's runs.
  // That is why the table stores only job names, timestamps and cross-tenant aggregates, and why a write
  // path gated on the same predicate would have let tenant B forge tenant A's history.
  it('the read gate has no tenant dimension — accepted for reads precisely because it holds no customer data', async () => {
    const other = await seedBase();
    const otherGroupAdmin: SessionContext = {
      tenantId: other.tenantId,
      userId: other.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
    const rows = await listRecentJobRuns(otherGroupAdmin);
    expect(rows).toHaveLength(1);
    // No per-tenant breakdown is stored, so cross-tenant readability leaks no customer data.
    expect(Object.keys(rows[0].result ?? {})).toEqual(['granted']);
    expect(rows[0]).not.toHaveProperty('tenantId');
  });
});
