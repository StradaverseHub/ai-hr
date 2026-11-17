/**
 * Recruitment slice 16 against Postgres — list exports and saved column sets: acceptance case 112 and the export-template parts of
 * 113 (docs/recruitment-reconstruction/specification.md "Slice 16 acceptance cases"), through the service and directly as the app
 * role. The serialisation (formula guard, CSV) is checked here on real exported rows and in test/recruitment-import-export-rules.test.ts.
 *
 * Expected rows are written out from what each fixture step did and read back with owner-connection SQL that ignores row security —
 * never computed with packs/recruitment/export*.ts. Values that must not leak carry the LETTER sentinel QZX. Every person is fictional.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import {
  addApplication, addJobMember, createJob, deleteExportTemplate, exportBoard, exportCsv, exportInterviewFeedback, exportTalentPool, exportTemplateColumns, exportTemplates,
  moveApplication, recordExport, recruitmentSettings, rejectApplication, saveCustomField, saveExportTemplate, scheduleInterview,
  submitScorecard, updateCandidateProfile, safeRows, EXPORT_MAX_ROWS, RecruitmentError, type ExportTable,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let gradeId: string;
let otherCompanyId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
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
async function partnerOf(companyId: string, name: string): Promise<Login> {
  const who = await login(name, companyId);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: who.userId, companyId, role: 'recruiting_partner' });
  return { ...who, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId }] };
}
const JOB = { workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time' };
const past = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
const column = (t: ExportTable, key: string) => t.rows.map((r) => r[t.columns.indexOf(key)]);

/**
 * Two jobs: J1 (recruiter R1, hiring manager HM) and J2 (recruiter R2; R1 is also J2's hiring manager — R1 READS J2's applications
 * but does not operate them, so J2's restricted values are not R1's). Candidates: four on J1 whose names start with a spreadsheet
 * formula character, one on J2. ID numbers and a restricted custom field carry the sentinel.
 */
async function fixture() {
  const [r1, r2, hm, iv, bystander] = [await login('Fictional Recruiter One'), await login('Fictional Recruiter Two'), await login('Fictional Manager'),
    await login('Fictional Interviewer'), await login('Fictional Bystander')];
  const otherPartner = await partnerOf(otherCompanyId, 'Fictional Other Partner');
  const job = (title: string, recruiterUserId: string) => createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title, recruiterUserId });
  const j1 = (await job('Fictional analyst', r1.userId)).id;
  const j2 = (await job('Fictional engineer', r2.userId)).id;
  await addJobMember(admin, j1, 'hiring_manager', hm.userId);
  await addJobMember(admin, j2, 'hiring_manager', r1.userId);
  const secret = (await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'short_text', label_en: 'Referral code', restricted: 'on' })).id;
  const open = (await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'short_text', label_en: 'Portfolio' })).id;
  const names = ['=QZXEQ()', '+QZXPLUS', '-QZXMINUS', '@QZXAT'];
  const j1Apps = [];
  for (const [i, name] of names.entries()) {
    const a = await addApplication(r1, { jobId: j1, fullName: name, email: `fx${i}@example.test`, idType: 'nric', idNumber: `QZXID${i}` });
    await updateCandidateProfile(r1, a.candidateId, { fullName: name, email: `fx${i}@example.test` }, { [secret]: `QZXSECRET${i}`, [open]: `Fictional portfolio ${i}` });
    j1Apps.push(a);
  }
  const b = await addApplication(r2, { jobId: j2, fullName: 'Fictional Other Job QZXOTHER', email: 'other@example.test', idType: 'passport', idNumber: 'QZXIDOTHER' });
  await updateCandidateProfile(r2, b.candidateId, { fullName: 'Fictional Other Job QZXOTHER', email: 'other@example.test' }, { [secret]: 'QZXSECRETOTHER', [open]: 'Fictional portfolio B' });
  return { r1, r2, hm, iv, bystander, otherPartner, j1, j2, secret, open, j1Apps, b };
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

describe('case 112 — exports contain exactly what the exporter can see, escape formula cells, cap at 10,000 rows and are audited without values', () => {
  it('the board: exactly the rows and columns the exporter reads; restricted values only where they may read them; other jobs absent', async () => {
    const f = await fixture();
    const cols = ['candidateName', 'email', 'jobTitle', 'idNumber', `cf.${f.secret}`, `cf.${f.open}`];
    // R1 operates J1 and reads J2 (as its hiring manager): both jobs' rows, J2's restricted values empty.
    const r1 = await exportBoard(f.r1, [base.companyId], {}, cols, 'en');
    expect(r1.columns).toEqual(cols);
    const byName = new Map(r1.rows.map((r) => [r[0], r]));
    expect([...byName.keys()].sort()).toEqual(['+QZXPLUS', '-QZXMINUS', '=QZXEQ()', '@QZXAT', 'Fictional Other Job QZXOTHER']);
    expect(byName.get('=QZXEQ()')).toEqual(['=QZXEQ()', 'fx0@example.test', 'Fictional analyst', 'QZXID0', 'QZXSECRET0', 'Fictional portfolio 0']);
    expect(byName.get('Fictional Other Job QZXOTHER')).toEqual(['Fictional Other Job QZXOTHER', 'other@example.test', 'Fictional engineer', null, null, 'Fictional portfolio B']);
    expect(JSON.stringify(r1.rows)).not.toMatch(/QZXIDOTHER|QZXSECRETOTHER/);
    // The job filter narrows to J1; R2 sees only J2 (and its restricted values: R2 operates J2), never J1's sentinels.
    expect(column(await exportBoard(f.r1, [base.companyId], { jobId: f.j2 }, cols, 'en'), 'candidateName')).toEqual(['Fictional Other Job QZXOTHER']);
    const r2 = await exportBoard(f.r2, [base.companyId], {}, cols, 'en');
    expect(r2.rows).toEqual([['Fictional Other Job QZXOTHER', 'other@example.test', 'Fictional engineer', 'QZXIDOTHER', 'QZXSECRETOTHER', 'Fictional portfolio B']]);
    expect(JSON.stringify(r2.rows)).not.toMatch(/QZXID\d|QZXSECRET\d|QZXEQ|QZXPLUS/);
    // An administrator reads everything.
    const all = await exportBoard(admin, [base.companyId], {}, cols, 'en');
    expect(all.rows.length).toBe(5);
    expect(column(all, 'idNumber').sort()).toEqual(['QZXID0', 'QZXID1', 'QZXID2', 'QZXID3', 'QZXIDOTHER']);
    // A stage tab: the archived bucket only.
    await rejectApplication(admin, f.j1Apps[1].applicationId, (await recruitmentSettings(admin, base.companyId)).reasons[0].id);
    expect(column(await exportBoard(admin, [base.companyId], { tab: 'archived' }, ['candidateName', 'status'], 'en'), 'status')).toEqual(['archived']);
    // Who may export: administrators and operators only; a hiring manager, a bystander and another company's partner are refused.
    for (const who of [f.hm, f.bystander, f.otherPartner, f.iv]) expect(await code(exportBoard(who, [base.companyId], {}, cols, 'en'))).toBe('forbidden');
    // Default columns when none are chosen; unknown keys are ignored.
    expect((await exportBoard(f.r1, [base.companyId], {}, ['nonsense'], 'en')).columns).toEqual(['candidateName', 'email', 'mobile', 'jobTitle', 'jobNumber', 'stage', 'status', 'appliedOn', 'source']);
  });

  it('escapes every formula-leading cell in the file, CSV and Excel alike', async () => {
    const f = await fixture();
    const t = await exportBoard(f.r1, [base.companyId], { jobId: f.j1 }, ['candidateName'], 'en');
    const safe = safeRows(['Candidate'], t.rows);
    expect(safe.slice(1).map((r) => r[0]).sort()).toEqual(["'+QZXPLUS", "'-QZXMINUS", "'=QZXEQ()", "'@QZXAT"]);
    const file = exportCsv(['Candidate'], t.rows);
    for (const n of ['=QZXEQ()', '+QZXPLUS', '-QZXMINUS', '@QZXAT']) {
      expect(file).toContain(`'${n}`);
      expect(file.split(/\r\n/).some((line) => line === n || line === `"${n}"`), n).toBe(false);
    }
  });

  it('the talent pool for those who may open it, and one job\'s interview feedback for its operators', async () => {
    const f = await fixture();
    const reason = (await recruitmentSettings(admin, base.companyId)).reasons[0].id;
    await rejectApplication(admin, f.j1Apps[0].applicationId, reason);
    await rejectApplication(admin, f.b.applicationId, reason);
    const pool = await exportTalentPool(admin, [base.companyId], {}, ['candidateName', 'jobTitle', 'archiveReason', 'idNumber'], 'en');
    expect(pool.rows.map((r) => [r[0], r[1], r[3]]).sort()).toEqual([['=QZXEQ()', 'Fictional analyst', 'QZXID0'], ['Fictional Other Job QZXOTHER', 'Fictional engineer', 'QZXIDOTHER']]);
    expect(column(await exportTalentPool(admin, [base.companyId], { jobId: f.j2 }, ['candidateName'], 'en'), 'candidateName')).toEqual(['Fictional Other Job QZXOTHER']);
    for (const who of [f.r1, f.hm, f.bystander]) expect(await code(exportTalentPool(who, [base.companyId], {}, null, 'en'))).toBe('forbidden');
    // Interview feedback: one row per scorecard; comments only when chosen.
    const interview = (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === 'Interview')!.id;
    await moveApplication(f.r1, f.j1Apps[2].applicationId, interview);
    const { id: interviewId } = await scheduleInterview(f.r1, { applicationId: f.j1Apps[2].applicationId, type: 'video', startsAt: past(3), durationMinutes: 60, interviewerIds: [f.iv.userId] });
    const ratings = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k, i) => [k, { rating: String(i + 1), notes: `QZXNOTE ${k}` }]));
    await submitScorecard(f.iv, interviewId, { ratings, result: 'recommended', overview: 'QZXOVERVIEW' });
    const fb = await exportInterviewFeedback(f.r1, f.j1, ['candidateName', 'round', 'interviewer', 'result', 'averageScore', 'scores']);
    expect(fb.rows).toEqual([['-QZXMINUS', 1, 'Fictional Interviewer', 'recommended', 3,
      'Role knowledge: 1; Problem solving: 2; Communication: 3; Collaboration: 4; Motivation and fit: 5']]);
    expect(JSON.stringify(fb.rows)).not.toMatch(/QZXNOTE|QZXOVERVIEW/);
    const withComments = await exportInterviewFeedback(f.r1, f.j1, ['candidateName', 'comments']);
    expect(String(withComments.rows[0][1])).toMatch(/^QZXOVERVIEW\nRole knowledge: QZXNOTE c1/);
    // The hiring manager and the interviewer see the job but do not operate it; the other recruiter and a bystander do not see it at all.
    expect(await Promise.all([f.hm, f.iv, f.r2, f.bystander].map((who) => code(exportInterviewFeedback(who, f.j1, null))))).toEqual(['forbidden', 'forbidden', 'not_found', 'not_found']);
  });

  it('refuses more than 10,000 rows and writes an audit event with counts and ids only', async () => {
    const f = await fixture();
    // Fill J1 to exactly 10,000 applications (owner inserts through the ordinary guards).
    const [stage] = await owner.db.execute<{ stage_id: string }>(sql`select ps.stage_id from recruitment_process_stage ps join recruitment_job_opening j on j.process_id = ps.process_id
      where j.id = ${f.j1}::uuid order by ps.position limit 1`);
    const fill = EXPORT_MAX_ROWS - 4;
    // In batches of 500 (each application insert takes the repeat guard's advisory locks; one transaction per batch).
    for (let from = 1; from <= fill; from += 500) {
      const to = Math.min(fill, from + 499);
      await owner.db.execute(sql`with c as (insert into recruitment_candidate (tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
          select ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Bulk ' || g, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid from generate_series(${from}::int, ${to}::int) g returning id)
        insert into recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
          select ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.j1}::uuid, c.id, ${stage.stage_id}::uuid, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid from c`);
    }
    const full = await exportBoard(f.r1, [base.companyId], { jobId: f.j1 }, ['candidateName'], 'en');
    expect(full.rows.length).toBe(EXPORT_MAX_ROWS);
    await addApplication(f.r1, { jobId: f.j1, fullName: 'Fictional One Too Many' });
    expect(await code(exportBoard(f.r1, [base.companyId], { jobId: f.j1 }, ['candidateName'], 'en'))).toBe('export_too_large');
    // A narrower filter still exports.
    expect((await exportBoard(f.r1, [base.companyId], { jobId: f.j2 }, ['candidateName'], 'en')).rows.length).toBe(1);
    // The audit event: who, kind, filters as ids, format, counts — never a value.
    await recordExport(f.r1, { kind: 'board', companyIds: [base.companyId], format: 'csv', filters: { job: f.j1, tab: undefined, tag: 'QZX free text?' }, columns: 1, rows: full.rows.length });
    const [ev] = await owner.db.execute<{ actor_id: string; payload: Record<string, unknown> }>(sql`select actor_id, payload from domain_event
      where tenant_id = ${base.tenantId}::uuid and event_type = 'recruitment-export.created'`);
    expect(ev.actor_id).toBe(f.r1.userId);
    expect(ev.payload).toEqual({ kind: 'board', companyIds: [base.companyId], format: 'csv', filters: { job: f.j1, tag: 'set' }, columns: 1, rows: EXPORT_MAX_ROWS });
    expect(JSON.stringify(ev.payload)).not.toMatch(/QZX|Fictional/);
  });
});

describe('case 112/113 — saved column sets: administrators manage, operators use; forced row security and grants', () => {
  it('only administrators manage export templates (service and database); operators read and use them; others see none', async () => {
    const f = await fixture();
    const { id } = await saveExportTemplate(admin, { companyId: base.companyId, kind: 'board', name: 'Fictional short list', columns: ['candidateName', 'email', `cf.${f.open}`] });
    expect(await code(saveExportTemplate(admin, { companyId: base.companyId, kind: 'board', name: 'fictional  SHORT list', columns: ['candidateName'] }))).toBe('name_taken');
    expect(await code(saveExportTemplate(admin, { companyId: base.companyId, kind: 'board', name: 'Fictional bad', columns: ['nonsense'] }))).toBe('missing_fields');
    for (const who of [f.r1, f.hm, f.bystander]) {
      expect(await code(saveExportTemplate(who, { companyId: base.companyId, kind: 'board', name: 'Fictional rogue', columns: ['candidateName'] }))).toBe('forbidden');
      expect(await code(deleteExportTemplate(who, id))).toBe(who === f.r1 ? 'forbidden' : 'not_found');
      expect(await code(rows(who, sql`insert into recruitment_export_template (tenant_id, company_id, kind, name, columns, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'board', 'Rogue', '{candidateName}', ${who.userId}::uuid, ${who.userId}::uuid)`))).toBe('42501');
    }
    // Operators use it (the export follows the saved columns); a hiring manager, bystander and another company see none.
    expect((await exportTemplates(f.r1, [base.companyId], 'board')).map((t) => t.name)).toEqual(['Fictional short list']);
    expect(await exportTemplateColumns(f.r1, id, 'board')).toEqual(['candidateName', 'email', `cf.${f.open}`]);
    expect((await exportBoard(f.r1, [base.companyId], { jobId: f.j1 }, await exportTemplateColumns(f.r1, id, 'board'), 'en')).columns).toEqual(['candidateName', 'email', `cf.${f.open}`]);
    for (const who of [f.hm, f.bystander, f.otherPartner]) {
      expect(await exportTemplates(who, [base.companyId], 'board')).toEqual([]);
      expect(await rows(who, sql`select 1 from recruitment_export_template`)).toEqual([]);
    }
    // A saved set keeps its kind; the administrator renames and deletes it.
    expect(await code(saveExportTemplate(admin, { id, kind: 'talent_pool', name: 'x', columns: ['candidateName'] }))).toBe('invalid_input');
    await saveExportTemplate(admin, { id, kind: 'board', name: 'Fictional renamed', columns: ['candidateName'] });
    await deleteExportTemplate(admin, id);
    expect(await owner.db.execute(sql`select 1 from recruitment_export_template`)).toEqual([]);
    const events = await owner.db.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`select event_type, payload from domain_event
      where tenant_id = ${base.tenantId}::uuid and event_type like 'recruitment-export-template.%' order by sequence`);
    expect(events.map((e) => e.event_type)).toEqual(['recruitment-export-template.created', 'recruitment-export-template.updated', 'recruitment-export-template.deleted']);
    expect(JSON.stringify(events)).not.toMatch(/Fictional/);
  });

  it('export reads are write-free: they run in a READ ONLY snapshot', async () => {
    const f = await fixture();
    const count = async () => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where tenant_id = ${base.tenantId}::uuid`))[0].n;
    const before = await count();
    await exportBoard(f.r1, [base.companyId], {}, null, 'en');
    await exportInterviewFeedback(f.r1, f.j1, null);
    expect(await count()).toBe(before);
  });
});
