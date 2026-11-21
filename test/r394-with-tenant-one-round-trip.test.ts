/**
 * r394 — withTenant sets the four session GUCs in ONE statement instead of four.
 *
 * Every RLS policy reads these (app.current_grants() reads app.grants; tenant isolation reads
 * app.tenant_id), so the values must be exactly what the four separate statements produced, still
 * transaction-local (cleared at COMMIT), and the saving must be real: one set_config round trip per
 * transaction.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { pgSqlState } from '../lib/db-error';
import { closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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

  it('a read-only snapshot opens REPEATABLE READ / READ ONLY in BEGIN itself, then the same one session statement', async () => {
    const ctx = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'] } as SessionContext;
    const { client } = await import('../db/client');
    const options = client.options as { debug?: unknown };
    const previous = options.debug;
    const sent: string[] = [];
    options.debug = (_connection: number, text: string) => { sent.push(text.replace(/\s+/g, ' ').trim().toLowerCase()); };
    let mode: Record<string, string>;
    try {
      mode = await withTenant(ctx, async (tx) => (await tx.execute(sql`select current_setting('transaction_isolation') as isolation,
        current_setting('transaction_read_only') as read_only, current_setting('app.tenant_id', true) as tenant`))[0] as Record<string, string>,
      { readOnlySnapshot: true });
    } finally { options.debug = previous; }
    expect(mode).toEqual({ isolation: 'repeatable read', read_only: 'on', tenant: b.tenantId });
    expect(sent[0]).toBe('begin isolation level repeatable read read only');
    expect(sent.filter((text) => text.startsWith('set transaction'))).toEqual([]);
    expect(sent.filter((text) => text.includes("set_config('app.tenant_id'"))).toHaveLength(1);
    expect(sent.at(-1)).toBe('commit');
    // Writes are refused in the snapshot, exactly as the separate SET TRANSACTION refused them.
    await expect(withTenant(ctx, (tx) => tx.execute(sql`create temporary table r394_refused(id int)`), { readOnlySnapshot: true }))
      .rejects.toSatisfy((error: unknown) => pgSqlState(error) === '25006');
    // An ordinary transaction is unchanged: read committed, read write, no isolation in its BEGIN.
    sent.length = 0;
    options.debug = (_connection: number, text: string) => { sent.push(text.replace(/\s+/g, ' ').trim().toLowerCase()); };
    try {
      const plain = await withTenant(ctx, async (tx) => (await tx.execute(sql`select current_setting('transaction_isolation') as isolation,
        current_setting('transaction_read_only') as read_only`))[0] as Record<string, string>);
      expect(plain).toEqual({ isolation: 'read committed', read_only: 'off' });
    } finally { options.debug = previous; }
    expect(sent[0]).toBe('begin');
  });

  it('withTenant issues exactly ONE set_config round trip for the four values before the caller runs', async () => {
    // Observe what the driver actually sends on the transaction's own connection rather than the source
    // text, so a refactor of withTenant cannot keep a matching string while adding round trips.
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'false'); // first arming may add its own statement; this pins the ordinary path
    const { client } = await import('../db/client');
    const sent: { connection: number; text: string }[] = [];
    const previous = client.options.debug;
    client.options.debug = (connection: number, text: string) => { sent.push({ connection, text }); };
    const grants = [{ role: 'hr_admin', companyId: null }, { role: 'manager', companyId: b.companyId }];
    const ctx = { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin', 'manager'], grants } as SessionContext;
    let sentBeforeCaller = -1;
    try {
      await withTenant(ctx, async (tx) => { sentBeforeCaller = sent.length; await tx.execute(sql`select 'r394-caller-first' as marker`); });
    } finally {
      client.options.debug = previous;
      vi.unstubAllEnvs();
    }
    const callerAt = sent.findIndex((q) => q.text.includes("'r394-caller-first'"));
    expect(callerAt, 'the caller statement was observed').toBeGreaterThan(0);
    expect(callerAt, 'nothing else is sent once the caller runs').toBe(sentBeforeCaller);
    const own = sent.filter((q) => q.connection === sent[callerAt].connection).map((q) => q.text.replace(/\s+/g, ' ').trim());
    const begin = own.findIndex((text) => /^begin\b/i.test(text));
    const caller = own.findIndex((text) => text.includes("'r394-caller-first'"));
    const commit = own.findIndex((text, index) => index > caller && /^commit\b/i.test(text));
    expect(begin).toBe(0);
    expect(commit).toBe(caller + 1);
    // Exactly one round trip between BEGIN and the caller's first statement, and it sets all four values.
    const bootstrap = own.slice(begin + 1, caller);
    expect(bootstrap).toHaveLength(1);
    const keys = ['app.tenant_id', 'app.user_id', 'app.roles', 'app.grants'];
    for (const k of keys) expect(bootstrap[0], k).toContain(`set_config('${k}'`);
    // …and none of the four is set again anywhere else in the transaction.
    for (const k of keys) expect(own.filter((text) => text.includes(`set_config('${k}'`)), k).toHaveLength(1);
  });
});
