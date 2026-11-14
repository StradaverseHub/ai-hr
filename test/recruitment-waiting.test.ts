/**
 * Recruitment slice 17 against Postgres — applications left unprocessed: acceptance cases 115–119
 * (docs/recruitment-reconstruction/specification.md "Slice 17 acceptance cases"), through the service AND directly as the app role.
 * The pure arithmetic is test/recruitment-waiting-rules.test.ts; case 120 is the lead's rendered check.
 *
 * Expected values are computed here from the fixture's own dates with a separate day-by-day loop (Date.UTC, getUTCDay) and read back
 * with plain owner-connection SQL that ignores row security — never with packs/recruitment/waiting*.ts. "Today" is the repository's
 * Kuala Lumpur day (lib/hr-date). Every person and company is fictional; names carry the LETTER sentinel QZW.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, holiday, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { todayInKualaLumpur } from '../lib/hr-date';
import { companyHolidayDatesByCompany } from '../core/holidays';
import {
  addApplication, addJobMember, applicationWaiting, archiveSuggestedApplications, blockCandidate, candidateBoard, createJob, deleteWaitingRule, jobFormOptions,
  moveApplication, pendingRecruitmentTasks, recruitmentJobTodos, recruitmentWaitingTodos, recruitmentPipelineCounts, WAITING_BOARD_SCAN_LIMIT, WAITING_SCAN_LIMIT,
  WAITING_TODOS_TIMEOUT_MS, recruitmentSettings, recruitmentTodos, rejectApplication,
  saveWaitingRule, suggestedArchiveList, updateStage, waitingRuleSettings, RecruitmentError,
} from '../packs/recruitment/service';
import { waitingContextTx } from '../packs/recruitment/waiting-store';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const constraintOf = async (operation: Promise<unknown>) => {
  const e = await operation.then(() => null, (x: unknown) => x);
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  return e === null ? 'ok' : pgSqlState(e) ?? 'unknown';
};
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
type Login = SessionContext & { userId: string };
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'QZW Fictional analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time', ...over,
});

// ── Independent date arithmetic (no module under test) ──────────────────────────────────────────────────────
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
function oracleDays(entered: string, today: string, kind: 'calendar' | 'working', holidays: Set<string>): number {
  let n = 0;
  for (let d = shift(entered, 1); d <= today; d = shift(d, 1)) {
    if (kind === 'calendar' || (weekday(d) !== 0 && weekday(d) !== 6 && !holidays.has(d))) n++;
  }
  return n;
}
/** The latest weekday strictly between `from` and `to`. */
const weekdayBetween = (from: string, to: string) => { for (let d = shift(to, -1); d > from; d = shift(d, -1)) if (weekday(d) !== 0 && weekday(d) !== 6) return d; throw new Error('none'); };

/** Fixture time travel: when an application was received and when it entered its CURRENT stage (its latest arrival event), set by
 *  the owner past the append-only history guard. `receivedOn` defaults to the stage entry. */
async function entered(applicationId: string, day: string, receivedOn = day) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_application set applied_at = ${`${receivedOn}T09:00:00+08:00`}::timestamptz where id = ${applicationId}::uuid`;
    await tx`update recruitment_application_event set occurred_at = ${`${receivedOn}T09:00:00+08:00`}::timestamptz where application_id = ${applicationId}::uuid and kind = 'applied'`;
    await tx`update recruitment_application_event e set occurred_at = ${`${day}T10:00:00+08:00`}::timestamptz from (select id from recruitment_application_event
      where application_id = ${applicationId}::uuid and to_stage_id is not null order by occurred_at desc, id desc limit 1) x where e.id = x.id and e.kind = 'moved'`;
    // As in the product, the last change of the application is its stage entry (a move sets updated_at).
    await tx`update recruitment_application set updated_at = (select max(occurred_at) from recruitment_application_event where application_id = ${applicationId}::uuid)
      where id = ${applicationId}::uuid`;
  });
}

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
});

/**
 * One job (J) with a recruiter, a hiring manager and an interviewer; a bystander; rules: Application Review remind 3 / archive 10
 * calendar days; Interview remind 2 / archive 6 working days (a national holiday H inside the window, and a Johor-only holiday that
 * does not apply: the company has no default work state). Applications:
 *   a1 Application Review, entered today−12            → waiting, suggested
 *   a2 Application Review, entered today−5             → waiting
 *   a3 Application Review, entered today−2             → nothing
 *   a4 Application Review, entered today−20, archived  → nothing (not active)
 *   a5 Interview, received today−20, moved in today−15 → waiting, suggested (working days)
 *   a6 received today−30, moved to Interview today     → nothing (moving resets)
 *   a7 Application Review, entered today−40, blocked   → waiting, suggested, held for review
 *   o1 another job of the recruiter's, entered today−50, no access for the bystander
 */
async function world() {
  const today = todayInKualaLumpur();
  const [recruiter, manager, interviewer, bystander] = await Promise.all([login('Fictional Recruiter'), login('Fictional Manager'), login('Fictional Interviewer'), login('Fictional Bystander')]);
  await jobFormOptions(admin, base.companyId); // seeds the company's stages
  const stages = (await recruitmentSettings(admin, base.companyId)).stages;
  const first = stages.find((s) => s.name === 'Application Review')!.id;
  const interview = stages.find((s) => s.name === 'Interview')!.id;
  const { id: j } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
  const { id: j2 } = await createJob(admin, job({ title: 'QZW Fictional second role', recruiterUserId: recruiter.userId }));
  await addJobMember(admin, j, 'hiring_manager', manager.userId);
  await addJobMember(admin, j, 'interviewer', interviewer.userId);
  const add = async (n: number, jobId = j) => addApplication(recruiter, { jobId, fullName: `QZW Fictional Candidate ${n}`, email: `qzw${n}@example.test` });
  const [a1, a2, a3, a4, a5, a6, a7] = [await add(1), await add(2), await add(3), await add(4), await add(5), await add(6), await add(7)];
  const o1 = await add(8, j2);
  await entered(a1.applicationId, shift(today, -12));
  await entered(a2.applicationId, shift(today, -5));
  await entered(a3.applicationId, shift(today, -2));
  await entered(a4.applicationId, shift(today, -20));
  await entered(a7.applicationId, shift(today, -40));
  await entered(o1.applicationId, shift(today, -50));
  await moveApplication(recruiter, a5.applicationId, interview);
  await entered(a5.applicationId, shift(today, -15), shift(today, -20));
  await entered(a6.applicationId, shift(today, -30));
  await moveApplication(recruiter, a6.applicationId, interview);
  const reasons = await owner.db.execute<{ id: string }>(sql`select id from recruitment_archive_reason where company_id = ${base.companyId}::uuid and displayed order by position limit 1`);
  await rejectApplication(recruiter, a4.applicationId, reasons[0].id);
  await blockCandidate(admin, a7.candidateId, 'Fictional QZW reason');
  const h = weekdayBetween(shift(today, -15), today);
  const johor = weekdayBetween(shift(today, -15), h);
  await owner.db.insert(holiday).values([
    { tenantId: base.tenantId, country: 'MY', holidayDate: h, name: 'QZW Fictional national holiday' },
    { tenantId: base.tenantId, country: 'MY', state: 'Johor', holidayDate: johor, name: 'QZW Fictional Johor holiday' },
  ]);
  await saveWaitingRule(admin, { companyId: base.companyId, stageId: first, remindDays: '3', archiveDays: '10', dayKind: 'calendar' });
  await saveWaitingRule(admin, { companyId: base.companyId, stageId: interview, remindDays: '2', archiveDays: '6', dayKind: 'working' });
  return { today, recruiter, manager, interviewer, bystander, first, interview, j, j2, a1, a2, a3, a4, a5, a6, a7, o1, h, johor, reason: reasons[0].id };
}
type World = Awaited<ReturnType<typeof world>>;
/** Expected waiting days, independently. */
const expected = (w: World) => ({
  a1: oracleDays(shift(w.today, -12), w.today, 'calendar', new Set()),
  a2: oracleDays(shift(w.today, -5), w.today, 'calendar', new Set()),
  a5: oracleDays(shift(w.today, -15), w.today, 'working', new Set([w.h])),
  a7: oracleDays(shift(w.today, -40), w.today, 'calendar', new Set()),
});

describe('case 115 — only administrators manage rules (service and database); thresholds are validated', () => {
  it('refuses everybody else, validates the thresholds and enforces the same in the database', async () => {
    const w = await world();
    for (const who of [w.recruiter, w.manager, w.interviewer, w.bystander]) {
      expect(await code(waitingRuleSettings(who, base.companyId))).toBe('forbidden');
      expect(await code(saveWaitingRule(who, { companyId: base.companyId, stageId: w.first, remindDays: '9', dayKind: 'calendar' }))).toBe('forbidden');
      expect(await code(deleteWaitingRule(who, { companyId: base.companyId, stageId: w.first }))).toBe('forbidden');
    }
    const save = (over: Record<string, unknown>) => code(saveWaitingRule(admin, { companyId: base.companyId, stageId: w.first, remindDays: '3', archiveDays: '10', dayKind: 'calendar', ...over }));
    expect(await save({ remindDays: '0' })).toBe('invalid_input');
    expect(await save({ remindDays: '366' })).toBe('invalid_input');
    expect(await save({ archiveDays: '3' })).toBe('invalid_input');
    expect(await save({ archiveDays: '731' })).toBe('invalid_input');
    expect(await save({ dayKind: 'weeks' })).toBe('invalid_input');
    expect(await save({ remindDays: '' })).toBe('missing_fields');
    // A disabled stage takes no new rule.
    const screening = (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === "Recruiter's Screening")!;
    await updateStage(admin, screening.id, { name: screening.name, type: screening.type, enabled: false });
    expect(await code(saveWaitingRule(admin, { companyId: base.companyId, stageId: screening.id, remindDays: '3', dayKind: 'calendar' }))).toBe('stage_unavailable');
    // The rules are unchanged by every refusal: exactly the two the fixture set.
    const stored = await owner.db.execute<{ stage_id: string; remind_days: number; archive_days: number | null; day_kind: string }>(sql`
      select stage_id, remind_days, archive_days, day_kind from recruitment_stage_waiting_rule where company_id = ${base.companyId}::uuid order by remind_days`);
    expect(stored).toEqual([
      { stage_id: w.interview, remind_days: 2, archive_days: 6, day_kind: 'working' },
      { stage_id: w.first, remind_days: 3, archive_days: 10, day_kind: 'calendar' },
    ]);
    // The settings page lists the enabled stages with their rules, and says the company has a public holiday calendar this year
    // only when it has one (here: the national holiday is in this year unless it fell in the previous one).
    const settings = await waitingRuleSettings(admin, base.companyId);
    expect(settings.stages.find((s) => s.stageId === w.first)?.rule).toMatchObject({ remindDays: 3, archiveDays: 10, dayKind: 'calendar' });
    expect(settings.stages.some((s) => s.stageId === screening.id)).toBe(false);
    expect(settings.holidaysThisYear).toBe(w.h.slice(0, 4) === w.today.slice(0, 4) ? 1 : 0);

    // Database: the app role as the recruiter or the manager cannot write a rule (an ENABLED stage without one, so the guard passes and
    // row security refuses); they (job teams) read it; a bystander reads nothing.
    const offer = (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === 'Offer')!.id;
    for (const who of [w.recruiter, w.manager]) {
      expect(await code(rows(who, sql`insert into recruitment_stage_waiting_rule (tenant_id, company_id, stage_id, remind_days, day_kind, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${offer}::uuid, 4, 'calendar', ${who.userId}::uuid, ${who.userId}::uuid)`))).toBe('42501');
      expect(await rows(who, sql`update recruitment_stage_waiting_rule set remind_days = 99 where stage_id = ${w.first}::uuid returning id`)).toEqual([]);
      expect(await rows(who, sql`delete from recruitment_stage_waiting_rule where stage_id = ${w.first}::uuid returning id`)).toEqual([]);
      expect((await rows(who, sql`select stage_id from recruitment_stage_waiting_rule order by stage_id`)).length).toBe(2);
    }
    expect(await rows(w.bystander, sql`select 1 from recruitment_stage_waiting_rule`)).toEqual([]);
    // The administrator's own direct writes still meet the CHECKs and the enabled-stage guard.
    const direct = (remind: number, archive: number | null, stage = w.interview) => rows(admin, sql`update recruitment_stage_waiting_rule
      set remind_days = ${remind}, archive_days = ${archive} where stage_id = ${stage}::uuid`);
    expect(await constraintOf(direct(5, 5))).toBe('recruitment_stage_waiting_rule_order_ck');
    expect(await code(direct(0, null))).toBe('23514');
    expect(await code(direct(3, 731))).toBe('23514');
    expect(await constraintOf(rows(admin, sql`insert into recruitment_stage_waiting_rule (tenant_id, company_id, stage_id, remind_days, day_kind, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${screening.id}::uuid, 4, 'calendar', ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`))).toBe('recruitment_stage_waiting_rule_stage');
    // A rule keeps its stage and creation record.
    expect(await code(rows(admin, sql`update recruitment_stage_waiting_rule set stage_id = ${screening.id}::uuid where stage_id = ${w.first}::uuid`))).toBe('23514');
    // Table shape: forced row security, explicit grants to the app role, none to PUBLIC; the stage-entry index exists.
    const [meta] = await owner.db.execute<{ rls: boolean; forced: boolean; app: string; pub: boolean }>(sql`select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      concat_ws(',', case when has_table_privilege('ai_hr_app', c.oid, 'select') then 'select' end, case when has_table_privilege('ai_hr_app', c.oid, 'insert') then 'insert' end,
        case when has_table_privilege('ai_hr_app', c.oid, 'update') then 'update' end, case when has_table_privilege('ai_hr_app', c.oid, 'delete') then 'delete' end) as app,
      exists (select 1 from aclexplode(c.relacl) a where a.grantee = 0) as pub
      from pg_class c where c.relname = 'recruitment_stage_waiting_rule'`);
    expect(meta).toEqual({ rls: true, forced: true, app: 'select,insert,update,delete', pub: false });
    const [idx] = await owner.db.execute<{ def: string }>(sql`select pg_get_indexdef(indexrelid) as def from pg_index where indexrelid = 'recruitment_application_event_stage_entry_idx'::regclass`);
    expect(idx.def).toMatch(/\(application_id, to_stage_id, occurred_at\) WHERE \(to_stage_id IS NOT NULL\)/);
    const [scanIdx] = await owner.db.execute<{ def: string }>(sql`select pg_get_indexdef(indexrelid) as def from pg_index where indexrelid = 'recruitment_application_active_stage_updated_idx'::regclass`);
    expect(scanIdx.def).toMatch(/\(job_id, current_stage_id, updated_at\) WHERE \(state = 'active'::text\)/);
    // Removing a rule: administrators only; the stage stops being reminded.
    await deleteWaitingRule(admin, { companyId: base.companyId, stageId: w.interview });
    expect(await owner.db.execute(sql`select 1 from recruitment_stage_waiting_rule where stage_id = ${w.interview}::uuid`)).toEqual([]);
    expect(await code(deleteWaitingRule(admin, { companyId: base.companyId, stageId: w.interview }))).toBe('not_found');
  });
});

describe('case 116 — waiting days in calendar and working days at Kuala Lumpur day boundaries; moving resets', () => {
  it('the company calendar: national days, the default work state\'s days, and a company override for its year', async () => {
    const [{ id: selangorCo }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Selangor Sdn Bhd', defaultWorkState: 'Selangor' })
      .returning({ id: company.id });
    await owner.db.insert(holiday).values([
      { tenantId: base.tenantId, country: 'MY', holidayDate: '2025-03-03', name: 'QZW national A' },
      { tenantId: base.tenantId, country: 'MY', holidayDate: '2026-03-03', name: 'QZW national B' },
      { tenantId: base.tenantId, country: 'MY', state: 'Selangor', holidayDate: '2025-04-07', name: 'QZW Selangor' },
      { tenantId: base.tenantId, country: 'MY', state: 'Johor', holidayDate: '2025-05-05', name: 'QZW Johor' },
      { tenantId: base.tenantId, country: 'SG', holidayDate: '2025-06-02', name: 'QZW other country' },
      // A company-scoped day in 2026 for the other company: that year it is the whole calendar.
      { tenantId: base.tenantId, country: 'MY', companyId: otherCompanyId, holidayDate: '2026-07-07', name: 'QZW company day' },
    ]);
    const got = await withTenant(admin, (tx) => companyHolidayDatesByCompany(tx, { companyIds: [base.companyId, selangorCo, otherCompanyId], startDate: '2025-01-01', endDate: '2026-12-31' }), { readOnlySnapshot: true });
    const sorted = (id: string) => [...(got.get(id) ?? [])].sort();
    expect(sorted(base.companyId)).toEqual(['2025-03-03', '2026-03-03']);
    expect(sorted(selangorCo)).toEqual(['2025-03-03', '2025-04-07', '2026-03-03']);
    expect(sorted(otherCompanyId)).toEqual(['2025-03-03', '2026-07-07']);
  });

  it('cards, the application page and the read-only context match independently computed days; moving resets', async () => {
    const w = await world();
    const want = expected(w);
    // The Johor day must not have been skipped: the oracle above counts it as a working day.
    expect(want.a5).toBe(oracleDays(shift(w.today, -15), w.today, 'working', new Set([w.h])));
    expect(want.a5).toBeLessThan(oracleDays(shift(w.today, -15), w.today, 'working', new Set()));
    const board = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: w.first });
    const card = (id: string) => board.cards.find((c) => c.id === id);
    expect(card(w.a1.applicationId)?.waiting).toEqual({ days: want.a1, stageName: 'Application Review', suggested: true });
    expect(card(w.a2.applicationId)?.waiting).toEqual({ days: want.a2, stageName: 'Application Review', suggested: false });
    expect(card(w.a3.applicationId)?.waiting).toBeNull();
    const interviewBoard = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: w.interview });
    expect(interviewBoard.cards.find((c) => c.id === w.a5.applicationId)?.waiting).toEqual({ days: want.a5, stageName: 'Interview', suggested: want.a5 >= 6 });
    // a6 waited 30 days in Application Review, then moved: zero in Interview.
    expect(interviewBoard.cards.find((c) => c.id === w.a6.applicationId)?.waiting).toBeNull();
    expect(await applicationWaiting(w.recruiter, w.a1.applicationId)).toEqual({ days: want.a1, stageName: 'Application Review', dayKind: 'calendar', suggested: true });
    expect(await applicationWaiting(w.recruiter, w.a5.applicationId)).toEqual({ days: want.a5, stageName: 'Interview', dayKind: 'working', suggested: want.a5 >= 6 });
    expect(await applicationWaiting(w.recruiter, w.a3.applicationId)).toBeNull();
    expect(await applicationWaiting(w.recruiter, w.a6.applicationId)).toBeNull();
    // Moving a1 resets its wait: it is no longer reminded anywhere.
    await moveApplication(w.recruiter, w.a1.applicationId, w.interview);
    expect(await applicationWaiting(w.recruiter, w.a1.applicationId)).toBeNull();
    // The rules context is write-free: it runs in a READ ONLY snapshot, and the cutoffs agree with the oracle at the boundary days.
    const ctx = await withTenant(w.recruiter, (tx) => waitingContextTx(tx, base.tenantId, [base.companyId], w.today), { readOnlySnapshot: true });
    const first = ctx.cutoffs.get(w.first)!;
    expect(first.remindOn).toBe(shift(w.today, -3));
    expect(first.archiveOn).toBe(shift(w.today, -10));
    const iv = ctx.cutoffs.get(w.interview)!;
    for (let back = 0; back <= 20; back++) {
      const day = shift(w.today, -back);
      expect(day <= iv.remindOn, day).toBe(oracleDays(day, w.today, 'working', new Set([w.h])) >= 2);
      expect(day <= iv.archiveOn!, day).toBe(oracleDays(day, w.today, 'working', new Set([w.h])) >= 6);
    }
  });
});

describe('case 117 — badges, filters and counts follow the rules for active applications only; hiring managers see waiting time only', () => {
  it('counts per stage and the filter for the recruiter; waiting time without the suggestion for the hiring manager', async () => {
    const w = await world();
    const want = expected(w);
    const suggested5 = want.a5 >= 6 ? 1 : 0;
    // Independent expectation: the fixture's active applications of J past each threshold (a4 archived; a6 moved today).
    const board = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: w.first });
    expect(board.waiting).toEqual({
      counts: { [w.first]: { waiting: 3, suggested: 2, capped: false }, [w.interview]: { waiting: 1, suggested: suggested5, capped: false } }, filter: null,
    });
    const waiting = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: w.first, waiting: 'waiting' });
    expect(waiting.waiting?.filter).toBe('waiting');
    expect(waiting.cards.map((c) => c.id).sort()).toEqual([w.a1.applicationId, w.a2.applicationId, w.a7.applicationId].sort());
    expect(waiting.tabs.map((t) => [t.key, t.count]).filter(([, n]) => n)).toEqual([[w.first, 3], [w.interview, 1]]);
    const suggested = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: w.first, waiting: 'suggested' });
    expect(suggested.cards.map((c) => c.id).sort()).toEqual([w.a1.applicationId, w.a7.applicationId].sort());
    // Every job in view: o1 (another job of the recruiter, 50 days) counts too.
    const all = await candidateBoard(w.recruiter, [base.companyId], { tab: w.first });
    expect(all.waiting?.counts[w.first]).toEqual({ waiting: 4, suggested: 3, capped: false });
    // The archived application never counts and never shows a badge.
    const archived = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: 'archived' });
    expect(archived.cards.map((c) => [c.id, c.waiting])).toEqual([[w.a4.applicationId, null]]);
    // The hiring manager: the same waiting time; no suggestion, no suggested counts, the suggested filter ignored.
    const hm = await candidateBoard(w.manager, [base.companyId], { jobId: w.j, tab: w.first, waiting: 'suggested' });
    expect(hm.waiting).toEqual({ counts: { [w.first]: { waiting: 3, suggested: null, capped: false }, [w.interview]: { waiting: 1, suggested: null, capped: false } }, filter: null });
    expect(hm.cards.find((c) => c.id === w.a1.applicationId)?.waiting).toEqual({ days: want.a1, stageName: 'Application Review', suggested: null });
    expect(await applicationWaiting(w.manager, w.a1.applicationId)).toEqual({ days: want.a1, stageName: 'Application Review', dayKind: 'calendar', suggested: null });
    // An interviewer gets no waiting information; a bystander cannot open the board.
    expect((await candidateBoard(w.interviewer, [base.companyId], { tab: w.first })).waiting).toBeNull();
    expect(await code(candidateBoard(w.bystander, [base.companyId], {}))).toBe('forbidden');
    // Without rules nothing shows (the board is as before).
    await deleteWaitingRule(admin, { companyId: base.companyId, stageId: w.first });
    await deleteWaitingRule(admin, { companyId: base.companyId, stageId: w.interview });
    const none = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j, tab: w.first, waiting: 'waiting' });
    expect(none.waiting).toBeNull();
    expect(none.cards.every((c) => c.waiting === null)).toBe(true);
    expect(none.cards.length).toBe(4);
  });
});

describe('case 118 — the suggested list archives only what an operator selects, with a reason, through the normal guards', () => {
  it('lists, refuses per application, archives the rest in one action and respects the blocked-list hold', async () => {
    const w = await world();
    const want = expected(w);
    // Nothing was archived by the rules themselves.
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application where job_id = ${w.j}::uuid and state = 'archived'`))[0].n).toBe(1);
    const list = await suggestedArchiveList(w.recruiter, w.j);
    const expectedRows = [
      { applicationId: w.a7.applicationId, days: want.a7, needsReview: true },
      ...(want.a5 >= 6 ? [{ applicationId: w.a5.applicationId, days: want.a5, needsReview: false }] : []),
      { applicationId: w.a1.applicationId, days: want.a1, needsReview: false },
    ];
    expect(list.rows.map((r) => ({ applicationId: r.applicationId, days: r.days, needsReview: r.needsReview }))).toEqual(expectedRows);
    expect(list.rows[0].candidateName).toBe('QZW Fictional Candidate 7');
    expect(list.hasRules).toBe(true);
    for (const who of [w.manager, w.interviewer, w.bystander]) {
      expect(await code(suggestedArchiveList(who, w.j))).toMatch(/^(forbidden|not_found)$/);
      expect(await code(archiveSuggestedApplications(who, { jobId: w.j, applicationIds: [w.a1.applicationId], archiveReasonId: w.reason }))).toMatch(/^(forbidden|not_found)$/);
    }
    // A reason of another company refuses the whole action; so does an empty selection.
    await jobFormOptions(admin, otherCompanyId);
    const [foreign] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_archive_reason where company_id = ${otherCompanyId}::uuid limit 1`);
    expect(await code(archiveSuggestedApplications(w.recruiter, { jobId: w.j, applicationIds: [w.a1.applicationId], archiveReasonId: foreign.id }))).toBe('reason_required');
    expect(await code(archiveSuggestedApplications(w.recruiter, { jobId: w.j, applicationIds: [], archiveReasonId: w.reason }))).toBe('missing_fields');
    expect(await code(archiveSuggestedApplications(w.recruiter, { jobId: w.j, applicationIds: ['not-an-id'], archiveReasonId: w.reason }))).toBe('invalid_input');
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application where job_id = ${w.j}::uuid and state = 'archived'`))[0].n).toBe(1);

    const unknown = randomUUID();
    const result = await archiveSuggestedApplications(w.recruiter, {
      jobId: w.j, archiveReasonId: w.reason,
      applicationIds: [w.a1.applicationId, w.a2.applicationId, w.a7.applicationId, w.a4.applicationId, w.o1.applicationId, unknown],
    });
    expect(result.archived).toEqual([w.a1.applicationId]);
    expect(result.refused).toEqual([
      { applicationId: w.a2.applicationId, code: 'not_suggested' }, { applicationId: w.a7.applicationId, code: 'needs_review' },
      { applicationId: w.a4.applicationId, code: 'application_closed' }, { applicationId: w.o1.applicationId, code: 'not_found' },
      { applicationId: unknown, code: 'not_found' },
    ]);
    // a1 went through the normal reject: archived with the reason, the stage it left, and one 'rejected' event by the recruiter.
    const [a1] = await owner.db.execute<Record<string, unknown>>(sql`select state, archive_reason_id, stage_left_at_archive, updated_by_user_id from recruitment_application where id = ${w.a1.applicationId}::uuid`);
    expect(a1).toEqual({ state: 'archived', archive_reason_id: w.reason, stage_left_at_archive: w.first, updated_by_user_id: w.recruiter.userId });
    const events = await owner.db.execute<Record<string, unknown>>(sql`select kind, from_stage_id, to_stage_id, from_state, to_state, archive_reason_id, actor_user_id
      from recruitment_application_event where application_id = ${w.a1.applicationId}::uuid and kind = 'rejected'`);
    expect(events).toEqual([{ kind: 'rejected', from_stage_id: w.first, to_stage_id: null, from_state: 'active', to_state: 'archived', archive_reason_id: w.reason, actor_user_id: w.recruiter.userId }]);
    // Everything else is as it was: the held application, the one not yet suggested and the other job's.
    const states = await owner.db.execute<{ id: string; state: string }>(sql`select id, state from recruitment_application
      where id = any(${`{${[w.a2.applicationId, w.a7.applicationId, w.o1.applicationId].join(',')}}`}::uuid[]) order by id`);
    expect(states.every((s) => s.state === 'active')).toBe(true);
    // The list no longer shows a1.
    expect((await suggestedArchiveList(w.recruiter, w.j)).rows.map((r) => r.applicationId)).not.toContain(w.a1.applicationId);
  });
});

describe('case 119 — the Overview workload shows the per-job counts; the bell is unchanged', () => {
  it('per job: applications waiting too long and suggested to archive, linked to the filter and the list; none in the bell', async () => {
    const w = await world();
    const want = expected(w);
    const jobs = await recruitmentWaitingTodos(w.recruiter, undefined);
    expect(jobs.status).toBe('ok');
    const items = jobs.status === 'ok' ? jobs.items : [];
    expect(items.every((i) => (i.kind === 'waiting' || i.kind === 'suggestedArchive') && i.countCapped === false)).toBe(true);
    // The slice 9 per-job counts no longer carry them (their own statement and timeout).
    const slice9 = await recruitmentJobTodos(w.recruiter, undefined);
    expect(slice9.status === 'ok' ? slice9.items.filter((i) => i.kind === 'waiting' || i.kind === 'suggestedArchive') : 'unavailable').toEqual([]);
    // Independently: J has a1, a2, a5, a7 past the reminder and a1, a7 (+ a5) past the suggestion; J2 has o1 (50 days) for both.
    expect(items.map((i) => `${i.kind}:${i.id}:${i.count}`).sort()).toEqual([
      `suggestedArchive:${w.j}:${2 + (want.a5 >= 6 ? 1 : 0)}`, `suggestedArchive:${w.j2}:1`, `waiting:${w.j}:4`, `waiting:${w.j2}:1`,
    ].sort());
    expect(items.find((i) => i.kind === 'waiting' && i.id === w.j)!.href).toBe(`/recruitment/candidates?job=${w.j}&waiting=waiting`);
    expect(items.find((i) => i.kind === 'suggestedArchive' && i.id === w.j)!.href).toBe(`/recruitment/suggested-archive?job=${w.j}`);
    // Only the job's recruiters and assistants get them (as for slice 9's per-job counts); the hiring manager none.
    const hmJobs = await recruitmentWaitingTodos(w.manager, undefined);
    expect(hmJobs).toEqual({ status: 'ok', items: [] });
    // The bell and the personal list carry none of them.
    expect((await recruitmentTodos(w.recruiter, undefined)).some((i) => i.kind === 'waiting' || i.kind === 'suggestedArchive')).toBe(false);
    expect((await pendingRecruitmentTasks(w.recruiter, undefined)).some((i) => /waiting|suggested/i.test(`${i.kind}${i.linkPath}`))).toBe(false);
  });
});

describe('5718 — the company delete covers the rules; restated byte for byte; the AI Centre read is counts only', () => {
  it('restates the company delete as 5717 plus one step; leaves the candidate removal as it was', () => {
    const read = (file: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${file}`, import.meta.url)), 'utf8');
    const fn = (source: string, name: string) => {
      const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('END $$;', start) + 'END $$;'.length);
    };
    const b = fn(read('5717_recruitment_import_export.sql'), 'app.recruitment_delete_company_setup').split('\n');
    const a = fn(read('5718_recruitment_waiting_limits.sql'), 'app.recruitment_delete_company_setup').split('\n');
    let i = 0;
    while (i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    expect(i + j).toBe(b.length);
    expect(b.length).toBeGreaterThan(90);
    const added = a.slice(i, a.length - j);
    expect(added.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual(['public.recruitment_stage_waiting_rule']);
    expect(added).toHaveLength(4);
    // Before the stages the rules name.
    expect(a.findIndex((l) => l.includes('DELETE FROM public.recruitment_stage_waiting_rule'))).toBeLessThan(a.findIndex((l) => l.includes('DELETE FROM public.recruitment_stage WHERE')));
    expect(read('5718_recruitment_waiting_limits.sql')).not.toContain('recruitment_destroy_candidate(p_candidate');
    // The journal names the file at its reserved place.
    const journal = JSON.parse(read('meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.find((e) => e.tag === '5718_recruitment_waiting_limits')).toMatchObject({ idx: 5118, when: 1793330005418 });
  });

  it('deleting a company with only setup removes its rules (every row of its recruitment tables counted); the AI Centre counts keep their keys', async () => {
    await jobFormOptions(admin, otherCompanyId);
    const stage = (await recruitmentSettings(admin, otherCompanyId)).stages.find((s) => s.name === 'Interview')!.id;
    await saveWaitingRule(admin, { companyId: otherCompanyId, stageId: stage, remindDays: '5', archiveDays: '', dayKind: 'working' });
    // Independently: every row of the company in every recruitment table with a company_id column, read by the owner — except a
    // process's ordered stages, which go with their process by ON DELETE CASCADE (not counted by the function's row counts).
    const tables = await owner.db.execute<{ t: string }>(sql`select c.table_name as t from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'company_id' and c.table_name like 'recruitment\\_%' and c.table_name <> 'recruitment_process_stage' order by 1`);
    let before = 0;
    for (const { t } of tables) before += (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(t)} where company_id = ${otherCompanyId}::uuid`))[0].n;
    expect(before).toBeGreaterThan(1);
    const [removed] = await withTenant(adminCtx(base), (tx) => tx.execute<{ n: number }>(sql`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid) as n`));
    expect(Number(removed.n)).toBe(before);
    expect(await owner.db.execute(sql`select 1 from recruitment_stage_waiting_rule where company_id = ${otherCompanyId}::uuid`)).toEqual([]);
    // The company with jobs still refuses (retained history).
    await world();
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
    const counts = await recruitmentPipelineCounts(admin);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    expect(counts.rows.length).toBeGreaterThan(0);
    for (const row of counts.rows) expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
    expect(JSON.stringify(counts)).not.toMatch(/QZW|waiting|suggest/i);
  });
});

/** Fixture time travel to an exact instant: the application was received and entered its (first) stage then. */
async function enteredAt(applicationId: string, instant: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_application set applied_at = ${instant}::timestamptz, updated_at = ${instant}::timestamptz where id = ${applicationId}::uuid`;
    await tx`update recruitment_application_event set occurred_at = ${instant}::timestamptz where application_id = ${applicationId}::uuid`;
  });
}

describe('case 116/117 — Kuala Lumpur day boundaries (23:59 and 00:01 KL, i.e. 15:59Z and 16:01Z)', () => {
  it('counts days, cutoff membership, the filter and the counts by the Kuala Lumpur day, not the UTC one', async () => {
    const today = todayInKualaLumpur();
    const recruiter = await login('Fictional Boundary Recruiter');
    await jobFormOptions(admin, base.companyId);
    const first = (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === 'Application Review')!.id;
    const { id: j } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
    const add = async (n: number) => (await addApplication(recruiter, { jobId: j, fullName: `QZW Fictional Boundary ${n}`, email: `qzwb${n}@example.test` })).applicationId;
    const [b1, b2, b3, b4] = [await add(1), await add(2), await add(3), await add(4)];
    // 23:59 KL is 15:59Z the same day; 00:01 KL is 16:01Z the PREVIOUS UTC day.
    await enteredAt(b1, `${shift(today, -3)}T15:59:00Z`); // KL day today−3 → 3 days
    await enteredAt(b2, `${shift(today, -3)}T16:01:00Z`); // KL day today−2 → 2 days (UTC day today−3 would say 3)
    await enteredAt(b3, `${shift(today, -4)}T15:59:00Z`); // KL day today−4 → 4 days
    await enteredAt(b4, `${shift(today, -4)}T16:01:00Z`); // KL day today−3 → 3 days (UTC day today−4 would say 4)
    await saveWaitingRule(admin, { companyId: base.companyId, stageId: first, remindDays: '3', archiveDays: '4', dayKind: 'calendar' });
    // Independently: the KL days are 3, 2, 4 and 3.
    expect([shift(today, -3), shift(today, -2), shift(today, -4), shift(today, -3)].map((d) => oracleDays(d, today, 'calendar', new Set()))).toEqual([3, 2, 4, 3]);
    const board = await candidateBoard(recruiter, [base.companyId], { jobId: j, tab: first });
    expect(Object.fromEntries(board.cards.map((c) => [c.id, c.waiting]))).toEqual({
      [b1]: { days: 3, stageName: 'Application Review', suggested: false }, [b2]: null,
      [b3]: { days: 4, stageName: 'Application Review', suggested: true }, [b4]: { days: 3, stageName: 'Application Review', suggested: false },
    });
    expect(board.waiting?.counts[first]).toEqual({ waiting: 3, suggested: 1, capped: false });
    expect((await candidateBoard(recruiter, [base.companyId], { jobId: j, tab: first, waiting: 'waiting' })).cards.map((c) => c.id).sort()).toEqual([b1, b3, b4].sort());
    expect((await candidateBoard(recruiter, [base.companyId], { jobId: j, tab: first, waiting: 'suggested' })).cards.map((c) => c.id)).toEqual([b3]);
    // The cutoff days themselves: entered on or before them ⇔ reminded / suggested.
    const ctx = await withTenant(recruiter, (tx) => waitingContextTx(tx, base.tenantId, [base.companyId], today), { readOnlySnapshot: true });
    expect(ctx.cutoffs.get(first)).toMatchObject({ remindOn: shift(today, -3), archiveOn: shift(today, -4) });
    const overview = await recruitmentWaitingTodos(recruiter, undefined);
    expect(overview.status === 'ok' ? overview.items.map((i) => `${i.kind}:${i.count}`).sort() : 'unavailable').toEqual(['suggestedArchive:1', 'waiting:3']);
    expect((await suggestedArchiveList(recruiter, j)).rows.map((r) => r.applicationId)).toEqual([b3]);
  });
});

describe('case 118 — races between listing and archiving', () => {
  it('an application listed as suggested and then moved is refused as no longer suggested', async () => {
    const w = await world();
    expect((await suggestedArchiveList(w.recruiter, w.j)).rows.map((r) => r.applicationId)).toContain(w.a1.applicationId);
    await moveApplication(w.recruiter, w.a1.applicationId, w.interview);
    const result = await archiveSuggestedApplications(w.recruiter, { jobId: w.j, applicationIds: [w.a1.applicationId], archiveReasonId: w.reason });
    expect(result).toEqual({ archived: [], refused: [{ applicationId: w.a1.applicationId, code: 'not_suggested' }] });
    expect((await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${w.a1.applicationId}::uuid`))[0].state).toBe('active');
  });

  it('a blocked-list hold added after listing is respected', async () => {
    const w = await world();
    const listed = (await suggestedArchiveList(w.recruiter, w.j)).rows.find((r) => r.applicationId === w.a1.applicationId);
    expect(listed?.needsReview).toBe(false);
    await blockCandidate(admin, w.a1.candidateId, 'Fictional QZW later reason');
    const result = await archiveSuggestedApplications(w.recruiter, { jobId: w.j, applicationIds: [w.a1.applicationId], archiveReasonId: w.reason });
    expect(result).toEqual({ archived: [], refused: [{ applicationId: w.a1.applicationId, code: 'needs_review' }] });
    expect((await owner.db.execute<{ state: string }>(sql`select state from recruitment_application where id = ${w.a1.applicationId}::uuid`))[0].state).toBe('active');
  });
});

describe('case 119 at scale — bounded reads, "N+" when capped, and the waiting counts degrade on their own', () => {
  /** `n` active applications of `jobId` in `stage`, received `receivedDaysAgo` (a second apart, in order) and moved into the stage
   *  `movedDaysAgo` — one owner statement, past the guards (fixture only). Returns nothing; the counts below are read independently. */
  async function bulk(jobId: string, n: number, first: string, stage: string, userId: string, receivedDaysAgo: number, movedDaysAgo: number, label: string) {
    const today = todayInKualaLumpur();
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        with g as materialized (select gs as k, gen_random_uuid() as cid, gen_random_uuid() as aid from generate_series(1, ${n}::int) gs),
        c as (insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
          select g.cid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${label} || ' ' || g.k, ${userId}::uuid, ${userId}::uuid from g returning 1),
        a as (insert into recruitment_application (id, tenant_id, company_id, job_id, candidate_id, current_stage_id, applied_at, updated_at, created_by_user_id, updated_by_user_id)
          select g.aid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${jobId}::uuid, g.cid, ${stage}::uuid,
            ${`${shift(today, -receivedDaysAgo)}T09:00:00+08:00`}::timestamptz + g.k * interval '1 second',
            ${`${shift(today, -movedDaysAgo)}T10:00:00+08:00`}::timestamptz + g.k * interval '1 second', ${userId}::uuid, ${userId}::uuid from g returning 1),
        e1 as (insert into recruitment_application_event (tenant_id, company_id, application_id, kind, to_stage_id, to_state, actor_user_id, occurred_at)
          select ${base.tenantId}::uuid, ${base.companyId}::uuid, g.aid, 'applied', ${first}::uuid, 'active', ${userId}::uuid,
            ${`${shift(today, -receivedDaysAgo)}T09:00:00+08:00`}::timestamptz + g.k * interval '1 second' from g returning 1)
        insert into recruitment_application_event (tenant_id, company_id, application_id, kind, from_stage_id, to_stage_id, from_state, to_state, actor_user_id, occurred_at)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, g.aid, 'moved', ${first}::uuid, ${stage}::uuid, 'active', 'active', ${userId}::uuid,
          ${`${shift(today, -movedDaysAgo)}T10:00:00+08:00`}::timestamptz from g`;
    });
  }
  async function scaleWorld() {
    const recruiter = await login('Fictional Scale Recruiter');
    await jobFormOptions(admin, base.companyId);
    const stages = (await recruitmentSettings(admin, base.companyId)).stages;
    const first = stages.find((s) => s.name === 'Application Review')!.id;
    const interview = stages.find((s) => s.name === 'Interview')!.id;
    const make = async (title: string) => (await createJob(admin, job({ title, recruiterUserId: recruiter.userId }))).id;
    const [j1, j2, j3, j4] = [await make('QZW Fictional scale one'), await make('QZW Fictional scale two'), await make('QZW Fictional scale three'),
      await make('QZW Fictional scale four')];
    // J1: 300 (under the bound): 25 moved in 10 days ago (past both limits), 275 moved in yesterday.
    await bulk(j1, 25, first, interview, recruiter.userId, 100, 10, 'QZW Fictional S1w');
    await bulk(j1, 275, first, interview, recruiter.userId, 99, 1, 'QZW Fictional S1r');
    // J2: 1,200: the 40 received FIRST moved in 8 days ago; 1,160 received later moved in yesterday. The bound reads the 500 oldest
    // received, which include all 40 — and there are more: "40+".
    await bulk(j2, 40, first, interview, recruiter.userId, 200, 8, 'QZW Fictional S2w');
    await bulk(j2, 1160, first, interview, recruiter.userId, 100, 1, 'QZW Fictional S2r');
    // J3: 1,500 received long ago, all moved in yesterday: nothing waiting.
    await bulk(j3, 1500, first, interview, recruiter.userId, 150, 1, 'QZW Fictional S3r');
    // J4: waiting applications BEYOND the first 500 by received date: 600 received early but moved yesterday, 10 received later but
    // moved 10 days ago. Least recently updated first, the 10 are read first: "10+".
    await bulk(j4, 600, first, interview, recruiter.userId, 300, 1, 'QZW Fictional S4r');
    await bulk(j4, 10, first, interview, recruiter.userId, 100, 10, 'QZW Fictional S4w');
    await saveWaitingRule(admin, { companyId: base.companyId, stageId: interview, remindDays: '2', archiveDays: '6', dayKind: 'calendar' });
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application where company_id = ${base.companyId}::uuid and state = 'active'`);
    expect(n).toBe(3610);
    return { recruiter, interview, j1, j2, j3, j4 };
  }

  it('a few thousand applications: correct counts under the bound, lower bounds ("N+") over it, within the timeout', { timeout: 120_000 }, async () => {
    const w = await scaleWorld();
    expect(WAITING_SCAN_LIMIT).toBeLessThan(1200);
    expect(WAITING_SCAN_LIMIT).toBeGreaterThan(300);
    const started = Date.now();
    const result = await recruitmentWaitingTodos(w.recruiter, undefined);
    const elapsed = Date.now() - started;
    expect(result.status).toBe('ok');
    expect(elapsed).toBeLessThan(WAITING_TODOS_TIMEOUT_MS);
    const items = result.status === 'ok' ? result.items : [];
    // J3 found none in its first 500 but has more: shown as "0+" (there may be more), never silently absent.
    expect(items.map((i) => `${i.kind}:${i.id}:${i.count}:${i.countCapped}`).sort()).toEqual([
      `suggestedArchive:${w.j1}:25:false`, `suggestedArchive:${w.j2}:40:true`, `suggestedArchive:${w.j3}:0:true`, `suggestedArchive:${w.j4}:10:true`,
      `waiting:${w.j1}:25:false`, `waiting:${w.j2}:40:true`, `waiting:${w.j3}:0:true`, `waiting:${w.j4}:10:true`,
    ].sort());
    // The board: the same bound per stage.
    const b1 = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j1, tab: w.interview });
    expect(b1.waiting?.counts[w.interview]).toEqual({ waiting: 25, suggested: 25, capped: false });
    const f1 = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j1, tab: w.interview, waiting: 'waiting' });
    expect(f1.cards.length).toBe(25);
    expect(f1.cards.every((c) => c.waiting?.suggested === true)).toBe(true);
    const b2 = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j2, tab: w.interview, waiting: 'suggested' });
    expect(b2.waiting?.counts[w.interview]).toEqual({ waiting: 40, suggested: 40, capped: true });
    expect(b2.cards.length).toBe(40);
    expect(b2.tabs.find((t) => t.key === w.interview)?.count).toBe(40);
    const b3 = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j3, tab: w.interview });
    expect(b3.waiting?.counts[w.interview]).toEqual({ waiting: 0, suggested: 0, capped: true });
    // The suggested list of the busy job: its 40, longest waiting first, and it says the list is partial.
    const list = await suggestedArchiveList(w.recruiter, w.j2);
    expect(list.rows).toHaveLength(40);
    expect(list.truncated).toBe(true);
    // Waiting applications received AFTER 600 others: found and flagged "+" on the board, the Overview (above) and the list.
    const b4 = await candidateBoard(w.recruiter, [base.companyId], { jobId: w.j4, tab: w.interview, waiting: 'waiting' });
    expect(b4.waiting?.counts[w.interview]).toEqual({ waiting: 10, suggested: 10, capped: true });
    expect(b4.cards).toHaveLength(10);
    const list4 = await suggestedArchiveList(w.recruiter, w.j4);
    expect([list4.rows.length, list4.truncated]).toEqual([10, true]);
    // A capped scan with none found still says the list is partial.
    const list3 = await suggestedArchiveList(w.recruiter, w.j3);
    expect([list3.rows.length, list3.truncated]).toEqual([0, true]);
    // Every job at once: the board stops at WAITING_BOARD_SCAN_LIMIT in all (3,610 candidates here) and flags every stage "+"; read
    // least recently updated first, the stage's 500 hold all 75 waiting applications (25 + 40 + 10, moved 8–10 days ago).
    expect(WAITING_BOARD_SCAN_LIMIT).toBeLessThan(3610);
    const all = await candidateBoard(w.recruiter, [base.companyId], { tab: w.interview, waiting: 'waiting' });
    expect(all.waiting?.counts[w.interview]).toEqual({ waiting: 75, suggested: 75, capped: true });
    expect(all.tabs.find((t) => t.key === w.interview)?.count).toBe(75);
    // Without any suggest-archiving limit in the company, a capped job shows "waiting 0+" but never a "suggested to archive 0+".
    await saveWaitingRule(admin, { companyId: base.companyId, stageId: w.interview, remindDays: '2', archiveDays: '', dayKind: 'calendar' });
    const noArchive = await recruitmentWaitingTodos(w.recruiter, undefined);
    expect(noArchive.status === 'ok' ? noArchive.items.map((i) => `${i.kind}:${i.id}:${i.count}:${i.countCapped}`).sort() : 'unavailable').toEqual([
      `waiting:${w.j1}:25:false`, `waiting:${w.j2}:40:true`, `waiting:${w.j3}:0:true`, `waiting:${w.j4}:10:true`,
    ].sort());
  });

  it('a forced timeout of the waiting statement leaves To schedule, To screen and To assign intact', async () => {
    const w = await world();
    const ROLLBACK = 'released on purpose';
    // Hold the rules table so the waiting read cannot finish; nothing else on the Overview reads it.
    const done = await owner.client.begin(async (tx) => {
      await tx`lock table recruitment_stage_waiting_rule in access exclusive mode`;
      expect(await recruitmentWaitingTodos(w.recruiter, undefined, { timeoutMs: 300 })).toEqual({ status: 'unavailable' });
      const jobs = await recruitmentJobTodos(w.recruiter, undefined);
      expect(jobs.status).toBe('ok');
      // Independently from the fixture: a1, a2, a3 and a7 never moved (to screen on J; a4 is archived), and o1 on J2.
      expect(jobs.status === 'ok' ? jobs.items.filter((i) => i.kind === 'toScreen').map((i) => `${i.id}:${i.count}`).sort() : []).toEqual([`${w.j}:4`, `${w.j2}:1`].sort());
      throw new Error(ROLLBACK);
    }).catch((err: unknown) => (err instanceof Error && err.message === ROLLBACK ? 'released' : Promise.reject(err)));
    expect(done).toBe('released');
    // Afterwards they load again.
    expect((await recruitmentWaitingTodos(w.recruiter, undefined)).status).toBe('ok');
  });
});
