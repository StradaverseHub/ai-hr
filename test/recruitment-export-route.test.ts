/**
 * Recruitment slice 16 — the export download route itself (app/recruitment/export/route.ts) against Postgres: the company scope it
 * passes (a talent pool export by someone who administers only some of the companies in scope), the response headers, CSV escaping
 * and typed Excel cells, the audit event written through the route, and the refusals that return to the page (?problem=). Also the
 * export admission (one running export per person) and the time limit mapped to a plain refusal without a retry.
 *
 * The session and scope come from mocks (the route reads them from the request); the database work is real. Every person is fictional.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addApplication, createJob, exportBoard, recruitmentSettings, rejectApplication, RecruitmentError } from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let current: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/authz', async (orig) => ({ ...(await orig<object>()), requireModule: vi.fn(async () => current.s) }));
vi.mock('@/lib/scope', () => ({ scopedSession: vi.fn(async () => ({ ...current, allowedCount: current.scopeIds.length })) }));
vi.mock('next-intl/server', () => {
  const cat = JSON.parse(readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'messages/en.json'), 'utf8'));
  const dig = (o: unknown, dotted: string) => dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
  return {
    getLocale: async () => 'en',
    getTranslations: async (ns: string | { namespace: string }) => {
      const base = dig(cat, typeof ns === 'string' ? ns : ns.namespace);
      return (key: string) => {
        const v = dig(base, key);
        if (typeof v !== 'string') throw new Error(`messages/en.json is missing ${String(ns)}.${key}`);
        return v;
      };
    },
  };
});
import { GET } from '../app/recruitment/export/route';

let base: Base;
let admin: SessionContext;
let gradeId: string;
let otherCompanyId: string;
type Login = SessionContext & { userId: string };
async function login(name: string, companyId = base.companyId): Promise<Login> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function partnerOf(companyId: string, name: string): Promise<Login> {
  const who = await login(name, companyId);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: who.userId, companyId, role: 'recruiting_partner' });
  return { ...who, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId }] };
}
const JOB = { workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time' };
const get = (query: Record<string, string | string[]>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  return GET(new Request(`http://localhost/recruitment/export?${q}`));
};
const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};

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

describe('the export route', () => {
  it('downloads the board as CSV (formula-escaped) and Excel (typed cells), with private headers and an audit event through the route', async () => {
    const recruiter = await login('Fictional Recruiter');
    const { id: jobId } = await createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title: 'Fictional analyst', recruiterUserId: recruiter.userId });
    await addApplication(recruiter, { jobId, fullName: '=QZXEQ()', email: 'eq@example.test' });
    current = { s: recruiter, scopeIds: [base.companyId] };
    const res = await get({ kind: 'board', format: 'csv', job: jobId, columns: ['candidateName', 'jobTitle'], returnTo: '/recruitment/candidates' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="board-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.text();
    expect(body).toContain("'=QZXEQ()");
    expect(body.split('\r\n')[1]).toBe("'=QZXEQ(),Fictional analyst");
    const [ev] = await owner.db.execute<{ actor_id: string; payload: Record<string, unknown> }>(sql`select actor_id, payload from domain_event
      where tenant_id = ${base.tenantId}::uuid and event_type = 'recruitment-export.created'`);
    expect(ev).toEqual({ actor_id: recruiter.userId, payload: { kind: 'board', companyIds: [base.companyId], format: 'csv', filters: { job: jobId }, columns: 2, rows: 1 } });
    // Excel: a string cell is written as it is (Excel never evaluates it), a number as a number.
    const xlsx = await get({ kind: 'board', format: 'xlsx', job: jobId, columns: ['candidateName', 'appliedOn'], returnTo: '/recruitment/candidates' });
    expect(xlsx.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const XLSX = await import('xlsx');
    const wb = XLSX.read(new Uint8Array(await xlsx.arrayBuffer()), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    expect(sheet.A2).toMatchObject({ t: 's', v: '=QZXEQ()' });
    expect(sheet.A2.f).toBeUndefined();
  });

  it('exports the talent pool of only the administered companies in a mixed scope; refusals return to the page with ?problem=', async () => {
    const recruiter = await login('Fictional Recruiter');
    const partner = await partnerOf(base.companyId, 'Fictional Partner');
    const { id: jobId } = await createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title: 'Fictional analyst', recruiterUserId: recruiter.userId });
    const a = await addApplication(recruiter, { jobId, fullName: 'Fictional Pooled QZXPOOL', email: 'pool@example.test' });
    await rejectApplication(admin, a.applicationId, (await recruitmentSettings(admin, base.companyId)).reasons[0].id);
    // The partner administers this company only; their scope also holds the other company.
    current = { s: partner, scopeIds: [base.companyId, otherCompanyId] };
    const res = await get({ kind: 'talent_pool', format: 'csv', columns: ['candidateName'], returnTo: '/recruitment/talent-pool?pool=public' });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8').split('\r\n').filter(Boolean)).toEqual(['Candidate', 'Fictional Pooled QZXPOOL']);
    const [ev] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where event_type = 'recruitment-export.created'`);
    expect(ev.payload).toMatchObject({ kind: 'talent_pool', rows: 1 });
    // A recruiter may not open the talent pool: back to the page with the refusal, and no event.
    current = { s: recruiter, scopeIds: [base.companyId] };
    const refused = await get({ kind: 'talent_pool', format: 'csv', returnTo: '/recruitment/talent-pool?pool=public' });
    expect(refused.status).toBe(303);
    expect(new URL(refused.headers.get('location')!).pathname + new URL(refused.headers.get('location')!).search).toBe('/recruitment/talent-pool?pool=public&problem=forbidden');
    const odd = await get({ kind: 'payroll', returnTo: 'https://evil.example/' });
    expect(new URL(odd.headers.get('location')!).pathname + new URL(odd.headers.get('location')!).search).toBe('/recruitment/candidates?problem=invalid_input');
    expect((await owner.db.execute(sql`select 1 from domain_event where event_type = 'recruitment-export.created'`)).length).toBe(1);
  });

  it('admits one running export per person, and turns a statement timeout into a plain refusal without retrying it', async () => {
    const recruiter = await login('Fictional Recruiter');
    const { id: jobId } = await createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title: 'Fictional analyst', recruiterUserId: recruiter.userId });
    await addApplication(recruiter, { jobId, fullName: 'Fictional Busy', email: 'busy@example.test' });
    // Another export of the same person holds its admission (the same transaction-scoped lock the service takes).
    const held = await owner.client.reserve();
    try {
      await held`begin`;
      await held`select pg_advisory_xact_lock(hashtextextended(${`recruitment-export-user:${base.tenantId}:${recruiter.userId}`}, 0))`;
      expect(await code(exportBoard(recruiter, [base.companyId], {}, null, 'en'))).toBe('export_busy');
      await held`rollback`;
    } finally { held.release(); }
    expect((await exportBoard(recruiter, [base.companyId], {}, null, 'en')).rows.length).toBe(1);
    // A statement over the export's time limit (the application table locked by another session): one refusal, not three attempts.
    const blocker = await owner.client.reserve();
    process.env.RECRUITMENT_EXPORT_TIMEOUT_MS = '300';
    try {
      await blocker`begin`;
      await blocker`lock table recruitment_application in access exclusive mode`;
      const startedAt = performance.now();
      expect(await code(exportBoard(recruiter, [base.companyId], {}, null, 'en'))).toBe('export_too_slow');
      expect(performance.now() - startedAt).toBeLessThan(900);
      await blocker`rollback`;
    } finally {
      delete process.env.RECRUITMENT_EXPORT_TIMEOUT_MS;
      blocker.release();
    }
  });
});
