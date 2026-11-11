/**
 * Recruitment slice 8 against Postgres: acceptance cases 46–57 (docs/recruitment-reconstruction/specification.md
 * "Slice 8 acceptance cases") through the service, the route handlers and directly as the app role: the public page and
 * job, the settings and job switch, the submission and its refusals, the limits (including the Kuala Lumpur day
 * boundary), the concurrency lock, the notice versions, the slice 5 removal and the owner-only marker-bound policies
 * under a production-like owner. Case 56 (middleware) is test/recruitment-careers-middleware.test.ts; the pure rules are
 * test/recruitment-careers-rules.test.ts. Every person and value is fictional; S8SENTINEL marks values that must never
 * reach a visitor or survive a removal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, applicationCareers, applicationHistory, candidateProfile, careersPublicJob as jobRead, careersPublicPage as pageRead, careersSettings, changeJobStatus, createJob,
  destroyCandidates, jobCareersStatus, rejectApplication, recruitmentOverviewReport, recruitmentSettings, setCareersPublished, setJobCareersPage, submitCareersApplication,
  updateCareersSettings, RecruitmentError, type CareersSubmission,
} from '../packs/recruitment/service';
import { GET as pageRoute } from '../app/careers/[address]/route';
import { GET as jobRoute, POST as applyRoute } from '../app/careers/[address]/jobs/[jobId]/route';
import { closeCareersPool } from '../packs/recruitment/careers';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S8SENTINEL';
/** The public reads without a read budget (the route handlers charge one); 'limited' never happens here. */
const careersPublicPage = async (...a: Parameters<typeof pageRead>) => { const r = await pageRead(...a); if (r === 'limited') throw new Error('read budget'); return r; };
const careersPublicJob = async (...a: Parameters<typeof jobRead>) => { const r = await jobRead(...a); if (r === 'limited') throw new Error('read budget'); return r; };
/** Reviewed SECURITY DEFINER functions that read job openings or careers sites/notices (see the residual-risk guard). */
const REVIEWED_DEFINERS: string[] = [
  // 4408: the careers functions themselves — each returns only the spec's public fields.
  'app.recruitment_careers_job(text,uuid)',
  'app.recruitment_careers_page(text,text,text,text,integer)',
  'app.recruitment_careers_published(uuid,uuid)',
  'app.recruitment_careers_site_at(text)',
  'app.recruitment_careers_submit(text,uuid,text,text,text,text,text,integer,boolean,text,text,bytea)',
  // 4401–4405/4408: deletes only the caller's tenant + company setup (checks job openings exist there first).
  'app.recruitment_delete_company_setup(uuid)',
  // 4407: every job read filters by the caller's tenant (and the referral marker's companies, or the referrer's own rows).
  'app.recruitment_my_referrals()',
  'app.recruitment_referral_portal(uuid)',
  'app.recruitment_submit_referral(uuid,text,text,text,text,boolean,text,text,bytea)',
];
/** The verified request source a reviewed proxy sets (deploy/internal-auth/abuse-careers-location.conf). */
const SOURCE = '192.0.2.10';
const ADDRESS = 'fictional-careers';
const ORIGIN = 'https://careers.fixture.test';
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
const rows = (ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute(query));
const count = async (table: string, tenantId = base.tenantId) => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${tenantId}::uuid`))[0].n;
const attempts = async () => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_careers_attempt`))[0].n;
const notStored = async () => (await owner.db.execute<{ reason: string }>(sql`
  select payload->>'reason' as reason from domain_event where tenant_id = ${base.tenantId}::uuid and event_type = 'recruitment-careers.application-not-stored'
  order by sequence`)).map((r) => r.reason);
const pdf = (marker = 'fictional resume') => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
const hashOf = (label: string) => createHash('sha256').update(`fictional-client:${label}`).digest('hex');
/** Kuala Lumpur wall-clock time on `day` as an instant (KL is UTC+8 all year). */
const klInstant = (day: string, hhmm: string) => `${day}T${hhmm}:00+08:00`;

/** A person with a login (no grant) and an employment in the base company. */
async function login(name: string, b: Base = base): Promise<SessionContext & { userId: string }> {
  const [p] = await owner.db.insert(person).values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: b.tenantId, companyId: b.companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, tenantId: b.tenantId, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional job description.', ...over,
});
/** The published careers page of a company (notice version 1). */
async function site(ctx = admin, companyId = base.companyId, address = ADDRESS) {
  await updateCareersSettings(ctx, companyId, {
    address, displayName: 'Fictional Careers Sdn Bhd', headline: 'Join the fictional team', introduction: 'Fictional introduction.', notice: 'Fictional privacy notice, version one.',
  });
  await setCareersPublished(ctx, companyId, true);
}
/** An Open job on the careers page. */
async function publicJob(over: Record<string, unknown> = {}, ctx = admin) {
  const { id } = await createJob(ctx, job(over));
  await setJobCareersPage(ctx, id, true);
  return id;
}
let seq = 0;
const apply = (jobId: string, over: Partial<CareersSubmission> = {}, client = 'default') => {
  const n = ++seq;
  return submitCareersApplication({
    address: ADDRESS, jobId, fullName: `Fictional Applicant ${n}`, email: `applicant${n}@example.test`, mobile: '', message: '', consent: 'on', noticeVersion: '1',
    website: '', resume: null, clientHash: () => hashOf(client), currentNoticeVersion: 1, ...over,
  });
};
const req = (path: string, init?: { method?: string; body?: FormData; headers?: Record<string, string> }) =>
  new NextRequest(ORIGIN + path, { ...init, headers: { 'x-aihr-request-source': SOURCE, ...init?.headers } });
const pageParams = (address = ADDRESS) => ({ params: Promise.resolve({ address }) });
const jobParams = (jobId: string, address = ADDRESS) => ({ params: Promise.resolve({ address, jobId }) });
function form(values: Record<string, string>, resume?: { name: string; bytes: Buffer }) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  if (resume) f.set('resume', new File([new Uint8Array(resume.bytes)], resume.name, { type: 'application/octet-stream' }));
  return f;
}

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  await resetDb();
  await owner.db.execute(sql`delete from app.recruitment_careers_attempt`);
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
  vi.unstubAllEnvs();
  // The reviewed ingress is in place (the production configuration in which applications are accepted).
  vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
});

describe('case 46 — only the Open, flagged jobs of a published page are public; everything else is the same Not found', () => {
  it('lists exactly the Open flagged jobs of the company and answers every other case with one Not found page', async () => {
    await site();
    await site(admin, otherCompanyId, 'fictional-other');
    const shown = await publicJob({ title: 'Fictional shown job' });
    const hidden = (await createJob(admin, job({ title: 'Fictional hidden job' }))).id;
    const onHold = await publicJob({ title: 'Fictional on-hold job' });
    await changeJobStatus(admin, onHold, 'on_hold');
    const closed = await publicJob({ title: 'Fictional closed job' });
    await changeJobStatus(admin, closed, 'closed');
    const otherCompany = await publicJob({ companyId: otherCompanyId, title: 'Fictional other company job' });

    const page = await careersPublicPage(ADDRESS);
    expect(page?.jobs.map((j) => j.id)).toEqual([shown]);
    expect(page?.total).toBe(1);
    expect((await careersPublicJob(ADDRESS, shown))?.job.title).toBe('Fictional shown job');
    for (const id of [hidden, onHold, closed, otherCompany, randomUUID()]) expect(await careersPublicJob(ADDRESS, id), id).toBeNull();
    // The other company's job is public only on its own page.
    expect((await careersPublicJob('fictional-other', otherCompany))?.job.id).toBe(otherCompany);
    expect(await careersPublicPage('fictional-unknown')).toBeNull();

    // Through the route handlers: every unavailable case is the same 404 body; the public ones are 200.
    const notFound = [
      await pageRoute(req('/careers/fictional-unknown'), pageParams('fictional-unknown')),
      ...await Promise.all([hidden, onHold, closed, otherCompany, randomUUID()].map((id) => jobRoute(req(`/careers/${ADDRESS}/jobs/${id}`), jobParams(id)))),
    ];
    // Withdrawn page: the page and its once-public job are Not found too.
    await setCareersPublished(admin, base.companyId, false);
    notFound.push(await pageRoute(req(`/careers/${ADDRESS}`), pageParams()), await jobRoute(req(`/careers/${ADDRESS}/jobs/${shown}`), jobParams(shown)));
    // A tenant without Recruitment: Not found.
    await setCareersPublished(admin, base.companyId, true);
    await setModule(base.tenantId, 'recruitment', null);
    notFound.push(await pageRoute(req(`/careers/${ADDRESS}`), pageParams()));
    const bodies = await Promise.all(notFound.map((r) => r.text()));
    expect(notFound.map((r) => r.status)).toEqual(notFound.map(() => 404));
    expect(new Set(bodies).size).toBe(1);
    for (const r of notFound) expect(r.headers.get('set-cookie')).toBeNull();
    await setModule(base.tenantId, 'recruitment', 'active');
    const ok = await jobRoute(req(`/careers/${ADDRESS}/jobs/${shown}`), jobParams(shown));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Fictional shown job');
  });
});

describe('case 47 — publishing rules and who may change the page or a job\'s flag', () => {
  it('refuses publishing without an address, a display name and a notice; enforces the address format and installation uniqueness', async () => {
    expect(await code(setCareersPublished(admin, base.companyId, true))).toBe('careers_incomplete');
    await updateCareersSettings(admin, base.companyId, { address: ADDRESS });
    const refused = await setCareersPublished(admin, base.companyId, true).catch((e: RecruitmentError) => e);
    expect(refused).toMatchObject({ code: 'careers_incomplete', detail: ['displayName', 'notice'] });
    expect((await careersSettings(admin, base.companyId)).missing).toEqual(['displayName', 'notice']);
    await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Careers Sdn Bhd' });
    expect(await code(setCareersPublished(admin, base.companyId, true))).toBe('careers_incomplete');
    await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Careers Sdn Bhd', notice: 'Fictional notice.' });
    expect(await code(setCareersPublished(admin, base.companyId, true))).toBe('ok');
    // A published page keeps what it needs; a notice cannot be emptied.
    expect(await code(updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: '', notice: 'Fictional notice.' }))).toBe('careers_incomplete');
    expect(await code(updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional', notice: '' }))).toBe('missing_fields');
    for (const address of ['ab', 'Fictional', '-fictional', 'fictional-', 'fic tional', 'a'.repeat(41)]) {
      expect(await code(updateCareersSettings(admin, otherCompanyId, { address })), address).toBe('invalid_input');
    }
    // Unique in the installation: another company of this tenant, and a company of another tenant.
    expect(await code(updateCareersSettings(admin, otherCompanyId, { address: ADDRESS }))).toBe('careers_address_taken');
    const base2 = await seedBase();
    await setModule(base2.tenantId, 'recruitment', 'active');
    const admin2: SessionContext = { ...(await entitledCtx(base2)), grants: [{ role: 'hr_admin', companyId: null }] };
    expect(await code(updateCareersSettings(admin2, base2.companyId, { address: ADDRESS }))).toBe('careers_address_taken');
    // The database refuses the same, whoever writes.
    for (const [statement, state] of [
      [sql`insert into recruitment_careers_site (company_id, tenant_id, address, created_by_user_id, updated_by_user_id) values (${otherCompanyId}::uuid, ${base.tenantId}::uuid, 'Bad_Address', ${admin.userId}::uuid, ${admin.userId}::uuid)`, '23514'],
      [sql`insert into recruitment_careers_site (company_id, tenant_id, address, created_by_user_id, updated_by_user_id) values (${otherCompanyId}::uuid, ${base.tenantId}::uuid, ${ADDRESS}, ${admin.userId}::uuid, ${admin.userId}::uuid)`, '23505'],
      [sql`insert into recruitment_careers_site (company_id, tenant_id, address, display_name, published, created_by_user_id, updated_by_user_id) values (${otherCompanyId}::uuid, ${base.tenantId}::uuid, 'fictional-other', 'X', true, ${admin.userId}::uuid, ${admin.userId}::uuid)`, '23514'],
    ] as const) expect(await code(rows(admin, statement))).toBe(state);
  });

  it('refuses the job team, an employee and another company\'s partner in the service and in the database', async () => {
    await site();
    const recruiter = await login('Fictional Recruiter');
    const worker = await login('Fictional Employee');
    const { id: jobId } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
    const partnerB = await login('Fictional Partner B');
    await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: partnerB.userId, companyId: otherCompanyId, role: 'recruiting_partner' });
    const partner: SessionContext = { ...partnerB, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId: otherCompanyId }] };

    expect(await code(setJobCareersPage(recruiter, jobId, true))).toBe('forbidden');
    for (const ctx of [worker, partner]) expect(await code(setJobCareersPage(ctx, jobId, true))).toBe('not_found');
    for (const ctx of [recruiter, worker, partner]) {
      expect(await code(updateCareersSettings(ctx, base.companyId, { address: 'fictional-taken-over', displayName: 'X', notice: 'X' }))).toBe('forbidden');
      expect(await code(setCareersPublished(ctx, base.companyId, false))).toBe('forbidden');
      expect(await code(careersSettings(ctx, base.companyId))).toBe('forbidden');
      // Directly as the app role: row security leaves nothing to update and refuses an insert.
      expect(await rows(ctx, sql`update recruitment_job_opening set show_on_careers_page = true where id = ${jobId}::uuid returning id`)).toHaveLength(0);
      expect(await rows(ctx, sql`update recruitment_careers_site set published = false, address = 'fictional-taken-over' returning company_id`)).toHaveLength(0);
      expect(await code(rows(ctx, sql`insert into recruitment_careers_notice (tenant_id, company_id, version, body, created_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 9, 'Fictional forged notice', ${ctx.userId}::uuid)`))).toBe('42501');
      expect(await rows(ctx, sql`select 1 from recruitment_careers_site`)).toHaveLength(0);
    }
    // And the guards refuse a non-administrator even where row security is not the barrier (the owner connection).
    for (const statement of [
      `update recruitment_job_opening set show_on_careers_page = true where id = '${jobId}'::uuid`,
      `update recruitment_careers_site set published = false where company_id = '${base.companyId}'::uuid`,
      `insert into recruitment_careers_notice (tenant_id, company_id, version, body, created_by_user_id) values ('${base.tenantId}', '${base.companyId}', 1, 'Fictional forged', '${recruiter.userId}')`,
    ]) {
      const guarded = await owner.client.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${recruiter.userId}, true), set_config('app.tenant_id', ${base.tenantId}, true)`;
        await tx.unsafe(statement);
        return 'not refused';
      }).catch((e: unknown) => pgSqlState(e));
      expect(guarded, statement).toBe('42501');
    }
    // The posted date follows the switch and is never written directly.
    await setJobCareersPage(admin, jobId, true);
    const [on] = await owner.db.execute<{ show: boolean; posted: string | null }>(sql`select show_on_careers_page as show, careers_posted_at::text as posted from recruitment_job_opening where id = ${jobId}::uuid`);
    expect(on.show).toBe(true);
    expect(on.posted).not.toBeNull();
    expect(await code(rows(admin, sql`update recruitment_job_opening set careers_posted_at = now() - interval '1 year' where id = ${jobId}::uuid`))).toBe('42501');
    const [event] = await owner.db.execute<{ payload: unknown }>(sql`select payload from domain_event where event_type = 'recruitment-job.careers-page-changed' and aggregate_id = ${jobId}::uuid`);
    expect(event.payload).toEqual({ companyId: base.companyId, from: false, to: true });
    expect(await jobCareersStatus(admin, jobId)).toMatchObject({ show: true, sitePublished: true, jobOpen: true, publicPath: `/careers/${ADDRESS}/jobs/${jobId}` });
    await setJobCareersPage(admin, jobId, false);
    expect((await owner.db.execute<{ posted: string | null }>(sql`select careers_posted_at::text as posted from recruitment_job_opening where id = ${jobId}::uuid`))[0].posted).toBeNull();
  });
});

describe('case 48 — the public data and pages carry no salary, team, count, stage or candidate field', () => {
  it('keeps sentinels on the job and on existing applications out of the HTML and the public data', async () => {
    await site();
    await owner.db.update(jobGrade).set({ name: `${SENTINEL} grade` });
    await owner.db.execute(sql`update department set name = ${`${SENTINEL} department`} where id = ${base.deptA}::uuid`);
    const recruiter = await login(`${SENTINEL} Recruiter`);
    const jobId = await publicJob({ title: 'Fictional public job', departmentId: base.deptA, recruiterUserId: recruiter.userId });
    await addApplication(admin, { jobId, fullName: `${SENTINEL} Candidate`, email: 's8sentinel@example.test', phone: '+60 12-888 9999' });
    // An earlier careers applicant's message is not public either.
    expect(await apply(jobId, { fullName: `${SENTINEL} Applicant`, email: 'sentinel.applicant@example.test', message: `${SENTINEL} message` })).toEqual({ ok: true, outcome: 'received' });

    const page = await careersPublicPage(ADDRESS);
    const one = await careersPublicJob(ADDRESS, jobId);
    expect(Object.keys(page!).sort()).toEqual(['displayName', 'employmentTypes', 'headline', 'introduction', 'jobs', 'locations', 'page', 'pageSize', 'total']);
    expect(Object.keys(page!.jobs[0]).sort()).toEqual(['employmentType', 'id', 'jobNumber', 'postedAt', 'title', 'workLocation']);
    expect(Object.keys(one!).sort()).toEqual(['displayName', 'job', 'notice']);
    expect(Object.keys(one!.job).sort()).toEqual(['description', 'employmentType', 'id', 'jobNumber', 'postedAt', 'title', 'workLocation']);
    // The raw database answer has exactly these keys too (nothing dropped only by the service).
    const [raw] = await owner.db.execute<{ r: Record<string, unknown> }>(sql`select app.recruitment_careers_job(${ADDRESS}, ${jobId}::uuid) as r`);
    expect(Object.keys(raw.r).sort()).toEqual(['displayName', 'job', 'notice']);
    expect(Object.keys(raw.r.job as object).sort()).toEqual(['description', 'employmentType', 'id', 'jobNumber', 'postedAt', 'title', 'workLocation']);
    const html = await Promise.all([
      pageRoute(req(`/careers/${ADDRESS}`), pageParams()).then((r) => r.text()),
      jobRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`), jobParams(jobId)).then((r) => r.text()),
    ]);
    for (const text of [...html, JSON.stringify(page), JSON.stringify(one), JSON.stringify(raw)]) {
      expect(text).not.toContain(SENTINEL);
      expect(text.toLowerCase()).not.toContain('s8sentinel');
      expect(text).not.toContain('888 9999');
    }
    expect(html[1]).toContain('Fictional public job');
  });
});

describe('case 49 — search, filters and paging against an independently computed list', () => {
  it('returns the expected jobs in posted-date order for each filter and page', async () => {
    await site();
    const specs = Array.from({ length: 36 }, (_, i) => ({
      title: `${i % 3 === 0 ? 'Senior Analyst' : i % 3 === 1 ? 'Fictional engineer' : 'Data ANALYST lead'} ${i}`,
      workLocation: i % 2 === 0 ? 'Kuala Lumpur' : 'Penang', employmentType: i % 4 === 0 ? 'part_time' : 'full_time',
    }));
    const made: { id: string; title: string; workLocation: string; employmentType: string; postedAt: string }[] = [];
    for (const [i, spec] of specs.entries()) {
      const id = await publicJob(spec);
      // Distinct posted moments, deliberately not in creation order (fixture time travel past the guard).
      const postedAt = new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + ((i * 7) % 36) * 3_600_000).toISOString();
      await owner.client.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update recruitment_job_opening set careers_posted_at = ${postedAt}::timestamptz where id = ${id}::uuid`;
      });
      made.push({ id, ...spec, postedAt });
    }
    const expected = (f: { q?: string; location?: string; type?: string }) => made
      .filter((j) => (!f.q || j.title.toLowerCase().includes(f.q.toLowerCase())) && (!f.location || j.workLocation === f.location) && (!f.type || j.employmentType === f.type))
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt) || a.id.localeCompare(b.id)).map((j) => j.id);
    const check = async (f: { q?: string; location?: string; type?: string }) => {
      const all = expected(f);
      expect(all.length, JSON.stringify(f)).toBeGreaterThan(0);
      const first = await careersPublicPage(ADDRESS, { query: f.q, location: f.location, employmentType: f.type, page: 1 });
      expect(first?.total, JSON.stringify(f)).toBe(all.length);
      expect(first?.jobs.map((j) => j.id), JSON.stringify(f)).toEqual(all.slice(0, 30));
      const second = await careersPublicPage(ADDRESS, { query: f.q, location: f.location, employmentType: f.type, page: 2 });
      expect(second?.jobs.map((j) => j.id), JSON.stringify(f)).toEqual(all.slice(30, 60));
    };
    await check({});
    await check({ q: 'analyst' });
    await check({ q: 'ANALYST LEAD' });
    await check({ location: 'Penang' });
    await check({ type: 'part_time' });
    await check({ q: 'analyst', location: 'Kuala Lumpur', type: 'full_time' });
    const page = await careersPublicPage(ADDRESS);
    expect(page?.locations).toEqual(['Kuala Lumpur', 'Penang']);
    expect(page?.employmentTypes).toEqual(['full_time', 'part_time']);
    // A LIKE pattern in the search is plain text, not a wildcard.
    expect((await careersPublicPage(ADDRESS, { query: '%' }))?.total).toBe(0);
    expect((await careersPublicPage(ADDRESS, { query: '_' }))?.total).toBe(0);
    // Through the route: the query string drives the same read.
    const html = await (await pageRoute(req(`/careers/${ADDRESS}?q=analyst&location=Penang&page=1`), pageParams())).text();
    expect(html).toContain(`${expected({ q: 'analyst', location: 'Penang' }).length} open positions`);
  });
});

describe('case 50 — a valid submission stores one candidate, application, resume, consent and event, in one transaction', () => {
  it('creates new records at the first enabled stage with source "Careers page" and never attaches to an existing candidate', async () => {
    await site();
    const jobId = await publicJob();
    const other = await publicJob({ title: 'Fictional other job' });
    // The application starts at the first ENABLED stage of the job's process (computed independently here).
    const [{ stage_id: firstEnabled }] = await owner.db.execute<{ stage_id: string }>(sql`
      select ps.stage_id from recruitment_process_stage ps join recruitment_stage s on s.id = ps.stage_id join recruitment_job_opening j on j.process_id = ps.process_id
      where j.id = ${jobId}::uuid and s.enabled order by ps.position limit 1`);
    // Someone with the same name and e-mail already applied to another job.
    await addApplication(admin, { jobId: other, fullName: 'Fictional Same Applicant', email: 'same.applicant@example.test' });

    const response = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({
      fullName: 'Fictional Same Applicant', email: 'Same.Applicant@Example.test', mobile: '+60 12-345 6789', message: 'Fictional message to HR.', consent: 'on', noticeVersion: '1', website: '',
    }, { name: 'cv.pdf', bytes: pdf() }) }), jobParams(jobId));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Thank you, your application was received');

    const candidates = await owner.db.execute<{ id: string; email: string; phone: string; source: string; created_by_user_id: string | null; x: string }>(sql`
      select id, email, phone, source, created_by_user_id, xmin::text as x from recruitment_candidate where tenant_id = ${base.tenantId}::uuid and lower(email) = 'same.applicant@example.test' order by created_at`);
    expect(candidates).toHaveLength(2);
    const c = candidates[1];
    expect(c).toMatchObject({ email: 'same.applicant@example.test', phone: '+60 12-345 6789', source: 'career_page', created_by_user_id: null });
    const [app] = await owner.db.execute<{ id: string; current_stage_id: string; source: string; state: string; created_by_user_id: string | null; x: string }>(sql`
      select id, current_stage_id, source, state, created_by_user_id, xmin::text as x from recruitment_application where candidate_id = ${c.id}::uuid`);
    expect(app).toMatchObject({ current_stage_id: firstEnabled, source: 'career_page', state: 'active', created_by_user_id: null });
    const [file] = await owner.db.execute<{ kind: string; mime_type: string; permission_confirmed: boolean; uploaded_by_user_id: string | null; size_bytes: number; x: string }>(sql`
      select kind, mime_type, permission_confirmed, uploaded_by_user_id, size_bytes, xmin::text as x from recruitment_candidate_file where candidate_id = ${c.id}::uuid`);
    expect(file).toMatchObject({ kind: 'resume', mime_type: 'application/pdf', permission_confirmed: true, uploaded_by_user_id: null, size_bytes: pdf().length });
    const [consent] = await owner.db.execute<{ status: string; method: string; careers_notice_version: number; effective_on: string; recorded_by_user_id: string | null; x: string }>(sql`
      select status, method, careers_notice_version, effective_on::text, recorded_by_user_id, xmin::text as x from recruitment_candidate_consent where candidate_id = ${c.id}::uuid`);
    expect(consent).toMatchObject({ status: 'consented', method: 'online_form', careers_notice_version: 1, effective_on: todayInKualaLumpur(), recorded_by_user_id: null });
    const [careers] = await owner.db.execute<{ message: string; job_id: string; x: string }>(sql`
      select message, job_id, xmin::text as x from recruitment_careers_application where application_id = ${app.id}::uuid`);
    expect(careers).toMatchObject({ message: 'Fictional message to HR.', job_id: jobId });
    const [history] = await owner.db.execute<{ kind: string; actor_user_id: string | null; x: string }>(sql`
      select kind, actor_user_id, xmin::text as x from recruitment_application_event where application_id = ${app.id}::uuid`);
    expect(history).toMatchObject({ kind: 'applied', actor_user_id: null });
    const events = await owner.db.execute<{ event_type: string; actor_type: string; actor_id: string | null; payload: Record<string, unknown>; x: string }>(sql`
      select event_type, actor_type::text, actor_id, payload, xmin::text as x from domain_event where tenant_id = ${base.tenantId}::uuid
       and event_type in ('recruitment-careers.application-received', 'recruitment-candidate.duplicate-flagged') and payload->>'jobId' = ${jobId} order by sequence`);
    expect(events.map((e) => e.event_type)).toEqual(['recruitment-candidate.duplicate-flagged', 'recruitment-careers.application-received']);
    expect(events[1]).toMatchObject({ actor_type: 'external', actor_id: null });
    expect(events[1].payload).toEqual({ companyId: base.companyId, jobId, candidateId: c.id, resume: true, noticeVersion: 1 });
    expect(events[0].payload).toEqual({ companyId: base.companyId, jobId, matches: 1, via: 'careers_page' });
    for (const e of events) expect(JSON.stringify(e.payload)).not.toMatch(/Fictional Same|same\.applicant|345 6789|message to HR/i);
    // One transaction: every row was written by the same transaction id.
    expect(new Set([c.x, app.x, file.x, consent.x, careers.x, history.x, ...events.map((e) => e.x)]).size).toBe(1);
    // The earlier candidate was not touched; the submission counted as accepted.
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application where candidate_id = ${candidates[0].id}::uuid`))[0].n).toBe(1);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_careers_attempt where accepted`))[0].n).toBe(1);

    // HR sees the source, the message, the consent with the notice version, and the applicant as the author.
    expect(await applicationCareers(admin, app.id)).toMatchObject({ message: 'Fictional message to HR.' });
    const profile = await candidateProfile(admin, app.id);
    expect(profile.source).toBe('career_page');
    expect(profile.consent?.history[0]).toMatchObject({ method: 'online_form', careersNoticeVersion: 1, byApplicant: true, recordedBy: null });
    expect(profile.files[0]).toMatchObject({ byApplicant: true, uploadedBy: null });
    expect((await applicationHistory(admin, app.id))[0]).toMatchObject({ kind: 'applied', byApplicant: true, actorName: null });
  });
});

describe('case 51 — invalid input stores nothing and returns field messages; an oversized body is refused before parsing', () => {
  it('answers each invalid field with its message and writes no row', async () => {
    await site();
    const jobId = await publicJob();
    const bad: [Partial<CareersSubmission>, Record<string, string>][] = [
      [{ fullName: '' }, { fullName: 'required' }],
      [{ email: 'not-an-email' }, { email: 'invalid' }],
      [{ mobile: '12-34' }, { mobile: 'invalid' }],
      [{ message: 'm'.repeat(1001) }, { message: 'too_long' }],
      [{ consent: '' }, { consent: 'consent_required' }],
      [{ resume: { fileName: 'cv.pdf', content: Buffer.from('plain text, not a PDF') } }, { resume: 'file_type' }],
      [{ resume: { fileName: 'cv.exe', content: pdf() } }, { resume: 'file_type' }],
      [{ resume: { fileName: 'cv.pdf', content: Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)]) } }, { resume: 'file_too_large' }],
    ];
    for (const [over, fields] of bad) expect(await apply(jobId, over), JSON.stringify(fields)).toEqual({ ok: false, fields });
    // The database function refuses malformed values on its own (the server checks first).
    expect(await code(owner.db.execute(sql`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('x')}, '', 'a@b.cd', null, null, 1, false)`))).toBe('22023');
    expect(await code(owner.db.execute(sql`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, 'raw 203.0.113.9', 'Fictional', 'a@b.cd', null, null, 1, false)`))).toBe('22023');
    expect(await code(owner.db.execute(sql`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('x')}, 'Fictional', 'a@b.cd', null, null, 1, false, 'cv.exe', 'application/x-msdownload', '\\x4d5a'::bytea)`))).toBe('22023');
    // Through the route: 400 with the messages, the typed values kept.
    const r = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({ fullName: 'Fictional Typed Name', email: 'bad', consent: '', noticeVersion: '1' }) }), jobParams(jobId));
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain('Enter a valid email address.');
    expect(html).toContain('Tick the box to confirm you agree to the privacy notice.');
    expect(html).toContain('value="Fictional Typed Name"');
    // An oversized body: by its declared length and by its stream, refused before anything is read or stored.
    const big = await applyRoute(new NextRequest(`${ORIGIN}/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', headers: { 'x-aihr-request-source': SOURCE, 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(11 * 1024 * 1024 + 1) }, body: 'x' }), jobParams(jobId));
    expect(big.status).toBe(413);
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(cn) { if (++pulled > 30) cn.close(); else cn.enqueue(chunk); } });
    const streamed = await applyRoute(new NextRequest(`${ORIGIN}/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', headers: { 'x-aihr-request-source': SOURCE, 'content-type': 'multipart/form-data; boundary=x' }, body: stream, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]), jobParams(jobId));
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(13);
    for (const table of ['recruitment_candidate', 'recruitment_application', 'recruitment_candidate_file', 'recruitment_candidate_consent', 'recruitment_careers_application']) {
      expect(await count(table), table).toBe(0);
    }
    expect(await attempts()).toBe(0);
  });
});

describe('case 52 — a repeated application and a filled honeypot get the same thank-you and store nothing', () => {
  it('names the reason in the audit event only', async () => {
    await site();
    const jobId = await publicJob();
    const thanks = async (values: Record<string, string>, client: string) => {
      const r = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({ consent: 'on', noticeVersion: '1', ...values }), headers: { 'x-fixture': client } }), jobParams(jobId));
      return { status: r.status, body: await r.text() };
    };
    const first = await thanks({ fullName: 'Fictional Repeat', email: 'repeat@example.test' }, 'a');
    expect(await count('recruitment_candidate')).toBe(1);
    const repeated = await thanks({ fullName: 'Fictional Repeat Again', email: 'REPEAT@example.test' }, 'b');
    const honeypot = await thanks({ fullName: 'Fictional Bot', email: 'bot@example.test', website: 'https://spam.example' }, 'c');
    expect([first.status, repeated.status, honeypot.status]).toEqual([200, 200, 200]);
    expect(repeated.body).toBe(first.body);
    expect(honeypot.body).toBe(first.body);
    expect(await count('recruitment_candidate')).toBe(1);
    expect(await count('recruitment_application')).toBe(1);
    expect(await notStored()).toEqual(['repeated_application', 'honeypot']);
    const payloads = await owner.db.execute<{ payload: unknown; actor_type: string }>(sql`select payload, actor_type::text from domain_event where event_type = 'recruitment-careers.application-not-stored'`);
    for (const p of payloads) {
      expect(Object.keys(p.payload as object).sort()).toEqual(['companyId', 'jobId', 'reason']);
      expect(p.actor_type).toBe('external');
    }
    // Archived inside the window still blocks; outside it (or with the window off) a new application is stored.
    const [{ id: applicationId }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_application where tenant_id = ${base.tenantId}::uuid`);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reason.id);
    expect(await apply(jobId, { email: 'repeat@example.test' }, 'd')).toEqual({ ok: true, outcome: 'received' });
    expect(await count('recruitment_candidate')).toBe(1);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${klInstant(addCalendarMonths(todayInKualaLumpur(), -4), '09:00')}::timestamptz where id = ${applicationId}::uuid`;
    });
    expect(await apply(jobId, { email: 'repeat@example.test' }, 'e')).toEqual({ ok: true, outcome: 'received' });
    expect(await count('recruitment_candidate')).toBe(2);
    expect(await notStored()).toEqual(['repeated_application', 'honeypot', 'repeated_application']);
  });
});

describe('case 53 — the limits: 5 an hour per client, 300 stored a Kuala Lumpur day per company; no raw address stored', () => {
  it('answers the 6th submission in an hour from one client with 429', async () => {
    await site();
    const jobId = await publicJob();
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
    const send = (source: string, n: number) => applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', headers: { 'x-aihr-request-source': source },
      body: form({ fullName: `Fictional Limited ${n}`, email: `limited${n}@example.test`, consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
    for (let n = 1; n <= 5; n++) expect((await send('203.0.113.77', n)).status, `#${n}`).toBe(200);
    const sixth = await send('203.0.113.77', 6);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe('3600');
    expect(await sixth.text()).toContain('Too many applications from this connection. Try again later.');
    expect(await count('recruitment_candidate')).toBe(5);
    // Another client is not affected.
    expect((await send('203.0.113.78', 7)).status).toBe(200);
    // Older than an hour no longer counts.
    await owner.db.execute(sql`update app.recruitment_careers_attempt set attempted_at = now() - interval '61 minutes'`);
    expect((await send('203.0.113.77', 8)).status).toBe(200);
    // Nothing anywhere holds the address itself; attempts older than two days are pruned by the next submission.
    const stored = await owner.db.execute<{ t: string }>(sql`select to_jsonb(a.*)::text as t from app.recruitment_careers_attempt a`);
    expect(stored.length).toBeGreaterThan(0);
    for (const { t } of stored) expect(t).not.toMatch(/203\.0\.113/);
    const [anywhere] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text like '%203.0.113%'`);
    expect(anywhere.n).toBe(0);
    await owner.db.execute(sql`update app.recruitment_careers_attempt set attempted_at = now() - interval '49 hours'`);
    expect((await send('203.0.113.79', 9)).status).toBe(200);
    expect(await attempts()).toBe(1);
  });

  it('refuses the 301st stored submission of a Kuala Lumpur day, with the boundary at Kuala Lumpur midnight', async () => {
    await site();
    const jobId = await publicJob();
    const today = todayInKualaLumpur();
    const midnight = `${today}T00:00:00+08:00`;
    // 300 stored submissions at exactly 00:00 today in Kuala Lumpur (fixture rows; the hashes are not real clients).
    await owner.db.execute(sql`insert into app.recruitment_careers_attempt (client_hash, tenant_id, company_id, attempted_at, accepted)
      select encode(sha256(('fictional-' || g)::bytea), 'hex'), ${base.tenantId}::uuid, ${base.companyId}::uuid, ${midnight}::timestamptz, true from generate_series(1, 300) g`);
    expect(await apply(jobId, {}, 'over-limit')).toEqual({ ok: true, outcome: 'company_limit' });
    const r = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({ fullName: 'Fictional Late', email: 'late@example.test', consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
    expect(r.status).toBe(429);
    expect(await r.text()).toContain('This page is not accepting applications right now. Try again later.');
    expect(await count('recruitment_candidate')).toBe(0);
    // One millisecond earlier is yesterday in Kuala Lumpur: they no longer count, and the submission is stored.
    await owner.db.execute(sql`update app.recruitment_careers_attempt set attempted_at = ${midnight}::timestamptz - interval '1 millisecond' where accepted`);
    expect(await apply(jobId, {}, 'next-day')).toEqual({ ok: true, outcome: 'received' });
    expect(await count('recruitment_candidate')).toBe(1);
    // Refused and limited submissions are not counted as stored.
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_careers_attempt
      where accepted and attempted_at >= ${midnight}::timestamptz`);
    expect(n).toBe(1);
  });
});

describe('case 54 — two concurrent submissions with the same e-mail to the same job', () => {
  it('stores exactly one', async () => {
    await site();
    const jobId = await publicJob();
    const [{ key }] = await owner.db.execute<{ key: string }>(sql`select hashtextextended(${`recruitment-referral:${base.tenantId}:${base.companyId}:email:twin@example.test`}, 0)::text as key`);
    let both!: Promise<unknown[]>;
    await owner.client.begin(async (tx) => {
      // Hold the identity lock so both submissions are in flight at once, then let them race.
      await tx`select pg_advisory_xact_lock(${key}::bigint)`;
      both = Promise.all([apply(jobId, { email: 'twin@example.test' }, 'twin-a'), apply(jobId, { email: 'TWIN@example.test' }, 'twin-b')]);
      let waiting = 0;
      for (let i = 0; i < 200 && waiting < 2; i++) {
        [{ n: waiting }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, 'both submissions are blocked on the locks at the same time').toBe(2);
    });
    expect(await both).toEqual([{ ok: true, outcome: 'received' }, { ok: true, outcome: 'received' }]);
    expect(await count('recruitment_candidate')).toBe(1);
    expect(await count('recruitment_application')).toBe(1);
    expect(await notStored()).toEqual(['repeated_application']);
  });
});

describe('case 55 — notice versions', () => {
  it('a changed notice is version N+1, version N is kept unchanged, and a submission records the version it showed', async () => {
    await site();
    const jobId = await publicJob();
    const [v1Before] = await owner.db.execute<{ body: string; created_at: string; id: string }>(sql`select id, body, created_at::text from recruitment_careers_notice where version = 1`);
    // Saving the same text creates no version; a different text creates version 2.
    await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Careers Sdn Bhd', notice: 'Fictional privacy notice, version one.' });
    expect((await careersSettings(admin, base.companyId)).versions.map((v) => v.version)).toEqual([1]);
    const shownBefore = await careersPublicJob(ADDRESS, jobId);
    expect(shownBefore?.notice).toEqual({ version: 1, body: 'Fictional privacy notice, version one.' });
    expect(await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Careers Sdn Bhd', notice: 'Fictional privacy notice, version two.' }))
      .toEqual({ noticeVersion: 2 });
    const settings = await careersSettings(admin, base.companyId);
    expect(settings.versions.map((v) => [v.version, v.body])).toEqual([[2, 'Fictional privacy notice, version two.'], [1, 'Fictional privacy notice, version one.']]);
    expect(settings.notice?.version).toBe(2);
    const [v1After] = await owner.db.execute<{ body: string; created_at: string; id: string }>(sql`select id, body, created_at::text from recruitment_careers_notice where version = 1`);
    expect(v1After).toEqual(v1Before);
    expect((await careersPublicJob(ADDRESS, jobId))?.notice.version).toBe(2);
    // Consent counts only for the current notice. A form opened before the change is refused by the server (it knows the
    // current version) and, if the change lands between that check and the database, by the database: nothing is stored.
    expect(await apply(jobId, { noticeVersion: '1', currentNoticeVersion: 2 }, 'v1')).toEqual({ ok: false, fields: { consent: 'notice_changed' } });
    expect(await apply(jobId, { noticeVersion: '1', currentNoticeVersion: 1 }, 'v1-race')).toEqual({ ok: false, fields: { consent: 'notice_changed' } });
    expect(await apply(jobId, { noticeVersion: '7', currentNoticeVersion: 7 }, 'v7')).toEqual({ ok: false, fields: { consent: 'notice_changed' } });
    expect(await count('recruitment_candidate')).toBe(0);
    // Through the route: the form comes back with the message, the box unticked and the CURRENT notice to read.
    const stale = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({
      fullName: 'Fictional Stale Form', email: 'stale@example.test', consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
    expect(stale.status).toBe(400);
    const staleHtml = await stale.text();
    expect(staleHtml).toContain('The privacy notice has changed since you opened this page.');
    expect(staleHtml).toContain('<input type="hidden" name="noticeVersion" value="2">');
    expect(staleHtml).toContain('Fictional privacy notice, version two.');
    expect(staleHtml).not.toMatch(/name="consent" value="on" checked/);
    expect(await apply(jobId, { noticeVersion: '2', currentNoticeVersion: 2 }, 'v2')).toEqual({ ok: true, outcome: 'received' });
    const versions = await owner.db.execute<{ v: number }>(sql`select careers_notice_version as v from recruitment_candidate_consent order by recorded_at`);
    expect(versions.map((r) => r.v)).toEqual([2]);
    // Versions are never changed or deleted: not by the app role (no grant), not even through the owner connection.
    expect(await code(rows(admin, sql`update recruitment_careers_notice set body = 'Fictional rewrite' where version = 1`))).toBe('42501');
    expect(await code(rows(admin, sql`delete from recruitment_careers_notice where version = 1`))).toBe('42501');
    expect(await code(owner.db.execute(sql`update recruitment_careers_notice set body = 'Fictional rewrite' where version = 1`))).toBe('23514');
    expect(await code(owner.db.execute(sql`delete from recruitment_careers_notice where version = 1`))).toBe('23514');
    // A consent naming a careers notice version is written only by the careers submission.
    const [{ id: candidateId }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_candidate limit 1`);
    expect(await code(rows(admin, sql`insert into recruitment_candidate_consent (tenant_id, company_id, candidate_id, status, effective_on, method, careers_notice_version, recorded_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${candidateId}::uuid, 'consented', ${todayInKualaLumpur()}::date, 'online_form', 1, ${admin.userId}::uuid)`))).toBe('42501');
  });
});

describe('case 57 — the slice 5 removal of a careers applicant leaves no personal data', () => {
  it('clears the candidate, the message, the resume and the consent; the attempt log and events hold none', async () => {
    await site();
    const jobId = await publicJob();
    expect(await apply(jobId, {
      fullName: `${SENTINEL} Applicant`, email: 's8sentinel.applicant@example.test', mobile: '+60 12-555 0101', message: `${SENTINEL} message`,
      resume: { fileName: `${SENTINEL}.pdf`, content: pdf(SENTINEL) },
    }, 'removal')).toEqual({ ok: true, outcome: 'received' });
    const [{ id: applicationId, candidate_id: candidateId }] = await owner.db.execute<{ id: string; candidate_id: string }>(sql`select id, candidate_id from recruitment_application`);
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const past = addCalendarMonths(todayInKualaLumpur(), -30);
      await tx`update recruitment_application set state_changed_at = ${klInstant(past, '09:00')}::timestamptz where id = ${applicationId}::uuid`;
      await tx`update recruitment_candidate_consent set effective_on = ${past}::date where candidate_id = ${candidateId}::uuid`;
    });
    expect(await destroyCandidates(admin, base.companyId, [candidateId], 'on')).toEqual({ removed: 1 });
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${candidateId}::uuid`);
    expect(event.payload).toMatchObject({ careersMessages: 1, files: 1, consents: 1 });
    const [careers] = await owner.db.execute<{ message: string | null; job_id: string }>(sql`select message, job_id from recruitment_careers_application where application_id = ${applicationId}::uuid`);
    expect(careers).toEqual({ message: null, job_id: jobId });
    const tables = await owner.db.execute<{ name: string }>(sql`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and ((n.nspname = 'public' and c.relname like 'recruitment\\_%') or (n.nspname = 'app' and c.relname like 'recruitment\\_careers\\_%'))
      order by 1`);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['public.recruitment_careers_application', 'app.recruitment_careers_attempt']));
    for (const { name } of [...tables, { name: 'public.domain_event' }]) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(name)} r where to_jsonb(r.*)::text ilike ${`%${SENTINEL}%`}
        or to_jsonb(r.*)::text ilike '%555 0101%'`);
      expect(hit.n, `${name} still holds personal data`).toBe(0);
    }
    // A later application from the same person is a new candidate.
    expect(await apply(jobId, { email: 's8sentinel.applicant@example.test' }, 'after')).toEqual({ ok: true, outcome: 'received' });
    expect(await count('recruitment_candidate')).toBe(2);
  });
});

describe('the submission is refused inside a signed-in session and a job closing mid-submission stores nothing', () => {
  it('refuses a call that carries a session and answers a job taken off the page with Not found', async () => {
    await site();
    const jobId = await publicJob();
    expect(await code(rows(admin, sql`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('s')}, 'Fictional', 'a@b.cd', null, null, 1, false)`))).toBe('42501');
    await setJobCareersPage(admin, jobId, false);
    expect(await apply(jobId, {}, 'gone')).toEqual({ ok: true, outcome: 'not_found' });
    expect(await count('recruitment_candidate')).toBe(0);
  });
});

describe('row security on the careers tables', () => {
  it('forces row security, grants the app role only what HR needs, nothing to PUBLIC, and nothing at all on the private tables', async () => {
    const forced = await owner.db.execute<{ name: string; rls: boolean; forced: boolean }>(sql`select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname in ('recruitment_careers_site', 'recruitment_careers_notice',
      'recruitment_careers_application', 'recruitment_careers_attempt', 'recruitment_careers_context') order by 1`);
    expect(forced).toHaveLength(5);
    for (const t of forced) expect(t, t.name).toMatchObject({ rls: true, forced: true });
    const grants = await owner.db.execute<{ table_name: string; grantee: string; privilege_type: string }>(sql`select table_name, grantee, privilege_type
      from information_schema.role_table_grants where table_name like 'recruitment\\_careers\\_%' and grantee in ('ai_hr_app', 'PUBLIC') order by 1, 3`);
    expect(grants.map((g) => `${g.table_name}:${g.grantee}:${g.privilege_type}`)).toEqual([
      'recruitment_careers_application:ai_hr_app:SELECT', 'recruitment_careers_notice:ai_hr_app:INSERT', 'recruitment_careers_notice:ai_hr_app:SELECT',
      'recruitment_careers_site:ai_hr_app:INSERT', 'recruitment_careers_site:ai_hr_app:SELECT', 'recruitment_careers_site:ai_hr_app:UPDATE',
    ]);
    const fns = await owner.db.execute<{ f: string; definer: boolean; config: string[]; app: boolean; pub: boolean }>(sql`
      select p.oid::regprocedure::text as f, p.prosecdef as definer, p.proconfig as config, has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') as app,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'recruitment\\_careers\\_%' order by 1`);
    expect(fns.map((f) => [f.f, f.definer, f.app, f.pub])).toEqual([
      ['app.recruitment_careers_client_limited(text)', true, true, false],
      ['app.recruitment_careers_job(text,uuid)', true, true, false],
      ['app.recruitment_careers_open(uuid,uuid)', true, true, false],
      ['app.recruitment_careers_page(text,text,text,text,integer)', true, true, false],
      ['app.recruitment_careers_prune()', true, false, false],
      ['app.recruitment_careers_published(uuid,uuid)', true, true, false],
      ['app.recruitment_careers_site_at(text)', true, false, false],
      ['app.recruitment_careers_submit(text,uuid,text,text,text,text,text,integer,boolean,text,text,bytea)', true, true, false],
    ]);
    for (const f of fns) expect(f.config.some((c) => c.startsWith('search_path=pg_catalog')), f.f).toBe(true);
    // The app role reads nothing private directly.
    expect(await code(owner.client.begin(async (tx) => { await tx`set local role ai_hr_app`; return tx`select 1 from app.recruitment_careers_attempt`; }))).toBe('42501');
  });
});

describe('the owner-only, marker-bound policies under a production-like owner', () => {
  it('lets the careers functions work for a NOBYPASSRLS owner, only through those policies', async () => {
    await site();
    const jobId = await publicJob({ title: 'Fictional owner rehearsal job' });
    await createJob(admin, job({ title: 'Fictional hidden rehearsal job' }));
    const ROLLBACK = 'rolled back on purpose';
    // In the test cluster the superuser owns every table and bypasses row security, so nothing above proves the
    // marker-bound policies. Here, in ONE rolled-back transaction, the migration role ai_hr_owner (as in production: not a
    // superuser, no BYPASSRLS) takes over the recruitment tables, the careers marker and attempt tables, the kernel tables
    // the definers read and the definer functions; then everything runs as the app role with NO session.
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['public.recruitment_careers_site', 'app.recruitment_careers_context', 'app.recruitment_careers_attempt']));
      for (const t of tables) await tx.unsafe(`alter table ${t.name} owner to ai_hr_owner`);
      const fns = await tx<{ f: string }[]>`select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_' and p.prosecdef`;
      for (const { f } of fns) await tx.unsafe(`alter function ${f} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const anonymous = async () => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true), set_config('app.roles', '', true), set_config('app.grants', '[]', true)`;
      };
      const markers = async () => {
        await tx`reset role`;
        return (await tx<{ n: number }[]>`select count(*)::int as n from app.recruitment_careers_context`)[0].n;
      };
      // Outside a submission the owner sees only what is public: the Open, flagged job of a published page — never the
      // hidden one, and no candidate or application (FORCE row security binds it, and no marker is held).
      await tx.unsafe('set local role ai_hr_owner');
      expect((await tx`select id from recruitment_job_opening`).map((r) => r.id)).toEqual([jobId]);
      expect(await tx`select company_id from recruitment_company_setting`).toEqual([]);

      await anonymous();
      const [page] = await tx`select app.recruitment_careers_page(${ADDRESS}, null, null, null, 1) as r`;
      expect((page.r as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toEqual([jobId]);
      const [one] = await tx`select app.recruitment_careers_job(${ADDRESS}, ${jobId}::uuid) as r`;
      expect((one.r as { notice: { version: number } }).notice.version).toBe(1);
      const [ok] = await tx`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('owner')}, 'Fictional Owner Applicant', 'owner.applicant@example.test',
        '+60 12-000 1111', 'Fictional message', 1, false, 'cv.pdf', 'application/pdf', ${pdf()}::bytea) as r`;
      expect(ok.r).toEqual({ status: 'received' });
      const [repeat] = await tx`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('owner-2')}, 'Fictional Owner Applicant', 'OWNER.applicant@example.test',
        null, null, 1, false) as r`;
      expect(repeat.r).toEqual({ status: 'received' });
      // The app role still reads none of it directly.
      expect(await tx`select 1 from recruitment_candidate`).toEqual([]);
      expect(await markers()).toBe(0);
      expect((await tx<{ n: number }[]>`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`)[0].n).toBe(1);
      for (const t of ['recruitment_candidate_file', 'recruitment_candidate_consent', 'recruitment_careers_application', 'recruitment_application_event']) {
        expect((await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`))[0].n, t).toBe(1);
      }

      // Without the marker-bound policies the submission can write nothing; without the public ones the reads find
      // nothing. This test fails if either set is dropped.
      const marked = await tx<{ name: string; tbl: string }[]>`select policyname as name, format('%I.%I', schemaname, tablename) as tbl from pg_policies
        where policyname ~ '^recruitment_[a-z_]+_careers_(read|insert|lock)$'`;
      expect(marked.length).toBe(14);
      for (const p of marked) await tx.unsafe(`drop policy ${p.name} on ${p.tbl}`);
      await anonymous();
      const [refused] = await tx`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('owner-3')}, 'Fictional Second', 'second@example.test', null, null, 1, false) as r`;
      expect(refused.r).toEqual({ status: 'not_found' });
      const [stillPublic] = await tx`select app.recruitment_careers_page(${ADDRESS}, null, null, null, 1) as r`;
      expect((stillPublic.r as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toEqual([jobId]);
      await tx`reset role`;
      const published = await tx<{ name: string; tbl: string }[]>`select policyname as name, format('%I.%I', schemaname, tablename) as tbl from pg_policies
        where policyname in ('recruitment_job_opening_careers_public', 'recruitment_careers_notice_public')`;
      expect(published.length).toBe(2);
      for (const p of published) await tx.unsafe(`drop policy ${p.name} on ${p.tbl}`);
      await anonymous();
      const [empty] = await tx`select app.recruitment_careers_page(${ADDRESS}, null, null, null, 1) as r`;
      expect((empty.r as { jobs: unknown[] }).jobs).toEqual([]);
      expect((await tx`select app.recruitment_careers_job(${ADDRESS}, ${jobId}::uuid) as r`)[0].r).toBeNull();
      expect(await markers()).toBe(0);
      throw new Error(ROLLBACK);
    }).catch((e: unknown) => (e instanceof Error && e.message === ROLLBACK ? 'rolled back' : Promise.reject(e)));
    expect(done).toBe('rolled back');
    expect(await count('recruitment_candidate')).toBe(0);
    const [{ owner: tableOwner }] = await owner.db.execute<{ owner: string }>(sql`select tableowner as owner from pg_tables where tablename = 'recruitment_careers_site'`);
    expect(tableOwner).not.toBe('ai_hr_owner');
  });
});

describe('deleting a company removes its careers page and notices with the rest of its recruitment setup', () => {
  it('removes the site and every notice version of a company without recruitment history', async () => {
    await site(admin, otherCompanyId, 'fictional-other');
    await updateCareersSettings(admin, otherCompanyId, { address: 'fictional-other', displayName: 'Fictional Other', notice: 'Fictional notice two.' });
    const [removed] = await rows({ ...admin, grants: [{ role: 'hr_admin', companyId: null }] }, sql`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid) as n`);
    expect(Number((removed as { n: number }).n)).toBeGreaterThanOrEqual(3);
    const [left] = await owner.db.execute<{ sites: number; notices: number }>(sql`select (select count(*)::int from recruitment_careers_site where company_id = ${otherCompanyId}::uuid) as sites,
      (select count(*)::int from recruitment_careers_notice where company_id = ${otherCompanyId}::uuid) as notices`);
    expect(left).toEqual({ sites: 0, notices: 0 });
  });
});

describe('the request source: no verified source, no applications (outside local development)', () => {
  it('refuses submissions with the unavailable page in a production server without trust, keeps the pages readable, and works in development', async () => {
    await site();
    const jobId = await publicJob();
    const post = (n: number, headers: Record<string, string> = {}) => applyRoute(new NextRequest(`${ORIGIN}/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', headers,
      body: form({ fullName: `Fictional Source ${n}`, email: `source${n}@example.test`, consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '');
    vi.stubEnv('NODE_ENV', 'production');
    const refused = await post(1, { 'x-aihr-request-source': SOURCE });
    expect(refused.status).toBe(503);
    const body = await refused.text();
    expect(body).toContain('Online applications are not available right now.');
    expect(body).not.toContain('not accepting applications');
    // The pages stay readable; the job page explains instead of offering a form that cannot be sent.
    const page = await jobRoute(new NextRequest(`${ORIGIN}/careers/${ADDRESS}/jobs/${jobId}`), jobParams(jobId));
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain('Online applications are not available right now.');
    expect(pageHtml).not.toContain('<form method="post"');
    expect((await careersSettings(admin, base.companyId)).acceptingApplications).toBe(false);
    // Trust on but the proxy header missing or malformed: the unavailable page, never the company-limit page.
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
    for (const headers of [{}, { 'x-aihr-request-source': 'not an address' }, { 'x-aihr-request-source': '192.0.2.1, 192.0.2.2' }] as Record<string, string>[]) {
      const r = await post(2, headers);
      expect(r.status, JSON.stringify(headers)).toBe(503);
      expect(await r.text()).toContain('Online applications are not available right now.');
    }
    expect(await count('recruitment_candidate')).toBe(0);
    expect(await attempts()).toBe(0);
    // Local development (next dev) without trust: a development-only bucket, and the form works.
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect((await post(3)).status).toBe(200);
    expect((await careersSettings(admin, base.companyId)).acceptingApplications).toBe(true);
    expect(await count('recruitment_candidate')).toBe(1);
  });
});

describe('control characters are refused with field messages and nothing is stored', () => {
  it('refuses NUL and other control characters in every text field and the file name; line breaks stay allowed in the message', async () => {
    await site();
    const jobId = await publicJob();
    const bad: [Partial<CareersSubmission>, Record<string, string>][] = [
      [{ fullName: 'Fictional\u0000Name' }, { fullName: 'invalid' }],
      [{ fullName: 'Fictional\u001bName' }, { fullName: 'invalid' }],
      [{ email: 'a\u0000b@example.test' }, { email: 'invalid' }],
      [{ mobile: '012\u0000345678' }, { mobile: 'invalid' }],
      [{ message: 'Fictional\u0000message' }, { message: 'invalid' }],
      [{ message: 'Fictional\tmessage' }, { message: 'invalid' }],
      [{ message: 'Fictional\u0085message' }, { message: 'invalid' }],
      [{ resume: { fileName: 'cv\u0000.pdf', content: pdf() } }, { resume: 'file_name' }],
      [{ resume: { fileName: 'cv\u202Efdp.exe', content: pdf() } }, { resume: 'file_name' }],
      [{ resume: { fileName: '../cv.pdf', content: pdf() } }, { resume: 'file_name' }],
    ];
    for (const [over, fields] of bad) expect(await apply(jobId, over), JSON.stringify(fields)).toEqual({ ok: false, fields });
    expect(await apply(jobId, { message: 'Line one\r\nLine two' })).toEqual({ ok: true, outcome: 'received' });
    // The database refuses the same on its own.
    for (const [name, message, file] of [['Fictional\u0001', null, null], ['Fictional', 'tab\there', null], ['Fictional', null, 'cv\u202e.pdf']] as const) {
      expect(await code(owner.db.execute(sql`select app.recruitment_careers_submit(${ADDRESS}, ${jobId}::uuid, ${hashOf('db')}, ${name}, 'a@b.cd', null, ${message}, 1, false,
        ${file}, ${file ? 'application/pdf' : null}, ${file ? pdf() : null}::bytea)`)), String(name)).toBe('22023');
    }
    // Through the route: 400 with the message.
    const r = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({ fullName: 'Fictional\u0000', email: 'ok@example.test', consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Check this field.');
    expect(await count('recruitment_candidate')).toBe(1);
  });
});

describe('anonymous traffic is bounded', () => {
  it('charges page reads to a per-source budget (60 a minute) and answers over it with 429', async () => {
    await site();
    const jobId = await publicJob();
    const read = (source: string, i: number) => (i % 2 === 0
      ? pageRoute(req(`/careers/${ADDRESS}`, { headers: { 'x-aihr-request-source': source } }), pageParams())
      : jobRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { headers: { 'x-aihr-request-source': source } }), jobParams(jobId)));
    for (let i = 0; i < 60; i++) expect((await read('192.0.2.20', i)).status, `read ${i + 1}`).toBe(200);
    let limited: Response | null = null;
    for (let i = 0; i < 5 && !limited; i++) {
      const r = await read('192.0.2.20', i);
      if (r.status === 429) limited = r;
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBe('60');
    expect(await limited?.text()).toContain('Too many page requests from this connection.');
    // Another source is unaffected; no budget key holds the address.
    expect((await read('192.0.2.21', 0)).status).toBe(200);
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from app_request_budget where budget_key like '%192.0.2%'`);
    expect(n).toBe(0);
  });

  it('answers a lock wait beyond the bound with the unavailable page, not a limit page', async () => {
    await site();
    const jobId = await publicJob();
    const [{ key }] = await owner.db.execute<{ key: string }>(sql`select hashtextextended(${`recruitment-careers-company:${base.tenantId}:${base.companyId}`}, 0)::text as key`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let response!: Response;
      await owner.client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${key}::bigint)`;
        response = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({ fullName: 'Fictional Waiting', email: 'waiting@example.test', consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('Online applications are not available right now.');
      expect(log.mock.calls).toEqual([['careers request failed', 'submit', 'PostgresError', '55P03']]);
    } finally {
      log.mockRestore();
    }
    expect(await count('recruitment_candidate')).toBe(0);
  });
});

describe('the scheduled prune', () => {
  it('deletes submission records older than two days even when nothing is submitted, and only the owner may run it', async () => {
    await owner.db.execute(sql`insert into app.recruitment_careers_attempt (client_hash, attempted_at) values
      (${hashOf('old-1')}, now() - interval '49 hours'), (${hashOf('old-2')}, now() - interval '3 days'), (${hashOf('fresh')}, now() - interval '47 hours')`);
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select app.recruitment_careers_prune() as n`);
    expect(n).toBe(2);
    const left = await owner.db.execute<{ client_hash: string }>(sql`select client_hash from app.recruitment_careers_attempt`);
    expect(left.map((r) => r.client_hash)).toEqual([hashOf('fresh')]);
    expect(await code(rows(admin, sql`select app.recruitment_careers_prune()`))).toBe('42501');
  });
});

describe('careers applications carry the canonical source code', () => {
  it('stores career_page on the candidate and the application, and the reports count them under that code', async () => {
    await site();
    const jobId = await publicJob();
    expect(await apply(jobId, {}, 'source-1')).toEqual({ ok: true, outcome: 'received' });
    expect(await apply(jobId, {}, 'source-2')).toEqual({ ok: true, outcome: 'received' });
    await addApplication(admin, { jobId, fullName: 'Fictional Walk-in', email: 'walkin@example.test', candidateSource: 'walk_in' });
    const sources = await owner.db.execute<{ candidate: string | null; application: string | null }>(sql`
      select c.source as candidate, a.source as application from recruitment_application a join recruitment_candidate c on c.id = a.candidate_id
      join recruitment_careers_application k on k.application_id = a.id`);
    expect(sources).toEqual([{ candidate: 'career_page', application: 'career_page' }, { candidate: 'career_page', application: 'career_page' }]);
    const today = todayInKualaLumpur();
    const report = await recruitmentOverviewReport(admin, [base.companyId], { from: today, to: today });
    expect(report.bySource).toEqual([{ source: 'career_page', count: 2 }, { source: 'walk_in', count: 1 }]);
  });
});

describe('a source that has used its hourly submissions is refused before its body is read', () => {
  it('answers 429 without parsing the body once five submissions were made this hour', async () => {
    await site();
    const jobId = await publicJob();
    for (let n = 1; n <= 5; n++) {
      const r = await applyRoute(req(`/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body: form({ fullName: `Fictional Early ${n}`, email: `early${n}@example.test`, consent: 'on', noticeVersion: '1' }) }), jobParams(jobId));
      expect(r.status, `#${n}`).toBe(200);
    }
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024 * 1024)); } });
    const r = await applyRoute(new NextRequest(`${ORIGIN}/careers/${ADDRESS}/jobs/${jobId}`, { method: 'POST', body,
      headers: { 'x-aihr-request-source': SOURCE, 'content-type': 'multipart/form-data; boundary=x' }, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]), jobParams(jobId));
    expect(r.status).toBe(429);
    expect(await r.text()).toContain('Too many applications from this connection. Try again later.');
    expect(pulled).toBeLessThanOrEqual(1);
    expect(await attempts()).toBe(5);
    expect(await count('recruitment_candidate')).toBe(5);
    // The check is read-only and answers only a boolean; the app role cannot read the attempt log itself.
    const [{ limited }] = await owner.db.execute<{ limited: boolean }>(sql`select app.recruitment_careers_client_limited(${hashOf('nobody')}) as limited`);
    expect(limited).toBe(false);
  });
});

describe('residual-risk guard: owner-run functions that can see public careers rows', () => {
  it('pins every SECURITY DEFINER function that reads job openings, careers sites or careers notices, so a new one forces a review', async () => {
    // The owner-only public policies (4408) expose every column of an Open job flagged for a published careers page, and
    // the published sites and their notices, to any code running as the owner. Each function listed here was reviewed
    // to filter by tenant and company itself (or to be a careers function returning only public fields). Adding one
    // fails this test: review it for that before adding it to the list.
    const rows = await owner.db.execute<{ f: string }>(sql`
      select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
        and p.prosrc ~ '(recruitment_job_opening|recruitment_careers_site|recruitment_careers_notice)'
      order by 1`);
    expect(rows.map((r) => r.f)).toEqual(REVIEWED_DEFINERS);
  });
});
