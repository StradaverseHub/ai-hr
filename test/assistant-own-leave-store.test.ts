import {setAgentActionPause} from '../core/ai-inventory';
import * as dbClient from '../db/client';
import * as vault from '../lib/pii/vault';
import {ownLeaveReviewedDigest} from '../core/assistant-actions/own-leave-review-digest';
import {assertAiActionUnpausedTx} from '../core/ai-governance';
/** Source-only acceptance: both SQL drafts must be journalled in a coordinated later window.
 * These cases are authored, NOT executed, while Board 3 owns the shared runtime. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { appendEvent } from '../db/events';
import {updateLeaveType} from '../core/admin';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { setAiAllowance } from '../core/ai-management';
import { prepareOwnLeaveReviewTx, reopenOwnLeaveReviewTx, discardOwnLeaveReviewTx, expireOwnLeaveReviewsTx, expireOwnLeaveReviewsForCallerTx, runOwnLeaveReviewRetention, confirmOwnLeaveReview } from '../core/assistant-actions/own-leave-store';
import { OwnLeaveContentUnavailable } from '../core/assistant-actions/own-leave-content';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { readOwnLeaveCandidateTx } from '../core/assistant-actions/own-leave-candidate';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { erasePersonPii } from '../core/pdpa';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let ctx: SessionContext;
let subject: { employmentId: string; personId: string };
let nomination: { action: 'leave.apply'; contractVersion: 1; employmentId: string; leaveTypeId: string; date: string; durationType: 'full_day' };
const text = { reason: 'Fictional custody-only private reason', employeeRemark: 'Fictional custody-only private remark' };
beforeAll(migrateTestDb);
afterAll(closeAll);
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv('AI_CONFIG_SECRET', 'fictional-review-storage-master-passphrase-12345');
  await resetDb(); base = await seedBase();
  await setModule(base.tenantId, 'assistant', 'active');
  subject = await hireEmployee(adminCtx(base), { person: { fullName: 'Fictional Review Applicant',
    primaryEmail: randomUUID() + '@example.test' }, companyId: base.companyId, departmentId: base.deptA,
    employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
  const userId = await createAppUser(base.tenantId, subject.personId, 'employee');
  await grantAssistant(adminCtx(base), { appUserId: userId });
  ctx = { ...await entitledCtx(base, ['employee']), userId, personId: subject.personId,
    grants: [{ role: 'employee', companyId: null }] };
  await credit(subject.employmentId);
  const next = new Date(todayInKualaLumpur() + 'T00:00:00Z');
  do { next.setUTCDate(next.getUTCDate() + 1); } while ([0, 6].includes(next.getUTCDay()));
  nomination = { action: 'leave.apply', contractVersion: 1, employmentId: subject.employmentId,
    leaveTypeId: base.annualLeaveTypeId, date: next.toISOString().slice(0, 10), durationType: 'full_day' };
});

/** seedBase inserts this exact group-wide role. Supply its explicit scope carrier and prove the
 * real SQL principal before changing user allowances; an admin label alone is deliberately too weak. */
async function groupCtx(): Promise<SessionContext> {
  const actor: SessionContext = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
  const [proof] = await withTenant(actor, tx => tx.execute<{ allowed: boolean }>(sql`select
    app.is_group_admin() and app.principal_snapshot_current() as allowed`));
  expect(proof?.allowed).toBe(true);
  return actor;
}

async function credit(employmentId: string) {
  await owner.db.insert(schema.leaveLedger).values({ tenantId: base.tenantId, employmentId,
    leaveTypeId: base.annualLeaveTypeId, entryType: 'accrual', days: '10', effectiveOn: todayInKualaLumpur() });
}
async function prepare(actor = ctx, employmentId = subject.employmentId) {
  const result = await withTenant(actor, tx => prepareOwnLeaveReviewTx(tx, actor, { ...nomination, employmentId },
    { employmentId, leaveTypeId: base.annualLeaveTypeId }, text, 'en'));
  if (result.kind !== 'prepared') throw new Error('Fictional fixture did not prepare a review: ' + result.kind);
  return result.review;
}
const confirmation = (r: Awaited<ReturnType<typeof prepare>>) => ({ actionId: r.actionId,
  contractVersion: r.contractVersion, reviewedDigest: r.reviewedDigest });
async function counts() {
  const [row] = await owner.db.execute<{ requests: number; model_runs: number; bodies: number; pending: number }>(sql`select
    (select count(*)::int from leave_request where tenant_id=${base.tenantId}::uuid) as requests,
    (select count(*)::int from ai_model_run where tenant_id=${base.tenantId}::uuid) as model_runs,
    (select count(*)::int from app.assistant_own_leave_review_content c join app.assistant_own_leave_review r on r.id=c.action_id where r.tenant_id=${base.tenantId}::uuid) as bodies,
    (select count(*)::int from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid and state='awaiting_confirmation') as pending`);
  return row;
}

describe('pending own-leave review custody', () => {
  it.each(['configuration','employment'] as const)('refuses initial preparation while the actual %s interval is held, returns no private card or custody, then prepares after release',async interval=>{
    const before=await counts();let entered!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;const ready=new Promise<void>((yes,no)=>{entered=yes;failed=no;}),done=new Promise<void>(yes=>{release=yes;});const watchdog=setTimeout(()=>{failed(Error('owned ownleave handshake timed out'));release();},10_000);
    const key=interval==='configuration'?'leave-dependency-configuration:'+base.tenantId:'leave-dependency-employment:'+base.tenantId+':'+subject.employmentId;
    // Hold only the exact tested leave interval, never Access, so a different earlier guard cannot
    // masquerade as configuration/subject protection of initial card disclosure.
    const holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);entered();await done;});void holder.catch(failed);
    try{await ready;await expect(prepare()).rejects.toThrow();expect(await counts()).toEqual(before);}
    finally{release();clearTimeout(watchdog);await holder;}
    const review=await prepare();expect(review.availableBalance).toBe(10);expect(review.humanText).toEqual(text);expect(await counts()).toEqual({...before,bodies:1,pending:1});
  });

  it.each(['confirm','reopen','discard','expireOwn','expireAdmin'] as const)('bounds actual held review-row %s custody before SQL/effect, rolls back, then completes the intended operation after release',async operation=>{
    const review=await prepare();
    if(operation==='expireOwn'||operation==='expireAdmin')await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' where id=${review.actionId}::uuid`);
    const invoke=()=>operation==='confirm'?confirmOwnLeaveReview(ctx,confirmation(review),'en'):
      operation==='reopen'?withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId,'en')):
      operation==='discard'?withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review))):
      operation==='expireOwn'?withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx)):
      withTenant(adminCtx(base),tx=>expireOwnLeaveReviewsTx(tx));
    const before=await counts(),ledger=await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id),events=await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id);
    let entered!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;const ready=new Promise<void>((yes,no)=>{entered=yes;failed=no;}),done=new Promise<void>(yes=>{release=yes;});const watchdog=setTimeout(()=>{failed(Error('owned ownleave handshake timed out'));release();},10_000);
    // A real physical row holder intentionally has no advisory/Access ownership.
    const holder=owner.db.transaction(async tx=>{const rows=await tx.execute(sql`select id from app.assistant_own_leave_review where id=${review.actionId}::uuid for update`);expect(rows).toHaveLength(1);entered();await done;});void holder.catch(failed);
    try{await ready;const started=Date.now();await expect(invoke()).rejects.toThrow();expect(Date.now()-started).toBeLessThan(4500);expect(await counts()).toEqual(before);expect(await owner.db.select().from(schema.leaveLedger).orderBy(schema.leaveLedger.id)).toEqual(ledger);expect(await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id)).toEqual(events);}
    finally{release();clearTimeout(watchdog);await holder;}
    const result=await invoke();
    if(operation==='confirm'||operation==='reopen'){
      if(operation==='reopen')expect(result).toEqual({kind:'prepared',review});
      const completed=operation==='confirm'?result:await confirmOwnLeaveReview(ctx,confirmation(review),'en');expect(completed).toMatchObject({kind:'completed',receipt:{state:'completed',actionId:review.actionId}});
      expect(await confirmOwnLeaveReview(ctx,confirmation(review),'en')).toEqual(completed);expect(await counts()).toMatchObject({requests:1,bodies:0,pending:0,model_runs:0});
    }else if(operation==='discard'){
      expect(result).toMatchObject({kind:'retired',receipt:{state:'discarded',actionId:review.actionId}});expect(await invoke()).toEqual(result);expect(await counts()).toMatchObject({requests:0,bodies:0,pending:0,model_runs:0});
    }else{expect(result).toBe(1);expect(await invoke()).toBe(0);expect(await counts()).toMatchObject({requests:0,bodies:0,pending:0,model_runs:0});}
  });

  it('saves and reopens the exact human review without a request, model run or plaintext telemetry', async () => {
    const before = await counts(), review = await prepare();
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
    expect(review.humanText).toEqual(text);
    expect(await counts()).toEqual({ ...before, bodies: before.bodies + 1, pending: before.pending + 1 });
    const [stored] = await owner.db.execute<{ metadata: unknown; ciphertext: string; wrapped_dek: string }>(sql`select
      to_jsonb(r) as metadata,c.ciphertext,c.wrapped_dek from app.assistant_own_leave_review r
      join app.assistant_own_leave_review_content c on c.action_id=r.id where r.id=${review.actionId}::uuid`);
    expect(JSON.stringify(stored)).not.toContain(text.reason);
    expect(JSON.stringify(stored)).not.toContain(text.employeeRemark);
    expect(stored.wrapped_dek).toBeTruthy();
    const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, base.tenantId))
      .orderBy(schema.domainEvent.sequence);
    expect(JSON.stringify(events)).not.toContain(text.reason);
    expect(JSON.stringify(events)).not.toContain(text.employeeRemark);
  });

  it('keeps hidden freshness balances and custody/identity fields out of the public card', async () => {
    await owner.db.update(schema.leaveType).set({ essViewConfig: { available: false } })
      .where(eq(schema.leaveType.id, base.annualLeaveTypeId));
    const review = await prepare();
    expect(review).toMatchObject({ availableBalance: null, estimatedAvailableAfter: null });
    for (const key of ['binding', 'privateAvailableBalance', 'sealed', 'wrappedDek', 'ciphertext', 'tenantId', 'personId', 'userId'])
      expect(review).not.toHaveProperty(key);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
  });

  it('retires the same review idempotently and deletes its body and wrapped action key', async () => {
    const review = await prepare();
    const discard = () => withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review)));
    const retired = { kind: 'retired', receipt: { actionId: review.actionId, contractVersion: 1, state: 'discarded' } };
    expect(await discard()).toEqual(retired);
    expect(await discard()).toEqual(retired);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).toEqual(retired);
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
  });

  it('reconciles simultaneous discard deliveries to the same retired reference', async () => {
    const review = await prepare();
    const retire = () => withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review)));
    const results = await Promise.all([retire(), retire()]);
    const expected = { kind: 'retired', receipt: { actionId: review.actionId, contractVersion: 1, state: 'discarded' } };
    expect(results).toEqual([expected, expected]);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).toEqual(expected);
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
  });

  it('allows only retirement after a pause or removed Assistant grant, never another private read', async () => {
    const review = await prepare();
    await setAiAllowance(await groupCtx(), { kind: 'user', subjectId: ctx.userId!, enabled: false,
      dailyRequests: null, monthlyTokens: null });
    await revokeAssistant(adminCtx(base), { appUserId: ctx.userId! });
    await expect(withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).rejects.toThrow();
    expect(await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review))))
      .toMatchObject({ kind: 'retired', receipt: { state: 'discarded' } });
    expect(await counts()).toMatchObject({ bodies: 0, requests: 0, model_runs: 0 });
  });

  it('does not count deterministic prepare/reopen/discard against exhausted model quotas', async () => {
    await setAiAllowance(await groupCtx(), { kind: 'user', subjectId: ctx.userId!, enabled: true,
      dailyRequests: 0, monthlyTokens: 0 });
    const review = await prepare();
    await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId));
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review)));
    expect(await counts()).toMatchObject({ model_runs: 0, requests: 0 });
  });

  it('bounds pending reviews per login and frees pending capacity only when a review retires', async () => {
    const reviews: Awaited<ReturnType<typeof prepare>>[] = [];
    for (let index = 0; index < 5; index++) reviews.push(await prepare());
    const before = await counts();
    expect(before).toMatchObject({ bodies: 5, pending: 5, model_runs: 0, requests: 0 });
    await expect(prepare()).rejects.toThrow(OwnLeaveContentUnavailable);
    expect(await counts()).toEqual(before);
    // Other logins have their own custody and budget, even when linked to the same person.
    const secondId = await createAppUser(base.tenantId, subject.personId, 'employee');
    await grantAssistant(adminCtx(base), { appUserId: secondId });
    await prepare({ ...ctx, userId: secondId });
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(reviews[0])));
    await prepare();
    expect(await counts()).toMatchObject({ bodies: 6, pending: 6, model_runs: 0, requests: 0 });
  });

  it('shares pending capacity across competing preparations rather than admitting each from an old count', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => prepare()));
    const prepared = attempts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const refused = attempts.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    expect(prepared).toHaveLength(5);
    expect(new Set(prepared.map(review => review.actionId)).size).toBe(5);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(OwnLeaveContentUnavailable);
    expect(await counts()).toMatchObject({ bodies: 5, pending: 5, model_runs: 0, requests: 0 });
    for (const review of prepared) expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
  });

  it('does not let retirement bypass the rolling preparation budget or count old reviews forever', async () => {
    const review = await prepare();
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review)));
    // Historical, already retired fixtures exhaust only the creation budget. No ciphertext or
    // pending row exists, so a refusal cannot accidentally pin only the outstanding-review cap.
    await owner.db.execute(sql`insert into app.assistant_own_leave_review
      (id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
      select gen_random_uuid(),tenant_id,user_id,person_id,employment_id,company_id,NULL,
       NULL,'discarded',created_at,expires_at
      from app.assistant_own_leave_review cross join generate_series(1,19)
      where id=${review.actionId}::uuid`);
    const before = await counts();
    expect(before).toMatchObject({ bodies: 0, pending: 0 });
    await expect(prepare()).rejects.toThrow(OwnLeaveContentUnavailable);
    expect(await counts()).toEqual(before);
    await owner.db.execute(sql`update app.assistant_own_leave_review
      set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute'
      where tenant_id=${base.tenantId}::uuid and user_id=${ctx.userId}::uuid`);
    await prepare();
    expect(await counts()).toMatchObject({ bodies: 1, pending: 1, model_runs: 0, requests: 0 });
  });

  it('refuses another login and foreign tenants while allowing the owner privacy retirement without a matching digest', async () => {
    const review = await prepare();
    const secondId = await createAppUser(base.tenantId, subject.personId, 'employee');
    await grantAssistant(adminCtx(base), { appUserId: secondId });
    const second = { ...ctx, userId: secondId };
    // This second login can prepare its own review: refusal of the first is not an unrelated grant gate.
    expect((await prepare(second)).actionId).not.toBe(review.actionId);
    await expect(withTenant(second, tx => reopenOwnLeaveReviewTx(tx, second, review.actionId)))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    await expect(withTenant(second, tx => discardOwnLeaveReviewTx(tx, second, confirmation(review))))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    const foreign = await seedBase();
    await expect(withTenant(adminCtx(foreign), tx => discardOwnLeaveReviewTx(tx, adminCtx(foreign), confirmation(review))))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
    const before = await counts();
    // Retirement destroys private pending content; it cannot submit or confirm the review.
    // The exact login remains authoritative, while a legacy digest is deliberately unnecessary.
    expect(await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, { ...confirmation(review), reviewedDigest: 'a'.repeat(64) })))
      .toMatchObject({ kind: 'retired', receipt: { actionId: review.actionId, state: 'discarded' } });
    expect(await counts()).toEqual({ ...before, bodies: before.bodies - 1, pending: before.pending - 1 });
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toMatchObject({ kind: 'retired', receipt: { actionId: review.actionId, state: 'discarded' } });
  });

  it('refuses direct app-role reads/writes to private custody and private metadata helpers', async () => {
    const review = await prepare();
    for (const query of [sql`select * from app.assistant_own_leave_review_content`,
      sql`select * from app.assistant_own_leave_review`,
      sql`update app.assistant_own_leave_review set state='discarded' where id=${review.actionId}::uuid`,
      sql`select app._assistant_own_leave_review_json(${review.actionId}::uuid)`])
      await expect(withTenant(ctx, tx => tx.execute(query))).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await counts()).toMatchObject({ bodies: 1, pending: 1 });
  });

  it('expires a saved review before reopening and removes its private key/body', async () => {
    const review = await prepare();
    await owner.db.execute(sql`update app.assistant_own_leave_review
      set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute'
      where id=${review.actionId}::uuid`);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toMatchObject({ kind: 'retired', receipt: { state: 'expired' } });
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0 });
  });

  it('bounds group-admin cleanup, refuses an employee and preserves all nonexpired reviews', async () => {
    await prepare(); await prepare(); const fresh = await prepare();
    await owner.db.execute(sql`update app.assistant_own_leave_review
      set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute'
      where tenant_id=${base.tenantId}::uuid and id<>${fresh.actionId}::uuid`);
    await expect(withTenant(ctx, tx => expireOwnLeaveReviewsTx(tx, 1))).rejects.toThrow();
    expect(await withTenant(adminCtx(base), tx => expireOwnLeaveReviewsTx(tx, 1))).toBe(1);
    expect(await counts()).toMatchObject({ bodies: 2, pending: 2 });
    expect(await withTenant(adminCtx(base), tx => expireOwnLeaveReviewsTx(tx, 100))).toBe(1);
    expect(await counts()).toMatchObject({ bodies: 1, pending: 1 });
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, fresh.actionId)))
      .toEqual({ kind: 'prepared', review: fresh });
  });

  it('retires only the actual login expired reviews after Assistant revocation, preserving foreign and fresh bodies', async () => {
    const mine = await prepare(), fresh = await prepare();
    const other = await hireEmployee(adminCtx(base), { person: { fullName: 'Fictional Other Review Owner', primaryEmail: randomUUID()+'@fixture.test' },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    const uid = await createAppUser(base.tenantId, other.personId, 'employee');
    await grantAssistant(adminCtx(base), { appUserId: uid }); await credit(other.employmentId);
    const otherCtx: SessionContext = { ...await entitledCtx(base,['employee']), userId: uid, personId: other.personId,
      grants: [{ role: 'employee', companyId: null }] };
    const foreign = await prepare(otherCtx, other.employmentId);
    await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute'
      where id in (${mine.actionId}::uuid,${foreign.actionId}::uuid)`);
    await revokeAssistant(adminCtx(base), { appUserId: ctx.userId! });
    vi.stubEnv('AI_CONFIG_SECRET',''); // Retirement requires no private decryption or model capability.
    expect(await withTenant(ctx, tx=>expireOwnLeaveReviewsForCallerTx(tx,1))).toBe(1);
    expect(await counts()).toMatchObject({bodies:2,pending:2,requests:0,model_runs:0});
    const states=await owner.db.execute<{id:string;state:string}>(sql`select id,state from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid`);
    expect(states.find(row=>row.id===mine.actionId)?.state).toBe('expired');
    expect(states.find(row=>row.id===foreign.actionId)?.state).toBe('awaiting_confirmation');
    expect(states.find(row=>row.id===fresh.actionId)?.state).toBe('awaiting_confirmation');
    expect(await withTenant(adminCtx(base),tx=>expireOwnLeaveReviewsForCallerTx(tx,100))).toBe(0); // Own-only even for HR.
  });

  it('keeps own cleanup bounded and atomic with the supplied transaction', async () => {
    const review=await prepare();
    await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${review.actionId}::uuid`);
    const before=await counts(), failure=Error('controlled cleanup rollback');
    await expect(withTenant(ctx,async tx=>{expect(await expireOwnLeaveReviewsForCallerTx(tx,1)).toBe(1);throw failure;})).rejects.toBe(failure);
    expect(await counts()).toEqual(before);
    for(const limit of [0,1001,1.5,NaN])await expect(withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx,limit))).rejects.toThrow('private review unavailable');
    expect(await counts()).toEqual(before);
    expect(await withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx,1))).toBe(1);
    expect(await counts()).toMatchObject({bodies:0,pending:0,requests:0,model_runs:0});
  });

  it('refuses stale/archived cleanup principals before touching their expired content', async () => {
    const review=await prepare();
    await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${review.actionId}::uuid`);
    const before=await counts();
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,ctx.userId!));
    await expect(withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx,1))).rejects.toThrow('private review unavailable');
    expect(await counts()).toEqual(before);
    await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,ctx.userId!));
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,ctx.userId!));
    await expect(withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx,1))).rejects.toThrow('private review unavailable');
    expect(await counts()).toEqual(before);
    expect(await runOwnLeaveReviewRetention(adminCtx(base),1)).toEqual({expired:1,limit:1,mayHaveMore:true});
  });

  it('retires text-derived digests on discard/expiry/completion and never re-executes terminal retries', async () => {
    const discarded=await prepare(), done=await prepare(), expired=await prepare(), pending=await prepare();
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(discarded)));
    await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${expired.actionId}::uuid`);
    await withTenant(ctx,tx=>expireOwnLeaveReviewsForCallerTx(tx));
    const result=await confirmOwnLeaveReview(ctx,confirmation(done),'en');expect(result.kind).toBe('completed');
    const rows=await owner.db.execute<{intent_digest:string|null;reviewed_digest:string|null}>(sql`select intent_digest,reviewed_digest from app.assistant_own_leave_review`);
    expect(rows).toHaveLength(4);expect(rows.filter(row=>row.intent_digest===null)).toHaveLength(3);for(const row of rows.filter(row=>row.intent_digest===null))expect(row).toEqual({intent_digest:null,reviewed_digest:null});
    const stale={...confirmation(done),reviewedDigest:'f'.repeat(64)};
    expect(await confirmOwnLeaveReview(ctx,stale,'en')).toEqual(result); // Current canonical receipt only.
    expect((await confirmOwnLeaveReview(ctx,{...stale,actionId:discarded.actionId},'en')).kind).toBe('retired');
    await expect(confirmOwnLeaveReview(ctx,{...stale,actionId:pending.actionId},'en')).rejects.toThrow('private review unavailable');
    expect(await counts()).toMatchObject({requests:1,pending:1,bodies:1,model_runs:0});
  });

  it('reports bounded administrative progress honestly and leaves completed canonical receipts intact', async () => {
    const completedReview=await prepare(), old=await prepare();
    const completedResult=await confirmOwnLeaveReview(ctx,confirmation(completedReview),'en');
    expect(completedResult.kind).toBe('completed');
    await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=${old.actionId}::uuid`);
    await expect(runOwnLeaveReviewRetention(ctx,1)).rejects.toThrow('private review unavailable');
    expect(await runOwnLeaveReviewRetention(adminCtx(base),1)).toEqual({expired:1,limit:1,mayHaveMore:true});
    expect(await runOwnLeaveReviewRetention(adminCtx(base),1)).toEqual({expired:0,limit:1,mayHaveMore:false});
    expect(await withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,completedReview.actionId))).toEqual(completedResult);
    expect(await counts()).toMatchObject({requests:1,bodies:0,pending:0,model_runs:0});
  });

  it('rolls back preparation when the enclosing caller transaction fails', async () => {
    const before = await counts();
    await expect(withTenant(ctx, async tx => {
      const prepared = await prepareOwnLeaveReviewTx(tx, ctx, nomination,
        { employmentId: subject.employmentId, leaveTypeId: base.annualLeaveTypeId }, text);
      expect(prepared.kind).toBe('prepared');
      throw new Error('Fictional enclosing transaction abort');
    })).rejects.toThrow('Fictional enclosing transaction abort');
    expect(await counts()).toEqual(before);
  });

  it('joins canonical person erasure across employments and retains only unavailable terminal references', async () => {
    const a = await prepare();
    await owner.db.update(schema.person).set({ phone: 'FICTIONAL-CONTACT-TO-ERASE' })
      .where(eq(schema.person.id, subject.personId));
    const [company] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId,
      legalName: 'Fictional Second Employment Company' }).returning();
    const [department] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId,
      companyId: company.id, name: 'Fictional Second Department' }).returning();
    const other = await hireEmployee(adminCtx(base), { person: { id: subject.personId }, companyId: company.id,
      departmentId: department.id, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    await credit(other.employmentId);
    const b = await prepare(ctx, other.employmentId);
    expect(await counts()).toMatchObject({ bodies: 2 });
    const report = await erasePersonPii(adminCtx(base), { subjectEmploymentId: subject.employmentId,
      scope: 'contact', requestRef: 'FICTIONAL-REVIEW-ERASURE', reason: 'Fictional private review cleanup' });
    expect(report.erased).toContain('assistantPreparedReviews');
    expect(report.erased).toContain('phone');
    const [person] = await owner.db.select({ phone: schema.person.phone }).from(schema.person)
      .where(eq(schema.person.id, subject.personId));
    expect(person.phone).toBeNull();
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
    const digests=await owner.db.execute<{intent_digest:string|null;reviewed_digest:string|null}>(sql`select intent_digest,reviewed_digest from app.assistant_own_leave_review where person_id=${subject.personId}::uuid`);
    expect(digests).toHaveLength(2);for(const row of digests)expect(row).toEqual({intent_digest:null,reviewed_digest:null});
    for (const review of [a, b]) expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toMatchObject({ kind: 'retired', receipt: { actionId: review.actionId, state: 'refused', code: 'unavailable' } });
  });

  it('preserves exact canonical completed references through person erasure without retaining text hashes', async () => {
    const review=await prepare(), receipt=await confirmOwnLeaveReview(ctx,confirmation(review),'en');
    const before=await counts();
    await owner.db.update(schema.person).set({phone:'FICTIONAL-ERASE-COMPLETED-REVIEW'}).where(eq(schema.person.id,subject.personId));
    await erasePersonPii(adminCtx(base),{subjectEmploymentId:subject.employmentId,scope:'contact',requestRef:'FICTIONAL-COMPLETED-REVIEW-ERASURE',reason:'Fictional terminal privacy cleanup'});
    const [row]=await owner.db.execute<{intent_digest:string|null;reviewed_digest:string|null;leave_request_id:string;submission_event_id:string}>(sql`select intent_digest,reviewed_digest,leave_request_id,submission_event_id from app.assistant_own_leave_review where id=${review.actionId}::uuid`);
    expect(row.intent_digest).toBeNull();expect(row.reviewed_digest).toBeNull();
    if(receipt.kind!=='completed')throw Error('Fictional submission did not complete');
    expect(row.leave_request_id).toBe(receipt.receipt.leaveRequestId);expect(row.submission_event_id).toBe(receipt.receipt.submissionEventId);
    expect(await withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId))).toEqual(receipt);
    expect(await counts()).toEqual(before);
  });

  it('keeps ordinary contact erasure working without inventing a review-erasure effect', async () => {
    await owner.db.update(schema.person).set({ phone: 'FICTIONAL-CONTACT-WITHOUT-REVIEW' })
      .where(eq(schema.person.id, subject.personId));
    const report = await erasePersonPii(adminCtx(base), { subjectEmploymentId: subject.employmentId,
      scope: 'contact', requestRef: 'FICTIONAL-NO-REVIEW-ERASURE', reason: 'Fictional ordinary contact cleanup' });
    expect(report.erased).toContain('phone');
    expect(report.erased).not.toContain('assistantPreparedReviews');
    const [person] = await owner.db.select({ phone: schema.person.phone }).from(schema.person)
      .where(eq(schema.person.id, subject.personId));
    expect(person.phone).toBeNull();
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
  });

  it('fails closed without key custody and can still discard an existing review without decrypting it', async () => {
    const review = await prepare();
    const before = await counts();
    vi.stubEnv('AI_CONFIG_SECRET', '');
    await expect(prepare()).rejects.toThrow(OwnLeaveContentUnavailable);
    expect(await counts()).toEqual(before);
    expect(await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, ctx, confirmation(review))))
      .toMatchObject({ kind: 'retired', receipt: { state: 'discarded' } });
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
  });

  it('refuses a forged erasure audit and rolls back redaction without its canonical final audit', async () => {
    const review = await prepare();
    await expect(withTenant(adminCtx(base), tx => appendEvent(tx, { tenantId: base.tenantId,
      aggregateType: 'person', aggregateId: subject.personId, eventType: 'pii.erased',
      actor: { type: 'user', id: base.adminUserId }, subjectEmploymentId: subject.employmentId,
      payload: { scope: 'contact', requestRef: 'FORGED-FICTIONAL', reason: 'Fictional forgery',
        erasedFields: ['assistantPreparedReviews'], withheld: [] } }))).rejects.toThrow();
    await expect(withTenant(adminCtx(base), async tx => {
      await tx.execute(sql`select app.home_greeting_erasure_begin(${subject.employmentId}::uuid,
        'contact','FICTIONAL-UNFINISHED','Fictional unfinished review erasure')`);
      await tx.execute(sql`select app.assistant_own_leave_reviews_redact(${subject.employmentId}::uuid)`);
    })).rejects.toThrow();
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
    expect(await counts()).toMatchObject({ bodies: 1, pending: 1, requests: 0 });
  });
});

/** Authored receipt-custody cases; drafts remain unjournalled and these cases are UNRUN.
 * These exercise storage after the actual canonical write, not an exposed confirmation command. */
async function canonicalSubmission(tx: Tx) {
  const outcome = await readOwnLeaveCandidateTx(tx, ctx, nomination,
    { employmentId: subject.employmentId, leaveTypeId: base.annualLeaveTypeId }, text, 'en');
  if (outcome.kind !== 'candidate') throw new Error('Fictional canonical candidate unavailable');
  const c = outcome.candidate;
  const result = await requestLeave(ctx, { employmentId: subject.employmentId, leaveTypeId: base.annualLeaveTypeId,
    startDate: nomination.date, endDate: nomination.date, durationType: 'full_day', ...text }, tx,
  { employmentId: subject.employmentId, companyId: base.companyId, leaveTypeId: base.annualLeaveTypeId,
    date: nomination.date, days: c.deductionDays, availableBalance: outcome.privateAvailableBalance,
    holidayWarnings: c.holidayWarnings });
  if (!result.submittedEventId) throw new Error('Missing canonical source event');
  return { requestId: result.leaveRequestId, eventId: result.submittedEventId };
}
async function completeReference(tx: Tx, review: Awaited<ReturnType<typeof prepare>>, refs: { requestId: string; eventId: string }) {
  const [row] = await tx.execute<{ review: { metadata: { state: string }; sealed: null; receipt: {
    actionId: string; contractVersion: 1; state: 'completed'; leaveRequestId: string; submissionEventId: string } } }>(sql`select
    app.assistant_own_leave_review_complete(${review.actionId}::uuid,${review.reviewedDigest},
      ${refs.requestId}::uuid,${refs.eventId}::uuid) as review`);
  return row.review;
}
describe('own-leave canonical completion-reference custody', () => {
  it('commits exact canonical references, deletes review content and reconciles without a second request', async () => {
    const review = await prepare();
    const result = await withTenant(ctx, async tx => {
      const refs = await canonicalSubmission(tx);
      return { refs, stored: await completeReference(tx, review, refs) };
    });
    expect(result.stored).toMatchObject({ metadata: { state: 'completed' }, sealed: null,
      receipt: { actionId: review.actionId, contractVersion: 1, state: 'completed',
        leaveRequestId: result.refs.requestId, submissionEventId: result.refs.eventId } });
    expect(JSON.stringify(result.stored)).not.toContain(text.reason);
    expect(JSON.stringify(result.stored)).not.toContain(text.employeeRemark);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'completed', receipt: result.stored.receipt });
    const after = await counts();
    expect(after).toMatchObject({ requests: 1, model_runs: 0, bodies: 0, pending: 0 });
    expect(await withTenant(ctx, tx => completeReference(tx, review, result.refs))).toEqual(result.stored);
    await expect(withTenant(ctx, tx => completeReference(tx, review,
      { ...result.refs, eventId: randomUUID() }))).rejects.toThrow();
    expect(await counts()).toEqual(after);
  });

  it('rolls back request, event, completion and content retirement together after a later failure', async () => {
    const review = await prepare(), before = await counts();
    await expect(withTenant(ctx, async tx => {
      const refs = await canonicalSubmission(tx); await completeReference(tx, review, refs);
      throw new Error('Fictional failure after completion');
    })).rejects.toThrow('Fictional failure after completion');
    expect(await counts()).toEqual(before);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
    const submitted = await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'leave-request.submitted')).orderBy(schema.domainEvent.id);
    expect(submitted).toEqual([]);
  });

  it('refuses attaching a previously committed canonical submission to a pending review', async () => {
    const review = await prepare();
    const refs = await withTenant(ctx, canonicalSubmission), before = await counts();
    await expect(withTenant(ctx, tx => completeReference(tx, review, refs))).rejects.toThrow();
    expect(await counts()).toEqual(before);
    // The unrelated committed submission changed the native balance/overlap source. Pending
    // reopening now refuses stale content, while the custody marker/body remain unchanged.
    await expect(withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it('fails closed for source rows created in an unsupported savepoint and rolls back the whole command', async () => {
    const review = await prepare(), before = await counts();
    await expect(withTenant(ctx, tx => tx.transaction(async child => {
      const refs = await canonicalSubmission(child); return completeReference(child, review, refs);
    }))).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });
});

/** Actual unmounted command acceptance, authored UNRUN. The HTTP/session/CSRF owner is separate. */
describe('own-leave top-level confirmation owner', () => {
  it('serializes simultaneous confirmation deliveries into one request and the same canonical receipt', async () => {
    const review = await prepare(), posted = confirmation(review);
    const results = await Promise.all([confirmOwnLeaveReview(ctx, posted, 'en'), confirmOwnLeaveReview(ctx, posted, 'en')]);
    expect(results[0].kind).toBe('completed'); expect(results[1]).toEqual(results[0]);
    expect(await counts()).toMatchObject({ requests: 1, pending: 0, bodies: 0, model_runs: 0 });
    expect(await confirmOwnLeaveReview(ctx, posted, 'en')).toEqual(results[0]);
    expect(await counts()).toMatchObject({ requests: 1, model_runs: 0 });
  });

  it('refuses a changed private balance even when the public ESS review hid balances', async () => {
    await owner.db.update(schema.leaveType).set({ essViewConfig: { available: false } })
      .where(eq(schema.leaveType.id, base.annualLeaveTypeId));
    const review = await prepare(); expect(review.availableBalance).toBeNull();
    await credit(subject.employmentId);
    const before = await counts();
    await expect(confirmOwnLeaveReview(ctx, confirmation(review), 'en')).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({ requests: 0, pending: 1, bodies: 1, model_runs: 0 });
  });

  it.each(['grant', 'pause'] as const)('refuses fresh %s revocation before creating any submission', async mode => {
    const review = await prepare();
    if (mode === 'grant') await revokeAssistant(adminCtx(base), { appUserId: ctx.userId! });
    else await setAiAllowance(await groupCtx(), { kind: 'user', subjectId: ctx.userId!, enabled: false,
      dailyRequests: null, monthlyTokens: null });
    const before = await counts();
    await expect(confirmOwnLeaveReview(ctx, confirmation(review), 'en')).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
    expect(await counts()).toEqual(before); expect(before.requests).toBe(0);
  });

  it('refuses an owned busy employee interval with no effect, then completes only after release', async () => {
    const review = await prepare(), before = await counts();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned confirmation handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, base.tenantId, [subject.employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started;
      await expect(confirmOwnLeaveReview(ctx, confirmation(review), 'en')).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
      expect(await counts()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    expect((await confirmOwnLeaveReview(ctx, confirmation(review), 'en')).kind).toBe('completed');
    expect(await counts()).toMatchObject({ requests: 1, pending: 0, bodies: 0, model_runs: 0 });
  });

  it('rolls back the canonical write when a database failure rejects completion persistence', async () => {
    const review = await prepare(), before = await counts();
    // Isolated test-database fault injection; never shipped in a migration or application path.
    await owner.db.execute(sql`create function app.fictional_own_leave_completion_failure() returns trigger
      language plpgsql as $$ begin if NEW.state='completed' then raise exception 'Fictional completion failure';
      end if; return NEW; end $$`);
    try {
      await owner.db.execute(sql`create trigger fictional_own_leave_completion_failure before update
        on app.assistant_own_leave_review for each row execute function app.fictional_own_leave_completion_failure()`);
      try {
        await expect(confirmOwnLeaveReview(ctx, confirmation(review), 'en')).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);
        expect(await counts()).toEqual(before);
        const submitted = await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
          .where(eq(schema.domainEvent.eventType, 'leave-request.submitted')).orderBy(schema.domainEvent.id);
        expect(submitted).toEqual([]);
      } finally {
        await owner.db.execute(sql`drop trigger if exists fictional_own_leave_completion_failure on app.assistant_own_leave_review`);
      }
    } finally { await owner.db.execute(sql`drop function app.fictional_own_leave_completion_failure()`); }
    expect((await confirmOwnLeaveReview(ctx, confirmation(review), 'en')).kind).toBe('completed');
  });
});

describe('fresh permitted pending own-leave reopening',()=>{
 it('refuses formerly visible saved balance after the actual canonical ESS view policy hides it, without returning private values or changing custody/native effects',async()=>{const review=await prepare();expect(review.availableBalance).not.toBeNull();const [type]=await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id,base.annualLeaveTypeId));await updateLeaveType(await groupCtx(),{id:type.id,name:type.name,essViewConfig:{...(type.essViewConfig??{}),available:false}});const before=await counts();await expect(withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId,'en'))).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);expect(await counts()).toEqual(before);expect(before).toMatchObject({requests:0,pending:1,bodies:1,model_runs:0});});
 it('refuses a changed canonical private balance during pending reopen instead of replaying the saved estimate',async()=>{const review=await prepare();await credit(subject.employmentId);const before=await counts();await expect(withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,review.actionId,'en'))).rejects.toBeInstanceOf(OwnLeaveContentUnavailable);expect(await counts()).toEqual(before);});
});

/** Original writer: no nonce/content compatibility reinterpretation. The exact protected candidate
 * and legacy domain-separated identity are encrypted independently of the refactored codec. */
async function retainedOwnLeaveReview(){return withTenant(ctx,async tx=>{
 const outcome=await readOwnLeaveCandidateTx(tx,ctx,nomination,{employmentId:subject.employmentId,leaveTypeId:base.annualLeaveTypeId},text,'en');if(outcome.kind!=='candidate')throw Error('Expected native candidate');await assertAiActionUnpausedTx(tx,ctx,'hr_assistant');
 const review=outcome.candidate,content={review,availableBalance:outcome.privateAvailableBalance},binding=review.binding,actionId=randomUUID(),reviewedDigest=ownLeaveReviewedDigest(review),identity=JSON.stringify([1,actionId,binding.tenantId,binding.userId,binding.personId,binding.companyId,binding.employmentId,review.intentDigest,reviewedDigest]),dek=vault.newDek();
 try{const kid=vault.newKid();await tx.execute(sql`select app.assistant_own_leave_review_prepare(${actionId}::uuid,${binding.personId}::uuid,${binding.employmentId}::uuid,${binding.companyId}::uuid,${review.intentDigest},${reviewedDigest},${kid},${vault.wrapDek(dek,'assistant:own-leave:key:'+identity)},${vault.sealUnderDek(dek,kid,JSON.stringify(content),'assistant:own-leave:body:'+identity)})`);return{actionId,reviewedDigest,contractVersion:1 as const};}finally{dek.fill(0);}
 });}
describe('WP9 original own-leave protocol compatibility',()=>{
 it('opens and completes an original non-nonce writer row once across digest refusal and replay',async()=>{const old=await retainedOwnLeaveReview();expect((await withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,old.actionId,'en'))).kind).toBe('prepared');await expect(confirmOwnLeaveReview(ctx,{...old,reviewedDigest:'0'.repeat(64)},'en')).rejects.toThrow();const done=await confirmOwnLeaveReview(ctx,old,'en');expect(done.kind).toBe('completed');const after=await counts();expect(after.requests).toBe(1);expect(await confirmOwnLeaveReview(ctx,old,'en')).toEqual(done);expect(await withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,old.actionId,'en'))).toEqual(done);expect(await counts()).toEqual(after);});
 it('retires original pending rows after grant removal without decrypting or requesting Leave',async()=>{const old=await retainedOwnLeaveReview();await revokeAssistant(adminCtx(base),{appUserId:ctx.userId!});const before=await counts(),unwrap=vi.spyOn(vault,'unwrapDek');try{const retired=await withTenant(ctx,tx=>discardOwnLeaveReviewTx(tx,ctx,{actionId:old.actionId,contractVersion:1}));expect(retired.kind).toBe('retired');expect(unwrap).not.toHaveBeenCalled();expect(await counts()).toMatchObject({requests:before.requests,model_runs:before.model_runs,bodies:0,pending:0});}finally{unwrap.mockRestore();}});
 it('reconciles a genuinely committed request after actual reply loss without a second request',async()=>{const r=await prepare(),real=dbClient.withTenant;const lost:typeof withTenant=async(who,work,options)=>{await real(who,work,options);throw Error('Fictional lost reply after commit');};const spy=vi.spyOn(dbClient,'withTenant').mockImplementationOnce(lost);try{await expect(confirmOwnLeaveReview(ctx,confirmation(r),'en')).rejects.toThrow();}finally{spy.mockRestore();}const after=await counts(),done=await withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,r.actionId,'en'));expect(done.kind).toBe('completed');expect(after.requests).toBe(1);expect(await confirmOwnLeaveReview(ctx,confirmation(r),'en')).toEqual(done);expect(await counts()).toEqual(after);});
});

it('enforces the fixed own-leave action pause without browser scope and preserves privacy retirement',async()=>{
 const r=await prepare();await setAgentActionPause(await groupCtx(),'leave.apply',true);const before=await counts();
 await expect(confirmOwnLeaveReview(ctx,confirmation(r),'en')).rejects.toThrow();await expect(withTenant(ctx,tx=>reopenOwnLeaveReviewTx(tx,ctx,r.actionId,'en'))).rejects.toThrow();expect(await counts()).toEqual(before);
 expect((await withTenant(ctx,tx=>discardOwnLeaveReviewTx(tx,ctx,{actionId:r.actionId,contractVersion:1}))).kind).toBe('retired');
 await setAgentActionPause(await groupCtx(),'leave.apply',false);const fresh=await prepare();expect((await confirmOwnLeaveReview(ctx,confirmation(fresh),'en')).kind).toBe('completed');expect((await counts()).requests).toBe(1);
});
