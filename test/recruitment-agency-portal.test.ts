/**
 * Recruitment slice 25 against Postgres — the agency portal: acceptance cases 162–168 (docs/recruitment-reconstruction/specification.md
 * "Slice 25 acceptance cases") through the public route handlers, the service, a FAKED mail relay (code e-mails are captured, nothing
 * is sent) and directly as the app role. Case 169 is the rendered check. Every person and address is fictional.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const relay = vi.hoisted(() => ({ available: true, sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock('../lib/recruitment-candidate-email-ipc', async (original) => ({
  ...(await original<typeof import('../lib/recruitment-candidate-email-ipc')>()),
  candidateEmailAvailable: async () => relay.available,
  candidateEmailSender: async () => (relay.available ? { revision: 'rev-fixture', host: 'hr.example.test', send: async (m: (typeof relay.sent)[number]) => { relay.sent.push(m); } } : null),
}));
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { jobGrade } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  agencyPortalInbox, assignAgencyContract, createJob, declineAgencyPortalSubmission, recordAgencyPortalSubmission, saveAgency, saveAgencyConsultant,
  saveAgencyContract, saveCandidateEmailSettings, setCareersPublished, updateAgencyPortalSetting, updateCareersSettings, RecruitmentError,
} from '../packs/recruitment/service';
import { GET as portalGet, POST as portalPost } from '../app/careers/[address]/agency/route';
import { GET as jobGet, POST as jobPost } from '../app/careers/[address]/agency/jobs/[jobId]/route';
import { closeCareersPool } from '../packs/recruitment/careers';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ADDRESS = 'fictional-agency';
const ORIGIN = 'https://careers.fixture.test';
const CONSULTANT = 'consultant.s25@agency.example.test';
let base: Base;
let admin: SessionContext;
let gradeId: string;
let today: string;
let clientSeq = 0;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const req = (path: string, init: { method?: string; body?: FormData; cookie?: string; source?: string } = {}) => new NextRequest(ORIGIN + path, {
  method: init.method, body: init.body,
  headers: { 'x-aihr-request-source': init.source ?? `198.51.100.${(clientSeq % 200) + 1}`, ...(init.cookie ? { cookie: `aihr_agency_portal=${init.cookie}` } : {}) },
});
const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const portalPath = `/careers/${ADDRESS}/agency`;
const params = { params: Promise.resolve({ address: ADDRESS }) };
const jobParams = (jobId: string) => ({ params: Promise.resolve({ address: ADDRESS, jobId }) });
const lastCode = () => /\b(\d{6})\b/.exec(relay.sent.at(-1)?.text ?? '')?.[1] ?? null;
const cookieOf = (r: Response) => /aihr_agency_portal=([A-Za-z0-9_-]{43})/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? null;

/** Ask for a code and enter it, as a consultant does; returns the session cookie value (or null). */
async function signIn(email = CONSULTANT): Promise<string | null> {
  await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'code', email }) }), params);
  const c = lastCode();
  if (!c) return null;
  const r = await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'verify', email, code: c }) }), params);
  return cookieOf(r);
}
async function setup(over: { endsOn?: string; status?: string } = {}) {
  await updateCareersSettings(admin, base.companyId, { address: ADDRESS, displayName: 'Fictional Agency Careers', headline: '', introduction: '', notice: 'Fictional notice.' });
  await setCareersPublished(admin, base.companyId, true);
  await saveCandidateEmailSettings(admin, base.companyId, { enabled: true, replyTo: 'talent.s25@example.test', senderName: 'S25 Talent', locale: 'en' });
  await updateAgencyPortalSetting(admin, base.companyId, true);
  const { id: agencyId } = await saveAgency(admin, { companyId: base.companyId, name: 'Fictional S25 Agency' });
  const { id: contractId } = await saveAgencyContract(admin, { agencyId, name: 'Fictional S25 contract', contractType: 'headhunter', feeRate: '20',
    startsOn: addDays(today, -10), endsOn: over.endsOn ?? addDays(today, 100), hrContactUserId: base.adminUserId, access: 'public' });
  const { id: consultantId } = await saveAgencyConsultant(admin, { contractId, name: 'Fictional S25 Consultant', email: CONSULTANT });
  const { id: jobId } = await createJob(admin, { companyId: base.companyId, title: 'Fictional S25 analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
    recruitmentType: 'budgeted', employmentType: 'full_time', description: 'Fictional description.' });
  await assignAgencyContract(admin, jobId, contractId);
  return { agencyId, contractId, consultantId, jobId };
}
/** Fixture: change a row past its audit guards (owner connection), as an administrator would in Settings › Agencies. */
async function disable(table: 'recruitment_agency_contract' | 'recruitment_agency_consultant', id: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx.unsafe(`update ${table} set status = 'disabled' where id = $1::uuid`, [id]);
  });
}
const submit = (cookie: string, jobId: string, contractId: string, values: Record<string, string> = {}) => jobPost(req(`${portalPath}/jobs/${jobId}`, {
  method: 'POST', cookie, body: form({ contractId, fullName: 'Fictional S25 Candidate', email: 's25.candidate@example.test', mobile: '', comments: 'Fictional note', ...values }),
}), jobParams(jobId));

beforeAll(migrateTestDb);
afterAll(async () => { await closeCareersPool(); await closeAll(); });
beforeEach(async () => {
  vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
  relay.available = true;
  relay.sent.length = 0;
  clientSeq++;
  await resetDb();
  for (const t of ['code', 'check', 'session']) await owner.db.execute(sql.raw(`delete from app.recruitment_agency_portal_${t}`));
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  today = todayInKualaLumpur();
});

describe('case 162 — the portal exists only while switched on with candidate e-mail able to send', () => {
  it('answers Not found when off, and the sign-in step when on', async () => {
    await setup();
    expect((await portalGet(req(portalPath), params)).status).toBe(200);
    await updateAgencyPortalSetting(admin, base.companyId, false);
    expect((await portalGet(req(portalPath), params)).status).toBe(404);
    await updateAgencyPortalSetting(admin, base.companyId, true);
    relay.available = false;
    expect((await portalGet(req(portalPath), params)).status).toBe(404);
  });
});

describe('case 163 — a code goes only to an active consultant on a usable contract; the page never tells', () => {
  it('sends to the consultant, not to a stranger or a disabled contract, with the same page', async () => {
    const f = await setup();
    const asked = async (email: string) => (await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'code', email }) }), params)).text();
    const known = await asked(CONSULTANT);
    expect(relay.sent.map((m) => m.to)).toEqual([CONSULTANT]);
    expect(relay.sent[0].text).not.toMatch(/https?:|www\./);
    const stranger = await asked('stranger.s25@example.test');
    expect(relay.sent).toHaveLength(1);
    expect(stranger.split('stranger.s25@example.test').join('X')).toBe(known.split(CONSULTANT).join('X'));
    await disable('recruitment_agency_contract', f.contractId);
    await asked(CONSULTANT);
    expect(relay.sent).toHaveLength(1);
    // No address or code is stored in clear.
    const stored = JSON.stringify(await owner.db.execute(sql`select * from app.recruitment_agency_portal_code`));
    expect(stored).not.toContain(CONSULTANT);
  });
  it('limits codes per address (3 an hour) and checks per client (30 an hour); 5 wrong entries spend a code', async () => {
    await setup();
    for (let i = 0; i < 4; i++) await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'code', email: CONSULTANT }) }), params);
    expect(relay.sent).toHaveLength(3);
    const right = lastCode()!;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'verify', email: CONSULTANT, code: wrong }) }), params);
      expect(r.status).toBe(400);
    }
    const late = await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'verify', email: CONSULTANT, code: right }) }), params);
    expect(cookieOf(late)).toBeNull();
    for (let i = 0; i < 24; i++) await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'verify', email: CONSULTANT, code: wrong }) }), params);
    expect((await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'verify', email: CONSULTANT, code: wrong }) }), params)).status).toBe(429);
  });
});

describe('case 164 — a session shows only the consultant\'s released jobs and ends when access ends', () => {
  it('signs in with an HttpOnly, SameSite=Strict cookie on the portal path and ends with the contract', async () => {
    const f = await setup();
    const { id: other } = await createJob(admin, { companyId: base.companyId, title: 'Fictional S25 unreleased', jobGradeIds: [gradeId], workLocation: 'Penang',
      recruitmentType: 'budgeted', employmentType: 'full_time' });
    await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'code', email: CONSULTANT }) }), params);
    const r = await portalPost(req(portalPath, { method: 'POST', body: form({ intent: 'verify', email: CONSULTANT, code: lastCode()! }) }), params);
    const setCookie = r.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toContain(`Path=${portalPath}`);
    const cookie = cookieOf(r)!;
    const page = await (await portalGet(req(portalPath, { cookie }), params)).text();
    expect(page).toContain('Fictional S25 analyst');
    expect(page).not.toContain('Fictional S25 unreleased');
    expect((await jobGet(req(`${portalPath}/jobs/${other}`, { cookie }), jobParams(other))).status).toBe(404);
    expect((await jobGet(req(`${portalPath}/jobs/${f.jobId}`, { cookie }), jobParams(f.jobId))).status).toBe(200);
    // The session is stored only as a hash.
    expect(JSON.stringify(await owner.db.execute(sql`select * from app.recruitment_agency_portal_session`))).not.toContain(cookie);
    await disable('recruitment_agency_consultant', f.consultantId);
    const after = await portalGet(req(portalPath, { cookie }), params);
    expect(await after.text()).toContain('signed out');
    expect((await jobGet(req(`${portalPath}/jobs/${f.jobId}`, { cookie }), jobParams(f.jobId))).status).toBe(401);
  });
  it('signs out', async () => {
    await setup();
    const cookie = (await signIn())!;
    await portalPost(req(portalPath, { method: 'POST', cookie, body: form({ intent: 'signout' }) }), params);
    expect(await (await portalGet(req(portalPath, { cookie }), params)).text()).not.toContain('Fictional S25 analyst');
  });
});

describe('case 165 — a submission waits in HR\'s inbox and creates nothing else', () => {
  it('stores the submission for the job\'s operators, refuses repeats, invalid fields and a job not released', async () => {
    const f = await setup();
    const cookie = (await signIn())!;
    const r = await submit(cookie, f.jobId, f.contractId);
    expect(r.status).toBe(303);
    expect((await owner.db.execute(sql`select count(*)::int as n from recruitment_candidate`))[0].n).toBe(0);
    expect((await owner.db.execute(sql`select count(*)::int as n from recruitment_agency_submission`))[0].n).toBe(0);
    const inbox = await agencyPortalInbox(admin, base.companyId);
    expect(inbox.map((x) => [x.fullName, x.state, x.consultantName])).toEqual([['Fictional S25 Candidate', 'waiting', 'Fictional S25 Consultant']]);
    expect((await submit(cookie, f.jobId, f.contractId)).status).toBe(429);
    expect((await submit(cookie, f.jobId, f.contractId, { fullName: '', email: '' })).status).toBe(400);
    const { id: other } = await createJob(admin, { companyId: base.companyId, title: 'Other', jobGradeIds: [gradeId], workLocation: 'Penang', recruitmentType: 'budgeted', employmentType: 'full_time' });
    expect((await submit(cookie, other, f.contractId, { email: 'x.s25@example.test' })).status).toBe(404);
    // No cookie: signed out, nothing stored.
    expect((await submit('A'.repeat(43), f.jobId, f.contractId, { email: 'y.s25@example.test' })).status).toBe(401);
    expect(await agencyPortalInbox(admin, base.companyId)).toHaveLength(1);
    // The app role cannot insert or delete inbox rows.
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`delete from recruitment_agency_portal_submission`)))).toBe('42501');
  });
});

describe('case 166 — HR records through slice 10 or declines; the agency sees a coarse status', () => {
  it('records as a slice 10 submission in one transaction and clears the inbox row', async () => {
    const f = await setup();
    const cookie = (await signIn())!;
    await submit(cookie, f.jobId, f.contractId);
    const [row] = await agencyPortalInbox(admin, base.companyId);
    const result = await recordAgencyPortalSubmission(admin, row.id);
    expect(result.outcome).toBe('accepted');
    const [stored] = await owner.db.execute<{ state: string; full_name: string | null; email: string | null; comments: string | null; submission_id: string }>(sql`
      select state, full_name, email, comments, submission_id from recruitment_agency_portal_submission where id = ${row.id}::uuid`);
    expect(stored).toMatchObject({ state: 'recorded', full_name: null, email: null, comments: null });
    const [sub] = await owner.db.execute<{ consultant_id: string; full_name: string }>(sql`select consultant_id, full_name from recruitment_agency_submission where id = ${stored.submission_id}::uuid`);
    expect(sub).toEqual({ consultant_id: f.consultantId, full_name: 'Fictional S25 Candidate' });
    expect(await code(recordAgencyPortalSubmission(admin, row.id))).toBe('portal_decided');
    const page = await (await portalGet(req(portalPath, { cookie }), params)).text();
    expect(page).toContain('Fictional S25 Candidate');
    expect(page).toContain('In process');
  });
  it('declines with a reason the agency never sees', async () => {
    const f = await setup();
    const cookie = (await signIn())!;
    await submit(cookie, f.jobId, f.contractId);
    const [row] = await agencyPortalInbox(admin, base.companyId);
    expect(await code(declineAgencyPortalSubmission(admin, row.id, ''))).toBe('missing_fields');
    await declineAgencyPortalSubmission(admin, row.id, 'S25SENTINEL not a fit');
    const page = await (await portalGet(req(portalPath, { cookie }), params)).text();
    expect(page).toContain('Not taken forward');
    expect(page).not.toContain('S25SENTINEL');
    // The database refuses a second decision or a forged recording.
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`update recruitment_agency_portal_submission set state = 'recorded', submission_id = ${randomUUID()}::uuid,
      decided_at = now(), decided_by_user_id = app.current_user_id(), decline_reason = null where id = ${row.id}::uuid`)))).not.toBe('ok');
  });
  it('refuses a forged recording that names no submission made now', async () => {
    const f = await setup();
    const cookie = (await signIn())!;
    await submit(cookie, f.jobId, f.contractId);
    const [row] = await agencyPortalInbox(admin, base.companyId);
    expect(await code(withTenant(admin, (tx) => tx.execute(sql`update recruitment_agency_portal_submission set state = 'recorded', submission_id = null,
      decided_at = now(), decided_by_user_id = app.current_user_id(), full_name = null, email = null, mobile = null, comments = null where id = ${row.id}::uuid`)))).toBe('23514');
  });
});

describe('case 167 — a daily limit per consultant address', () => {
  it('refuses the 21st submission of a Kuala Lumpur day', async () => {
    const f = await setup();
    const cookie = (await signIn())!;
    for (let i = 0; i < 20; i++) {
      clientSeq++;
      expect((await submit(cookie, f.jobId, f.contractId, { email: `c${i}.s25@example.test` })).status).toBe(303);
    }
    clientSeq++;
    expect(await (await submit(cookie, f.jobId, f.contractId, { email: 'c21.s25@example.test' })).text()).toContain('limit of 20');
  });
});

describe('case 168 — readers of the inbox', () => {
  it('shows a job\'s rows to its operators only', async () => {
    const f = await setup();
    const cookie = (await signIn())!;
    await submit(cookie, f.jobId, f.contractId);
    const [{ id: u }] = await owner.db.execute<{ id: string }>(sql`insert into app_user (tenant_id, workos_user_id) values (${base.tenantId}::uuid, ${`user_${randomUUID()}`}) returning id`);
    const stranger = { ...admin, userId: u, roles: ['employee'], grants: [{ role: 'employee' as const, companyId: null }] };
    const rows = await agencyPortalInbox(stranger as SessionContext, base.companyId).catch(() => []);
    expect(rows).toEqual([]);
  });
});
