/** Authored UNRUN; requires coordinated custody/feedback migrations. Raw fictional storage fixtures
 * test erasure and bounds only, never canonical preparation, consent or submitted-leave provenance.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { lockAccessConfigurationTx } from '../core/access-configuration-lock';
import { retireExpiredAiCustodyTx } from '../core/ai-retention-maintenance';
import { runAiRetentionTick } from '../scripts/ai-retention-runner';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base, employee: { employmentId: string; personId: string };
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  employee = await hireEmployee(adminCtx(base), { person: { fullName: 'Fictional Retention Subject',
    primaryEmail: `${randomUUID()}@example.test` }, companyId: base.companyId, departmentId: base.deptA,
    employmentType: 'full_time', hiredOn: '2020-01-01' });
});
afterAll(closeAll);
async function review(expired: boolean) {
  const id = randomUUID(), created = new Date(Date.now() - 600_000), expires = new Date(Date.now() + (expired ? -1000 : 600_000));
  await owner.db.execute(sql`with inserted as (
    insert into app.assistant_own_leave_review(id,tenant_id,user_id,person_id,employment_id,company_id,
      intent_digest,reviewed_digest,state,created_at,expires_at)
    values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${employee.personId}::uuid,
      ${employee.employmentId}::uuid,${base.companyId}::uuid,${'a'.repeat(64)},${'b'.repeat(64)},
      'awaiting_confirmation',${created.toISOString()}::timestamptz,${expires.toISOString()}::timestamptz) returning id
  ) insert into app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext)
    select id,'0123456789abcdef','fictional-wrapped-bytes','fictional-encrypted-bytes' from inserted`);
  return id;
}
async function feedback(expired: boolean) {
  const id = randomUUID(), exchange = randomUUID();
  await owner.db.execute(sql`insert into public.assistant_exchange(id,tenant_id,app_user_id,question)
    values(${exchange}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,'Fictional consent fixture')`);
  await owner.db.execute(sql`insert into public.ai_agent_feedback(id,tenant_id,user_id,exchange_id,outcome,consented,created_at,expires_at)
    values(${id}::uuid,${base.tenantId}::uuid,${base.adminUserId}::uuid,${exchange}::uuid,'incorrect',true,
      now()-interval '29 days',${new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString()}::timestamptz)`);
  return id;
}
const state = async () => ({
  reviews: await owner.db.execute(sql`select r.*,c.ciphertext from app.assistant_own_leave_review r
    left join app.assistant_own_leave_review_content c on c.action_id=r.id order by r.id`),
  feedback: await owner.db.execute(sql`select * from public.ai_agent_feedback order by id`),
  requests: await owner.db.select().from(schema.leaveRequest).orderBy(schema.leaveRequest.id),
  ledger: await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id),
  events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId)).orderBy(schema.domainEvent.id),
});
describe('out-of-band expired AI custody maintenance', () => {
  it('retires expired private bytes and opinions only, leaves active custody and HR facts unchanged, then is idempotent', async () => {
    const expired = await review(true), active = await review(false), expiredFeedback = await feedback(true), activeFeedback = await feedback(false);
    const before = await state(), result = await runAiRetentionTick(owner);
    expect(result).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 1,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0, backlog: false, oldestExpiredAgeSeconds: null });
    for (const id of [expired, active, expiredFeedback, activeFeedback, base.tenantId]) expect(JSON.stringify(result)).not.toContain(id);
    const after = await state();
    expect(after.reviews.find(row => row.id === expired)).toMatchObject({ state: 'expired', intent_digest: null, reviewed_digest: null, ciphertext: null });
    expect(after.reviews.find(row => row.id === active)).toEqual(before.reviews.find(row => row.id === active));
    expect(after.feedback.some(row => row.id === expiredFeedback)).toBe(false);
    expect(after.feedback.find(row => row.id === activeFeedback)).toEqual(before.feedback.find(row => row.id === activeFeedback));
    expect(after.requests).toEqual(before.requests); expect(after.ledger).toEqual(before.ledger); expect(after.events).toEqual(before.events);
    expect(await runAiRetentionTick(owner)).toEqual({ tenants: 0, busy: 0, reviews: 0, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0, backlog: false, oldestExpiredAgeSeconds: null });
  });
  it('rejects an app-role carrier despite administrator claims, without any mutation', async () => {
    await review(true); await feedback(true); const before = await state();
    await expect(withTenant(adminCtx(base), tx => retireExpiredAiCustodyTx(tx))).rejects.toThrow('AI retention maintenance could not be confirmed');
    expect(await state()).toEqual(before);
  });
  it('rolls all retirement back if the owning transaction fails', async () => {
    await review(true); await feedback(true); const before = await state();
    await expect(owner.db.transaction(async tx => { await retireExpiredAiCustodyTx(tx as unknown as Tx); throw Error('owned retention rollback'); })).rejects.toThrow('owned retention rollback');
    expect(await state()).toEqual(before);
  });
  it('retains stricter caller statement and lock timeouts', async () => {
    await owner.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='4000ms'`);
      await tx.execute(sql`set local lock_timeout='400ms'`);
      expect(await retireExpiredAiCustodyTx(tx as unknown as Tx)).toEqual({ tenants: 0, busy: 0, reviews: 0, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0 });
      const rows = await tx.execute<{ name: string; setting: string }>(sql`select name,setting from pg_settings
        where name in ('statement_timeout','lock_timeout') order by name`);
      expect(rows).toEqual([{ name: 'lock_timeout', setting: '400' }, { name: 'statement_timeout', setting: '4000' }]);
    });
  });
  it('skips a genuinely busy Access interval without changes and retires after release', async () => {
    await review(true); await feedback(true); const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(Error('owned retention handshake timed out')); release(); }, 10_000);
    const holder = withTenant(adminCtx(base), async tx => { await lockAccessConfigurationTx(tx, base.tenantId); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; const result = await runAiRetentionTick(owner);
      expect(result).toMatchObject({ tenants: 1, busy: 1, reviews: 0, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0, backlog: true });
      expect(result.oldestExpiredAgeSeconds).toBeGreaterThanOrEqual(1); expect(await state()).toEqual(before);
    }
    finally { release(); clearTimeout(watchdog); await holder; }
    expect(await runAiRetentionTick(owner)).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 1,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0, backlog: false, oldestExpiredAgeSeconds: null });
  });
  it('reports real remaining expired custody after the100-row bound, then clears it in a separate pass', async () => {
    const ids: string[] = [];
    for (let index=0; index<101; index++) ids.push(await review(true));
    const first = await runAiRetentionTick(owner);
    expect(first).toMatchObject({ tenants: 1, busy: 0, reviews: 100, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0, backlog: true });
    expect(first.oldestExpiredAgeSeconds).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(first)).not.toContain(base.tenantId);
    for (const id of ids) expect(JSON.stringify(first)).not.toContain(id);
    expect(await runAiRetentionTick(owner)).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 0,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0, backlog: false, oldestExpiredAgeSeconds: null });
    const after=await state();expect(after.reviews).toHaveLength(101);
    expect(after.reviews.every(row=>row.state==='expired'&&row.ciphertext===null&&row.intent_digest===null&&row.reviewed_digest===null)).toBe(true);
  });
  it('supports a real nonsuperuser table-owner identity under FORCE RLS, without seeing nonexpired opinions', async () => {
    await review(true); await feedback(true); await feedback(false);
    const name = 'ai_retention_fixture_' + randomUUID().replaceAll('-', ''), role = sql.identifier(name);
    // Every role/ownership change is inside this deliberately rolled-back, isolated fixture Tx.
    await expect(owner.db.transaction(async tx => {
      await tx.execute(sql`create role ${role} nologin nosuperuser nobypassrls`);
      await tx.execute(sql`grant usage on schema app,public to ${role}`);
      await tx.execute(sql`grant execute on function app.current_tenant_id(),app.is_group_admin(),app.principal_snapshot_current() to ${role}`);
      await tx.execute(sql`alter table app.assistant_own_leave_review owner to ${role}`);
      await tx.execute(sql`alter table app.assistant_own_leave_review_content owner to ${role}`);
      await tx.execute(sql`alter table public.ai_agent_feedback owner to ${role}`);
      for(const table of ['ai_agent_plan_proposal','ai_agent_job_feedback','ai_agent_candidate_provenance','ai_agent_job_receipt','personnel_import_assistance_attempt'])await tx.execute(sql`alter table public.${sql.identifier(table)} owner to ${role}`);
      await tx.execute(sql`set local session authorization ${role}`);
      const [identity] = await tx.execute<{ current_role_name: string; session_role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(sql`
        select current_user as current_role_name,session_user as session_role_name,r.rolsuper,r.rolbypassrls
        from pg_roles r where r.rolname=current_user`);
      expect(identity).toEqual({ current_role_name: name, session_role_name: name, rolsuper: false, rolbypassrls: false });
      const [expired] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from public.ai_agent_feedback where expires_at<=now()`);
      expect(expired.count).toBe(1);
      await tx.execute(sql`savepoint feedback_update_refusal`);
      await expect(tx.execute(sql`update public.ai_agent_feedback set outcome='helpful' where expires_at<=now()`)).rejects.toThrow();
      await tx.execute(sql`rollback to savepoint feedback_update_refusal`);
      expect(await retireExpiredAiCustodyTx(tx as unknown as Tx)).toEqual({ tenants: 1, busy: 0, reviews: 1, feedback: 1,jobs:0,jobFeedback:0,candidateProvenance:0,plans:0,importAssistance:0 });
      const [hidden] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from public.ai_agent_feedback where expires_at>now()`);
      expect(hidden.count).toBe(0);
      throw Error('owned role fixture rollback');
    })).rejects.toThrow('owned role fixture rollback');
    const [left] = await owner.db.execute<{ count: number }>(sql`select count(*)::int as count from pg_roles where rolname=${name}`);
    expect(left.count).toBe(0);
  });
});
