/** Actual explicit read-owner cases, authored UNRUN. Requires coordinated action-control migration. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tenantDb from '../db/client';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import * as canonical from '../core/read';
import { withAssistantRead, withAssistantReadTx, type AssistantReadSession } from '../core/assistant-read-session';
import { ASSISTANT_TOOLS } from '../core/assistant-tools';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { lockAccessConfigurationTx } from '../core/access-configuration-lock';
import { setAiFeature } from '../core/ai-management';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'assistant', 'active'); });
afterAll(closeAll);
const profile = ASSISTANT_TOOLS.find(tool => tool.spec.name === 'employee_profile')!;
async function fixture() {
  const a = adminCtx(base);
  const make = (name: string) => hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
  const mine = await make('Fictional Read Owner'), other = await make('Fictional Private Peer');
  const uid = await createAppUser(base.tenantId, mine.personId, 'employee');
  await grantAssistant(a, { appUserId: uid }); await grantAssistant(a, { appUserId: base.adminUserId });
  const ctx: SessionContext = { ...await entitledCtx(base, ['employee']), userId: uid, personId: mine.personId,
    roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  return { a, ctx, mine, other };
}
async function observeWaiting() {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const [row] = await owner.db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_locks l
      where l.locktype='advisory' and not l.granted and l.objsubid=1
      and l.database=(select oid from pg_database where datname=current_database())
      and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${'access-configuration:' + base.tenantId},0)) as waiting`);
    if (row?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('No actual pending Access lock observed');
}

describe('explicit Assistant read ownership', () => {
  it('runs two actual tools through one Read Committed/read-only backend and preserves RLS refusal', async () => {
    const { ctx, mine, other } = await fixture();
    const original = canonical.employeeDetail;
    const observed: number[] = [];
    const connection = vi.spyOn(canonical, 'employeeDetail').mockImplementation(async (...args) => {
      expect(args[3]).toBeDefined();
      const [mode] = await args[3]!.execute<{ pid: number; isolation: string; readonly: string; actor: string }>(sql`select pg_backend_pid() as pid,
        current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly,app.current_user_id() as actor`);
      expect(mode).toMatchObject({ isolation: 'read committed', readonly: 'on', actor: ctx.userId });
      observed.push(mode.pid); return original(...args);
    });
    const transactions = vi.spyOn(tenantDb, 'withTenant');
    try {
      const result = await withAssistantRead(ctx, null, async session => ({
        mine: await profile.run(ctx, { employment_id: mine.employmentId }, session),
        peer: await profile.run(ctx, { employment_id: other.employmentId }, session),
      }));
      expect(result.mine).toMatchObject({ ok: true }); expect(result.peer).toMatchObject({ ok: false, refusal: 'not_visible' });
      expect(transactions).toHaveBeenCalledTimes(1);
      expect(observed).toHaveLength(2); expect(new Set(observed).size).toBe(1);
      expect(JSON.stringify(result)).not.toContain('Fictional Private Peer');
    } finally { connection.mockRestore(); transactions.mockRestore(); }
  });
  it('joins only an explicitly read-only actual carrier and refuses write-mode or cross-principal joins', async () => {
    const { ctx } = await fixture(); let consumed = 0;
    await expect(withTenant(ctx, tx => withAssistantReadTx(ctx, tx, async () => { consumed++; }))).rejects.toThrow('data access');
    expect(consumed).toBe(0);
    await withTenant(ctx, async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      expect(await withAssistantReadTx(ctx, tx, session => session.myEmployments())).toHaveLength(1);
      await expect(withAssistantReadTx({ ...ctx, userId: randomUUID() }, tx, async () => { consumed++; })).rejects.toThrow('data access');
    });
    expect(consumed).toBe(0);
  });
  it('exposes no query handle and rejects forged, cross-principal and escaped method sessions', async () => {
    const { ctx } = await fixture();
    let saved: AssistantReadSession | undefined, invoked = 0;
    await withAssistantRead(ctx, 'employees', async session => {
      saved = session;
      expect(Object.isFrozen(session)).toBe(true);
      for (const key of ['tx', 'query', 'execute', 'insert', 'update', 'delete', 'session', 'apiKey']) expect(session).not.toHaveProperty(key);
      expect((await session.myEmployments()).length).toBe(1);
      await expect(withAssistantRead(ctx, 'employees', async () => { invoked++; }, { ...session })).rejects.toThrow('data access');
      await expect(withAssistantRead({ ...ctx, userId: randomUUID() }, 'employees', async () => { invoked++; }, session)).rejects.toThrow('data access');
    });
    expect(invoked).toBe(0);
    await expect(saved!.myEmployments()).rejects.toThrow('data access');
    await expect(withAssistantRead(ctx, 'employees', async () => { invoked++; }, saved)).rejects.toThrow('data access');
    expect(invoked).toBe(0);
  });
  it('enforces database read-only even if a canonical reader accidentally attempts a normally permitted write', async () => {
    const { a, mine } = await fixture();
    const rollback = new Error('controlled fictional write rollback');
    // Positive capability leg: an admin can write this row outside the read owner, then rolls back.
    await expect(withTenant(a, async tx => {
      const changed = await tx.update(schema.person).set({ fullName: 'Transient capability proof' }).where(eq(schema.person.id, mine.personId)).returning({ id: schema.person.id });
      expect(changed).toHaveLength(1); throw rollback;
    })).rejects.toBe(rollback);
    const original = canonical.employeeDetail;
    const write = vi.spyOn(canonical, 'employeeDetail').mockImplementationOnce(async (...args) => {
      await args[3]!.update(schema.person).set({ fullName: 'MUST NOT PERSIST' }).where(eq(schema.person.id, mine.personId));
      return original(...args);
    });
    try { await expect(profile.run(a, { employment_id: mine.employmentId })).rejects.toThrow('data access'); }
    finally { write.mockRestore(); }
    const [person] = await owner.db.select({ name: schema.person.fullName }).from(schema.person).where(eq(schema.person.id, mine.personId));
    expect(person.name).toBe('Fictional Read Owner');
  });
  it('captures the caller before a real Access wait, preventing retained-context retargeting', async () => {
    const { a, ctx, mine, other } = await fixture();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; }), held = new Promise<void>(resolve => { release = resolve; });
    const watchdog = setTimeout(release, 10_000);
    const holder = withTenant(a, async tx => { await lockAccessConfigurationTx(tx, base.tenantId); ready(); await held; });
    void holder.catch(failed);
    let reading: Promise<Awaited<ReturnType<typeof canonical.myEmployments>>> | undefined;
    try {
      await started;
      reading = withAssistantRead(ctx, 'employees', session => session.myEmployments());
      void reading.catch(() => {});
      await observeWaiting();
      ctx.personId = other.personId; ctx.roles!.push('super_admin'); ctx.grants!.push({ role: 'super_admin', companyId: null });
    } finally { release(); clearTimeout(watchdog); await holder; }
    expect((await reading!).map(row => row.employmentId)).toEqual([mine.employmentId]);
  });
  it('holds real grant writers until the read ends, then refuses new reads after revocation', async () => {
    const { a, ctx } = await fixture();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; }), held = new Promise<void>(resolve => { release = resolve; });
    const watchdog = setTimeout(release, 10_000);
    const reading = withAssistantRead(ctx, 'employees', async session => { await session.myEmployments(); ready(); await held; });
    void reading.catch(failed);
    let writing: Promise<unknown> | undefined;
    try {
      await started; writing = revokeAssistant(a, { appUserId: ctx.userId! }); void writing.catch(() => {});
      await observeWaiting();
    } finally { release(); clearTimeout(watchdog); await reading; if (writing) await writing; }
    await expect(withAssistantRead(ctx, 'employees', session => session.myEmployments())).rejects.toThrow('data access');
    await grantAssistant(a, { appUserId: ctx.userId! });
    expect(await withAssistantRead(ctx, 'employees', session => session.myEmployments())).toHaveLength(1);
  });
  it('rechecks feature pause without a provider admission or data effects', async () => {
    const { a, ctx } = await fixture();
    // Shared AI features are changed only by a group-wide administrator (setAiFeature refuses others first).
    const group: SessionContext = { ...a, grants: [{ role: 'hr_admin', companyId: null }] };
    await setAiFeature(group, 'hr_assistant', false);
    await expect(withAssistantRead(ctx, 'employees', session => session.myEmployments())).rejects.toThrow('paused');
    expect(await owner.db.select().from(schema.aiModelRun)).toEqual([]);
    await setAiFeature(group, 'hr_assistant', true);
    expect(await withAssistantRead(ctx, 'employees', session => session.myEmployments())).toHaveLength(1);
  });
});
