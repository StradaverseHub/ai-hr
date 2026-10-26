/** Authored actual connection interleavings, UNRUN until coordinated local runtime admission. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { lockAccessConfigurationTx } from '../core/access-configuration-lock';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);

describe('Assistant grant writers join the existing caller-authority barrier', () => {
  it.each(['grant', 'revoke'] as const)('%s waits for the real held Access interval and records only its eventual change', async command => {
    const ctx = adminCtx(b);
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Grant Interval', primaryEmail: `grant-${randomUUID()}@t.local` },
      companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const userId = await createAppUser(b.tenantId, employee.personId, 'employee');
    if (command === 'revoke') await grantAssistant(ctx, { appUserId: userId });
    const state = async () => ({
      grants: await owner.db.select().from(schema.assistantGrant).where(eq(schema.assistantGrant.appUserId, userId)).orderBy(schema.assistantGrant.id),
      events: await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned grant handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockAccessConfigurationTx(tx, b.tenantId); ready(); await finish; });
    void holder.catch(failed);
    let writing: Promise<unknown> | undefined, writeFailure: unknown;
    try {
      await started;
      const input = { appUserId: userId };
      writing = command === 'grant' ? grantAssistant(ctx, input) : revokeAssistant(ctx, input);
      void writing.catch(error => { writeFailure = error; });
      // Observe an ACTUAL blocked lock request for this fresh tenant, rather than infer waiting from
      // a sleep or an unscheduled promise. Inspect only lock metadata in the isolated fixture DB.
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        if (writeFailure) throw writeFailure;
        const [row] = await owner.db.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_locks l where l.locktype='advisory' and not l.granted and l.objsubid=1
          and l.database=(select oid from pg_database where datname=current_database())
          and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${'access-configuration:' + b.tenantId},0)
        ) as waiting`);
        if (row?.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting, 'the canonical writer must actually wait for the owned authority interval').toBe(true);
      expect(await state()).toEqual(before);
      // A retained caller object cannot retarget the operation while it waits for authority.
      input.appUserId = randomUUID();
    } finally { release(); clearTimeout(watchdog); await holder; if (writing) await writing; }
    const after = await state();
    expect(after.grants.filter(row => row.revokedAt === null)).toHaveLength(command === 'grant' ? 1 : 0);
    expect(after.events).toHaveLength(before.events.length + 1);
  });
});
