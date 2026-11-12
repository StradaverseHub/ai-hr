/**
 * Recruitment slice 13 against Postgres — custom talent pools: acceptance cases 88 and 89
 * (docs/recruitment-reconstruction/specification.md "Slice 13 acceptance cases"), through the service AND directly as the app
 * role. The blocked list (cases 90–93) is test/recruitment-blocked-list.test.ts; the pure rules are
 * test/recruitment-pools-rules.test.ts. Case 94 is the lead's rendered check.
 *
 * Expected values are computed independently of packs/recruitment/pools.ts: from what each fixture step did (which candidate
 * went into which pool, by whom) and from plain owner-connection SQL that ignores row security. Every person is fictional.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import {
  addApplication, addCandidateToPool, addJobMember, applicationPools, candidateBoard, createJob, deletePool, poolChoices, poolMembers, poolNav, poolSettings,
  recruitmentSettings, recruitmentViewer, rejectApplication, removeCandidateFromPool, savePool, talentPool, RecruitmentError,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const rows = <T = Record<string, unknown>>(ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute<T & Record<string, unknown>>(query));
const constraintOf = async (operation: Promise<unknown>) => {
  const e = await operation.then(() => null, (x: unknown) => x);
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  return e === null ? 'ok' : pgSqlState(e) ?? 'unknown';
};
type Login = SessionContext & { userId: string };
async function login(name: string): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId: base.companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
let seq = 0;
/** Two jobs: job 1 (recruiter r1, hiring manager hm, interviewer iv), job 2 (recruiter r2); and a bystander. */
async function fixture() {
  const [r1, r2, hm, iv, bystander] = await Promise.all([login('Fictional Recruiter One'), login('Fictional Recruiter Two'), login('Fictional Manager'),
    login('Fictional Interviewer'), login('Fictional Bystander')]);
  const job = { companyId: base.companyId, jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time' };
  const { id: job1 } = await createJob(admin, { ...job, title: 'Fictional analyst', recruiterUserId: r1.userId });
  const { id: job2 } = await createJob(admin, { ...job, title: 'Fictional engineer', recruiterUserId: r2.userId });
  await addJobMember(admin, job1, 'hiring_manager', hm.userId);
  await addJobMember(admin, job1, 'interviewer', iv.userId);
  return { r1, r2, hm, iv, bystander, job1, job2 };
}
const apply = async (ctx: SessionContext, jobId: string) => addApplication(ctx, { jobId, fullName: `Fictional Candidate ${++seq}`, email: `pool${seq}@example.test` });
const poolRow = async (id: string) => (await owner.db.execute<{ parent_id: string | null; sharing: string; name: string }>(sql`
  select parent_id, sharing, name from recruitment_talent_pool where id = ${id}::uuid`))[0];
const membersOf = async (poolId: string) => (await owner.db.execute<{ candidate_id: string }>(sql`
  select candidate_id from recruitment_talent_pool_member where pool_id = ${poolId}::uuid order by candidate_id`)).map((r) => r.candidate_id);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('case 88 — administrators manage pools; sharing hides a pool and its members; two levels; deleting keeps candidates', () => {
  it('only administrators create, edit, share and delete pools (service and database)', async () => {
    const f = await fixture();
    expect(await code(savePool(f.r1, { companyId: base.companyId, name: 'Fictional pool' }))).toBe('forbidden');
    const { id: a } = await savePool(admin, { companyId: base.companyId, name: 'Fictional graduates', description: 'Fictional description' });
    expect(await poolRow(a)).toEqual({ parent_id: null, sharing: 'all_recruiters', name: 'Fictional graduates' });
    expect(await code(savePool(f.r1, { id: a, name: 'Renamed by a recruiter' }))).toBe('forbidden');
    expect(await code(savePool(f.r1, { id: a, name: 'Fictional graduates', sharing: 'listed_users', sharedUserIds: [f.r1.userId] }))).toBe('forbidden');
    expect(await code(deletePool(f.r1, a))).toBe('forbidden');
    expect(await code(poolSettings(f.r1, base.companyId))).toBe('forbidden');
    // Directly as the app role: a recruiter's insert, update, delete and share are refused or touch nothing.
    expect(await code(rows(f.r1, sql`insert into recruitment_talent_pool (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Direct pool', ${f.r1.userId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    expect(await rows(f.r1, sql`update recruitment_talent_pool set name = 'Direct rename' where id = ${a}::uuid returning id`)).toHaveLength(0);
    expect(await rows(f.r1, sql`delete from recruitment_talent_pool where id = ${a}::uuid returning id`)).toHaveLength(0);
    expect(await code(rows(f.r1, sql`insert into recruitment_talent_pool_share (pool_id, app_user_id, tenant_id, company_id, created_by_user_id)
      values (${a}::uuid, ${f.r1.userId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    expect((await poolRow(a)).name).toBe('Fictional graduates');
    // The administrator edits and deletes.
    await savePool(admin, { id: a, name: 'Fictional graduates 2026', description: '' });
    expect((await poolRow(a)).name).toBe('Fictional graduates 2026');
    expect(await code(savePool(admin, { companyId: base.companyId, name: 'fictional GRADUATES 2026' }))).toBe('name_taken');
    expect(await deletePool(admin, a)).toEqual({ removedMembers: 0 });
    expect(await owner.db.execute(sql`select 1 from recruitment_talent_pool where id = ${a}::uuid`)).toHaveLength(0);
  });

  it('sharing to listed users hides the pool, its sub-pools and their members from everyone else (service and database)', async () => {
    const f = await fixture();
    const { id: open } = await savePool(admin, { companyId: base.companyId, name: 'Fictional open pool' });
    const { id: listed } = await savePool(admin, { companyId: base.companyId, name: 'Fictional listed pool', sharing: 'listed_users', sharedUserIds: [f.r1.userId] });
    const { id: sub } = await savePool(admin, { companyId: base.companyId, name: 'Fictional listed sub-pool', parentId: listed, sharing: 'all_recruiters' });
    // A sub-pool follows its pool's sharing, whatever was asked.
    expect((await poolRow(sub)).sharing).toBe('listed_users');
    const c1 = await apply(f.r1, f.job1);
    const c2 = await apply(f.r2, f.job2);
    await addCandidateToPool(admin, listed, c1.candidateId);
    await addCandidateToPool(admin, sub, c1.candidateId);
    await addCandidateToPool(admin, listed, c2.candidateId);
    await addCandidateToPool(admin, open, c2.candidateId);
    // Independently: what each viewer may see.
    const visible = async (who: SessionContext) => {
      const nav = await poolNav(who, [base.companyId]);
      return nav.pools.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]).sort();
    };
    expect(await visible(admin)).toEqual([open, listed, sub].sort());
    expect(await visible(f.r1)).toEqual([open, listed, sub].sort());
    expect(await visible(f.r2)).toEqual([open]);
    for (const who of [f.hm, f.iv, f.bystander]) expect(await visible(who)).toEqual([]);
    expect(await code(poolMembers(f.r2, listed))).toBe('not_found');
    expect(await code(poolMembers(f.r2, sub))).toBe('not_found');
    expect(await code(addCandidateToPool(f.r2, listed, c2.candidateId))).toBe('not_found');
    // Directly: the hidden pool and its memberships return no row; a membership insert into it is refused.
    expect(await rows(f.r2, sql`select id from recruitment_talent_pool where id = any(${`{${listed},${sub}}`}::uuid[])`)).toHaveLength(0);
    expect(await rows(f.r2, sql`select candidate_id from recruitment_talent_pool_member where pool_id = any(${`{${listed},${sub}}`}::uuid[])`)).toHaveLength(0);
    expect(await code(rows(f.r2, sql`insert into recruitment_talent_pool_member (pool_id, candidate_id, tenant_id, company_id, added_by_user_id)
      values (${listed}::uuid, ${c2.candidateId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.r2.userId}::uuid)`))).toBe('42501');
    expect((await rows<{ id: string }>(f.r1, sql`select id from recruitment_talent_pool where id = any(${`{${listed},${sub}}`}::uuid[]) order by id`)).map((r) => r.id))
      .toEqual([listed, sub].sort());
    for (const who of [f.hm, f.iv, f.bystander]) {
      expect(await rows(who, sql`select 1 from recruitment_talent_pool where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
      expect(await rows(who, sql`select 1 from recruitment_talent_pool_member where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
      expect(await rows(who, sql`select 1 from recruitment_talent_pool_share where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
    }
    // The listed recruiter sees the members they operate (c1), not r2's candidate in the same pool.
    expect((await poolMembers(f.r1, listed)).cards.map((c) => c.candidateId)).toEqual([c1.candidateId]);
    expect((await poolMembers(admin, listed)).cards.map((c) => c.candidateId).sort()).toEqual([c1.candidateId, c2.candidateId].sort());
    // Sharing with all recruiters reaches the sub-pool too.
    await savePool(admin, { id: listed, name: 'Fictional listed pool', sharing: 'all_recruiters' });
    expect((await poolRow(sub)).sharing).toBe('all_recruiters');
    expect(await visible(f.r2)).toEqual([open, listed, sub].sort());
    expect(await owner.db.execute(sql`select 1 from recruitment_talent_pool_share where pool_id = ${listed}::uuid`)).toHaveLength(0);
    // The viewer flags: pools for administrators and operators only.
    const viewer = async (who: SessionContext) => (await recruitmentViewer(who, [base.companyId])).poolCompanies.map((c) => c.id);
    expect(await viewer(admin)).toEqual([base.companyId]);
    expect(await viewer(f.r1)).toEqual([base.companyId]);
    expect(await viewer(f.hm)).toEqual([]);
    expect(await viewer(f.iv)).toEqual([]);
  });

  it('pools nest two levels at most; a pool with sub-pools is deleted only after them; deleting a pool keeps its candidates', async () => {
    const f = await fixture();
    const { id: top } = await savePool(admin, { companyId: base.companyId, name: 'Fictional top' });
    const { id: sub } = await savePool(admin, { companyId: base.companyId, name: 'Fictional sub', parentId: top });
    expect(await poolRow(sub)).toMatchObject({ parent_id: top });
    expect(await code(savePool(admin, { companyId: base.companyId, name: 'Fictional third level', parentId: sub }))).toBe('pool_depth');
    // The database refuses a third level and moving a pool under another, whoever writes.
    expect(await constraintOf(rows(admin, sql`insert into recruitment_talent_pool (tenant_id, company_id, parent_id, name, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${sub}::uuid, 'Direct third', ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`))).toBe('recruitment_talent_pool_depth');
    const { id: other } = await savePool(admin, { companyId: base.companyId, name: 'Fictional other' });
    expect(await constraintOf(rows(admin, sql`update recruitment_talent_pool set parent_id = ${top}::uuid where id = ${other}::uuid`))).toBe('recruitment_talent_pool_fixed');
    expect(await constraintOf(rows(admin, sql`insert into recruitment_talent_pool_share (pool_id, app_user_id, tenant_id, company_id, created_by_user_id)
      values (${sub}::uuid, ${f.r1.userId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${base.adminUserId}::uuid)`))).toBe('recruitment_talent_pool_depth');
    // Sibling names are unique; the same name under another parent is fine.
    expect(await code(savePool(admin, { companyId: base.companyId, name: 'Fictional SUB', parentId: top }))).toBe('name_taken');
    await savePool(admin, { companyId: base.companyId, name: 'Fictional sub', parentId: other });
    // Deleting: the top pool waits for its sub-pool (service and database).
    expect(await code(deletePool(admin, top))).toBe('pool_has_subpools');
    expect(await constraintOf(rows(admin, sql`delete from recruitment_talent_pool where id = ${top}::uuid`))).toBe('recruitment_talent_pool_has_subpools');
    const a = await apply(f.r1, f.job1);
    const b = await apply(f.r1, f.job1);
    await addCandidateToPool(f.r1, sub, a.candidateId);
    await addCandidateToPool(f.r1, sub, b.candidateId);
    await addCandidateToPool(f.r1, top, a.candidateId);
    const candidatesBefore = (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`))[0].n;
    expect(candidatesBefore).toBe(2);
    expect(await deletePool(admin, sub)).toEqual({ removedMembers: 2 });
    expect(await membersOf(sub)).toEqual([]);
    expect(await membersOf(top)).toEqual([a.candidateId]);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`))[0].n).toBe(candidatesBefore);
    await deletePool(admin, top);
    expect(await owner.db.execute(sql`select 1 from recruitment_talent_pool_member where tenant_id = ${base.tenantId}::uuid and pool_id = ${top}::uuid`)).toHaveLength(0);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`))[0].n).toBe(2);
  });
});

describe('case 89 — operators add and remove candidates they can read; the list filters by pool with counts', () => {
  it('adds and removes only candidates the operator works with, in pools they can see (service and database)', async () => {
    const f = await fixture();
    const { id: pool } = await savePool(admin, { companyId: base.companyId, name: 'Fictional shortlist' });
    const mine = await apply(f.r1, f.job1);
    const theirs = await apply(f.r2, f.job2);
    expect(await addCandidateToPool(f.r1, pool, mine.candidateId)).toEqual({ added: true });
    expect(await addCandidateToPool(f.r1, pool, mine.candidateId)).toEqual({ added: false });
    // A candidate the recruiter cannot read is not found (nothing about them is disclosed).
    expect(await code(addCandidateToPool(f.r1, pool, theirs.candidateId))).toBe('not_found');
    for (const who of [f.hm, f.iv, f.bystander]) expect(await code(addCandidateToPool(who, pool, mine.candidateId))).toMatch(/^(forbidden|not_found)$/);
    // Directly: inserting someone else's candidate, or as a hiring manager, is refused by row security.
    expect(await code(rows(f.r1, sql`insert into recruitment_talent_pool_member (pool_id, candidate_id, tenant_id, company_id, added_by_user_id)
      values (${pool}::uuid, ${theirs.candidateId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    expect(await code(rows(f.hm, sql`insert into recruitment_talent_pool_member (pool_id, candidate_id, tenant_id, company_id, added_by_user_id)
      values (${pool}::uuid, ${mine.candidateId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.hm.userId}::uuid)`))).toBe('42501');
    // Someone else's name on the row is refused by the guard.
    expect(await code(rows(f.r2, sql`insert into recruitment_talent_pool_member (pool_id, candidate_id, tenant_id, company_id, added_by_user_id)
      values (${pool}::uuid, ${theirs.candidateId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    expect(await membersOf(pool)).toEqual([mine.candidateId]);
    // r2 cannot remove r1's candidate (no row is theirs); r1 removes it.
    expect(await code(removeCandidateFromPool(f.r2, pool, mine.candidateId))).toBe('not_found');
    expect(await rows(f.r2, sql`delete from recruitment_talent_pool_member where pool_id = ${pool}::uuid returning candidate_id`)).toHaveLength(0);
    expect(await removeCandidateFromPool(f.r1, pool, mine.candidateId)).toEqual({ removed: true });
    expect(await membersOf(pool)).toEqual([]);
    // Events carry ids only.
    const [ev] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event
      where event_type = 'recruitment-talent-pool.candidate-added' and aggregate_id = ${pool}::uuid`);
    expect(ev.payload).toEqual({ companyId: base.companyId, candidateId: mine.candidateId });
  });

  it('counts per pool and the pool filter match independently computed values for each viewer; cards say "Pools: …"', async () => {
    const f = await fixture();
    const { id: a } = await savePool(admin, { companyId: base.companyId, name: 'Fictional A' });
    const { id: a1 } = await savePool(admin, { companyId: base.companyId, name: 'Fictional A1', parentId: a });
    const { id: b } = await savePool(admin, { companyId: base.companyId, name: 'Fictional B' });
    const job1 = [await apply(f.r1, f.job1), await apply(f.r1, f.job1), await apply(f.r1, f.job1)];
    const job2 = [await apply(f.r2, f.job2), await apply(f.r2, f.job2)];
    // Who put whom where (the independent record).
    const put: [string, string, SessionContext][] = [
      [a, job1[0].candidateId, f.r1], [a, job1[1].candidateId, f.r1], [a, job2[0].candidateId, f.r2], [a1, job1[0].candidateId, f.r1],
      [b, job2[0].candidateId, admin], [b, job2[1].candidateId, f.r2], [b, job1[2].candidateId, admin],
    ];
    for (const [p, c, who] of put) await addCandidateToPool(who, p, c);
    const ops = { [f.r1.userId]: new Set(job1.map((x) => x.candidateId)), [f.r2.userId]: new Set(job2.map((x) => x.candidateId)) };
    const expected = (viewer: string | null, poolId: string) => put.filter(([p, c]) => p === poolId && (viewer === null || ops[viewer].has(c))).length;
    // The owner's own count agrees with the record (non-vacuous).
    const owned = await owner.db.execute<{ pool_id: string; n: number }>(sql`select pool_id, count(*)::int as n from recruitment_talent_pool_member
      where tenant_id = ${base.tenantId}::uuid group by 1`);
    expect(Object.fromEntries(owned.map((r) => [r.pool_id, r.n]))).toEqual({ [a]: 3, [a1]: 1, [b]: 3 });
    for (const [viewer, ctx] of [[null, admin], [f.r1.userId, f.r1], [f.r2.userId, f.r2]] as const) {
      const nav = await poolNav(ctx, [base.companyId]);
      const counts = Object.fromEntries(nav.pools.flatMap((p) => [[p.id, p.count], ...p.children.map((c) => [c.id, c.count])]));
      expect(counts, `viewer ${viewer ?? 'admin'}`).toEqual({ [a]: expected(viewer, a), [a1]: expected(viewer, a1), [b]: expected(viewer, b) });
      // Filtering by pool lists exactly those candidates (each count is non-zero for someone, so no check is vacuous).
      for (const p of [a, a1, b]) {
        const listed = (await poolMembers(ctx, p)).cards.map((c) => c.candidateId).sort();
        expect(listed, `viewer ${viewer ?? 'admin'} pool ${p}`).toEqual(put.filter(([q, c]) => q === p && (viewer === null || ops[viewer].has(c))).map(([, c]) => c).sort());
      }
    }
    expect(Math.max(expected(f.r1.userId, a), expected(f.r2.userId, b))).toBeGreaterThan(0);
    // The tree: A with A1, then B, by name.
    const nav = await poolNav(admin, [base.companyId]);
    expect(nav.pools.map((p) => [p.name, p.children.map((c) => c.name)])).toEqual([['Fictional A', ['Fictional A1']], ['Fictional B', []]]);
    // Cards name every pool of the candidate the viewer can see.
    const card = (await poolMembers(f.r1, a)).cards.find((c) => c.candidateId === job1[0].candidateId)!;
    expect(card.pools).toEqual(['Fictional A', 'Fictional A › Fictional A1']);
    expect(card.latest).toMatchObject({ applicationId: job1[0].applicationId, state: 'active' });
    // The Candidates board shows the pools on the operator's own cards, and nothing on a hiring manager's.
    const board = await candidateBoard(f.r1, [base.companyId], { jobId: f.job1 });
    expect(board.cards.find((c) => c.id === job1[0].applicationId)?.pools.map((p) => p.label)).toEqual(['Fictional A', 'Fictional A › Fictional A1']);
    const hmBoard = await candidateBoard(f.hm, [base.companyId], { jobId: f.job1 });
    expect(hmBoard.cards.length).toBeGreaterThan(0);
    expect(hmBoard.cards.every((c) => c.pools.length === 0)).toBe(true);
    // The application page: the operator's pools and choices; nothing for the hiring manager.
    expect(await applicationPools(f.r1, job1[2].applicationId)).toMatchObject({ member: [{ id: b, label: 'Fictional B' }], canEdit: true });
    expect((await applicationPools(f.r1, job1[2].applicationId))?.addable.map((x) => x.id).sort()).toEqual([a, a1].sort());
    expect(await applicationPools(f.hm, job1[0].applicationId)).toBeNull();
    expect((await poolChoices(f.hm, [base.companyId]))).toEqual([]);
    // The public pool card names the pools of an archived candidate.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, job2[1].applicationId, reason.id);
    const pub = await talentPool(admin, [base.companyId]);
    expect(pub.cards.find((c) => c.candidateId === job2[1].candidateId)).toMatchObject({ pools: ['Fictional B'], blocked: false });
  });
});
