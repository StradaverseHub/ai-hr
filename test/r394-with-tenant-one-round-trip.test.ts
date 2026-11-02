/**
 * r394 — withTenant sets the four session GUCs in ONE statement instead of four.
 *
 * Every RLS policy reads these (app.current_grants() reads app.grants; tenant isolation reads
 * app.tenant_id), so the values must be exactly what the four separate statements produced, still
 * transaction-local (cleared at COMMIT), and the saving must be real: one set_config round trip per
 * transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(async () => { await migrateTestDb(); await resetDb(); b = await seedBase(); });
afterAll(async () => { await closeAll(); });

describe('r394 · withTenant session context in one round trip', () => {
  it('sets tenant, user, roles and grants exactly as before, inside the transaction', async () => {
    const grants = [{ role: 'hr_admin', companyId: null }, { role: 'manager', companyId: b.companyId }];
    const ctx = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin', 'manager'], grants } as SessionContext;
    const row = await withTenant(ctx, async (tx) => (await tx.execute(sql`
      select current_setting('app.tenant_id', true) as t, current_setting('app.user_id', true) as u,
             current_setting('app.roles', true) as r, current_setting('app.grants', true) as g`))[0] as Record<string, string>);
    expect(row.t).toBe(b.tenantId);
    expect(row.u).toBe(b.adminUserId);
    expect(row.r).toBe('hr_admin,manager');
    expect(JSON.parse(row.g)).toEqual(grants);
    // RLS reads the grants through app.current_grants(): the parsed form must be the two grants.
    const parsed = await withTenant(ctx, async (tx) => (await tx.execute(sql`select role, company_id from app.current_grants() order by role`)) as unknown as { role: string; company_id: string | null }[]);
    expect(parsed.map((p) => [p.role, p.company_id])).toEqual([['hr_admin', null], ['manager', b.companyId]]);
  });

  it('a context with no userId and roles only still yields group-wide grants and an empty user', async () => {
    const row = await withTenant({ tenantId: b.tenantId, roles: ['employee'] } as SessionContext, async (tx) =>
      (await tx.execute(sql`select current_setting('app.user_id', true) as u, current_setting('app.grants', true) as g`))[0] as Record<string, string>);
    expect(row.u).toBe('');
    expect(JSON.parse(row.g)).toEqual([{ role: 'employee', companyId: null }]);
  });

  it('the values are transaction-local: gone once the transaction commits', async () => {
    const ctx = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'] } as SessionContext;
    // A reserved connection guarantees the second read runs on the SAME backend as the transaction.
    const { client } = await import('../db/client');
    const reserved = await client.reserve();
    try {
      await reserved`begin`;
      await reserved`select set_config('app.tenant_id', ${ctx.tenantId}, true), set_config('app.user_id', ${ctx.userId!}, true)`;
      await reserved`commit`;
      const [after] = await reserved`select coalesce(current_setting('app.tenant_id', true), '') as t`;
      expect(after.t).toBe('');
    } finally { reserved.release(); }
  });

  it('withTenant issues exactly ONE set_config statement for the four values', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'db/client.ts'), 'utf8');
    const start = src.indexOf('async function withTenant');
    const end = src.indexOf('return fn(tx);', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start + 500);
    const body = src.slice(start, end);
    const statements = body.match(/tx\.execute\(\s*sql`[^`]*`/g) ?? [];
    const fourInOne = statements.filter((s) => ['app.tenant_id', 'app.user_id', 'app.roles', 'app.grants'].every((k) => s.includes(`set_config('${k}'`)));
    expect(fourInOne).toHaveLength(1);
    // …and none of the four is set again in a statement of its own.
    for (const k of ['app.tenant_id', 'app.user_id', 'app.roles', 'app.grants']) {
      expect(statements.filter((s) => s.includes(`set_config('${k}'`)), k).toHaveLength(1);
    }
  });

  it('keeps warm audit arming and clears it across commit and rollback on the same backend', async () => {
    const previous = process.env.AUDIT_HASH_CHAIN_ENABLED;
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('application_name', 'audit-session-isolation');
    const scoped = createDb(url.toString(), {max: 1});
    const read = (ctx: SessionContext) => scoped.withTenant(ctx, async tx =>
      (await tx.execute(sql`select pg_backend_pid() as pid, current_setting('app.audit_hash_chain', true) as chain,
        current_setting('app.tenant_id', true) as tenant`))[0] as {pid: number; chain: string | null; tenant: string});
    try {
      process.env.AUDIT_HASH_CHAIN_ENABLED = 'true';
      const first = await read(adminCtx(b));
      expect(first.chain).toBe('on');
      process.env.AUDIT_HASH_CHAIN_ENABLED = 'false';
      const warm = await read(adminCtx(b));
      expect(warm).toEqual(first);
      const foreign = await seedBase();
      const other = await read(adminCtx(foreign));
      expect(other.pid).toBe(first.pid);
      expect(other.tenant).toBe(foreign.tenantId);
      expect(other.chain).not.toBe('on');
      await expect(scoped.withTenant(adminCtx(b), async () => {throw Error('Fictional rollback');})).rejects.toThrow('Fictional rollback');
      expect(await read(adminCtx(foreign))).toEqual(other);
    } finally {
      if (previous === undefined) delete process.env.AUDIT_HASH_CHAIN_ENABLED;
      else process.env.AUDIT_HASH_CHAIN_ENABLED = previous;
      await scoped.client.end();
    }
  });
});
