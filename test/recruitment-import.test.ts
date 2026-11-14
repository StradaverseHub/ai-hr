/**
 * Recruitment slice 16 against Postgres — candidate import and the To assign list: acceptance cases 108–111 and the removal, company
 * deletion, row security and owner-rehearsal parts of 113 (docs/recruitment-reconstruction/specification.md "Slice 16 acceptance
 * cases"), through the service, the bulk-job kernel's own worker tick (runBulkJobTick with the registered handlers, as the other
 * import tests run it) AND directly as the app role. Exports (112) are test/recruitment-export.test.ts; the pure rules are
 * test/recruitment-import-export-rules.test.ts; 114 is the lead's rendered check.
 *
 * Expected values are written out per file row from what the fixture file says, and read back with plain owner-connection SQL that
 * ignores row security — never computed with packs/recruitment/import*.ts. Every person and company is fictional. Personal values in
 * the file carry the LETTER sentinel QZK (no UUID, timestamp or number can contain it).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { toCsv } from '../lib/csv';
import { runBulkJobTick } from '../core/bulk-job-worker';
import { BULK_JOB_HANDLERS } from '../core/bulk-job-handlers';
import { IMPORT_SAVEPOINTS_PER_ROW, RECRUITMENT_IMPORT_MAX_ROWS_PER_CHUNK, recruitmentCandidateImportJobHandler } from '../core/recruitment-candidate-import-worker';
import {
  addApplication, addJobMember, assignToJob, blockCandidate, candidateImportJob, candidateImportResult, cancelCandidateImport, changeJobStatus, createJob, dueForDestruction,
  IMPORT_PREVIEW_TIMEOUT_MS,
  previewCandidateImport, recruitmentJobTodos, recruitmentPipelineCounts, saveCustomField, saveCustomFieldOption, setToAssignHidden, startCandidateImport,
  toAssignList, RecruitmentError, type ImportPreview,
} from '../packs/recruitment/service';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const NEW_TABLES = ['recruitment_candidate_import', 'recruitment_candidate_import_note', 'recruitment_candidate_import_row', 'recruitment_export_template', 'recruitment_to_assign'];
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

// ── The worker, as the other bulk-job tests drive it ────────────────────────────────────────────────────────────
const tick = () => runBulkJobTick(owner.client, { handlers: BULK_JOB_HANDLERS });
type JobRow = { id: string; state: string; steps_done: number; steps_total: number; metrics: Record<string, number>; source_content: Buffer | null; input: unknown; error: string | null };
const jobRow = async (id: string) => (await owner.client<JobRow[]>`select id, state, steps_done, steps_total, metrics, source_content, input, error from bulk_job where id = ${id}::uuid`)[0];
async function ticks(id: string, stop: (job: JobRow) => boolean, max = 400) {
  for (let i = 0; i < max; i++) {
    const job = await jobRow(id);
    if (stop(job)) return job;
    if (!await tick()) await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('job did not reach the expected state');
}
const terminal = (job: JobRow) => ['completed', 'failed', 'cancelled'].includes(job.state);

// ── The fixture: jobs, custom fields, an existing candidate and a blocked person ───────────────────────────────
async function fixture() {
  const recruiter = await login('Fictional Recruiter');
  const otherRecruiter = await login('Fictional Other Recruiter');
  const manager = await login('Fictional Manager');
  const bystander = await login('Fictional Bystander');
  const partner = await partnerOf(base.companyId, 'Fictional Partner');
  const otherPartner = await partnerOf(otherCompanyId, 'Fictional Other Partner');
  const job = (title: string, recruiterUserId: string) => createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title, recruiterUserId });
  const j1 = await job('Fictional analyst', recruiter.userId);
  const j2 = await job('Fictional engineer', otherRecruiter.userId);
  const j3 = await job('Fictional clerk', recruiter.userId);
  await changeJobStatus(admin, j3.id, 'on_hold');
  await addJobMember(admin, j1.id, 'hiring_manager', manager.userId);
  const shift = (await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'single_choice', label_en: 'Shift preference' })).id;
  const morning = (await saveCustomFieldOption(admin, { fieldId: shift, label_en: 'Morning' })).id;
  const night = (await saveCustomFieldOption(admin, { fieldId: shift, label_en: 'Night' })).id;
  const years = (await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'number', label_en: 'Years of experience', numberMin: '0', numberMax: '60',
    numberDecimals: '0' })).id;
  const secret = (await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'short_text', label_en: 'Referral code', restricted: 'on' })).id;
  // A candidate the company already has (row 6 matches them by e-mail and mobile), and a blocked person (row 9 matches by ID number).
  const existing = await addApplication(admin, { jobId: j2.id, fullName: 'Fictional Existing QZKEXIST', email: 'qzk.existing@example.test', phone: '012-3456789' });
  const listed = await addApplication(admin, { jobId: j2.id, fullName: 'Fictional Listed QZKLIST', email: 'qzk.listed@example.test', idType: 'nric', idNumber: '900101015555' });
  await blockCandidate(admin, listed.candidateId, 'Fictional reason');
  return { recruiter, otherRecruiter, manager, bystander, partner, otherPartner, j1, j2, j3, shift, morning, night, years, secret, existing, listed };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const HEADER = ['Full name *', 'E-mail', 'Mobile', 'ID type', 'ID number', 'Source', 'Job number', 'Job title as written', 'Notes', 'Shift preference', 'Years of experience'];
/**
 * The fixture file, row by row (file row = index + 2). Expectations per row are written beside it.
 *   2 good, Open job J1 the importer operates          → created, applied
 *   3 good, no job, a title and notes                  → created, To assign (grouped "Fictional data analyst")
 *   4 no name                                          → invalid (fullName required)
 *   5 a bad e-mail                                     → invalid (email invalid)
 *   6 same e-mail and mobile as an existing candidate  → created, applied to J1, possible duplicate (existing)
 *   7 a job number no position has                     → created, To assign, unknown_job
 *   8 the On hold job J3                               → created, To assign, job_not_open
 *   9 the blocked person's ID number, Open job J1       → created, applied, possible duplicate (ID), needs review
 *  10 an ID number without its type                    → invalid (idType id_type_required)
 *  11 a choice no option has                           → invalid (cf.shift custom_value_invalid)
 *  12 the same name and e-mail as row 2, no job        → created, To assign, possible duplicate (row 2)
 *  13 custom values, no job                            → created, To assign (custom values stored)
 */
function fileRows(f: Fixture, j1: string, j3: string): string[][] {
  return [
    ['Fictional Ana QZKANA', 'qzk.ana@example.test', '011-1111111', '', '', 'Job board', j1, '', '', 'Morning', '4'],
    ['Fictional Ben QZKBEN', 'qzk.ben@example.test', '', '', '', 'walk-in', '', 'Fictional data analyst', 'Fictional note QZKNOTE', '', ''],
    ['', 'qzk.noname@example.test', '', '', '', '', '', '', '', '', ''],
    ['Fictional Cai QZKCAI', 'not-an-email', '', '', '', '', '', '', '', '', ''],
    ['Fictional Existing Twin QZKTWIN', 'QZK.Existing@example.test', '0123456789', '', '', '', j1, '', '', '', ''],
    ['Fictional Dee QZKDEE', 'qzk.dee@example.test', '', '', '', '', 'MJ999999', 'Fictional welder', '', '', ''],
    ['Fictional Eve QZKEVE', 'qzk.eve@example.test', '', '', '', '', j3, '', '', '', ''],
    ['Fictional Fay QZKFAY', 'qzk.fay@example.test', '', 'NRIC', '900101-01-5555', '', j1, '', '', '', ''],
    ['Fictional Gus QZKGUS', 'qzk.gus@example.test', '', '', 'A1234567', '', '', '', '', '', ''],
    ['Fictional Hal QZKHAL', 'qzk.hal@example.test', '', '', '', '', '', '', '', 'Weekend', ''],
    ['fictional  ana qzkana', 'qzk.ana@example.test', '', '', '', '', '', 'Fictional data analyst', '', '', ''],
    ['Fictional Ivy QZKIVY', 'qzk.ivy@example.test', '', '', '', 'other', '', '', '', 'Night', '12'],
  ].map((r) => (f ? r : r));
}
const csv = (body: string[][]) => toCsv([HEADER, ...body]);
async function jobNumbers(f: Fixture) {
  const [a] = await owner.db.execute<{ n: string }>(sql`select job_number as n from recruitment_job_opening where id = ${f.j1.id}::uuid`);
  const [c] = await owner.db.execute<{ n: string }>(sql`select job_number as n from recruitment_job_opening where id = ${f.j3.id}::uuid`);
  return { j1: a.n, j3: c.n };
}
async function theFile(f: Fixture) {
  const n = await jobNumbers(f);
  return csv(fileRows(f, n.j1, n.j3));
}
const okPreview = (p: ImportPreview) => {
  if (!p.ok) throw new Error(`preview refused: ${p.fileError}`);
  return p;
};
async function runImport(who: SessionContext, text: string) {
  const preview = okPreview(await previewCandidateImport(who, { companyId: base.companyId, text, fileName: 'fictional.csv' }));
  const { importId } = await startCandidateImport(who, { companyId: base.companyId, text, fileName: 'fictional.csv', previewHash: preview.previewHash, permissionConfirmed: 'on' });
  const job = await ticks(importId, terminal);
  return { preview, importId, job };
}
type ImportRowDb = { row_num: number; outcome: string; candidate_id: string | null; application_id: string | null; job_result: string | null; possible_duplicate: boolean;
  needs_review: boolean; error_code: string | null; error_fields: string[] };
const importRows = (importId: string) => owner.db.execute<ImportRowDb>(sql`select row_num, outcome, candidate_id, application_id, job_result, possible_duplicate, needs_review,
  error_code, error_fields from recruitment_candidate_import_row where import_id = ${importId}::uuid order by row_num`);
const candidateCount = async () => (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`))[0].n;

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

describe('case 108 — only administrators and operators import and use To assign; imported candidates are the company\'s and nobody else\'s', () => {
  it('refuses everybody else by the service and the tables', async () => {
    const f = await fixture();
    const text = await theFile(f);
    for (const who of [f.manager, f.bystander, f.otherPartner]) {
      expect(await code(previewCandidateImport(who, { companyId: base.companyId, text }))).toBe('forbidden');
      expect(await code(startCandidateImport(who, { companyId: base.companyId, text, previewHash: 'x'.repeat(64), permissionConfirmed: true }))).toBe('import_changed');
      expect(await code(toAssignList(who, base.companyId))).toBe('forbidden');
    }
    // A forged admission by someone who may not import: the service refuses before enqueueing; directly, the import record is refused.
    const preview = okPreview(await previewCandidateImport(f.recruiter, { companyId: base.companyId, text }));
    expect(await code(startCandidateImport(f.bystander, { companyId: base.companyId, text, previewHash: preview.previewHash, permissionConfirmed: true }))).toBe('forbidden');
    expect(await code(rows(f.bystander, sql`insert into recruitment_candidate_import (id, tenant_id, company_id, created_by_user_id, permission_confirmed_at, file_rows)
      values (${randomUUID()}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.bystander.userId}::uuid, now(), 1)`))).toBe('42501');
    // The recruiter (operator of J1 and J3) imports; the partner (administrator of this company) imports too.
    const run = await runImport(f.recruiter, text);
    expect(run.job.state).toBe('completed');
    const created = await owner.db.execute<{ id: string; company_id: string }>(sql`select c.id, c.company_id from recruitment_candidate c
      join recruitment_candidate_import_row r on r.candidate_id = c.id where r.import_id = ${run.importId}::uuid`);
    // Rows 2, 3, 6, 7, 8, 9 and 12 (row 13 carries custom values without a job: only an administrator may import that).
    expect(created.length).toBe(7);
    expect(new Set(created.map((c) => c.company_id))).toEqual(new Set([base.companyId]));
    // To assign candidates (rows 3, 7, 8 and 12) are read by the company's operators (the recruiter, the other recruiter, the partner and
    // administrators) — never by the hiring manager, a bystander or another company's partner, through the service or the table.
    const toAssignIds = (await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_to_assign where import_id = ${run.importId}::uuid`)).map((r) => r.candidate_id).sort();
    expect(toAssignIds).toHaveLength(4);
    for (const who of [f.recruiter, f.otherRecruiter, f.partner, admin]) {
      const seen = (await rows<{ id: string }>(who, sql`select id from recruitment_candidate where id = any(${`{${toAssignIds.join(',')}}`}::uuid[]) order by id`)).map((r) => r.id);
      expect(seen, 'operator reads To assign candidates').toEqual(toAssignIds);
      expect((await toAssignList(who, base.companyId)).total).toBe(4);
    }
    for (const who of [f.manager, f.bystander, f.otherPartner]) {
      expect(await rows(who, sql`select 1 from recruitment_candidate where id = any(${`{${toAssignIds.join(',')}}`}::uuid[])`)).toEqual([]);
      for (const t of NEW_TABLES) expect(await rows(who, sql`select 1 from ${sql.identifier(t)} where tenant_id = ${base.tenantId}::uuid`), `${t} for a non-operator`).toEqual([]);
    }
    // The import record and its rows: the importer and the company's administrators read them; another operator does not.
    expect(await rows(f.otherRecruiter, sql`select 1 from recruitment_candidate_import where id = ${run.importId}::uuid`)).toEqual([]);
    expect(await rows(f.partner, sql`select 1 from recruitment_candidate_import_row where import_id = ${run.importId}::uuid`)).toHaveLength(12);
    expect(await code(candidateImportResult(f.otherRecruiter, run.importId))).toBe('not_found');
    // Nobody marks someone else's candidate "to assign" (only a candidate they created in this very transaction).
    expect(await code(rows(f.recruiter, sql`insert into recruitment_to_assign (candidate_id, tenant_id, company_id, created_by_user_id)
      values (${f.existing.candidateId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.recruiter.userId}::uuid)`))).toBe('42501');
    // …and nobody removes a marker or writes an import row through the app role.
    expect(await rows(admin, sql`delete from recruitment_to_assign where import_id = ${run.importId}::uuid returning 1`).catch((e) => pgSqlState(e))).toBe('42501');
    expect(await code(rows(f.recruiter, sql`insert into recruitment_candidate_import_row (import_id, tenant_id, company_id, row_num, outcome, error_code)
      values (${run.importId}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 99, 'invalid', 'invalid_row')`))).toBe('42501');
  });
});

describe('case 109 — every bad row is found before the job starts; the preview shows duplicates and unknown jobs; starting needs the permission confirmation', () => {
  it('previews exactly the independently expected rows, writes nothing, and refuses to start without the confirmation or with another file', async () => {
    const f = await fixture();
    const text = await theFile(f);
    const before = await candidateCount();
    const p = okPreview(await previewCandidateImport(admin, { companyId: base.companyId, text, fileName: 'fictional.csv' }));
    expect({ rows: p.rows, ready: p.ready, invalid: p.invalid, withJob: p.withJob, toAssign: p.toAssign, duplicates: p.duplicates, unknownJobs: p.unknownJobs })
      .toEqual({ rows: 12, ready: 8, invalid: 4, withJob: 3, toAssign: 5, duplicates: 3, unknownJobs: 2 });
    const byRow = new Map(p.issues.map((r) => [r.rowNum, r]));
    expect([...byRow.keys()].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(byRow.get(4)!.issues).toEqual([{ field: 'fullName', code: 'required' }]);
    expect(byRow.get(5)!.issues).toEqual([{ field: 'email', code: 'invalid' }]);
    expect(byRow.get(10)!.issues).toEqual([{ field: 'idType', code: 'id_type_required' }]);
    expect(byRow.get(11)!.issues).toEqual([{ field: `cf.${f.shift}`, code: 'custom_value_invalid' }]);
    expect([6, 9, 12].map((n) => byRow.get(n)!.duplicate)).toEqual(['existing', 'existing', 'file']);
    expect(byRow.get(12)!.duplicateOfRow).toBe(2);
    expect([7, 8].map((n) => byRow.get(n)!.job)).toEqual(['unknown_job', 'job_not_open']);
    expect(JSON.stringify(p.issues)).not.toMatch(/qzk\.|900101|A1234567|Weekend|QZKNOTE/i);
    // Nothing was written.
    expect(await candidateCount()).toBe(before);
    expect(await owner.db.execute(sql`select 1 from bulk_job where tenant_id = ${base.tenantId}::uuid`)).toEqual([]);
    // The same rows for an operator, plus the ones only an administrator may import without a job (an ID number, custom values).
    const op = okPreview(await previewCandidateImport(f.recruiter, { companyId: base.companyId, text }));
    expect(op.issues.find((r) => r.rowNum === 13)!.issues).toEqual([{ field: `cf.${f.shift}`, code: 'needs_job' }, { field: `cf.${f.years}`, code: 'needs_job' }]);
    expect({ ready: op.ready, invalid: op.invalid }).toEqual({ ready: 7, invalid: 5 });
    // Starting: the permission confirmation; the very file that was previewed; one import at a time per person.
    expect(await code(startCandidateImport(admin, { companyId: base.companyId, text, previewHash: p.previewHash, permissionConfirmed: '' }))).toBe('permission_required');
    expect(await code(startCandidateImport(admin, { companyId: base.companyId, text: `${text}\n`, previewHash: p.previewHash, permissionConfirmed: true }))).toBe('import_changed');
    const { importId } = await startCandidateImport(admin, { companyId: base.companyId, text, previewHash: p.previewHash, permissionConfirmed: true });
    expect(await code(startCandidateImport(admin, { companyId: base.companyId, text, previewHash: p.previewHash, permissionConfirmed: true }))).toBe('import_running');
    // Still nothing imported: the request only enqueued (the job has not been picked up).
    expect(await candidateCount()).toBe(before);
    const [rec] = await owner.db.execute<{ permission_confirmed_at: Date | null; file_rows: number; created_by_user_id: string }>(sql`select permission_confirmed_at, file_rows,
      created_by_user_id from recruitment_candidate_import where id = ${importId}::uuid`);
    expect(rec.file_rows).toBe(12);
    expect(rec.permission_confirmed_at).not.toBeNull();
    expect(rec.created_by_user_id).toBe(admin.userId);
    // A file that cannot be imported at all says why.
    expect(await previewCandidateImport(admin, { companyId: base.companyId, text: 'E-mail\nqzk@example.test\n' })).toEqual({ ok: false, fileError: 'import_no_name_column' });
    expect(await previewCandidateImport(admin, { companyId: base.companyId, text: toCsv([HEADER]) })).toEqual({ ok: false, fileError: 'import_empty' });
    const many = toCsv([HEADER, ...Array.from({ length: 5001 }, (_, i) => [`Fictional Person ${i}`, '', '', '', '', '', '', '', '', '', ''])]);
    expect(await previewCandidateImport(admin, { companyId: base.companyId, text: many })).toEqual({ ok: false, fileError: 'import_too_many_rows' });
    // Previewing writes no candidate; it appends one audit event with counts only (a preview answers "already a candidate?").
    const previewed = async () => owner.db.execute<{ actor_id: string; payload: Record<string, unknown> }>(sql`select actor_id, payload from domain_event
      where tenant_id = ${base.tenantId}::uuid and event_type = 'recruitment-import.previewed' order by sequence`);
    const [c0, e0] = [await candidateCount(), (await previewed()).length];
    okPreview(await previewCandidateImport(f.recruiter, { companyId: base.companyId, text }));
    expect(await candidateCount()).toBe(c0);
    const all = await previewed();
    expect(all.length).toBe(e0 + 1);
    expect(all.at(-1)).toEqual({ actor_id: f.recruiter.userId, payload: { companyId: base.companyId, rows: 12, invalid: 5, flaggedDuplicates: 3, unknownJobs: 2 } });
    expect(JSON.stringify(all)).not.toMatch(/QZK|qzk|900101/);
  });
});

describe('case 110 — a background job with progress and cancellation, in batches; rows independent; results row for row; normal application rules', () => {
  it('imports the file row for row as the kernel\'s job and leaves no file or values behind', async () => {
    const f = await fixture();
    const text = await theFile(f);
    const run = await runImport(admin, text);
    expect(run.job.state).toBe('completed');
    expect({ total: run.job.steps_total, done: run.job.steps_done }).toEqual({ total: 12, done: 12 });
    const got = await importRows(run.importId);
    const pick = (r: ImportRowDb) => ({ row: r.row_num, outcome: r.outcome, job: r.job_result, applied: r.application_id !== null, dup: r.possible_duplicate, review: r.needs_review,
      code: r.error_code, fields: r.error_fields });
    expect(got.map(pick)).toEqual([
      { row: 2, outcome: 'created', job: 'applied', applied: true, dup: false, review: false, code: null, fields: [] },
      { row: 3, outcome: 'created', job: 'no_job', applied: false, dup: false, review: false, code: null, fields: [] },
      { row: 4, outcome: 'invalid', job: null, applied: false, dup: false, review: false, code: 'invalid_row', fields: ['fullName|required'] },
      { row: 5, outcome: 'invalid', job: null, applied: false, dup: false, review: false, code: 'invalid_row', fields: ['email|invalid'] },
      { row: 6, outcome: 'created', job: 'applied', applied: true, dup: true, review: false, code: null, fields: [] },
      { row: 7, outcome: 'created', job: 'unknown_job', applied: false, dup: false, review: false, code: null, fields: [] },
      { row: 8, outcome: 'created', job: 'job_not_open', applied: false, dup: false, review: false, code: null, fields: [] },
      { row: 9, outcome: 'created', job: 'applied', applied: true, dup: true, review: true, code: null, fields: [] },
      { row: 10, outcome: 'invalid', job: null, applied: false, dup: false, review: false, code: 'invalid_row', fields: ['idType|id_type_required'] },
      { row: 11, outcome: 'invalid', job: null, applied: false, dup: false, review: false, code: 'invalid_row', fields: [`cf.${f.shift}|custom_value_invalid`] },
      { row: 12, outcome: 'created', job: 'no_job', applied: false, dup: true, review: false, code: null, fields: [] },
      { row: 13, outcome: 'created', job: 'no_job', applied: false, dup: false, review: false, code: null, fields: [] },
    ]);
    // Each created row is a NEW candidate (row 6 is not merged into the existing candidate it resembles), with the file's values.
    const cand = await owner.db.execute<{ row_num: number; id: string; full_name: string; email: string | null; source: string | null; created_by_user_id: string }>(sql`
      select r.row_num, c.id, c.full_name, c.email, c.source, c.created_by_user_id from recruitment_candidate_import_row r join recruitment_candidate c on c.id = r.candidate_id
      where r.import_id = ${run.importId}::uuid order by r.row_num`);
    expect(cand.map((c) => [c.row_num, c.full_name, c.email, c.source])).toEqual([
      [2, 'Fictional Ana QZKANA', 'qzk.ana@example.test', 'job_board'], [3, 'Fictional Ben QZKBEN', 'qzk.ben@example.test', 'walk_in'],
      [6, 'Fictional Existing Twin QZKTWIN', 'qzk.existing@example.test', null], [7, 'Fictional Dee QZKDEE', 'qzk.dee@example.test', null],
      [8, 'Fictional Eve QZKEVE', 'qzk.eve@example.test', null], [9, 'Fictional Fay QZKFAY', 'qzk.fay@example.test', null],
      [12, 'fictional  ana qzkana', 'qzk.ana@example.test', null], [13, 'Fictional Ivy QZKIVY', 'qzk.ivy@example.test', 'other'],
    ]);
    expect(cand.map((c) => c.id)).not.toContain(f.existing.candidateId);
    expect(new Set(cand.map((c) => c.created_by_user_id))).toEqual(new Set([admin.userId]));
    // Applications: at J1's first enabled stage with the "applied" history row; consent stays not recorded.
    const apps = await owner.db.execute<{ row_num: number; job_id: string; state: string; first: boolean; applied: number }>(sql`
      select r.row_num, a.job_id, a.state,
        a.current_stage_id = (select ps.stage_id from recruitment_process_stage ps join recruitment_stage st on st.id = ps.stage_id and st.enabled
          where ps.process_id = j.process_id order by ps.position limit 1) as first,
        (select count(*)::int from recruitment_application_event e where e.application_id = a.id and e.kind = 'applied') as applied
      from recruitment_candidate_import_row r join recruitment_application a on a.id = r.application_id join recruitment_job_opening j on j.id = a.job_id
      where r.import_id = ${run.importId}::uuid order by r.row_num`);
    expect(apps.map((a) => [a.row_num, a.job_id, a.state, a.first, a.applied])).toEqual([2, 6, 9].map((n) => [n, f.j1.id, 'active', true, 1]));
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate_consent where candidate_id = any(${`{${cand.map((c) => c.id).join(',')}}`}::uuid[])`)).toEqual([]);
    // Slice 13: row 9's application carries an open blocked-list mark (it cannot move until an administrator decides).
    const row9 = got.find((r) => r.row_num === 9)!;
    expect(await owner.db.execute(sql`select 1 from recruitment_application_review_mark where application_id = ${row9.application_id}::uuid and cleared_at is null`)).toHaveLength(1);
    // The restricted ID number, the custom values and the notes are stored where slices 5 and 14 keep them.
    const [restricted] = await owner.db.execute<{ id_type: string; id_number: string }>(sql`select id_type, id_number from recruitment_candidate_restricted where candidate_id = ${row9.candidate_id}::uuid`);
    expect(restricted).toEqual({ id_type: 'nric', id_number: '900101-01-5555' });
    const row13 = got.find((r) => r.row_num === 13)!;
    const values = await owner.db.execute<{ field_id: string; option_id: string | null; number_value: string | null }>(sql`select field_id, option_id, number_value::text as number_value
      from recruitment_candidate_custom_value where candidate_id = ${row13.candidate_id}::uuid order by field_id`);
    expect(values.map((v) => [v.field_id, v.option_id ?? v.number_value]).sort()).toEqual([[f.shift, f.night], [f.years, '12']].sort());
    const row3 = got.find((r) => r.row_num === 3)!;
    expect(await owner.db.execute(sql`select note from recruitment_candidate_import_note where candidate_id = ${row3.candidate_id}::uuid`)).toEqual([{ note: 'Fictional note QZKNOTE' }]);
    // The kernel's counters and the import record.
    const job = await candidateImportJob(admin, run.importId);
    expect(job.counters).toEqual({ rows: 12, created: 8, applications: 3, toAssign: 5, possibleDuplicates: 3, needsReview: 1, failed: 0, invalid: 4 });
    expect(job.outcome).toBe('completed');
    // No file and no per-row values stay with the job; results, rows and events carry no value from the file.
    expect(run.job.source_content).toBeNull();
    expect(await owner.client`select 1 from bulk_job_step where job_id = ${run.importId}::uuid`).toHaveLength(0);
    const leftovers = await owner.db.execute<{ t: string }>(sql`select to_jsonb(j)::text as t from bulk_job j where j.id = ${run.importId}::uuid
      union all select to_jsonb(r)::text from recruitment_candidate_import_row r where r.import_id = ${run.importId}::uuid
      union all select to_jsonb(i)::text from recruitment_candidate_import i where i.id = ${run.importId}::uuid
      union all select payload::text from domain_event where tenant_id = ${base.tenantId}::uuid and (event_type like 'recruitment-import.%' or event_type = 'bulk-job.finished')`);
    expect(leftovers.length).toBeGreaterThan(14);
    for (const l of leftovers) expect(l.t).not.toMatch(/QZK|qzk|900101|A1234567|Weekend|Fictional (data analyst|welder)/);
    const events = await owner.db.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`select event_type, payload from domain_event
      where tenant_id = ${base.tenantId}::uuid and event_type like 'recruitment-import.%' order by sequence`);
    expect(events.map((e) => e.event_type)).toEqual(['recruitment-import.previewed', 'recruitment-import.started', 'recruitment-import.finished']);
    expect(events[2].payload).toMatchObject({ outcome: 'completed', rows: 12, created: 8, applications: 3, toAssign: 5, invalid: 4, failed: 0 });
  });

  it('runs in bounded batches with progress, stops on request keeping the rows done, and records a refused row without stopping the others', async () => {
    const f = await fixture();
    // 60 good rows without a job: at most 25 rows per chunk transaction, so at least three chunks.
    const body = Array.from({ length: 60 }, (_, i) => [`Fictional Batch ${String.fromCharCode(65 + (i % 26))}${i} QZKB`, `qzk.b${i}@example.test`, '', '', '', '', '', '', '', '', '']);
    const text = csv(body);
    const p = okPreview(await previewCandidateImport(admin, { companyId: base.companyId, text }));
    expect(p.ready).toBe(60);
    const { importId } = await startCandidateImport(admin, { companyId: base.companyId, text, previewHash: p.previewHash, permissionConfirmed: true });
    const prepared = await ticks(importId, (j) => j.state === 'running');
    expect({ total: prepared.steps_total, done: prepared.steps_done }).toEqual({ total: 60, done: 0 });
    await tick();
    const after1 = await jobRow(importId);
    expect(after1.steps_done).toBeGreaterThan(0);
    expect(after1.steps_done).toBeLessThanOrEqual(25);
    const progress = await candidateImportJob(admin, importId);
    expect(progress.job?.state).toBe('running');
    expect(progress.job?.stepsDone).toBe(after1.steps_done);
    await cancelCandidateImport(admin, importId);
    const stopped = await ticks(importId, terminal);
    expect(stopped.state).toBe('cancelled');
    const done = await importRows(importId);
    // Every row done before the stop is a real candidate; nothing after it was written.
    expect(done.length).toBe(stopped.steps_done);
    expect(done.length).toBeLessThan(60);
    expect(done.map((r) => r.row_num)).toEqual(Array.from({ length: done.length }, (_, i) => i + 2));
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where full_name like '%QZKB'`);
    expect(n).toBe(done.length);
    expect((await candidateImportJob(admin, importId)).outcome).toBe('cancelled');
    expect(await code(cancelCandidateImport(admin, importId))).toBe('import_finished');

    // Rows refused when they run (an option disabled, and a field made required, after the file was read) are recorded; the rows
    // around them import. The required rule applies alike to a row with other custom values and to one with none.
    const text2 = csv([
      ['Fictional Jon QZKJON', '', '', '', '', '', '', '', '', 'Morning', '3'],
      ['Fictional Kim QZKKIM', '', '', '', '', '', '', '', '', '', '4'],
      ['Fictional Lee QZKLEE', '', '', '', '', '', '', '', '', 'Night', '5'],
      ['Fictional Mo QZKMO', '', '', '', '', '', '', '', '', '', ''],
      ['Fictional Nia QZKNIA', '', '', '', '', '', '', '', '', 'Night', ''],
    ]);
    const p2 = okPreview(await previewCandidateImport(admin, { companyId: base.companyId, text: text2 }));
    const { importId: id2 } = await startCandidateImport(admin, { companyId: base.companyId, text: text2, previewHash: p2.previewHash, permissionConfirmed: true });
    await ticks(id2, (j) => j.state === 'running');
    await saveCustomField(admin, { id: f.years, companyId: base.companyId, kind: 'candidate', type: 'number', label_en: 'Years of experience', numberMin: '0', numberMax: '60',
      numberDecimals: '0', required: 'on' });
    await saveCustomFieldOption(admin, { id: f.morning, label_en: 'Morning', enabled: false });
    const end = await ticks(id2, terminal);
    expect(end.state).toBe('completed');
    expect((await importRows(id2)).map((r) => [r.row_num, r.outcome, r.error_code, r.error_fields])).toEqual([
      [2, 'failed', 'custom_value_invalid', []], [3, 'created', null, []], [4, 'created', null, []],
      [5, 'invalid', 'invalid_row', [`cf.${f.years}|custom_field_required`]], [6, 'invalid', 'invalid_row', [`cf.${f.years}|custom_field_required`]],
    ]);
    expect((await candidateImportJob(admin, id2)).counters).toMatchObject({ created: 2, failed: 1, invalid: 2, rows: 5 });
  });

  it('applications obey the repeat rule and blocked-list matching; possible duplicates are never merged', async () => {
    const f = await fixture();
    const run = await runImport(admin, await theFile(f));
    const got = await importRows(run.importId);
    const twin = got.find((r) => r.row_num === 6)!;
    // The twin is a separate candidate from the existing one; both remain.
    expect(twin.candidate_id).not.toBe(f.existing.candidateId);
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate where id = ${f.existing.candidateId}::uuid and destroyed_at is null`)).toHaveLength(1);
    // Assigning a To assign candidate twice to the same job: the repeat rule refuses the second.
    const row7 = got.find((r) => r.row_num === 7)!;
    await assignToJob(admin, row7.candidate_id, f.j1.id);
    expect(await code(addApplication(admin, { jobId: f.j1.id, existingCandidateId: row7.candidate_id, fullName: 'Fictional Dee QZKDEE' }))).toBe('duplicate_application');
    // The blocked person's row matched by ID number (slice 13): the application cannot move.
    const row9 = got.find((r) => r.row_num === 9)!;
    const [mark] = await owner.db.execute<{ entry_candidate: string }>(sql`select e.candidate_id as entry_candidate from recruitment_application_review_mark m
      join recruitment_blocked_entry e on e.id = m.entry_id where m.application_id = ${row9.application_id}::uuid`);
    expect(mark.entry_candidate).toBe(f.listed.candidateId);
  });
});

describe('case 111 — To assign lists exactly the candidates with no application; assigning is a normal application; removing hides without deleting', () => {
  it('lists, assigns, hides and shows again', async () => {
    const f = await fixture();
    // The company's Recruiting Partner (an administrator of the company with a name) imports.
    const run = await runImport(f.partner, await theFile(f));
    const got = await importRows(run.importId);
    const noApp = async () => (await owner.db.execute<{ id: string }>(sql`select c.id from recruitment_candidate c where c.company_id = ${base.companyId}::uuid
      and c.destroyed_at is null and not exists (select 1 from recruitment_application a where a.candidate_id = c.id) order by c.id`)).map((r) => r.id);
    const listed = (l: Awaited<ReturnType<typeof toAssignList>>) => l.groups.flatMap((g) => g.entries.map((e) => e.candidateId)).sort();
    const expected = got.filter((r) => [3, 7, 8, 12, 13].includes(r.row_num)).map((r) => r.candidate_id!).sort();
    expect(await noApp()).toEqual(expected);
    const list = await toAssignList(f.recruiter, base.companyId);
    expect(listed(list)).toEqual(expected);
    expect(list.total).toBe(5);
    // Grouped by the job title as written (no title last); with source, import date and importer.
    expect(list.groups.map((g) => [g.title, g.entries.length])).toEqual([['Fictional data analyst', 2], ['Fictional welder', 1], [null, 2]]);
    const ben = list.groups[0].entries.find((e) => e.name === 'Fictional Ben QZKBEN')!;
    expect({ source: ben.source, note: ben.note, by: ben.importedBy, dup: ben.possibleDuplicate }).toEqual({ source: 'walk_in', note: 'Fictional note QZKNOTE', by: 'Fictional Partner', dup: false });
    expect(list.groups[0].entries.find((e) => e.name === 'fictional  ana qzkana')!.possibleDuplicate).toBe(true);
    // Only Open jobs the caller may add applications to are offered (the recruiter: J1; not J2 of another recruiter, not On hold J3).
    expect(list.jobs.map((j) => j.id)).toEqual([f.j1.id]);
    // Assign: a normal application at the first enabled stage; the database takes the candidate off the list.
    const row8 = got.find((r) => r.row_num === 8)!;
    // A job the recruiter cannot see at all, and one they cannot add applications to (the hiring manager of J1 does not operate it).
    expect(await code(assignToJob(f.recruiter, row8.candidate_id, f.j2.id))).toBe('not_found');
    expect(await code(assignToJob(f.manager, row8.candidate_id, f.j1.id))).toBe('not_to_assign');
    expect(await code(assignToJob(f.recruiter, row8.candidate_id, f.j3.id))).toBe('job_not_open');
    const { applicationId } = await assignToJob(f.recruiter, row8.candidate_id, f.j1.id);
    const [app] = await owner.db.execute<{ job_id: string; state: string; created_by_user_id: string; events: number }>(sql`select job_id, state, created_by_user_id,
      (select count(*)::int from recruitment_application_event e where e.application_id = a.id and e.kind = 'applied') as events from recruitment_application a where id = ${applicationId}::uuid`);
    expect(app).toEqual({ job_id: f.j1.id, state: 'active', created_by_user_id: f.recruiter.userId, events: 1 });
    expect(await owner.db.execute(sql`select 1 from recruitment_to_assign where candidate_id = ${row8.candidate_id}::uuid`)).toEqual([]);
    expect(await code(assignToJob(f.recruiter, row8.candidate_id, f.j1.id))).toBe('not_to_assign');
    // Any other channel taking the candidate (an administrator adding an application to the existing candidate) also clears the marker.
    const row12 = got.find((r) => r.row_num === 12)!;
    await addApplication(admin, { jobId: f.j2.id, existingCandidateId: row12.candidate_id, fullName: 'x' });
    expect(await owner.db.execute(sql`select 1 from recruitment_to_assign where candidate_id = ${row12.candidate_id}::uuid`)).toEqual([]);
    const remaining = expected.filter((id) => id !== row8.candidate_id && id !== row12.candidate_id);
    expect(await noApp()).toEqual(remaining);
    expect(listed(await toAssignList(f.recruiter, base.companyId))).toEqual(remaining);
    // Hide: nothing deleted or archived; off the list, on the "removed" view; shown again on request.
    const row13 = got.find((r) => r.row_num === 13)!;
    await setToAssignHidden(f.recruiter, row13.candidate_id, true);
    const [hidden] = await owner.db.execute<{ hidden_by_user_id: string; exists: boolean }>(sql`select t.hidden_by_user_id,
      exists (select 1 from recruitment_candidate c where c.id = t.candidate_id and c.destroyed_at is null) as exists from recruitment_to_assign t where t.candidate_id = ${row13.candidate_id}::uuid`);
    expect(hidden).toEqual({ hidden_by_user_id: f.recruiter.userId, exists: true });
    expect(listed(await toAssignList(f.recruiter, base.companyId))).toEqual(remaining.filter((id) => id !== row13.candidate_id));
    expect(listed(await toAssignList(f.recruiter, base.companyId, { hidden: true }))).toEqual([row13.candidate_id]);
    expect((await rows(f.recruiter, sql`select 1 from recruitment_candidate where id = ${row13.candidate_id}::uuid`)).length).toBe(1);
    await setToAssignHidden(f.recruiter, row13.candidate_id, false);
    expect(listed(await toAssignList(f.recruiter, base.companyId))).toEqual(remaining);
    // The marker only changes whether it is shown (directly as the app role).
    expect(await code(rows(f.recruiter, sql`update recruitment_to_assign set job_title_as_written = 'Rogue' where candidate_id = ${row13.candidate_id}::uuid`))).toBe('23514');
    // The Overview's To do count for operators (capped, within its own timeout path).
    const todos = await recruitmentJobTodos(f.recruiter, undefined);
    expect(todos.status).toBe('ok');
    const item = todos.status === 'ok' ? todos.items.find((i) => i.kind === 'toAssign') : undefined;
    expect(item).toMatchObject({ kind: 'toAssign', id: base.companyId, count: remaining.length, href: `/recruitment/to-assign?company=${base.companyId}` });
    const managerTodos = await recruitmentJobTodos(f.manager, undefined);
    expect(managerTodos.status === 'ok' ? managerTodos.items.filter((i) => i.kind === 'toAssign') : null).toEqual([]);
  });
});

describe('case 113 — removal and company deletion cover the new tables; forced row security and grants; the owner rehearsal; the AI Centre read', () => {
  it('forces row security with exact grants and none to PUBLIC; guards are not callable by the app role', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    const grants: Record<string, string> = {
      recruitment_candidate_import: 'INSERT,SELECT,UPDATE', recruitment_candidate_import_note: 'INSERT,SELECT', recruitment_candidate_import_row: 'INSERT,SELECT',
      recruitment_export_template: 'DELETE,INSERT,SELECT,UPDATE', recruitment_to_assign: 'INSERT,SELECT,UPDATE',
    };
    expect(meta).toEqual(NEW_TABLES.map((relname) => ({ relname, forced: true, enabled: true, app: grants[relname], public_grants: 0 })));
    const fns = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec, p.prosecdef as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
        and p.proname in ('recruitment_guard_candidate_import', 'recruitment_guard_to_assign', 'recruitment_clear_to_assign', 'recruitment_guard_export_template') order by p.proname collate "C"`);
    expect(fns).toEqual([
      { proname: 'recruitment_clear_to_assign', app_exec: false, public_exec: false, secdef: true },
      { proname: 'recruitment_guard_candidate_import', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_export_template', app_exec: false, public_exec: false, secdef: false },
      { proname: 'recruitment_guard_to_assign', app_exec: false, public_exec: false, secdef: true },
    ]);
    const [kind] = await owner.db.execute<{ scope_kind: string | null; exclusive: string; finalize_owner: boolean; input_shape: Record<string, string> }>(sql`
      select scope_kind, exclusive, finalize_owner, input_shape from bulk_job_kind where kind = 'recruitment_candidate_import'`);
    expect(kind).toEqual({ scope_kind: null, exclusive: 'creator', finalize_owner: false,
      input_shape: { companyId: 'string', previewHash: 'string', locale: 'string', permissionConfirmed: 'boolean' } });
  });

  it('restates the candidate removal and the company delete byte for byte with added steps only', () => {
    const read = (file: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${file}`, import.meta.url)), 'utf8');
    const fn = (source: string, name: string) => {
      const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('END $$;', start) + 'END $$;'.length);
    };
    const added = (prior: string, name: string) => {
      const b = fn(read(prior), name).split('\n');
      const a = fn(read('5717_recruitment_import_export.sql'), name).split('\n');
      let i = 0;
      while (i < b.length && a[i] === b[i]) i++;
      let j = 0;
      while (j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
      expect(i + j, name).toBe(b.length);
      expect(b.length).toBeGreaterThan(90);
      return a.slice(i, a.length - j);
    };
    const destroy = added('5715_recruitment_custom_fields.sql', 'app.recruitment_destroy_candidate');
    expect(destroy.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual(['public.recruitment_to_assign', 'public.recruitment_candidate_import_note']);
    expect(destroy).toHaveLength(6);
    const del = added('5716_recruitment_position_templates.sql', 'app.recruitment_delete_company_setup');
    expect(del.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual(['public.recruitment_candidate_import_note', 'public.recruitment_to_assign',
      'public.recruitment_candidate_import_row', 'public.recruitment_candidate_import', 'public.recruitment_export_template']);
    expect(del).toHaveLength(13);
  });

  it('removal deletes the marker and the note and keeps ids-only rows; company deletion covers the new tables; the owner rehearsal; the AI Centre read is counts only', async () => {
    const f = await fixture();
    const run = await runImport(admin, await theFile(f));
    const got = await importRows(run.importId);
    const row3 = got.find((r) => r.row_num === 3)!;
    // Removal (the administrator's slice 5 path, through the database function itself).
    const [{ counts }] = await withTenant(adminCtx(base), (tx) => tx.execute<{ counts: Record<string, number> }>(sql`select app.recruitment_destroy_candidate(${row3.candidate_id}::uuid) as counts`));
    expect(counts).toMatchObject({ toAssign: 1, importNotes: 1, applications: 0 });
    expect(await owner.db.execute(sql`select 1 from recruitment_to_assign where candidate_id = ${row3.candidate_id}::uuid`)).toEqual([]);
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate_import_note where candidate_id = ${row3.candidate_id}::uuid`)).toEqual([]);
    const kept = await owner.db.execute<{ t: string }>(sql`select to_jsonb(r)::text as t from recruitment_candidate_import_row r where candidate_id = ${row3.candidate_id}::uuid`);
    expect(kept).toHaveLength(1);
    expect(kept[0].t).not.toMatch(/QZK|qzk/);
    // Retention covers candidates with no application (the clock starts the day they were added).
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate where id = ${row3.candidate_id}::uuid and full_name like 'Removed candidate %'`)).toHaveLength(1);

    // The other company has only company setup from slice 16: an import whose every row was refused, and an export template.
    const partnerB = f.otherPartner;
    const bad = toCsv([HEADER, ['', 'qzk.none@example.test', '', '', '', '', '', '', '', '', '']]);
    const pb = await previewCandidateImport(partnerB, { companyId: otherCompanyId, text: bad });
    expect(pb).toMatchObject({ ok: true, invalid: 1, ready: 0 });
    const { importId: idB } = await startCandidateImport(partnerB, { companyId: otherCompanyId, text: bad, previewHash: (pb as { previewHash: string }).previewHash, permissionConfirmed: true });
    await ticks(idB, terminal);
    await rows(partnerB, sql`insert into recruitment_export_template (tenant_id, company_id, kind, name, columns, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${otherCompanyId}::uuid, 'board', 'Fictional set', '{candidateName}', ${partnerB.userId}::uuid, ${partnerB.userId}::uuid)`);
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(NEW_TABLES.map((t) => `public.${t}`)));
      for (const t of tables) await tx.unsafe(`alter table ${t.name} owner to ai_hr_owner`);
      const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
      expect(fns.map((x) => x.sig)).toEqual(expect.arrayContaining(['app.recruitment_delete_company_setup(uuid)', 'app.recruitment_destroy_candidate(uuid)',
        'app.recruitment_guard_to_assign()', 'app.recruitment_clear_to_assign()', 'app.recruitment_guard_candidate_import()']));
      for (const x of fns) await tx.unsafe(`alter function ${x.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      expect(await tx`select relname from pg_class where relname = any(${NEW_TABLES}) and relforcerowsecurity and relrowsecurity`).toHaveLength(NEW_TABLES.length);
      const as = async (userId: string, roles: string, grants: unknown) => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
          set_config('app.grants', ${JSON.stringify(grants)}, true)`;
      };
      const adminGrants = [{ role: 'hr_admin', companyId: null }];
      // The owner itself, outside its definers, sees none of these rows for a session that operates nowhere.
      await tx.unsafe('set local role ai_hr_owner');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${f.bystander.userId}, true), set_config('app.roles', 'employee', true),
        set_config('app.grants', ${JSON.stringify([{ role: 'employee', companyId: null }])}, true)`;
      for (const t of NEW_TABLES) expect(await tx.unsafe(`select 1 from public.${t}`), t).toEqual([]);
      // Under the NOBYPASSRLS owner: a new candidate marked "to assign" in the same transaction (the definer guard sees it), then an
      // application inserted for them clears the marker (the owner-bound definer trigger).
      await as(base.adminUserId, 'hr_admin', adminGrants);
      const fresh = randomUUID();
      await tx`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        values (${fresh}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Rehearsal', ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`;
      await tx`insert into recruitment_to_assign (candidate_id, tenant_id, company_id, created_by_user_id) values (${fresh}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${base.adminUserId}::uuid)`;
      expect(await tx`select 1 from recruitment_to_assign where candidate_id = ${fresh}::uuid`).toHaveLength(1);
      const [stage] = await tx<{ stage_id: string }[]>`select ps.stage_id from recruitment_process_stage ps join recruitment_job_opening j on j.process_id = ps.process_id
        where j.id = ${f.j1.id}::uuid order by ps.position limit 1`;
      await tx`insert into recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.j1.id}::uuid, ${fresh}::uuid, ${stage.stage_id}::uuid, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`;
      expect(await tx`select 1 from recruitment_to_assign where candidate_id = ${fresh}::uuid`).toEqual([]);
      // Removal of a To assign candidate under the new owner.
      const row7 = got.find((r) => r.row_num === 7)!;
      await tx`select app.recruitment_destroy_candidate(${row7.candidate_id}::uuid)`;
      // The company delete removes the other company's import, its row and its template as the owner under forced row security.
      const [removed] = await tx`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid) as n`;
      // Independently: 1 import row + 1 import + 1 export template (the other company never opened Recruitment otherwise).
      expect(Number(removed.n)).toBe(3);
      await tx`reset role`;
      expect(await tx`select 1 from recruitment_to_assign where candidate_id = ${row7.candidate_id}::uuid`).toEqual([]);
      for (const t of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${t} where company_id = '${otherCompanyId}'::uuid`);
        expect(n.n, t).toBe(0);
      }
      throw new Error(ROLLBACK);
    }).catch((err: unknown) => (err instanceof Error && err.message === ROLLBACK ? 'rolled back' : Promise.reject(err)));
    expect(done).toBe('rolled back');
    // Through the default owner as well; the company with candidates keeps everything (its candidates refuse the delete first).
    await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid)`));
    for (const t of NEW_TABLES) expect(await owner.db.execute(sql`select 1 from ${sql.identifier(t)} where company_id = ${otherCompanyId}::uuid`), t).toHaveLength(0);
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
    // The AI Centre read: the same count keys as before, integers only, nothing of an import or the To assign list.
    const counts2 = await recruitmentPipelineCounts(admin);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    expect(counts2.rows.length).toBeGreaterThan(0);
    for (const row of counts2.rows) {
      expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
      for (const k of COUNT_KEYS) expect(Number.isInteger((row as Record<string, unknown>)[k]), k).toBe(true);
    }
    expect(JSON.stringify(counts2)).not.toMatch(/QZK|qzk|assign|import/i);
  });
});

describe('review follow-ups — fresh job and authority per row and chunk, required fields, lost access, previews, the marker guard, retention', () => {
  const plain = (n: number, prefix: string, job = '') => Array.from({ length: n }, (_, i) => [`Fictional ${prefix} ${i} QZKR`, `qzk.${prefix.toLowerCase()}${i}@example.test`, '', '', '', '', job, '', '', '', '']);
  async function started(who: SessionContext, text: string) {
    const p = okPreview(await previewCandidateImport(who, { companyId: base.companyId, text }));
    return (await startCandidateImport(who, { companyId: base.companyId, text, previewHash: p.previewHash, permissionConfirmed: true })).importId;
  }

  it('a job put on hold while the import runs sends the remaining rows to To assign (read per row), never refusing them', async () => {
    const f = await fixture();
    const { j1 } = await jobNumbers(f);
    const importId = await started(admin, csv(plain(40, 'Hold', j1)));
    await ticks(importId, (j) => j.state === 'running');
    await tick();
    const before = (await jobRow(importId)).steps_done;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(40);
    await changeJobStatus(admin, f.j1.id, 'on_hold');
    expect((await ticks(importId, terminal)).state).toBe('completed');
    const got = await importRows(importId);
    expect(got).toHaveLength(40);
    expect(got.filter((r) => r.outcome !== 'created')).toEqual([]);
    expect(got.slice(0, before).map((r) => r.job_result)).toEqual(Array(before).fill('applied'));
    expect(got.slice(before).map((r) => [r.job_result, r.application_id])).toEqual(Array(40 - before).fill(['job_not_open', null]));
    const [{ n }] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_to_assign where import_id = ${importId}::uuid`);
    expect(n).toBe(40 - before);
  });

  it('required custom fields: a recruiter\'s row without a job goes to To assign; rows with a job must fill them, with or without other values', async () => {
    const f = await fixture();
    const licence = (await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'short_text', label_en: 'Licence', required: 'on' })).id;
    const { j1 } = await jobNumbers(f);
    const text = toCsv([['Full name', 'E-mail', 'Job number', 'Licence'],
      ['Fictional Ora QZKORA', 'qzk.ora@example.test', '', ''],        // 2: no job, nothing filled — To assign (completed when assigned)
      ['Fictional Pat QZKPAT', 'qzk.pat@example.test', j1, ''],        // 3: a job, the required field empty
      ['Fictional Quin QZKQUIN', 'qzk.quin@example.test', j1, 'L-1'],  // 4: a job, filled
    ]);
    const p = okPreview(await previewCandidateImport(f.recruiter, { companyId: base.companyId, text }));
    expect({ ready: p.ready, invalid: p.invalid, toAssign: p.toAssign, withJob: p.withJob }).toEqual({ ready: 2, invalid: 1, toAssign: 1, withJob: 1 });
    expect(p.issues.map((r) => [r.rowNum, r.issues])).toEqual([[3, [{ field: `cf.${licence}`, code: 'custom_field_required' }]]]);
    // The same rule for an administrator's row without a job (they may fill it).
    const pa = okPreview(await previewCandidateImport(admin, { companyId: base.companyId, text }));
    expect(pa.issues.map((r) => r.rowNum)).toEqual([2, 3]);
    const { importId } = await startCandidateImport(f.recruiter, { companyId: base.companyId, text, previewHash: p.previewHash, permissionConfirmed: true });
    await ticks(importId, terminal);
    expect((await importRows(importId)).map((r) => [r.row_num, r.outcome, r.job_result, r.error_fields])).toEqual([
      [2, 'created', 'no_job', []], [3, 'invalid', null, [`cf.${licence}|custom_field_required`]], [4, 'created', 'applied', []],
    ]);
  });

  it('an importer who loses access mid-import: the remaining rows are recorded as refused and the record still reaches its end (owner settle)', async () => {
    const f = await fixture();
    const importId = await started(f.recruiter, csv(plain(40, 'Lost')));
    await ticks(importId, (j) => j.state === 'running');
    await tick();
    const done = (await jobRow(importId)).steps_done;
    expect(done).toBeGreaterThan(0);
    await owner.db.execute(sql`delete from recruitment_job_member where app_user_id = ${f.recruiter.userId}::uuid`);
    const end = await ticks(importId, (j) => terminal(j));
    expect(end.state).toBe('completed');
    // The settle runs with the terminal job; tick until the notice is owed no more.
    for (let i = 0; i < 20 && (await owner.db.execute(sql`select 1 from bulk_job where id = ${importId}::uuid and notified_at is null`)).length; i++) await tick();
    const [rec] = await owner.db.execute<{ outcome: string | null; finished: boolean }>(sql`select outcome, finished_at is not null as finished from recruitment_candidate_import where id = ${importId}::uuid`);
    expect(rec).toEqual({ outcome: 'completed', finished: true });
    const got = await importRows(importId);
    expect(got.map((r) => r.row_num)).toEqual(Array.from({ length: 40 }, (_, i) => i + 2));
    expect(got.slice(0, done).every((r) => r.outcome === 'created')).toBe(true);
    expect(got.slice(done).map((r) => [r.outcome, r.error_code])).toEqual(Array(40 - done).fill(['failed', 'refused']));
    // The kernel's own error list carries row numbers and a scrubbed message only.
    const [job] = await owner.client<{ errors: { rowNum: number; ref: string; message: string }[] }[]>`select errors from bulk_job where id = ${importId}::uuid`;
    expect(JSON.stringify(job.errors)).not.toMatch(/QZK|qzk|select|insert/i);
  });

  it('previews are audited with counts only and limited to 20 per person per Kuala Lumpur day; a timeout is a plain refusal, not retried', async () => {
    const f = await fixture();
    const text = csv(plain(2, 'Quota'));
    for (let i = 0; i < 20; i++) okPreview(await previewCandidateImport(f.recruiter, { companyId: base.companyId, text }));
    expect(await code(previewCandidateImport(f.recruiter, { companyId: base.companyId, text }))).toBe('import_preview_limit');
    okPreview(await previewCandidateImport(f.otherRecruiter, { companyId: base.companyId, text }));
    const [q] = await owner.db.execute<{ previews: number; today: boolean }>(sql`select previews, day = (now() at time zone 'Asia/Kuala_Lumpur')::date as today
      from recruitment_import_preview_quota where app_user_id = ${f.recruiter.userId}::uuid`);
    expect(q).toEqual({ previews: 20, today: true });
    // A forged day or a lowered count is not accepted from the app role.
    await rows(f.otherRecruiter, sql`insert into recruitment_import_preview_quota (tenant_id, app_user_id, day) values (${base.tenantId}::uuid, ${f.otherRecruiter.userId}::uuid, '2000-01-01')
      on conflict do nothing`);
    expect(await owner.db.execute(sql`select 1 from recruitment_import_preview_quota where day = '2000-01-01'`)).toEqual([]);
    expect(await code(rows(f.otherRecruiter, sql`update recruitment_import_preview_quota set previews = 0 where app_user_id = ${f.otherRecruiter.userId}::uuid`))).toBe('23514');
    expect(await rows(f.bystander, sql`select 1 from recruitment_import_preview_quota`)).toEqual([]);
    const [ev] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where event_type = 'recruitment-import.previewed' and actor_id = ${f.recruiter.userId}::uuid`);
    expect(ev.n).toBe(20);
    // A refused caller uses no quota.
    expect(await code(previewCandidateImport(f.bystander, { companyId: base.companyId, text }))).toBe('forbidden');
    expect(await owner.db.execute(sql`select 1 from recruitment_import_preview_quota where app_user_id = ${f.bystander.userId}::uuid`)).toEqual([]);
    // A preview over its statement time limit: a plain refusal, once (not retried).
    process.env.RECRUITMENT_PREVIEW_TIMEOUT_MS = '1';
    try {
      const startedAt = performance.now();
      expect(await code(previewCandidateImport(admin, { companyId: base.companyId, text: csv(plain(3000, 'Heavy')) }))).toBe('import_too_heavy');
      expect(performance.now() - startedAt).toBeLessThan(10_000);
    } finally { delete process.env.RECRUITMENT_PREVIEW_TIMEOUT_MS; }
  });

  it('the To assign guard refuses a candidate who has an application, even one just created in the same transaction (direct SQL)', async () => {
    const f = await fixture();
    const [stage] = await owner.db.execute<{ stage_id: string }>(sql`select ps.stage_id from recruitment_process_stage ps join recruitment_job_opening j on j.process_id = ps.process_id
      where j.id = ${f.j1.id}::uuid order by ps.position limit 1`);
    const fresh = randomUUID();
    const err = await withTenant(adminCtx(base), async (tx) => {
      await tx.execute(sql`insert into recruitment_candidate (id, tenant_id, company_id, full_name, created_by_user_id, updated_by_user_id)
        values (${fresh}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Guarded', ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`);
      await tx.execute(sql`insert into recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${f.j1.id}::uuid, ${fresh}::uuid, ${stage.stage_id}::uuid, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid)`);
      await tx.execute(sql`insert into recruitment_to_assign (candidate_id, tenant_id, company_id, created_by_user_id)
        values (${fresh}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, ${base.adminUserId}::uuid)`);
    }).then(() => null, (e: unknown) => e);
    let cur = err as { constraint_name?: unknown; cause?: unknown } | null;
    let named = '';
    for (let i = 0; cur && i < 4; i++, cur = cur.cause as typeof cur) if (typeof cur.constraint_name === 'string') { named = cur.constraint_name; break; }
    expect([pgSqlState(err), named]).toEqual(['42501', 'recruitment_to_assign_new_candidate']);
  });

  it('retention: a To assign candidate (shown or hidden) is due at the day they were added plus the months without consent', async () => {
    await fixture();
    const importId = await started(admin, csv(plain(3, 'Keep')));
    await ticks(importId, terminal);
    const ids = (await importRows(importId)).map((r) => r.candidate_id!);
    await setToAssignHidden(admin, ids[1], true);
    // Fixture time travel past the candidate guard: two of them were added seven months ago.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_candidate set created_at = now() - interval '7 months' where id = any(${[ids[0], ids[1]]}::uuid[])`;
    });
    const expected = await owner.db.execute<{ id: string; due: string }>(sql`select id, to_char(((created_at at time zone 'Asia/Kuala_Lumpur')::date + interval '6 months')::date, 'YYYY-MM-DD') as due
      from recruitment_candidate where id = any(${`{${ids[0]},${ids[1]}}`}::uuid[]) order by id`);
    const due = (await dueForDestruction(admin, base.companyId)).due.filter((d) => ids.includes(d.candidateId));
    expect(due.map((d) => ({ id: d.candidateId, due: d.dueOn })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
  });

  it('keeps a chunk below PostgreSQL\'s 64 cached subtransactions', () => {
    expect(recruitmentCandidateImportJobHandler.maxStepsPerChunk).toBe(RECRUITMENT_IMPORT_MAX_ROWS_PER_CHUNK);
    expect(RECRUITMENT_IMPORT_MAX_ROWS_PER_CHUNK * IMPORT_SAVEPOINTS_PER_ROW).toBeLessThan(64);
  });

  it('measures a 5,000-row preview of repeated placeholder names after the same names were already imported', async () => {
    await fixture();
    // The earlier "import": 5,000 candidates sharing one placeholder name (owner-seeded; the worker path is measured elsewhere).
    for (let from = 0; from < 5000; from += 1000) {
      await owner.db.execute(sql`insert into recruitment_candidate (tenant_id, company_id, full_name, email, created_by_user_id, updated_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional Placeholder', 'qzk.ph' || g || '@example.test', ${base.adminUserId}::uuid, ${base.adminUserId}::uuid
        from generate_series(${from}::int, ${from + 999}::int) g`);
    }
    const text = csv(Array.from({ length: 5000 }, (_, i) => ['Fictional Placeholder', `qzk.ph${i}@example.test`, '', '', '', '', '', '', '', '', '']));
    const startedAt = performance.now();
    const p = okPreview(await previewCandidateImport(admin, { companyId: base.companyId, text }));
    const ms = Math.round(performance.now() - startedAt);
    // The measurement for the review report (the suite's console is quiet): written only when asked for.
    if (process.env.SLICE16_TIMING_FILE) appendFileSync(process.env.SLICE16_TIMING_FILE, `5000-row preview, repeated names, 5000 existing: ${ms} ms\n`);
    expect({ rows: p.rows, duplicates: p.duplicates }).toEqual({ rows: 5000, duplicates: 5000 });
    expect(ms).toBeLessThan(IMPORT_PREVIEW_TIMEOUT_MS);
  });
});
