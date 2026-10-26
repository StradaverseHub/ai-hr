/** Source-only acceptance: both SQL drafts must be journalled in a coordinated later window.
 * These cases are authored, NOT executed, while Board 3 owns the shared runtime. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { appendEvent } from '../db/events';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { setAiAllowance } from '../core/ai-management';
import { prepareOwnLeaveReviewTx, reopenOwnLeaveReviewTx, discardOwnLeaveReviewTx, expireOwnLeaveReviewsTx, confirmOwnLeaveReview } from '../core/assistant-actions/own-leave-store';
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
    const discard = () => withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(review)));
    const retired = { kind: 'retired', receipt: { actionId: review.actionId, contractVersion: 1, state: 'discarded' } };
    expect(await discard()).toEqual(retired);
    expect(await discard()).toEqual(retired);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).toEqual(retired);
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
  });

  it('reconciles simultaneous discard deliveries to the same retired reference', async () => {
    const review = await prepare();
    const retire = () => withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(review)));
    const results = await Promise.all([retire(), retire()]);
    const expected = { kind: 'retired', receipt: { actionId: review.actionId, contractVersion: 1, state: 'discarded' } };
    expect(results).toEqual([expected, expected]);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).toEqual(expected);
    expect(await counts()).toMatchObject({ bodies: 0, pending: 0, requests: 0, model_runs: 0 });
  });

  it('allows only retirement after a pause or removed Assistant grant, never another private read', async () => {
    const review = await prepare();
    await setAiAllowance(adminCtx(base), { kind: 'user', subjectId: ctx.userId!, enabled: false,
      dailyRequests: null, monthlyTokens: null });
    await revokeAssistant(adminCtx(base), { appUserId: ctx.userId! });
    await expect(withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId))).rejects.toThrow();
    expect(await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(review))))
      .toMatchObject({ kind: 'retired', receipt: { state: 'discarded' } });
    expect(await counts()).toMatchObject({ bodies: 0, requests: 0, model_runs: 0 });
  });

  it('does not count deterministic prepare/reopen/discard against exhausted model quotas', async () => {
    await setAiAllowance(adminCtx(base), { kind: 'user', subjectId: ctx.userId!, enabled: true,
      dailyRequests: 0, monthlyTokens: 0 });
    const review = await prepare();
    await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId));
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(review)));
    expect(await counts()).toMatchObject({ model_runs: 0, requests: 0 });
  });

  it('bounds pending reviews per login and frees pending capacity only when a review retires', async () => {
    const reviews = [];
    for (let index = 0; index < 5; index++) reviews.push(await prepare());
    const before = await counts();
    expect(before).toMatchObject({ bodies: 5, pending: 5, model_runs: 0, requests: 0 });
    await expect(prepare()).rejects.toThrow(OwnLeaveContentUnavailable);
    expect(await counts()).toEqual(before);
    // Other logins have their own custody and budget, even when linked to the same person.
    const secondId = await createAppUser(base.tenantId, subject.personId, 'employee');
    await grantAssistant(adminCtx(base), { appUserId: secondId });
    await prepare({ ...ctx, userId: secondId });
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(reviews[0])));
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
    await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(review)));
    // Historical, already retired fixtures exhaust only the creation budget. No ciphertext or
    // pending row exists, so a refusal cannot accidentally pin only the outstanding-review cap.
    await owner.db.execute(sql`insert into app.assistant_own_leave_review
      select gen_random_uuid(),tenant_id,user_id,person_id,employment_id,company_id,intent_digest,
       reviewed_digest,'discarded',created_at,expires_at
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

  it('refuses another login of the same person, foreign tenants and altered discard digests', async () => {
    const review = await prepare();
    const secondId = await createAppUser(base.tenantId, subject.personId, 'employee');
    await grantAssistant(adminCtx(base), { appUserId: secondId });
    const second = { ...ctx, userId: secondId };
    // This second login can prepare its own review: refusal of the first is not an unrelated grant gate.
    expect((await prepare(second)).actionId).not.toBe(review.actionId);
    await expect(withTenant(second, tx => reopenOwnLeaveReviewTx(tx, second, review.actionId)))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    await expect(withTenant(second, tx => discardOwnLeaveReviewTx(tx, confirmation(review))))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    const foreign = await seedBase();
    await expect(withTenant(adminCtx(foreign), tx => discardOwnLeaveReviewTx(tx, confirmation(review))))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    await expect(withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, { ...confirmation(review), reviewedDigest: 'a'.repeat(64) })))
      .rejects.toThrow(OwnLeaveContentUnavailable);
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
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
    for (const review of [a, b]) expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toMatchObject({ kind: 'retired', receipt: { actionId: review.actionId, state: 'refused', code: 'unavailable' } });
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
    expect(await withTenant(ctx, tx => discardOwnLeaveReviewTx(tx, confirmation(review))))
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
  return { requestId: result.requestId, eventId: result.submittedEventId };
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
    expect(await withTenant(ctx, tx => reopenOwnLeaveReviewTx(tx, ctx, review.actionId)))
      .toEqual({ kind: 'prepared', review });
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
    else await setAiAllowance(adminCtx(base), { kind: 'user', subjectId: ctx.userId!, enabled: false,
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
