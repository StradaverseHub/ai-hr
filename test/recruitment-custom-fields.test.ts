/**
 * Recruitment slice 14 against Postgres — custom candidate and job fields: acceptance cases 95–100
 * (docs/recruitment-reconstruction/specification.md "Slice 14 acceptance cases"), through the service AND directly as the app
 * role, with a rehearsal under a NOBYPASSRLS table owner with row security forced. The pure rules (types, ranges, the
 * sensitive-category word list, fallbacks, filters) are test/recruitment-custom-fields-rules.test.ts; case 101 is the lead's
 * rendered check.
 *
 * Expected values are computed independently of packs/recruitment/custom-field*.ts: from what each fixture step did (which
 * candidate or job was given which answer) and from plain owner-connection SQL that ignores row security. Every person is
 * fictional. Restricted and removable values carry LETTER sentinels (QZR…, QZD…: no UUID, timestamp or number can contain them).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, addJobMember, candidateBoard, candidateProfile, createJob, customFieldSettings, deleteCustomField, deleteCustomFieldOption, destroyCandidates,
  getJob, jobFormOptions, labelFor, listJobs, moveCustomField, recruitmentPipelineCounts, recruitmentSettings, rejectApplication, saveCustomField,
  saveCustomFieldOption, scheduleInterview, talentPool, updateCandidateProfile, updateJob, RecruitmentError, type RawCustomValues,
} from '../packs/recruitment/service';
import { customFilterChoicesTx, recordCustomFieldsTx } from '../packs/recruitment/custom-field-store';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const NEW_TABLES = ['recruitment_candidate_custom_restricted', 'recruitment_candidate_custom_value', 'recruitment_custom_field', 'recruitment_custom_field_option',
  'recruitment_job_custom_value'];
const SECRET = 'QZRSECRET fictional bonus arrangement';
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
const future = (hoursAhead: number) => new Date(Date.now() + hoursAhead * 3_600_000);
const JOB = { jobGradeIds: [] as string[], workLocation: 'Kuala Lumpur', recruitmentType: 'budgeted', employmentType: 'full_time' };
let seq = 0;

/** Job 1 (recruiter r1, hiring manager hm), job 2 (recruiter r2); an interviewer and a bystander. */
async function fixture() {
  const [r1, r2, hm, iv, bystander] = await Promise.all([login('Fictional Recruiter One'), login('Fictional Recruiter Two'), login('Fictional Manager'),
    login('Fictional Interviewer'), login('Fictional Bystander')]);
  const job = { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId] };
  const { id: job1 } = await createJob(admin, { ...job, title: 'Fictional analyst', recruiterUserId: r1.userId });
  const { id: job2 } = await createJob(admin, { ...job, title: 'Fictional engineer', recruiterUserId: r2.userId });
  await addJobMember(admin, job1, 'hiring_manager', hm.userId);
  return { r1, r2, hm, iv, bystander, job1, job2 };
}
const apply = (ctx: SessionContext, jobId: string) => addApplication(ctx, { jobId, fullName: `Fictional Candidate ${++seq}`, email: `custom${seq}@example.test` });
const field = (input: Record<string, unknown>) => saveCustomField(admin, { companyId: base.companyId, ...input });
const option = async (fieldId: string, label: string) => (await saveCustomFieldOption(admin, { fieldId, label_en: label })).id;
/** Save a candidate's custom values through the profile form's service path (the fixed fields unchanged). */
const saveCandidate = async (ctx: SessionContext, candidateId: string, custom: RawCustomValues) => {
  const [c] = await owner.db.execute<{ full_name: string; email: string | null }>(sql`select full_name, email from recruitment_candidate where id = ${candidateId}::uuid`);
  return updateCandidateProfile(ctx, candidateId, { fullName: c.full_name, email: c.email ?? '' }, custom);
};
const jobInput = async (jobId: string) => {
  const [j] = await owner.db.execute<{ title: string; work_location: string; recruitment_type: string; employment_type: string; job_grade_ids: string[]; process_id: string }>(sql`
    select title, work_location, recruitment_type, employment_type, job_grade_ids, process_id from recruitment_job_opening where id = ${jobId}::uuid`);
  return { title: j.title, workLocation: j.work_location, recruitmentType: j.recruitment_type, employmentType: j.employment_type, jobGradeIds: j.job_grade_ids, processId: j.process_id };
};
const saveJob = async (jobId: string, custom: RawCustomValues) => updateJob(admin, jobId, { ...(await jobInput(jobId)), custom });
const valueRows = (table: string, fieldId: string) => owner.db.execute<{ candidate_id?: string; job_id?: string; text_value: string | null; number_value: string | null;
  date_value: string | null; bool_value: boolean | null; option_id: string | null }>(sql`select *, number_value::text as number_value, to_char(date_value, 'YYYY-MM-DD') as date_value
  from ${sql.identifier(table)} where field_id = ${fieldId}::uuid order by option_id nulls first`);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
});

describe('case 95 — administrators define fields; type fixed once used; disabling keeps values; deleting refused when used', () => {
  it('only administrators define fields and options (service and database)', async () => {
    const f = await fixture();
    expect(await code(saveCustomField(f.r1, { companyId: base.companyId, kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' }))).toBe('forbidden');
    expect(await code(customFieldSettings(f.r1, base.companyId, 'candidate'))).toBe('forbidden');
    const { id } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift' });
    const morning = await option(id, 'Morning');
    for (const who of [f.r1, f.hm]) {
      expect(await code(saveCustomField(who, { id, label_en: 'Renamed' }))).toBe('forbidden');
      expect(await code(saveCustomFieldOption(who, { fieldId: id, label_en: 'Night' }))).toBe('forbidden');
      expect(await code(deleteCustomField(who, id))).toBe('forbidden');
      expect(await code(moveCustomField(who, id, 'down'))).toBe('forbidden');
      expect(await code(deleteCustomFieldOption(who, morning))).toBe('forbidden');
    }
    // Directly as the app role: a recruiter's insert is refused; update and delete touch nothing (they may read the definitions).
    expect(await code(rows(f.r1, sql`insert into recruitment_custom_field (tenant_id, company_id, record_kind, field_type, label_en, position, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'candidate', 'short_text', 'Direct field', 9, ${f.r1.userId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    expect(await code(rows(f.r1, sql`insert into recruitment_custom_field_option (field_id, tenant_id, company_id, label_en, position, created_by_user_id, updated_by_user_id)
      values (${id}::uuid, ${base.tenantId}::uuid, ${base.companyId}::uuid, 'Direct option', 9, ${f.r1.userId}::uuid, ${f.r1.userId}::uuid)`))).toBe('42501');
    expect(await rows(f.r1, sql`update recruitment_custom_field set label_en = 'Direct rename' where id = ${id}::uuid returning id`)).toHaveLength(0);
    expect(await rows(f.r1, sql`delete from recruitment_custom_field_option where id = ${morning}::uuid returning id`)).toHaveLength(0);
    expect(await rows(f.r1, sql`delete from recruitment_custom_field where id = ${id}::uuid returning id`)).toHaveLength(0);
    expect((await rows<{ id: string }>(f.r1, sql`select id from recruitment_custom_field where id = ${id}::uuid`)).map((r) => r.id)).toEqual([id]);
    // The bystander (no job team) reads nothing.
    expect(await rows(f.bystander, sql`select 1 from recruitment_custom_field where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
    const [stored] = await owner.db.execute<{ label_en: string; n: number }>(sql`select f.label_en, (select count(*)::int from recruitment_custom_field_option o
      where o.field_id = f.id) as n from recruitment_custom_field f where f.id = ${id}::uuid`);
    expect(stored).toEqual({ label_en: 'Preferred shift', n: 1 });
    // The administrator orders, renames and reads them back.
    const { id: second } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' });
    await moveCustomField(admin, second, 'up');
    expect((await customFieldSettings(admin, base.companyId, 'candidate')).fields.map((x) => x.id)).toEqual([second, id]);
    expect(await code(field({ kind: 'candidate', type: 'date', label_en: 'portfolio  LINK' }))).toBe('name_taken');
  });

  it('a type or restricted change and a delete are refused once a value exists (service and database); unused fields change freely', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const { id: link } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' });
    const { id: spare } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Spare choice' });
    const spareOption = await option(spare, 'Spare option');
    // No value yet: the type changes (a choice field loses its options when it stops being a choice).
    await saveCustomField(admin, { id: spare, type: 'number', label_en: 'Spare number', numberDecimals: '0' });
    expect((await owner.db.execute(sql`select 1 from recruitment_custom_field_option where id = ${spareOption}::uuid`))).toHaveLength(0);
    await saveCandidate(f.r1, c.candidateId, { [link]: 'https://portfolio.example.test/fictional' });
    expect(await code(saveCustomField(admin, { id: link, type: 'long_text', label_en: 'Portfolio link' }))).toBe('field_in_use');
    expect(await code(saveCustomField(admin, { id: link, restricted: 'on', label_en: 'Portfolio link' }))).toBe('field_in_use');
    expect(await code(deleteCustomField(admin, link))).toBe('field_in_use');
    // The database refuses the same for an administrator writing directly (the values' foreign key, whoever reads them).
    expect(await constraintOf(rows(admin, sql`update recruitment_custom_field set field_type = 'long_text' where id = ${link}::uuid`)))
      .toBe('recruitment_candidate_custom_value_field_fk');
    expect(await constraintOf(rows(admin, sql`update recruitment_custom_field set restricted = true where id = ${link}::uuid`)))
      .toBe('recruitment_candidate_custom_value_field_fk');
    expect(await constraintOf(rows(admin, sql`delete from recruitment_custom_field where id = ${link}::uuid`))).toBe('recruitment_candidate_custom_value_field_fk');
    // Other properties still change; the unused field is deleted.
    await saveCustomField(admin, { id: link, label_en: 'Portfolio address', helpText: 'A public link', required: 'on' });
    expect((await customFieldSettings(admin, base.companyId, 'candidate')).fields.find((x) => x.id === link)).toMatchObject({
      type: 'short_text', restricted: false, required: true, inUse: true, labels: { en: 'Portfolio address' },
    });
    await deleteCustomField(admin, spare);
    expect(await owner.db.execute(sql`select 1 from recruitment_custom_field where id = ${spare}::uuid`)).toHaveLength(0);
  });

  it('disabling hides a field and an option from forms and lists but keeps the values; an option in use is not deleted', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const { id: shift } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift' });
    const [morning, night, spareOpt] = [await option(shift, 'Morning'), await option(shift, 'Night'), await option(shift, 'Weekend')];
    const { id: years } = await field({ kind: 'job', type: 'number', label_en: 'Years of experience', numberDecimals: '0' });
    await saveCandidate(f.r1, c.candidateId, { [shift]: morning });
    await saveJob(f.job1, { [years]: '3' });
    expect(await code(deleteCustomFieldOption(admin, morning))).toBe('option_in_use');
    expect(await constraintOf(rows(admin, sql`delete from recruitment_custom_field_option where id = ${morning}::uuid`))).toBe('recruitment_candidate_custom_value_option_fk');
    await deleteCustomFieldOption(admin, spareOpt);
    // The option disabled: it is no longer offered, but stays chosen (and shown) where it was chosen.
    await saveCustomFieldOption(admin, { id: morning, label_en: 'Morning', enabled: false });
    const app = (await owner.db.execute<{ id: string }>(sql`select id from recruitment_application where candidate_id = ${c.candidateId}::uuid`))[0].id;
    const shown = (await candidateProfile(f.r1, app)).custom.find((x) => x.id === shift)!;
    expect(shown.value).toEqual({ type: 'single_choice', optionIds: [morning] });
    expect(shown.options.map((o) => [o.id, o.enabled])).toEqual([[morning, false], [night, true]]);
    // Re-saving keeps it; choosing it anew elsewhere is refused (service and database).
    await saveCandidate(f.r1, c.candidateId, { [shift]: morning });
    const other = await apply(f.r1, f.job1);
    expect(await code(saveCandidate(f.r1, other.candidateId, { [shift]: morning }))).toBe('custom_value_invalid');
    expect(await constraintOf(rows(f.r1, sql`insert into recruitment_candidate_custom_value (tenant_id, company_id, candidate_id, field_id, field_type, option_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${other.candidateId}::uuid, ${shift}::uuid, 'single_choice', ${morning}::uuid, ${f.r1.userId}::uuid)`)))
      .toBe('recruitment_custom_option_disabled');
    // The fields disabled: gone from the profile, the job form, the job page and the filters; the values stay stored.
    await saveCustomField(admin, { id: shift, label_en: 'Preferred shift', enabled: false });
    await saveCustomField(admin, { id: years, label_en: 'Years of experience', enabled: false });
    expect((await candidateProfile(f.r1, app)).custom.map((x) => x.id)).not.toContain(shift);
    expect((await jobFormOptions(admin, base.companyId)).customFields.map((x) => x.id)).not.toContain(years);
    expect((await getJob(admin, f.job1)).custom.map((x) => x.id)).not.toContain(years);
    expect((await candidateBoard(admin, [base.companyId])).customFilters).toEqual([]);
    expect((await valueRows('recruitment_candidate_custom_value', shift)).map((r) => r.option_id)).toEqual([morning]);
    expect((await valueRows('recruitment_job_custom_value', years)).map((r) => r.number_value)).toEqual(['3']);
    // A save while disabled leaves the value alone; a direct write for a disabled field is refused.
    await saveCandidate(f.r1, c.candidateId, {});
    expect((await valueRows('recruitment_candidate_custom_value', shift)).map((r) => r.option_id)).toEqual([morning]);
    expect(await constraintOf(rows(admin, sql`update recruitment_job_custom_value set number_value = 4 where job_id = ${f.job1}::uuid`)))
      .toBe('recruitment_custom_field_disabled');
    // Enabled again: the value is back.
    await saveCustomField(admin, { id: years, label_en: 'Years of experience', enabled: true });
    expect((await getJob(f.hm, f.job1)).custom.find((x) => x.id === years)?.value).toEqual({ type: 'number', number: '3' });
  });
});

describe('case 96 — values by type, range and options; required on save; multiple choice stores option ids', () => {
  it('refuses values that do not fit and stores typed ones (service and database)', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const { id: score } = await field({ kind: 'candidate', type: 'number', label_en: 'Assessment score', numberMin: '1', numberMax: '10', numberDecimals: '1' });
    const { id: start } = await field({ kind: 'candidate', type: 'date', label_en: 'Earliest start' });
    const { id: grad } = await field({ kind: 'candidate', type: 'year_month', label_en: 'Graduation' });
    const { id: shift } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift' });
    const morning = await option(shift, 'Morning');
    const { id: other } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Other choice' });
    const foreign = await option(other, 'Foreign option');
    const { id: relocate } = await field({ kind: 'candidate', type: 'yes_no', label_en: 'Willing to relocate' });
    for (const bad of [{ [score]: '11' }, { [score]: '0.5' }, { [score]: '2.25' }, { [score]: 'seven' }, { [start]: '2026-02-30' }, { [grad]: '2026-13' },
      { [shift]: foreign }, { [relocate]: 'perhaps' }]) {
      expect(await code(saveCandidate(f.r1, c.candidateId, bad)), JSON.stringify(bad)).toBe('custom_value_invalid');
    }
    expect(await owner.db.execute(sql`select 1 from recruitment_candidate_custom_value where candidate_id = ${c.candidateId}::uuid`)).toHaveLength(0);
    await saveCandidate(f.r1, c.candidateId, { [score]: '9.50', [start]: '2027-01-04', [grad]: '2024-06', [shift]: morning, [relocate]: 'no' });
    const typed = await owner.db.execute<{ field_id: string; text_value: string | null; number_value: string | null; date_value: string | null; bool_value: boolean | null;
      option_id: string | null }>(sql`select field_id, text_value, number_value::text as number_value, to_char(date_value, 'YYYY-MM-DD') as date_value, bool_value, option_id
      from recruitment_candidate_custom_value where candidate_id = ${c.candidateId}::uuid`);
    const by = (id: string) => typed.find((r) => r.field_id === id);
    expect(by(score)).toEqual({ field_id: score, text_value: null, number_value: '9.5', date_value: null, bool_value: null, option_id: null });
    expect(by(start)).toEqual({ field_id: start, text_value: null, number_value: null, date_value: '2027-01-04', bool_value: null, option_id: null });
    expect(by(grad)).toEqual({ field_id: grad, text_value: null, number_value: null, date_value: '2024-06-01', bool_value: null, option_id: null });
    expect(by(shift)).toEqual({ field_id: shift, text_value: null, number_value: null, date_value: null, bool_value: null, option_id: morning });
    expect(by(relocate)).toEqual({ field_id: relocate, text_value: null, number_value: null, date_value: null, bool_value: false, option_id: null });
    // The database refuses the same directly: an untyped value, an out-of-range number, a foreign option, a value for the wrong
    // record kind, a restricted field's value in the open table.
    const insert = (cols: ReturnType<typeof sql>, values: ReturnType<typeof sql>) => rows(f.r1, sql`insert into recruitment_candidate_custom_value
      (tenant_id, company_id, candidate_id, updated_by_user_id, ${cols}) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${c.candidateId}::uuid, ${f.r1.userId}::uuid, ${values})`);
    const other2 = await apply(f.r1, f.job1);
    const insert2 = (cols: ReturnType<typeof sql>, values: ReturnType<typeof sql>) => rows(f.r1, sql`insert into recruitment_candidate_custom_value
      (tenant_id, company_id, candidate_id, updated_by_user_id, ${cols}) values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${other2.candidateId}::uuid, ${f.r1.userId}::uuid, ${values})`);
    expect(await constraintOf(insert2(sql`field_id, field_type, text_value`, sql`${score}::uuid, 'number', 'nine'`))).toBe('recruitment_candidate_custom_value_typed_ck');
    expect(await constraintOf(insert2(sql`field_id, field_type, number_value`, sql`${score}::uuid, 'number', 10.5`))).toBe('recruitment_custom_value_range');
    expect(await constraintOf(insert2(sql`field_id, field_type, number_value`, sql`${score}::uuid, 'number', 2.25`))).toBe('recruitment_custom_value_range');
    // Another field's option: the guard refuses it as no enabled option of this field (the option foreign key stands behind it).
    expect(await constraintOf(insert2(sql`field_id, field_type, option_id`, sql`${shift}::uuid, 'single_choice', ${foreign}::uuid`))).toBe('recruitment_custom_option_disabled');
    expect(await constraintOf(insert2(sql`field_id, field_type, text_value`, sql`${score}::uuid, 'short_text', 'x'`))).toBe('recruitment_candidate_custom_value_field_fk');
    expect(await constraintOf(insert(sql`field_id, field_type, option_id`, sql`${shift}::uuid, 'single_choice', ${morning}::uuid`))).toBe('recruitment_candidate_custom_value_one_uq');
    const { id: jobField } = await field({ kind: 'job', type: 'short_text', label_en: 'Cost centre code' });
    expect(await constraintOf(insert2(sql`field_id, field_type, text_value`, sql`${jobField}::uuid, 'short_text', 'x'`))).toBe('recruitment_candidate_custom_value_field_fk');
    const { id: secret } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Bonus notes', restricted: 'on' });
    expect(await constraintOf(insert2(sql`field_id, field_type, text_value`, sql`${secret}::uuid, 'short_text', 'x'`))).toBe('recruitment_candidate_custom_value_field_fk');
  });

  it('multiple choice stores one row per chosen option id; emptying deletes; a job field fills on create and edit', async () => {
    await fixture();
    const { id: langs } = await field({ kind: 'job', type: 'multiple_choice', label_en: 'Languages required' });
    const [malay, english, mandarin] = [await option(langs, 'Malay'), await option(langs, 'English'), await option(langs, 'Mandarin')];
    const { id: job } = await createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title: 'Fictional translator', custom: { [langs]: [malay, english] } });
    const stored = async () => (await valueRows('recruitment_job_custom_value', langs)).map((r) => ({ job: r.job_id, option: r.option_id, text: r.text_value, n: r.number_value, b: r.bool_value }));
    const expectSet = (ids: string[]) => ids.map((o) => ({ job, option: o, text: null, n: null, b: null })).sort((a, b) => a.option.localeCompare(b.option));
    expect((await stored()).sort((a, b) => a.option!.localeCompare(b.option!))).toEqual(expectSet([malay, english]));
    await saveJob(job, { [langs]: [english, mandarin] });
    expect((await stored()).sort((a, b) => a.option!.localeCompare(b.option!))).toEqual(expectSet([english, mandarin]));
    expect((await getJob(admin, job)).custom.find((x) => x.id === langs)?.value).toEqual({ type: 'multiple_choice', optionIds: [english, mandarin] });
    await saveJob(job, { [langs]: [] });
    expect(await stored()).toEqual([]);
    // The settings tab form does not carry custom fields: saving it leaves the values alone.
    await saveJob(job, { [langs]: [malay] });
    await updateJob(admin, job, await jobInput(job));
    expect((await stored()).map((r) => r.option)).toEqual([malay]);
    // Events carry ids only.
    const events = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event
      where event_type = 'recruitment-job.custom-values-updated' and aggregate_id = ${job}::uuid order by sequence`);
    expect(events.length).toBe(4);
    for (const e of events) expect(e.payload).toEqual({ companyId: base.companyId, fieldIds: [langs] });
  });

  it('required is enforced on save; a record saved before the field became required stays valid until its next edit', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const app = c.applicationId;
    const { id: link } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' });
    await saveCandidate(f.r1, c.candidateId, {});
    await saveCustomField(admin, { id: link, label_en: 'Portfolio link', required: 'on' });
    // Still readable and unchanged; editing the fixed fields without the custom form part is not blocked.
    expect((await candidateProfile(f.r1, app)).custom.find((x) => x.id === link)).toMatchObject({ required: true, value: null });
    await updateCandidateProfile(f.r1, c.candidateId, { fullName: 'Fictional Renamed Candidate' });
    // The next edit through the form must fill it.
    expect(await code(saveCandidate(f.r1, c.candidateId, {}))).toBe('custom_field_required');
    expect(await code(saveCandidate(f.r1, c.candidateId, { [link]: '   ' }))).toBe('custom_field_required');
    await saveCandidate(f.r1, c.candidateId, { [link]: 'https://portfolio.example.test/a' });
    expect((await valueRows('recruitment_candidate_custom_value', link)).map((r) => r.text_value)).toEqual(['https://portfolio.example.test/a']);
    // A required job field refuses the whole new job (all or nothing).
    const { id: code_ } = await field({ kind: 'job', type: 'short_text', label_en: 'Cost centre code', required: 'on' });
    const before = (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_job_opening`))[0].n;
    const refused = await createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title: 'Fictional refused', custom: {} }).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(RecruitmentError);
    expect((refused as RecruitmentError).code).toBe('custom_field_required');
    expect((refused as RecruitmentError).detail).toEqual([`cf.${code_}`]);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_job_opening`))[0].n).toBe(before);
  });
});

describe('case 97 — restricted candidate fields: administrators and the candidate\'s job operators only (service, page data, database), never in events', () => {
  it('hides restricted fields and values from hiring managers, interviewers and other operators', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    await scheduleInterview(f.r1, { applicationId: c.applicationId, type: 'onsite', startsAt: future(24), interviewerIds: [f.iv.userId] });
    const { id: open } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' });
    const { id: secret } = await field({ kind: 'candidate', type: 'long_text', label_en: 'Bonus notes', restricted: 'on' });
    await saveCandidate(f.r1, c.candidateId, { [open]: 'https://portfolio.example.test/open', [secret]: SECRET });
    // Stored apart: the restricted value only in the restricted table.
    expect((await valueRows('recruitment_candidate_custom_restricted', secret)).map((r) => r.text_value)).toEqual([SECRET]);
    expect(await valueRows('recruitment_candidate_custom_value', secret)).toEqual([]);
    // Administrators and the candidate's recruiter see both.
    for (const who of [admin, f.r1]) {
      const p = await candidateProfile(who, c.applicationId);
      expect(p.custom.map((x) => [x.id, x.restricted, x.value])).toEqual([
        [open, false, { type: 'short_text', text: 'https://portfolio.example.test/open' }], [secret, true, { type: 'long_text', text: SECRET }],
      ]);
    }
    // The hiring manager and the interviewer see the open value only: no restricted field, no sentinel anywhere in the page data.
    for (const who of [f.hm, f.iv]) {
      const p = await candidateProfile(who, c.applicationId);
      expect(p.custom.map((x) => x.id)).toEqual([open]);
      expect(JSON.stringify(p)).not.toContain('QZRSECRET');
      expect(await code(saveCandidate(who, c.candidateId, { [open]: 'changed' }))).toBe('forbidden');
    }
    // Another job's recruiter and a bystander cannot open the application at all.
    for (const who of [f.r2, f.bystander]) expect(await code(candidateProfile(who, c.applicationId))).toMatch(/^(not_found|forbidden)$/);
    // Directly as the app role.
    for (const who of [f.hm, f.iv, f.r2, f.bystander]) {
      expect(await rows(who, sql`select 1 from recruitment_candidate_custom_restricted where tenant_id = ${base.tenantId}::uuid`), 'restricted').toHaveLength(0);
      expect(await rows(who, sql`update recruitment_candidate_custom_restricted set text_value = 'x' returning 1`)).toHaveLength(0);
      // Refused: by row security (42501) for another job's recruiter, who may read the definition; by the guard (23514) for anyone who
      // cannot even read the restricted field's definition (the hiring manager, the interviewer, a bystander).
      expect(await code(rows(who, sql`insert into recruitment_candidate_custom_restricted (tenant_id, company_id, candidate_id, field_id, field_type, text_value, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${c.candidateId}::uuid, ${secret}::uuid, 'long_text', 'x', ${who.userId}::uuid)`))).toBe(who === f.r2 ? '42501' : '23514');
    }
    // The restricted field's DEFINITION (label, help text) and its options are hidden too from the hiring manager and the interviewer;
    // the company's recruiters (operators) and administrators read them. The open field stays readable to the whole job team.
    const { id: secretChoice } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Restricted grade band', helpText: 'QZRHELP fictional', restricted: 'on' });
    const band = await option(secretChoice, 'QZRBAND fictional');
    const defs = (who: SessionContext) => rows<{ id: string }>(who, sql`select id from recruitment_custom_field where tenant_id = ${base.tenantId}::uuid order by id`);
    const opts = (who: SessionContext) => rows<{ id: string }>(who, sql`select id from recruitment_custom_field_option where field_id = ${secretChoice}::uuid`);
    for (const who of [f.hm, f.iv]) {
      expect((await defs(who)).map((r) => r.id), 'definitions').toEqual([open]);
      expect(await opts(who), 'options').toHaveLength(0);
      expect(JSON.stringify(await candidateProfile(who, c.applicationId))).not.toMatch(/QZR/);
    }
    for (const who of [f.r1, f.r2, admin]) {
      expect((await defs(who)).map((r) => r.id).sort(), 'definitions').toEqual([open, secret, secretChoice].sort());
      expect((await opts(who)).map((r) => r.id)).toEqual([band]);
    }
    expect(await rows(f.bystander, sql`select 1 from recruitment_custom_field where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
    for (const who of [f.hm, f.iv]) expect(await rows(who, sql`select text_value from recruitment_candidate_custom_value where candidate_id = ${c.candidateId}::uuid`)).toHaveLength(1);
    for (const who of [f.r2, f.bystander]) expect(await rows(who, sql`select 1 from recruitment_candidate_custom_value where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
    expect((await rows<{ text_value: string }>(f.r1, sql`select text_value from recruitment_candidate_custom_restricted where candidate_id = ${c.candidateId}::uuid`))
      .map((r) => r.text_value)).toEqual([SECRET]);
    // The restricted table's only non-owner policy admits the candidate's operators (administrators included).
    const policies = await owner.db.execute<{ policyname: string; text: string }>(sql`select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as text
      from pg_policies where tablename = 'recruitment_candidate_custom_restricted' order by 1`);
    expect(policies.length).toBe(5);
    for (const p of policies) {
      expect(/recruitment_operates_candidate|relowner/.test(p.text), p.policyname).toBe(true);
      expect(p.text, p.policyname).not.toMatch(/reads_candidate|review|team_in_company/);
    }
    // Never in an event: the value event carries field ids only.
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text ilike '%QZRSECRET%'`))[0].n).toBe(0);
    const [e] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event
      where event_type = 'recruitment-candidate.custom-values-updated' and aggregate_id = ${c.candidateId}::uuid`);
    expect(e.payload).toEqual({ companyId: base.companyId, fieldIds: [open, secret] });
  });
});

describe('case 98 — filters by a choice or yes/no field return exactly the matching candidates and jobs', () => {
  it('the board, the talent pool and the job list filter by one field and answer, counts included', async () => {
    const f = await fixture();
    const { id: shift } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift' });
    const [morning, night] = [await option(shift, 'Morning'), await option(shift, 'Night')];
    const { id: relocate } = await field({ kind: 'candidate', type: 'yes_no', label_en: 'Willing to relocate' });
    const { id: secretChoice } = await field({ kind: 'candidate', type: 'yes_no', label_en: 'Restricted yes or no', restricted: 'on' });
    // Independently: who answered what (job 1 unless noted).
    const plan = [
      { shift: morning, relocate: 'yes' }, { shift: night, relocate: 'yes' }, { shift: morning, relocate: 'no' }, { shift: null, relocate: null },
      { shift: morning, relocate: 'yes', job: 'job2' },
    ] as const;
    const people: { candidateId: string; applicationId: string; shift: string | null; relocate: string | null }[] = [];
    for (const p of plan) {
      const jobId = 'job' in p ? f.job2 : f.job1;
      const c = await apply('job' in p ? f.r2 : f.r1, jobId);
      await saveCandidate(admin, c.candidateId, { ...(p.shift ? { [shift]: p.shift } : {}), ...(p.relocate ? { [relocate]: p.relocate } : {}), [secretChoice]: 'yes' });
      people.push({ ...c, shift: p.shift, relocate: p.relocate });
    }
    const expectIds = (pred: (p: (typeof people)[number]) => boolean) => people.filter(pred).map((p) => p.candidateId).sort();
    const board = async (who: SessionContext, cf?: string) => {
      const b = await candidateBoard(who, [base.companyId], { custom: cf });
      return { ids: b.cards.map((x) => x.candidateId).sort(), counted: b.tabs.reduce((n, t) => n + t.count, 0), applied: b.customFilter, choices: b.customFilters };
    };
    const all = await board(admin);
    expect(all.ids).toEqual(people.map((p) => p.candidateId).sort());
    // Restricted fields are never offered as a filter; asking for one anyway is ignored.
    expect(all.choices.map((c) => c.fieldId)).toEqual([shift, relocate]);
    expect((await board(admin, `${secretChoice}:yes`)).applied).toBeNull();
    const morningBoard = await board(admin, `${shift}:${morning}`);
    expect(morningBoard).toMatchObject({ ids: expectIds((p) => p.shift === morning), counted: 3, applied: `${shift}:${morning}` });
    expect(morningBoard.ids.length).toBe(3);
    expect((await board(admin, `${relocate}:no`)).ids).toEqual(expectIds((p) => p.relocate === 'no'));
    expect((await board(admin, `${relocate}:yes`)).ids).toEqual(expectIds((p) => p.relocate === 'yes'));
    expect((await board(admin, `${shift}:${night}`)).ids).toEqual(expectIds((p) => p.shift === night));
    // Plain owner SQL agrees.
    const sqlMorning = (await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_candidate_custom_value
      where field_id = ${shift}::uuid and option_id = ${morning}::uuid order by candidate_id`)).map((r) => r.candidate_id);
    expect(morningBoard.ids).toEqual(sqlMorning);
    // A hiring manager of job 1 sees only job 1's matches; garbage is no filter.
    expect((await board(f.hm, `${shift}:${morning}`)).ids).toEqual(expectIds((p) => p.shift === morning && !people.slice(4).includes(p)));
    expect((await board(admin, 'not-a-filter')).ids).toEqual(all.ids);
    // Talent pool: two archived candidates; the filter keeps the morning one.
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, people[0].applicationId, reason.id);
    await rejectApplication(admin, people[1].applicationId, reason.id);
    const pool = await talentPool(admin, [base.companyId], { custom: `${shift}:${morning}` });
    expect(pool.cards.map((x) => x.candidateId)).toEqual([people[0].candidateId]);
    expect(pool.customFilter).toBe(`${shift}:${morning}`);
    expect((await talentPool(admin, [base.companyId])).cards.map((x) => x.candidateId).sort()).toEqual([people[0].candidateId, people[1].candidateId].sort());

    // Jobs: remote yes (job 1), no (job 2), unanswered (job 3); languages multiple choice.
    const { id: remote } = await field({ kind: 'job', type: 'yes_no', label_en: 'Remote allowed' });
    const { id: langs } = await field({ kind: 'job', type: 'multiple_choice', label_en: 'Languages required' });
    const [malay, english] = [await option(langs, 'Malay'), await option(langs, 'English')];
    const { id: job3 } = await createJob(admin, { ...JOB, companyId: base.companyId, jobGradeIds: [gradeId], title: 'Fictional third role' });
    await saveJob(f.job1, { [remote]: 'yes', [langs]: [malay, english] });
    await saveJob(f.job2, { [remote]: 'no', [langs]: [english] });
    const jobs = async (cf?: string) => {
      const l = await listJobs(admin, [base.companyId], { custom: cf });
      return { ids: l.rows.map((r) => r.id).sort(), opening: l.counts.opening, applied: l.customFilter };
    };
    expect(await jobs(`${remote}:yes`)).toEqual({ ids: [f.job1], opening: 1, applied: `${remote}:yes` });
    expect(await jobs(`${remote}:no`)).toEqual({ ids: [f.job2], opening: 1, applied: `${remote}:no` });
    expect(await jobs(`${langs}:${english}`)).toEqual({ ids: [f.job1, f.job2].sort(), opening: 2, applied: `${langs}:${english}` });
    expect(await jobs(`${langs}:${malay}`)).toEqual({ ids: [f.job1], opening: 1, applied: `${langs}:${malay}` });
    expect((await jobs()).ids).toEqual([f.job1, f.job2, job3].sort());
    // The hiring manager's list (their job only) filters within it.
    expect((await listJobs(f.hm, [base.companyId], { custom: `${langs}:${english}` })).rows.map((r) => r.id)).toEqual([f.job1]);
  });
});

describe('case 99 — sensitive field names refused with an explanation; locale fallbacks', () => {
  it('refuses by any locale\'s name, help text and option name, and creates nothing', async () => {
    for (const input of [
      { kind: 'candidate', type: 'single_choice', label_en: 'Religion' },
      { kind: 'candidate', type: 'short_text', label_en: 'Background', label_zh: '种族' },
      { kind: 'candidate', type: 'yes_no', label_en: 'Status', helpText: 'Are you pregnant?' },
      { kind: 'candidate', type: 'number', label_en: 'Number of children' },
      { kind: 'candidate', type: 'short_text', label_en: 'Medical history' },
    ]) expect(await code(field(input)), JSON.stringify(input)).toBe('sensitive_field');
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_custom_field`))[0].n).toBe(0);
    const { id } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Current situation' });
    expect(await code(saveCustomFieldOption(admin, { fieldId: id, label_en: 'Married' }))).toBe('sensitive_field');
    const { id: kept } = await saveCustomFieldOption(admin, { fieldId: id, label_en: 'Studying' });
    expect(await code(saveCustomFieldOption(admin, { id: kept, label_en: 'Studying', label_zh: '已婚' }))).toBe('sensitive_field');
    expect(await code(saveCustomField(admin, { id, label_en: 'Current situation', label_vi: 'Tôn giáo' }))).toBe('sensitive_field');
    expect((await owner.db.execute<{ label_zh: string | null }>(sql`select label_zh from recruitment_custom_field_option`)).map((r) => r.label_zh)).toEqual([null]);
    // Job fields and their options describe the job, not a person: the word list does not apply (the lead's ruling on D-052).
    const { id: jobField } = await field({ kind: 'job', type: 'single_choice', label_en: 'Requirement', label_ms: 'Rekod jenayah bersih', helpText: 'Health screening offered' });
    await saveCustomFieldOption(admin, { fieldId: jobField, label_en: 'Married couples housing' });
    await saveCustomField(admin, { id: jobField, label_en: 'Medical insurance' });
    expect((await customFieldSettings(admin, base.companyId, 'job')).fields.map((x) => [x.labels.en, x.options.map((o) => o.labels.en)]))
      .toEqual([['Medical insurance', ['Married couples housing']]]);
    // The explanation names the categories, in every locale.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const en = JSON.parse(readFileSync(`${root}messages/en.json`, 'utf8')).recruitment.errors.sensitive_field as string;
    expect(en).toMatch(/race.*religion.*health.*pregnancy.*criminal records.*family/);
    for (const l of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(readFileSync(`${root}messages/${l}.json`, 'utf8')).recruitment.errors.sensitive_field as string;
      expect(m.length, l).toBeGreaterThan(40);
      expect(m, l).not.toBe(en);
    }
  });

  it('labels and options show in the viewer\'s language, or English when that language has none', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const { id } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift', label_ms: 'Syif pilihan', label_zh: '偏好班次' });
    const { id: o } = await saveCustomFieldOption(admin, { fieldId: id, label_en: 'Morning', label_ms: 'Pagi' });
    await saveCandidate(f.r1, c.candidateId, { [id]: o });
    const [view] = (await candidateProfile(f.hm, c.applicationId)).custom;
    expect(view.labels).toEqual({ en: 'Preferred shift', ms: 'Syif pilihan', ta: null, th: null, vi: null, zh: '偏好班次' });
    expect(['en', 'ms', 'zh', 'ta', 'th', 'vi'].map((l) => labelFor(view.labels, l))).toEqual(['Preferred shift', 'Syif pilihan', '偏好班次', 'Preferred shift', 'Preferred shift', 'Preferred shift']);
    expect(['ms', 'zh'].map((l) => labelFor(view.options[0].labels, l))).toEqual(['Pagi', 'Morning']);
  });
});

describe('case 100 — removal, company deletion, row security and grants, the AI Centre read, the owner rehearsal', () => {
  async function rejectAndAge(applicationId: string) {
    const [reason] = (await recruitmentSettings(admin, base.companyId)).reasons;
    await rejectApplication(admin, applicationId, reason.id);
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_application set state_changed_at = ${`${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`}::timestamptz where id = ${applicationId}::uuid`;
    });
  }

  it('slice 5 removal deletes every custom value of the person, open and restricted; nothing of them stays', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const keep = await apply(f.r1, f.job1);
    const { id: open } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' });
    const { id: secret } = await field({ kind: 'candidate', type: 'long_text', label_en: 'Bonus notes', restricted: 'on' });
    const { id: langs } = await field({ kind: 'candidate', type: 'multiple_choice', label_en: 'Languages spoken' });
    const [malay, english] = [await option(langs, 'Malay'), await option(langs, 'English')];
    await saveCandidate(f.r1, c.candidateId, { [open]: 'QZDOPEN fictional link', [secret]: 'QZDSECRET fictional note', [langs]: [malay, english] });
    await saveCandidate(f.r1, keep.candidateId, { [open]: 'Kept fictional link' });
    await rejectAndAge(c.applicationId);
    expect(await destroyCandidates(admin, base.companyId, [c.candidateId], 'on')).toEqual({ removed: 1 });
    const [event] = await owner.db.execute<{ payload: Record<string, number> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${c.candidateId}::uuid`);
    // Independently: one open text value and two chosen options; one restricted value.
    expect(event.payload).toMatchObject({ customValues: 3, customRestrictedValues: 1 });
    for (const t of ['recruitment_candidate_custom_value', 'recruitment_candidate_custom_restricted']) {
      expect(await owner.db.execute(sql`select 1 from ${sql.identifier(t)} where candidate_id = ${c.candidateId}::uuid`), t).toHaveLength(0);
    }
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.map((x) => x.relname)).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r where to_jsonb(r.*)::text ilike '%QZD%'`);
      expect(hit.n, relname).toBe(0);
    }
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from domain_event where payload::text ilike '%QZD%'`))[0].n).toBe(0);
    // The other candidate's value and the definitions stay; the removed record takes no new value.
    expect((await valueRows('recruitment_candidate_custom_value', open)).map((r) => r.text_value)).toEqual(['Kept fictional link']);
    expect(await code(saveCandidate(admin, c.candidateId, { [open]: 'again' }))).toBe('candidate_removed');
    expect(await constraintOf(rows(admin, sql`insert into recruitment_candidate_custom_value (tenant_id, company_id, candidate_id, field_id, field_type, text_value, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${c.candidateId}::uuid, ${open}::uuid, 'short_text', 'again', ${base.adminUserId}::uuid)`))).toBe('recruitment_candidate_removed');
  });

  it('forces row security with exact grants and none to PUBLIC; the AI Centre read is counts only; read paths write nothing', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta).toEqual(NEW_TABLES.map((relname) => ({ relname, forced: true, enabled: true, app: 'DELETE,INSERT,SELECT,UPDATE', public_grants: 0 })));
    const fns = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec, p.prosecdef as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'recruitment\\_guard\\_custom%' order by p.proname collate "C"`);
    expect(fns).toEqual(['recruitment_guard_custom_field', 'recruitment_guard_custom_field_option', 'recruitment_guard_custom_value']
      .map((proname) => ({ proname, app_exec: false, public_exec: false, secdef: false })));
    // The AI Centre read: the same count keys as before, integers only, nothing of a custom field.
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const { id: secret } = await field({ kind: 'candidate', type: 'short_text', label_en: 'QZRLABEL notes', restricted: 'on' });
    await saveCandidate(f.r1, c.candidateId, { [secret]: SECRET });
    const counts = await recruitmentPipelineCounts(admin);
    const COUNT_KEYS = ['activeApplications', 'archived', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen'];
    expect(counts.rows.length).toBeGreaterThan(0);
    for (const row of counts.rows) {
      expect(Object.keys(row).sort()).toEqual(['company', ...COUNT_KEYS].sort());
      for (const k of COUNT_KEYS) expect(Number.isInteger((row as Record<string, unknown>)[k]), k).toBe(true);
    }
    expect(JSON.stringify(counts)).not.toMatch(/QZR|custom/i);
    // The record and filter reads work in a READ ONLY transaction and take no transaction id.
    for (const who of [f.r1, f.hm, admin]) {
      const out = await withTenant(who, async (tx) => {
        const fields = await recordCustomFieldsTx(tx, who, 'candidate', { id: c.candidateId, companyId: base.companyId }, who !== f.hm);
        const choices = await customFilterChoicesTx(tx, who, [base.companyId], 'candidate');
        const [xid] = await tx.execute<{ x: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as x`);
        const [mode] = await tx.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
        return { n: fields.length, choices: choices.length, xid: xid.x, ro: mode.ro };
      }, { readOnlySnapshot: true });
      expect(out).toEqual({ n: who === f.hm ? 0 : 1, choices: 0, xid: null, ro: 'on' });
    }
  });

  it('company deletion covers the new tables; removal and the company delete work under a NOBYPASSRLS owner with forced row security', async () => {
    const [{ id: emptyCompany }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Empty Sdn Bhd' }).returning({ id: company.id });
    const { id: emptyField } = await saveCustomField(admin, { companyId: emptyCompany, kind: 'candidate', type: 'single_choice', label_en: 'Empty company field' });
    await saveCustomFieldOption(admin, { fieldId: emptyField, label_en: 'Empty option' });
    await saveCustomField(admin, { companyId: emptyCompany, kind: 'job', type: 'yes_no', label_en: 'Empty job field' });
    const f = await fixture();
    const d = await apply(f.r1, f.job1);
    const { id: open } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link' });
    const { id: secret } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Bonus notes', restricted: 'on' });
    const { id: remote } = await field({ kind: 'job', type: 'yes_no', label_en: 'Remote allowed' });
    await saveCandidate(f.r1, d.candidateId, { [open]: 'Fictional open', [secret]: 'Fictional restricted' });
    await saveJob(f.job1, { [remote]: 'yes' });
    await rejectAndAge(d.applicationId);
    const ROLLBACK = 'rolled back on purpose';
    const done = await owner.client.begin(async (tx) => {
      const [role] = await tx`select rolsuper, rolbypassrls from pg_roles where rolname = 'ai_hr_owner'`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const kernel = ['tenant', 'tenant_module', 'app_user', 'company', 'person', 'job_grade', 'domain_event', 'role_assignment', 'employment'];
      const tables = await tx<{ name: string }[]>`select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and ((n.nspname = 'public' and (c.relname ~ '^recruitment_' or c.relname = any(${kernel}))) or (n.nspname = 'app' and c.relname ~ '^recruitment_'))`;
      expect(tables.map((x) => x.name)).toEqual(expect.arrayContaining(NEW_TABLES.map((x) => `public.${x}`)));
      for (const x of tables) await tx.unsafe(`alter table ${x.name} owner to ai_hr_owner`);
      const fns = await tx<{ sig: string }[]>`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.proname ~ '^recruitment_'`;
      expect(fns.map((x) => x.sig)).toEqual(expect.arrayContaining(['app.recruitment_destroy_candidate(uuid)', 'app.recruitment_delete_company_setup(uuid)',
        'app.recruitment_guard_custom_value()']));
      for (const x of fns) await tx.unsafe(`alter function ${x.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      const forced = await tx`select relname from pg_class where relname = any(${NEW_TABLES}) and relforcerowsecurity and relrowsecurity`;
      expect(forced).toHaveLength(NEW_TABLES.length);
      const as = async (userId: string, roles: string, grants: unknown) => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
          set_config('app.grants', ${JSON.stringify(grants)}, true)`;
      };
      const adminGrants = [{ role: 'hr_admin', companyId: null }];
      const employee = [{ role: 'employee', companyId: null }];
      // Outside a removal or a company delete, the owner sees no value through the owner-bound policies.
      await tx.unsafe('set local role ai_hr_owner');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${f.bystander.userId}, true), set_config('app.roles', 'employee', true),
        set_config('app.grants', ${JSON.stringify(employee)}, true)`;
      for (const t of NEW_TABLES.filter((x) => x !== 'recruitment_custom_field' && x !== 'recruitment_custom_field_option')) {
        expect(await tx.unsafe(`select 1 from public.${t}`), t).toEqual([]);
      }
      // The app role cannot use the company-delete context value to delete another company's values.
      await as(f.bystander.userId, 'employee', employee);
      await tx`select set_config('app.recruitment_company_delete', ${base.companyId}, true)`;
      expect(await tx`delete from recruitment_job_custom_value returning 1`).toEqual([]);
      expect(await tx`delete from recruitment_candidate_custom_restricted returning 1`).toEqual([]);
      await tx`select set_config('app.recruitment_company_delete', '', true)`;
      // A recruiter writes a value as the app role under the new owner (guards run as the caller).
      await as(f.r1.userId, 'employee', employee);
      await tx`update recruitment_candidate_custom_value set text_value = 'Fictional open 2' where candidate_id = ${d.candidateId}::uuid`;
      // The administrator removes D: both value tables are cleared as the owner under forced row security.
      await as(base.adminUserId, 'hr_admin', adminGrants);
      const [destroyed] = await tx`select app.recruitment_destroy_candidate(${d.candidateId}::uuid) as r`;
      expect(destroyed.r).toMatchObject({ customValues: 1, customRestrictedValues: 1 });
      const [removed] = await tx`select app.recruitment_delete_company_setup(${emptyCompany}::uuid) as n`;
      expect(Number(removed.n)).toBe(3);
      await tx`reset role`;
      for (const x of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${x} where company_id = '${emptyCompany}'::uuid`);
        expect(n.n, x).toBe(0);
      }
      expect(await tx`select 1 from recruitment_candidate_custom_value where candidate_id = ${d.candidateId}::uuid`).toEqual([]);
      expect(await tx`select 1 from recruitment_candidate_custom_restricted where candidate_id = ${d.candidateId}::uuid`).toEqual([]);
      expect(await tx`select 1 from recruitment_job_custom_value where job_id = ${f.job1}::uuid`).toHaveLength(1);
      throw new Error(ROLLBACK);
    }).catch((err: unknown) => (err instanceof Error && err.message === ROLLBACK ? 'rolled back' : Promise.reject(err)));
    expect(done).toBe('rolled back');
    // Through the service as well (default owner): the company delete removes the empty company's fields and options.
    await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${emptyCompany}::uuid)`));
    for (const t of ['recruitment_custom_field', 'recruitment_custom_field_option']) {
      expect(await owner.db.execute(sql`select 1 from ${sql.identifier(t)} where company_id = ${emptyCompany}::uuid`), t).toHaveLength(0);
    }
    // A company with candidates and jobs keeps everything (its job opening refuses the delete first).
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
    expect(await owner.db.execute(sql`select 1 from recruitment_custom_field where company_id = ${base.companyId}::uuid`)).toHaveLength(3);
  });
});

describe('review follow-ups — required choice fields, field limits, narrowed numbers, invisible values', () => {
  it('a required choice field always keeps an enabled option; one left without (by any route) does not block saving', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    expect(await code(field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift', required: 'on' }))).toBe('required_needs_option');
    const { id } = await field({ kind: 'candidate', type: 'single_choice', label_en: 'Preferred shift' });
    expect(await code(saveCustomField(admin, { id, label_en: 'Preferred shift', required: 'on' }))).toBe('required_needs_option');
    const morning = await option(id, 'Morning');
    await saveCustomField(admin, { id, label_en: 'Preferred shift', required: 'on' });
    expect(await code(saveCustomFieldOption(admin, { id: morning, label_en: 'Morning', enabled: false }))).toBe('required_needs_option');
    expect(await code(deleteCustomFieldOption(admin, morning))).toBe('required_needs_option');
    const night = await option(id, 'Night');
    await saveCustomFieldOption(admin, { id: morning, label_en: 'Morning', enabled: false });
    expect(await code(deleteCustomFieldOption(admin, night))).toBe('required_needs_option');
    await deleteCustomFieldOption(admin, morning);
    // Still required: a save without an answer is refused while an option can be chosen.
    expect(await code(saveCandidate(f.r1, c.candidateId, {}))).toBe('custom_field_required');
    // If the field is ever left without an enabled option (here written directly, past the service), it is not enforced: the
    // form does not require it and saving every record still works.
    await owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update recruitment_custom_field_option set enabled = false where field_id = ${id}::uuid`;
    });
    const view = (await candidateProfile(f.r1, c.applicationId)).custom.find((x) => x.id === id)!;
    expect({ required: view.required, options: view.options }).toEqual({ required: true, options: [] });
    await saveCandidate(f.r1, c.candidateId, {});
    expect(await valueRows('recruitment_candidate_custom_value', id)).toEqual([]);
  });

  it('counts only enabled fields toward 50 per kind, with 500 in all', async () => {
    const insert = (n: number, enabled: boolean, offset: number) => owner.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into recruitment_custom_field (tenant_id, company_id, record_kind, field_type, label_en, position, enabled, created_by_user_id, updated_by_user_id)
        select ${base.tenantId}::uuid, ${base.companyId}::uuid, 'candidate', 'short_text', 'Fictional field ' || (g + ${offset}), g + ${offset}, ${enabled}, ${base.adminUserId}::uuid,
          ${base.adminUserId}::uuid from generate_series(1, ${n}::int) g`;
    });
    await insert(49, true, 0);
    const { id: fiftieth } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Fiftieth field' });
    expect(await code(field({ kind: 'candidate', type: 'short_text', label_en: 'One too many' }))).toBe('custom_field_limit');
    // A disabled field does not count toward the 50; enabling it does.
    const { id: spare } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Disabled spare', enabled: false });
    expect(await code(saveCustomField(admin, { id: spare, label_en: 'Disabled spare', enabled: true }))).toBe('custom_field_limit');
    await saveCustomField(admin, { id: fiftieth, label_en: 'Fiftieth field', enabled: false });
    await saveCustomField(admin, { id: spare, label_en: 'Disabled spare', enabled: true });
    // Job fields are counted on their own.
    await field({ kind: 'job', type: 'yes_no', label_en: 'Remote allowed' });
    const [counts] = await owner.db.execute<{ enabled: number; total: number }>(sql`select count(*) filter (where enabled)::int as enabled, count(*)::int as total
      from recruitment_custom_field where company_id = ${base.companyId}::uuid and record_kind = 'candidate'`);
    expect(counts).toEqual({ enabled: 50, total: 51 });
    // 500 in all, disabled ones included.
    await insert(449, false, 1000);
    expect(await code(field({ kind: 'candidate', type: 'short_text', label_en: 'Five hundred and first', enabled: false }))).toBe('custom_field_limit');
  });

  it('a stored number survives a narrowed range unchanged; a changed one is checked; invisible characters alone are empty', async () => {
    const f = await fixture();
    const c = await apply(f.r1, f.job1);
    const { id } = await field({ kind: 'candidate', type: 'number', label_en: 'Assessment score', numberMax: '10', numberDecimals: '1' });
    await saveCandidate(f.r1, c.candidateId, { [id]: '9.5' });
    await saveCustomField(admin, { id, label_en: 'Assessment score', numberMin: '0', numberMax: '5', numberDecimals: '0' });
    await saveCandidate(f.r1, c.candidateId, { [id]: '9.50' });
    expect((await valueRows('recruitment_candidate_custom_value', id)).map((r) => r.number_value)).toEqual(['9.5']);
    expect(await code(saveCandidate(f.r1, c.candidateId, { [id]: '9.6' }))).toBe('custom_value_invalid');
    expect(await code(saveCandidate(f.r1, c.candidateId, { [id]: '2,5' }))).toBe('custom_value_invalid');
    await saveCandidate(f.r1, c.candidateId, { [id]: '4' });
    expect((await valueRows('recruitment_candidate_custom_value', id)).map((r) => r.number_value)).toEqual(['4']);
    const { id: link } = await field({ kind: 'candidate', type: 'short_text', label_en: 'Portfolio link', required: 'on' });
    expect(await code(saveCandidate(f.r1, c.candidateId, { [id]: '4', [link]: '​­ ' }))).toBe('custom_field_required');
  });
});
