/**
 * Recruitment slice 23 against Postgres: acceptance cases 149–154 (docs/recruitment-reconstruction/specification.md "Slice 23
 * acceptance cases") through the service AND directly as the app role: the job's reward and the referral's frozen copy, the
 * reward states from the hire's own employment dates, the HR decision and its database checks, the payroll send (one earning in
 * Individual Transactions, once), the referrer's view and the agency fee's four-eyes decision. Every person and value is
 * fictional; the decline reasons carry the sentinel S23SENTINEL so the referrer's data can be searched for it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, employment, jobGrade, payPeriod, payrollBatch, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { todayInKualaLumpur } from '../lib/hr-date';
import { createEmployeeDraftWithReservedCode } from '../core/employee-draft';
import {
  agencyFees, assignAgencyContract, createJob, decideAgencyFee, decideReferralReward, linkHireDraft, moveApplication, myReferrals, recordAgencyFee,
  recordAgencySubmission, recruitmentSettings, referralPortal, referralRewards, rewardPayMonths, rewardPayrollQueue, saveAgency, saveAgencyConsultant,
  saveAgencyContract, sendRewardToPayroll, setJobReferralPortal, setJobReferralReward, submitReferral, RecruitmentError, type ReferralRewardRow,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const SENTINEL = 'S23SENTINEL';
let base: Base;
let admin: SessionContext;
let gradeId: string;
let today: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
type Login = SessionContext & { userId: string; personId: string; employmentId: string };
let seq = 0;
/** A person with a login, an employment in the base company and the given role (employee by default). */
async function login(name: string, role: 'employee' | 'hr_admin' | 'recruiting_partner' | 'payroll_partner' = 'employee'): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  const [e] = await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01',
    employeeCode: `S23-${++seq}` }).returning({ id: employment.id });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  const scoped = role === 'employee' || role === 'hr_admin' ? null : base.companyId;
  if (role !== 'employee') await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: scoped, role });
  return { ...admin, userId: u.id, personId: p.id, employmentId: e.id, roles: [role], grants: [{ role, companyId: scoped }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional S23 analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', ...over,
});
async function portalJob(reward: string | null) {
  const { id } = await createJob(admin, job());
  await setJobReferralPortal(admin, id, true);
  if (reward !== null) await setJobReferralReward(admin, id, reward);
  return id;
}
const refer = (ctx: SessionContext, jobId: string) => submitReferral(ctx, {
  jobId, fullName: `Fictional S23 Candidate ${++seq}`, email: `s23.candidate${seq}@example.test`, mobile: '', reason: 'Fictional reason', confirmed: true,
});
async function applicationOf(referralId: string) {
  const [r] = await owner.db.execute<{ application_id: string }>(sql`select application_id from recruitment_referral where id = ${referralId}::uuid`);
  return r.application_id;
}
async function hire(applicationId: string) {
  const s = await recruitmentSettings(admin, base.companyId);
  await moveApplication(admin, applicationId, s.stages.find((x) => x.name === 'Onboarding')!.id);
  expect((await moveApplication(admin, applicationId)).state).toBe('hired');
}
/**
 * Fixture: the hire's employee draft was completed into an employment (the hand-off, then the 'employee-draft.completed' event
 * naming it, exactly what core/employee-draft writes), with the given employment dates.
 */
async function employHire(applicationId: string, dates: Record<string, string | null> = {}) {
  const draft = await createEmployeeDraftWithReservedCode(admin, { companyId: base.companyId, fullName: `Fictional S23 Hire ${++seq}`,
    primaryEmail: `${randomUUID()}@example.test`, employeeIdMode: 'manual', employeeCode: `S23H${seq}` });
  const draftId = draft.id;
  await linkHireDraft(admin, applicationId, draftId, draft.employeeCode);
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: `Fictional S23 Hire ${++seq}`, primaryEmail: `${randomUUID()}@example.test` })
    .returning({ id: person.id });
  const [e] = await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: addDays(today, -100) })
    .returning({ id: employment.id });
  await setEmployment(e.id, dates);
  await owner.client`insert into domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
    values (${base.tenantId}, 'employee-draft', ${draftId}, 'employee-draft.completed', 'user', ${base.adminUserId}, ${e.id},
      ${JSON.stringify({ employmentId: e.id, companyId: base.companyId })}::jsonb)`;
  return { employmentId: e.id, personId: p.id };
}
/** Fixture: set an employment's dates past its guards (owner connection). */
async function setEmployment(employmentId: string, dates: Record<string, string | null>) {
  const cols = Object.entries(dates);
  if (!cols.length) return;
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const [col, value] of cols) await tx.unsafe(`update employment set ${col} = $1::date where id = $2::uuid`, [value, employmentId]);
  });
}
const rewardRow = async (referralId: string, ctx = admin): Promise<ReferralRewardRow> => (await referralRewards(ctx, base.companyId)).find((r) => r.referralId === referralId)!;
async function allowance() {
  const [c] = await owner.db.execute<{ id: string }>(sql`insert into pay_component (tenant_id, code, name, kind)
    values (${base.tenantId}::uuid, ${`S23_${randomUUID().slice(0, 6)}`}, 'Fictional referral bonus', 'allowance') returning id`);
  return c.id;
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  today = todayInKualaLumpur();
});

describe('case 149 — the job reward is set by administrators and frozen on each referral when it is made', () => {
  it('sets and clears the reward, refuses others, shows it on the portal and freezes it on the referral', async () => {
    const referrer = await login('Fictional S23 Referrer');
    const jobId = await portalJob('500');
    const [stored] = await rows(admin, sql`select referral_reward::text as r from recruitment_job_opening where id = ${jobId}::uuid`);
    expect(stored.r).toBe('500.00');
    expect((await referralPortal(referrer)).jobs.find((j) => j.jobId === jobId)?.reward).toEqual({ amount: '500.00', currency: 'MYR' });
    // Invalid amounts and non-administrators are refused (service and database).
    for (const bad of ['0', '-1', '1000000.01', '12.345', 'abc']) expect(await code(setJobReferralReward(admin, jobId, bad)), bad).toBe('invalid_input');
    // The job is not even visible to a non-administrator.
    expect(await code(setJobReferralReward(referrer, jobId, '900'))).toBe('not_found');

    const first = await refer(referrer, jobId);
    await setJobReferralReward(admin, jobId, '750.50');
    const second = await refer(referrer, jobId);
    await setJobReferralReward(admin, jobId, '');
    const third = await refer(referrer, jobId);
    const frozen = await owner.db.execute<{ id: string; a: string | null; c: string | null }>(sql`
      select id, reward_amount::text as a, reward_currency as c from recruitment_referral where tenant_id = ${base.tenantId}::uuid order by created_at, id`);
    expect(Object.fromEntries(frozen.map((f) => [f.id, [f.a, f.c]]))).toEqual({
      [first.referralId]: ['500.00', 'MYR'], [second.referralId]: ['750.50', 'MYR'], [third.referralId]: [null, null],
    });
    // The frozen amount cannot be rewritten, even by the owner path's guard.
    expect(await code(owner.db.execute(sql`update recruitment_referral set reward_amount = 1 where id = ${first.referralId}::uuid`))).toBe('42501');
    // The audit event carries no amount.
    const events = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where tenant_id = ${base.tenantId}::uuid
      and event_type = 'recruitment-job.referral-reward-changed' order by sequence`);
    expect(events.map((e) => [e.payload.from, e.payload.to])).toEqual([['none', 'set'], ['set', 'set'], ['set', 'none']]);
    expect(JSON.stringify(events)).not.toContain('500');
  });
});

describe('case 150 — a hired referral reward reads its state from the hire\'s own employment', () => {
  it('waits for the record, then probation; is ready from the due day; flags a missing date; reads hire left', async () => {
    const referrer = await login('Fictional S23 Referrer');
    const jobId = await portalJob('300');
    const ids = await Promise.all(Array.from({ length: 5 }, () => refer(referrer, jobId)));
    const apps = await Promise.all(ids.map((r) => applicationOf(r.referralId)));
    for (const a of apps) await hire(a);
    expect((await rewardRow(ids[0].referralId)).state).toBe('waiting_record');
    await employHire(apps[1], { final_confirmation_date: addDays(today, 10) });
    await employHire(apps[2], { probation_end_date: addDays(today, -1) });
    await employHire(apps[3]);
    await employHire(apps[4], { probation_end_date: addDays(today, 30), terminated_on: addDays(today, -2) });
    const [r0, r1, r2, r3, r4] = await Promise.all(ids.map((r) => rewardRow(r.referralId)));
    expect(r0).toMatchObject({ state: 'waiting_record', dueOn: null });
    expect(r1).toMatchObject({ state: 'waiting_probation', dueOn: addDays(today, 10), noProbationDate: false });
    // The day after the probation end: yesterday + 1 = today.
    expect(r2).toMatchObject({ state: 'ready', dueOn: today, noProbationDate: false });
    expect(r3).toMatchObject({ state: 'ready', dueOn: addDays(today, -100), noProbationDate: true });
    expect(r4).toMatchObject({ state: 'hire_left' });
    expect(r1.payees.map((p) => p.employmentId)).toEqual([referrer.employmentId]);
    expect(r1).toMatchObject({ amount: '300.00', currency: 'MYR', referrerName: 'Fictional S23 Referrer' });
    // A referral without a reward, and one not hired, are not listed.
    const noReward = await portalJob(null);
    await hire(await applicationOf((await refer(referrer, noReward)).referralId));
    await refer(referrer, jobId);
    expect((await referralRewards(admin, base.companyId)).length).toBe(5);
    // Only recruitment administrators read the list and the facts.
    expect(await code(referralRewards(referrer, base.companyId))).toBe('forbidden');
    expect(await rows(referrer, sql`select app.recruitment_reward_facts(${apps[1]}::uuid) as f`)).toEqual([{ f: null }]);
  });
});

describe('case 151 — HR decides a reward once, and the database re-checks every fact', () => {
  it('approves a ready reward to the referrer\'s employment, declines with a reason and refuses the rest', async () => {
    const referrer = await login('Fictional S23 Referrer', 'hr_admin');
    const hr = await login('Fictional S23 HR', 'hr_admin');
    const jobId = await portalJob('400');
    const [ready, waiting, decline] = await Promise.all([refer(referrer, jobId), refer(referrer, jobId), refer(referrer, jobId)]);
    const apps = await Promise.all([ready, waiting, decline].map((r) => applicationOf(r.referralId)));
    for (const a of apps) await hire(a);
    const hireEmp = await employHire(apps[0], { final_confirmation_date: today });
    await employHire(apps[1], { final_confirmation_date: addDays(today, 5) });

    expect(await code(decideReferralReward(hr, { referralId: waiting.referralId, decision: 'approved' }))).toBe('reward_not_ready');
    // The referrer may not decide their own reward.
    expect(await code(decideReferralReward(referrer, { referralId: ready.referralId, decision: 'approved' }))).toBe('reward_self');
    // A forged direct insert: wrong amount, another employment, another decider — each refused by the database.
    const forge = (over: Record<string, string>) => rows(hr, sql`insert into recruitment_referral_reward (tenant_id, company_id, referral_id, amount, currency,
      decision, hire_employment_id, payee_employment_id, payee_company_id, decided_by_user_id) values (${base.tenantId}::uuid, ${base.companyId}::uuid,
      ${ready.referralId}::uuid, ${over.amount ?? '400'}, 'MYR', 'approved', ${hireEmp.employmentId}::uuid, ${over.payee ?? referrer.employmentId}::uuid,
      ${base.companyId}::uuid, ${over.by ?? hr.userId}::uuid)`);
    expect(await code(forge({ amount: '4000' }))).toBe('23514');
    expect(await code(forge({ payee: hr.employmentId }))).toBe('23514');
    expect(await code(forge({ by: referrer.userId }))).toBe('42501');

    expect(await decideReferralReward(hr, { referralId: ready.referralId, decision: 'approved' })).toMatchObject({ rewardId: expect.any(String) });
    const [w] = await owner.db.execute<Record<string, unknown>>(sql`select amount::text as amount, currency, decision, payee_employment_id, payee_company_id,
      hire_employment_id, decided_by_user_id, txn_id from recruitment_referral_reward where referral_id = ${ready.referralId}::uuid`);
    expect(w).toEqual({ amount: '400.00', currency: 'MYR', decision: 'approved', payee_employment_id: referrer.employmentId, payee_company_id: base.companyId,
      hire_employment_id: hireEmp.employmentId, decided_by_user_id: hr.userId, txn_id: null });
    expect(await code(decideReferralReward(hr, { referralId: ready.referralId, decision: 'declined', reason: 'Fictional' }))).toBe('reward_decided');

    expect(await code(decideReferralReward(hr, { referralId: decline.referralId, decision: 'declined', reason: '  ' }))).toBe('decline_reason');
    await decideReferralReward(hr, { referralId: decline.referralId, decision: 'declined', reason: `${SENTINEL} probation not confirmed` });
    expect((await rewardRow(decline.referralId)).state).toBe('declined');
    // Never deleted or rewritten by the app role.
    expect(await code(rows(hr, sql`delete from recruitment_referral_reward where referral_id = ${decline.referralId}::uuid`))).not.toBe('ok');
    expect(await code(rows(hr, sql`update recruitment_referral_reward set reason = 'x' where referral_id = ${decline.referralId}::uuid`))).not.toBe('ok');
    // Events name the decision, never the amount.
    const events = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where tenant_id = ${base.tenantId}::uuid
      and event_type = 'recruitment-referral-reward.decided' order by sequence`);
    expect(events.map((e) => e.payload.decision)).toEqual(['approved', 'declined']);
    // UUIDs can contain the amount's digits; assert the complete permitted payload instead.
    expect(events.map(event => event.payload)).toEqual([
      { decision: 'approved', companyId: base.companyId, referralId: ready.referralId, payeeCompanyId: base.companyId },
      { decision: 'declined', companyId: base.companyId, referralId: decline.referralId, payeeCompanyId: null },
    ]);
  });

  it('refuses approval when the referrer has left', async () => {
    const referrer = await login('Fictional S23 Leaver');
    const hr = await login('Fictional S23 HR', 'hr_admin');
    const jobId = await portalJob('200');
    const r = await refer(referrer, jobId);
    const app = await applicationOf(r.referralId);
    await hire(app);
    await employHire(app, { final_confirmation_date: addDays(today, -1) });
    await setEmployment(referrer.employmentId, { terminated_on: addDays(today, -1) });
    expect((await rewardRow(r.referralId)).payees).toEqual([]);
    expect(await code(decideReferralReward(hr, { referralId: r.referralId, decision: 'approved' }))).toBe('reward_payee_unavailable');
  });
});

describe('case 152 — a payroll administrator sends an approved reward once, as one earning', () => {
  it('records the earning and marks the reward sent in one transaction; refuses everyone and everything else', async () => {
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
    const referrer = await login('Fictional S23 Referrer', 'hr_admin');
    const hr = await login('Fictional S23 HR', 'hr_admin');
    const recruiterAdmin = await login('Fictional S23 Recruiting Partner', 'recruiting_partner');
    const jobId = await portalJob('650.25');
    const r = await refer(referrer, jobId);
    const app = await applicationOf(r.referralId);
    await hire(app);
    await employHire(app, { final_confirmation_date: today });
    const { rewardId } = await decideReferralReward(hr, { referralId: r.referralId, decision: 'approved' });
    const componentId = await allowance();
    const [month, , last] = rewardPayMonths(today);

    const queue = await rewardPayrollQueue(hr, base.companyId);
    expect(queue.ledgerPays).toBe(true);
    expect(queue.rows).toEqual([expect.objectContaining({ id: rewardId, amount: '650.25', currency: 'MYR', payeeEmploymentId: referrer.employmentId,
      payeeName: 'Fictional S23 Referrer', approvedBy: 'Fictional S23 HR' })]);
    expect(queue.components.map((c) => c.id)).toContain(componentId);
    // The queue names no hire, candidate or job.
    expect(JSON.stringify(queue)).not.toMatch(/S23 Candidate|S23 analyst/);
    const txns = () => owner.db.execute<Record<string, unknown>>(sql`select employment_id, company_id, pay_period, kind::text as kind, amount::text as amount,
      component_id, source, source_ref, notes, txn_date::text as txn_date, batch_id from payroll_individual_txn where tenant_id = ${base.tenantId}::uuid`);

    // Not a payroll administrator; the receiver; a month out of range; a closed month — nothing is written.
    expect(await code(sendRewardToPayroll(recruiterAdmin, { rewardId, payPeriod: month, componentId }))).toBe('forbidden');
    expect(await code(rewardPayrollQueue(recruiterAdmin, base.companyId))).toBe('forbidden');
    expect(await code(sendRewardToPayroll(referrer, { rewardId, payPeriod: month, componentId }))).toBe('reward_self');
    expect(await code(sendRewardToPayroll(hr, { rewardId, payPeriod: addDays(`${month}-01`, -1).slice(0, 7), componentId }))).toBe('invalid_input');
    expect(await code(sendRewardToPayroll(hr, { rewardId, payPeriod: month, componentId: randomUUID() }))).toBe('invalid_input');
    // A closed regular run in the last offered month.
    const [pp] = await owner.db.insert(payPeriod).values({ tenantId: base.tenantId, companyId: base.companyId, period: last, status: 'closed' }).returning({ id: payPeriod.id });
    await owner.db.insert(payrollBatch).values({ tenantId: base.tenantId, companyId: base.companyId, payPeriodId: pp.id, payPeriod: last, batchDate: `${last}-25`, status: 'closed' });
    expect(await code(sendRewardToPayroll(hr, { rewardId, payPeriod: last, componentId }))).toBe('reward_month_closed');
    expect(await txns()).toEqual([]);

    expect(await sendRewardToPayroll(hr, { rewardId, payPeriod: month, componentId })).toMatchObject({ txnId: expect.any(String) });
    expect(await txns()).toEqual([{ employment_id: referrer.employmentId, company_id: base.companyId, pay_period: month, kind: 'earning', amount: '650.25',
      component_id: componentId, source: 'system', source_ref: `recruitment-referral-reward:${rewardId}`, notes: 'Employee referral reward', txn_date: today, batch_id: null }]);
    const [sent] = await owner.db.execute<Record<string, unknown>>(sql`select pay_period, sent_by_user_id, txn_id is not null as has_txn from recruitment_referral_reward where id = ${rewardId}::uuid`);
    expect(sent).toEqual({ pay_period: month, sent_by_user_id: hr.userId, has_txn: true });
    expect(await code(sendRewardToPayroll(hr, { rewardId, payPeriod: month, componentId }))).toBe('reward_decided');
    expect((await txns()).length).toBe(1);
    expect((await rewardPayrollQueue(hr, base.companyId)).rows).toEqual([]);
    expect((await rewardRow(r.referralId)).state).toBe('sent');
    // The payroll columns cannot be written without the matching earning.
    const r2 = await refer(referrer, jobId);
    const app2 = await applicationOf(r2.referralId);
    await hire(app2);
    await employHire(app2, { final_confirmation_date: today });
    const { rewardId: second } = await decideReferralReward(hr, { referralId: r2.referralId, decision: 'approved' });
    expect(await code(rows(hr, sql`update recruitment_referral_reward set txn_id = ${randomUUID()}::uuid, pay_period = ${month}, sent_by_user_id = ${hr.userId}::uuid,
      sent_at = now() where id = ${second}::uuid`))).toBe('23514');
  });

  it('refuses while payroll does not pay individual transactions', async () => {
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
    admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
    const hr = await login('Fictional S23 HR', 'hr_admin');
    expect(await code(sendRewardToPayroll(hr, { rewardId: randomUUID(), payPeriod: rewardPayMonths(today)[0], componentId: randomUUID() }))).toBe('reward_payroll_off');
    expect((await rewardPayrollQueue(hr, base.companyId)).ledgerPays).toBe(false);
  });
});

describe('case 153 — the referrer sees each reward state and never a reason', () => {
  it('reads if hired, waiting, approved, sent and not payable', async () => {
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
    admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
    const referrer = await login('Fictional S23 Referrer');
    const hr = await login('Fictional S23 HR', 'hr_admin');
    const jobId = await portalJob('100');
    const refs = await Promise.all(Array.from({ length: 4 }, () => refer(referrer, jobId)));
    const apps = await Promise.all(refs.map((r) => applicationOf(r.referralId)));
    for (const a of apps.slice(1)) await hire(a);
    for (const a of apps.slice(2)) await employHire(a, { final_confirmation_date: today });
    const { rewardId } = await decideReferralReward(hr, { referralId: refs[2].referralId, decision: 'approved' });
    await decideReferralReward(hr, { referralId: refs[3].referralId, decision: 'declined', reason: `${SENTINEL} reason` });
    const before = Object.fromEntries((await myReferrals(referrer)).map((r) => [r.id, r.reward?.state]));
    expect(before).toEqual({ [refs[0].referralId]: 'if_hired', [refs[1].referralId]: 'waiting', [refs[2].referralId]: 'approved', [refs[3].referralId]: 'not_payable' });
    const month = rewardPayMonths(today)[1];
    await sendRewardToPayroll(hr, { rewardId, payPeriod: month, componentId: await allowance() });
    const mine = await myReferrals(referrer);
    expect(mine.find((r) => r.id === refs[2].referralId)?.reward).toEqual({ amount: '100.00', currency: 'MYR', state: 'sent', payPeriod: month });
    expect(JSON.stringify(mine)).not.toContain(SENTINEL);
    expect(JSON.stringify(mine)).not.toContain('Fictional S23 HR');
    // Another person sees none of these rewards.
    const other = await login('Fictional S23 Other');
    expect(await myReferrals(other)).toEqual([]);
    expect(await rows(other, sql`select * from app.recruitment_my_referral_rewards()`)).toEqual([]);
  });
});

describe('case 154 — an agency fee is recorded for a hired agency candidate and decided by another administrator', () => {
  it('records, corrects, refuses the recorder\'s own decision, decides once and never reaches payroll', async () => {
    const hr1 = await login('Fictional S23 HR One', 'hr_admin');
    const hr2 = await login('Fictional S23 HR Two', 'hr_admin');
    const { id: agencyId } = await saveAgency(admin, { companyId: base.companyId, name: 'Fictional S23 Agency' });
    const { id: contractId } = await saveAgencyContract(admin, { agencyId, name: 'Fictional contract', contractType: 'headhunter', feeRate: '20',
      startsOn: addDays(today, -10), endsOn: addDays(today, 100), hrContactUserId: base.adminUserId, access: 'public' });
    const { id: consultantId } = await saveAgencyConsultant(admin, { contractId, name: 'Fictional Consultant', email: 'consultant.s23@agency.example.test' });
    const { id: jobId } = await createJob(admin, job());
    await assignAgencyContract(admin, jobId, contractId);
    const sub = await recordAgencySubmission(admin, { jobId, contractId, consultantId, fullName: 'Fictional S23 Agency Candidate', email: 's23.agency@example.test' });
    expect(sub.outcome).toBe('accepted');
    const applicationId = sub.applicationId!;
    // Not hired yet: no fee.
    expect(await code(recordAgencyFee(hr1, applicationId, { amount: '8000', currency: 'MYR' }))).toBe('fee_not_eligible');
    await hire(applicationId);
    expect(await code(recordAgencyFee(hr1, applicationId, { amount: '0', currency: 'MYR' }))).toBe('invalid_input');
    expect(await code(recordAgencyFee(hr1, applicationId, { amount: '8000', currency: 'myrr' }))).toBe('invalid_input');
    const { feeId } = await recordAgencyFee(hr1, applicationId, { amount: '8,000.00', currency: 'myr', invoiceRef: 'INV-S23-1' });
    const list = await agencyFees(hr1, base.companyId);
    expect(list).toEqual([expect.objectContaining({ applicationId, agencyName: 'Fictional S23 Agency', companyCurrency: 'MYR',
      fee: expect.objectContaining({ id: feeId, amount: '8000.00', currency: 'MYR', invoiceRef: 'INV-S23-1', recordedByMe: true, decision: null }) })]);
    expect(await code(decideAgencyFee(hr1, { feeId, decision: 'approved' }))).toBe('reward_self');
    // The database refuses it too.
    expect(await code(rows(hr1, sql`update recruitment_agency_fee set decision = 'approved', decided_by_user_id = ${hr1.userId}::uuid, decided_at = now()
      where id = ${feeId}::uuid`))).toBe('42501');
    // hr2 corrects it: now hr1 may decide and hr2 may not.
    await recordAgencyFee(hr2, applicationId, { amount: '7500', currency: 'MYR', invoiceRef: 'INV-S23-2', note: 'Fictional corrected invoice' });
    expect(await code(decideAgencyFee(hr2, { feeId, decision: 'approved' }))).toBe('reward_self');
    expect(await code(decideAgencyFee(hr1, { feeId, decision: 'declined', reason: '' }))).toBe('decline_reason');
    await decideAgencyFee(hr1, { feeId, decision: 'approved' });
    const [fee] = await owner.db.execute<Record<string, unknown>>(sql`select amount::text as amount, invoice_ref, recorded_by_user_id, decision, decided_by_user_id
      from recruitment_agency_fee where id = ${feeId}::uuid`);
    expect(fee).toEqual({ amount: '7500.00', invoice_ref: 'INV-S23-2', recorded_by_user_id: hr2.userId, decision: 'approved', decided_by_user_id: hr1.userId });
    expect(await code(decideAgencyFee(hr2, { feeId, decision: 'declined', reason: 'Fictional' }))).toBe('fee_decided');
    expect(await code(recordAgencyFee(hr2, applicationId, { amount: '1', currency: 'MYR' }))).toBe('fee_decided');
    expect(await code(rows(hr2, sql`update recruitment_agency_fee set amount = 1 where id = ${feeId}::uuid`))).toBe('42501');
    expect(await code(rows(hr2, sql`delete from recruitment_agency_fee where id = ${feeId}::uuid`))).not.toBe('ok');
    const [ledger] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from payroll_individual_txn where tenant_id = ${base.tenantId}::uuid`);
    expect(ledger.n).toBe(0);
    // A hired application that did not come from an agency has no fee.
    const referrer = await login('Fictional S23 Referrer');
    const plain = await applicationOf((await refer(referrer, await portalJob(null))).referralId);
    await hire(plain);
    expect(await code(recordAgencyFee(hr1, plain, { amount: '100', currency: 'MYR' }))).toBe('fee_not_eligible');
  });
});
