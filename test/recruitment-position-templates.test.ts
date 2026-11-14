/**
 * Recruitment slice 15 against Postgres — position templates: acceptance cases 102–106
 * (docs/recruitment-reconstruction/specification.md "Slice 15 acceptance cases"), through the service AND directly as the app role,
 * with a rehearsal under a NOBYPASSRLS table owner with row security forced. The pure rules (template checks, resolving with notes,
 * the requisition merge) are test/recruitment-position-templates-rules.test.ts; case 107 is the lead's rendered check.
 *
 * Expected values are written out from what each fixture step did and read back with plain owner-connection SQL that ignores row
 * security — never computed with packs/recruitment/position-template*.ts. Every person and company is fictional. Template names
 * carry the LETTER sentinel QZT (no UUID, timestamp or number can contain it).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, businessUnit, company, department, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import {
  addApplication, addJobMember, changeRequisitionStatus, createJob, createRequisition, deleteCustomField, deleteCustomFieldOption, deletePositionTemplate,
  interviewFormOptions, jobFormOptions, newPositionFromTemplate, newPositionFromTemplateTx, positionTemplateChoices, positionTemplateChoicesTx,
  positionTemplateEditor, positionTemplateSettings, saveCustomField, saveCustomFieldOption, saveEvaluationForm, savePositionTemplate, scheduleInterview,
  setPositionTemplateEnabled, updateJob, updatePositionTemplateSetting, updateProcess, RecruitmentError, type TemplateNote, type TypedValue,
} from '../packs/recruitment/service';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const NEW_TABLES = ['recruitment_position_template', 'recruitment_position_template_value'];
const FORM_SOURCE = 'Fictional section\nFictional criterion one\nFictional criterion two';
let base: Base;
let admin: SessionContext;
let otherCompanyId: string;

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
const future = (hoursAhead: number) => new Date(Date.now() + hoursAhead * 3_600_000);
const sortValue = (v: TypedValue | null | undefined) => (v && 'optionIds' in v ? { ...v, optionIds: [...v.optionIds].sort() } : v);

/** The company setup the templates name: two processes, two forms, two grades, two departments, a business unit and custom job fields. */
async function setup() {
  const opts = await jobFormOptions(admin, base.companyId); // seeds the company's process, stages and default form
  const defaultProcess = opts.processes[0].id;
  const defaultForm = opts.forms.find((f) => f.isDefault)!.id;
  const [{ id: fast }] = await owner.db.execute<{ id: string }>(sql`insert into recruitment_process (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
    values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional fast-track process', ${base.adminUserId}::uuid, ${base.adminUserId}::uuid) returning id`);
  await owner.db.execute(sql`insert into recruitment_process_stage (tenant_id, company_id, process_id, stage_id, position)
    select tenant_id, company_id, ${fast}::uuid, stage_id, position from recruitment_process_stage where process_id = ${defaultProcess}::uuid`);
  await saveEvaluationForm(admin, { companyId: base.companyId, name: 'Fictional technical form', source: FORM_SOURCE, enabled: 'on' });
  const [{ id: tech }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_evaluation_form where company_id = ${base.companyId}::uuid and name = 'Fictional technical form'`);
  const [{ id: g1 }, { id: g2 }] = await owner.db.insert(jobGrade).values([
    { tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }, { tenantId: base.tenantId, code: 'FG2', name: 'Fictional grade 2', rank: 2 },
  ]).returning({ id: jobGrade.id });
  const [{ id: bu }] = await owner.db.insert(businessUnit).values({ tenantId: base.tenantId, companyId: base.companyId, code: 'FBU', name: 'Fictional unit' }).returning({ id: businessUnit.id });
  const [{ id: dept }, { id: dept2 }] = await owner.db.insert(department).values([
    { tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional finance' }, { tenantId: base.tenantId, companyId: base.companyId, name: 'Fictional people' },
  ]).returning({ id: department.id });
  const field = async (input: Record<string, unknown>) => (await saveCustomField(admin, { companyId: base.companyId, kind: 'job', ...input })).id;
  const option = async (fieldId: string, label: string) => (await saveCustomFieldOption(admin, { fieldId, label_en: label })).id;
  const text = await field({ type: 'short_text', label_en: 'Shift pattern' });
  const num = await field({ type: 'number', label_en: 'Headcount band', numberMin: '0', numberMax: '50', numberDecimals: '0' });
  const single = await field({ type: 'single_choice', label_en: 'Seniority track' });
  const [trackA, trackB] = [await option(single, 'Track A'), await option(single, 'Track B')];
  const multi = await field({ type: 'multiple_choice', label_en: 'Languages' });
  const [malay, english, tamil] = [await option(multi, 'Malay'), await option(multi, 'English'), await option(multi, 'Tamil')];
  const yes = await field({ type: 'yes_no', label_en: 'Remote allowed' });
  const costCentre = await field({ type: 'short_text', label_en: 'Cost centre code', required: 'on' });
  return { defaultProcess, fast, defaultForm, tech, g1, g2, bu, dept, dept2, f: { text, num, single, multi, yes, costCentre }, o: { trackA, trackB, malay, english, tamil } };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The full template every case starts from: every field filled. */
const fullTemplate = (x: Setup, over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, name: 'QZTNAME Fictional analyst template', title: 'Fictional payroll analyst', description: 'Fictional analyst description',
  workLocation: 'Kuala Lumpur', employmentType: 'contract', recruitmentType: 'unbudgeted', jobGradeIds: [x.g1, x.g2], businessUnitId: x.bu, departmentId: x.dept,
  processId: x.fast, interviewPlanFormIds: [x.tech, x.defaultForm], enabled: 'on',
  custom: { [x.f.text]: 'Rotating', [x.f.num]: '12', [x.f.single]: x.o.trackB, [x.f.multi]: [x.o.malay, x.o.tamil], [x.f.yes]: 'yes' },
  ...over,
});
const jobRow = async (jobId: string) => (await owner.db.execute<Record<string, unknown>>(sql`select title, description, work_location, employment_type, recruitment_type,
  job_grade_ids, business_unit_id, department_id, process_id, interview_plan_form_ids, created_from_template_id from recruitment_job_opening where id = ${jobId}::uuid`))[0];
const jobValues = (jobId: string) => owner.db.execute<{ field_id: string; text_value: string | null; number_value: string | null; bool_value: boolean | null; option_id: string | null }>(sql`
  select field_id, text_value, number_value::text as number_value, bool_value, option_id from recruitment_job_custom_value where job_id = ${jobId}::uuid
  order by field_id, option_id`);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
});

describe('case 102 — administrators manage templates and the setting; position creators see their company\'s enabled templates only', () => {
  it('refuses everybody else by the service and the tables; partners see only their own company\'s enabled templates', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: on } = await savePositionTemplate(admin, fullTemplate(x));
    const { id: off } = await savePositionTemplate(admin, { companyId: base.companyId, name: 'QZTOFF Fictional disabled template', title: 'Fictional clerk', enabled: '' });
    // A job team: recruiter and hiring manager of a job; a bystander; the other company's partner; this company's partner.
    const recruiter = await login('Fictional Recruiter');
    const manager = await login('Fictional Manager');
    const bystander = await login('Fictional Bystander');
    const { id: jobId } = await createJob(admin, { companyId: base.companyId, title: 'Fictional team job', jobGradeIds: [x.g1], workLocation: 'KL', recruitmentType: 'budgeted',
      employmentType: 'full_time', recruiterUserId: recruiter.userId });
    await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
    const partner = await partnerOf(base.companyId, 'Fictional Partner');
    const otherPartner = await partnerOf(otherCompanyId, 'Fictional Other Partner');
    for (const who of [recruiter, manager, bystander, otherPartner]) {
      expect(await code(positionTemplateSettings(who, base.companyId))).toBe('forbidden');
      expect(await code(positionTemplateEditor(who, base.companyId, on))).toBe('forbidden');
      expect(await code(savePositionTemplate(who, { companyId: base.companyId, name: 'Fictional rogue', title: 'Rogue' }))).toBe('forbidden');
      // They cannot even see that the template exists.
      expect(await code(savePositionTemplate(who, { id: on, name: 'Fictional rogue rename', title: 'Rogue' }))).toBe('not_found');
      expect(await code(setPositionTemplateEnabled(who, on, 'false'))).toBe('not_found');
      expect(await code(deletePositionTemplate(who, on))).toBe('not_found');
      expect(await code(updatePositionTemplateSetting(who, base.companyId, ''))).toBe('forbidden');
      expect(await code(positionTemplateChoices(who, base.companyId))).toBe('forbidden');
      expect(await code(newPositionFromTemplate(who, on))).toBe('template_unavailable');
      // Directly as the app role: no row is visible; inserts are refused; updates and deletes touch nothing; the setting stays.
      expect(await rows(who, sql`select id from recruitment_position_template`)).toHaveLength(0);
      expect(await rows(who, sql`select id from recruitment_position_template_value`)).toHaveLength(0);
      expect(await code(rows(who, sql`insert into recruitment_position_template (tenant_id, company_id, name, title, created_by_user_id, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'Fictional direct', 'Direct', ${who.userId}::uuid, ${who.userId}::uuid)`))).toBe('42501');
      // (Refused by row security, or first by the value guard for a caller who cannot even read the field.)
      expect(await code(rows(who, sql`insert into recruitment_position_template_value (tenant_id, company_id, template_id, field_id, field_type, bool_value, updated_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${on}::uuid, ${x.f.yes}::uuid, 'yes_no', false, ${who.userId}::uuid)`))).toMatch(/^(42501|23514)$/);
      expect(await rows(who, sql`update recruitment_position_template set name = 'Fictional direct rename' where id = ${on}::uuid returning id`)).toHaveLength(0);
      expect(await rows(who, sql`delete from recruitment_position_template where id = ${on}::uuid returning id`)).toHaveLength(0);
      expect(await rows(who, sql`update recruitment_company_setting set position_templates_enabled = false where company_id = ${base.companyId}::uuid returning 1`)).toHaveLength(0);
    }
    expect((await owner.db.execute<{ on: boolean }>(sql`select position_templates_enabled as on from recruitment_company_setting where company_id = ${base.companyId}::uuid`))[0].on).toBe(true);
    expect(await owner.db.execute(sql`select 1 from recruitment_position_template where name in ('QZTNAME Fictional analyst template', 'QZTOFF Fictional disabled template')`)).toHaveLength(2);
    // Administrators (and the company's partner) manage every template; "New position from template" offers the ENABLED ones only.
    for (const who of [admin, partner]) {
      expect((await positionTemplateSettings(who, base.companyId)).templates.map((r) => [r.name, r.enabled])).toEqual([
        ['QZTNAME Fictional analyst template', true], ['QZTOFF Fictional disabled template', false],
      ]);
      expect(await positionTemplateChoices(who, base.companyId)).toEqual({ on: true, templates: [{ id: on, name: 'QZTNAME Fictional analyst template', title: 'Fictional payroll analyst' }] });
      expect(await code(newPositionFromTemplate(who, off))).toBe('template_unavailable');
      expect((await rows<{ id: string }>(who, sql`select id from recruitment_position_template order by name`)).map((r) => r.id)).toEqual([on, off]);
    }
    // The partner manages too (the setting included).
    expect(await code(setPositionTemplateEnabled(partner, off, 'true'))).toBe('ok');
    expect((await positionTemplateChoices(admin, base.companyId)).templates).toHaveLength(2);
    // The other company's partner manages ITS templates and sees none of this company's.
    await savePositionTemplate(otherPartner, { companyId: otherCompanyId, name: 'QZTOTHER Fictional other template', title: 'Fictional other job' });
    expect((await rows<{ name: string }>(otherPartner, sql`select name from recruitment_position_template`)).map((r) => r.name)).toEqual(['QZTOTHER Fictional other template']);
    expect(await positionTemplateChoices(otherPartner, otherCompanyId)).toEqual({ on: false, templates: [] });
    // Turned off: nothing is offered, and a template cannot be opened or recorded on a new job.
    await updatePositionTemplateSetting(admin, base.companyId, '');
    expect(await positionTemplateChoices(admin, base.companyId)).toEqual({ on: false, templates: [] });
    expect(await code(newPositionFromTemplate(admin, on))).toBe('template_unavailable');
    expect(await code(createJob(admin, { companyId: base.companyId, title: 'T', jobGradeIds: [x.g1], workLocation: 'KL', recruitmentType: 'budgeted', employmentType: 'full_time', templateId: on })))
      .toBe('template_unavailable');
    // The setting change and template changes are events with ids and flags only (never a name).
    const events = await owner.db.execute<{ event_type: string; payload: unknown }>(sql`select event_type, payload from domain_event
      where tenant_id = ${base.tenantId}::uuid and (aggregate_type = 'recruitment-position-template' or event_type = 'recruitment-setting.templates-updated') order by sequence`);
    expect(events.map((e) => e.event_type)).toEqual(['recruitment-setting.templates-updated', 'recruitment-position-template.created', 'recruitment-position-template.created',
      'recruitment-position-template.enabled', 'recruitment-position-template.created', 'recruitment-setting.templates-updated']);
    expect(JSON.stringify(events)).not.toMatch(/QZT|Fictional/);
  });
});

describe('case 103 — "New position from template" pre-fills every stored field; saving is a normal position; later edits leave it unchanged', () => {
  it('pre-fills, validates by the normal rules, records the template, and is never linked', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    const draft = await newPositionFromTemplate(admin, tpl);
    expect(draft.notes).toEqual([]);
    expect(draft.templateName).toBe('QZTNAME Fictional analyst template');
    expect(draft.draft).toEqual({
      title: 'Fictional payroll analyst', description: 'Fictional analyst description', workLocation: 'Kuala Lumpur', employmentType: 'contract', recruitmentType: 'unbudgeted',
      jobGradeIds: [x.g1, x.g2], businessUnitId: x.bu, departmentId: x.dept, processId: x.fast, interviewPlan: [x.tech, x.defaultForm],
    });
    const custom = Object.fromEntries(draft.custom.map((f) => [f.id, sortValue(f.value)]));
    expect(custom).toEqual({
      [x.f.text]: { type: 'short_text', text: 'Rotating' }, [x.f.num]: { type: 'number', number: '12' }, [x.f.single]: { type: 'single_choice', optionIds: [x.o.trackB] },
      [x.f.multi]: { type: 'multiple_choice', optionIds: [x.o.malay, x.o.tamil].sort() }, [x.f.yes]: { type: 'yes_no', bool: true }, [x.f.costCentre]: null,
    });
    // The administrator's template form opens the same.
    const editor = await positionTemplateEditor(admin, base.companyId, tpl);
    expect(editor.draft).toEqual(draft.draft);
    expect(editor.template).toEqual({ id: tpl, name: 'QZTNAME Fictional analyst template', enabled: true });

    // Saving: the normal rules apply — a required custom field (empty on the template) and a missing job level are refused.
    const form = {
      companyId: base.companyId, title: 'Fictional payroll analyst', description: 'Fictional analyst description', workLocation: 'Kuala Lumpur', employmentType: 'contract',
      recruitmentType: 'unbudgeted', jobGradeIds: [x.g1, x.g2], businessUnitId: x.bu, departmentId: x.dept, processId: x.fast, interviewPlanFormIds: [x.tech, x.defaultForm],
      templateId: tpl, custom: { [x.f.text]: 'Rotating', [x.f.num]: '12', [x.f.single]: x.o.trackB, [x.f.multi]: [x.o.malay, x.o.tamil], [x.f.yes]: 'yes' } as Record<string, string | string[]>,
    };
    expect(await code(createJob(admin, form))).toBe('custom_field_required');
    expect(await code(createJob(admin, { ...form, jobGradeIds: [], custom: { ...form.custom, [x.f.costCentre]: 'CC-01' } }))).toBe('missing_fields');
    expect(await owner.db.execute(sql`select 1 from recruitment_job_opening where created_from_template_id is not null`)).toHaveLength(0);
    // The person edits before saving (the title).
    const { id: jobId } = await createJob(admin, { ...form, title: 'Fictional senior payroll analyst', custom: { ...form.custom, [x.f.costCentre]: 'CC-01' } });
    const saved = await jobRow(jobId);
    expect(saved).toEqual({
      title: 'Fictional senior payroll analyst', description: 'Fictional analyst description', work_location: 'Kuala Lumpur', employment_type: 'contract',
      recruitment_type: 'unbudgeted', job_grade_ids: [x.g1, x.g2], business_unit_id: x.bu, department_id: x.dept, process_id: x.fast,
      interview_plan_form_ids: [x.tech, x.defaultForm], created_from_template_id: tpl,
    });
    const valuesBefore = await jobValues(jobId);
    const expectedValues = [
      { field_id: x.f.text, text_value: 'Rotating', number_value: null, bool_value: null, option_id: null },
      { field_id: x.f.num, text_value: null, number_value: '12', bool_value: null, option_id: null },
      { field_id: x.f.single, text_value: null, number_value: null, bool_value: null, option_id: x.o.trackB },
      { field_id: x.f.multi, text_value: null, number_value: null, bool_value: null, option_id: x.o.malay },
      { field_id: x.f.multi, text_value: null, number_value: null, bool_value: null, option_id: x.o.tamil },
      { field_id: x.f.yes, text_value: null, number_value: null, bool_value: true, option_id: null },
      { field_id: x.f.costCentre, text_value: 'CC-01', number_value: null, bool_value: null, option_id: null },
    ].sort((a, b) => (a.field_id + (a.option_id ?? '')).localeCompare(b.field_id + (b.option_id ?? '')));
    expect([...valuesBefore].sort((a, b) => (a.field_id + (a.option_id ?? '')).localeCompare(b.field_id + (b.option_id ?? '')))).toEqual(expectedValues);
    const [created] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`select payload from domain_event where event_type = 'recruitment-job.created' and aggregate_id = ${jobId}::uuid`);
    expect(created.payload).toMatchObject({ templateId: tpl, interviewRounds: 2 });

    // The job's interview plan: round 1 uses the technical form when no form is chosen; round 2 the default form.
    const recruiter = await login('Fictional Recruiter');
    const interviewer = await login('Fictional Interviewer');
    await addJobMember(admin, jobId, 'recruiter', recruiter.userId);
    const app = await addApplication(recruiter, { jobId, fullName: 'Fictional Candidate', email: 'template-candidate@example.test' });
    expect((await interviewFormOptions(recruiter, app.applicationId)).plan.map((p) => [p.round, p.formId])).toEqual([[1, x.tech], [2, x.defaultForm]]);
    const { id: iv1 } = await scheduleInterview(recruiter, { applicationId: app.applicationId, roundNo: '1', type: 'onsite', startsAt: future(24), interviewerIds: [interviewer.userId] });
    const { id: iv2 } = await scheduleInterview(recruiter, { applicationId: app.applicationId, roundNo: '2', type: 'onsite', startsAt: future(48), interviewerIds: [interviewer.userId] });
    const forms = await owner.db.execute<{ id: string; evaluation_form_id: string }>(sql`select id, evaluation_form_id from recruitment_interview where application_id = ${app.applicationId}::uuid`);
    expect(Object.fromEntries(forms.map((r) => [r.id, r.evaluation_form_id]))).toEqual({ [iv1]: x.tech, [iv2]: x.defaultForm });

    // Later template edits change no position.
    await savePositionTemplate(admin, fullTemplate(x, { id: tpl, title: 'Fictional changed title', processId: x.defaultProcess, interviewPlanFormIds: [x.defaultForm],
      jobGradeIds: [x.g1], custom: { [x.f.text]: 'Fixed hours', [x.f.yes]: 'no' } }));
    expect(await jobRow(jobId)).toEqual(saved);
    expect(await jobValues(jobId)).toEqual(valuesBefore);
    // Deleting the template clears only the job's record of it.
    await deletePositionTemplate(admin, tpl);
    expect(await jobRow(jobId)).toEqual({ ...saved, created_from_template_id: null });
    expect(await jobValues(jobId)).toEqual(valuesBefore);
    expect(await owner.db.execute(sql`select 1 from recruitment_position_template_value where template_id = ${tpl}::uuid`)).toHaveLength(0);
  });

  it('the database records only an enabled template of the company while templates are on, and never changes it afterwards', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    const { id: other } = await savePositionTemplate(admin, { companyId: base.companyId, name: 'Fictional second template', title: 'Fictional clerk' });
    const insertJob = (templateId: string) => rows(admin, sql`insert into recruitment_job_opening (tenant_id, company_id, job_number, title, job_grade_ids, work_location,
      recruitment_type, employment_type, position_attribute, process_id, created_by_user_id, updated_by_user_id, created_from_template_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, 'MJ000000', 'Fictional direct job', array[${x.g1}::uuid], 'KL', 'budgeted', 'full_time', 'regular',
        ${x.defaultProcess}::uuid, ${base.adminUserId}::uuid, ${base.adminUserId}::uuid, ${templateId}::uuid) returning id`);
    const [{ id: jobId }] = await insertJob(tpl) as unknown as { id: string }[];
    expect(await constraintOf(rows(admin, sql`update recruitment_job_opening set created_from_template_id = ${other}::uuid where id = ${jobId}::uuid`))).toBe('recruitment_job_template_unavailable');
    await setPositionTemplateEnabled(admin, other, 'false');
    expect(await constraintOf(insertJob(other))).toBe('recruitment_job_template_unavailable');
    await updatePositionTemplateSetting(admin, base.companyId, '');
    expect(await constraintOf(insertJob(tpl))).toBe('recruitment_job_template_unavailable');
    // A plan names enabled forms of the company only (an added disabled one is refused by the service and the database).
    await saveEvaluationForm(admin, { id: x.tech, name: 'Fictional technical form', source: FORM_SOURCE, enabled: '' });
    expect(await constraintOf(rows(admin, sql`update recruitment_job_opening set interview_plan_form_ids = array[${x.tech}::uuid] where id = ${jobId}::uuid`)))
      .toBe('recruitment_job_interview_plan_form');
    expect(await code(createJob(admin, { companyId: base.companyId, title: 'T', jobGradeIds: [x.g1], workLocation: 'KL', recruitmentType: 'budgeted', employmentType: 'full_time',
      interviewPlanFormIds: [x.tech] }))).toBe('invalid_input');
  });
});

describe('case 104 — disabled or removed references are left empty with a note; custom values follow slice 14', () => {
  it('opens a template whose references were disabled or removed, copying none of them', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    // Since then: the process is disabled; the department, business unit and grade 2 are archived; the technical form is disabled; an
    // option is disabled, another deleted; a field disabled, another deleted, and the number field narrowed. A template never blocks these.
    await updateProcess(admin, x.fast, { name: 'Fictional fast-track process', enabled: '' });
    await owner.db.execute(sql`update department set archived_at = now() where id = ${x.dept}::uuid`);
    await owner.db.execute(sql`update business_unit set archived_at = now() where id = ${x.bu}::uuid`);
    await owner.db.execute(sql`update job_grade set archived_at = now() where id = ${x.g2}::uuid`);
    await saveEvaluationForm(admin, { id: x.tech, name: 'Fictional technical form', source: FORM_SOURCE, enabled: '' });
    expect(await code(saveCustomFieldOption(admin, { id: x.o.trackB, label_en: 'Track B', enabled: '' }))).toBe('ok');
    expect(await code(deleteCustomFieldOption(admin, x.o.tamil))).toBe('ok');
    expect(await code(saveCustomField(admin, { id: x.f.yes, label_en: 'Remote allowed', type: 'yes_no', enabled: '' }))).toBe('ok');
    expect(await code(deleteCustomField(admin, x.f.text))).toBe('ok');
    expect(await code(saveCustomField(admin, { id: x.f.num, label_en: 'Headcount band', type: 'number', numberMin: '0', numberMax: '10', numberDecimals: '0', enabled: 'on' }))).toBe('ok');

    const opened = await newPositionFromTemplate(admin, tpl);
    expect(opened.draft).toEqual({
      title: 'Fictional payroll analyst', description: 'Fictional analyst description', workLocation: 'Kuala Lumpur', employmentType: 'contract', recruitmentType: 'unbudgeted',
      jobGradeIds: [x.g1], businessUnitId: null, departmentId: null, processId: null, interviewPlan: [null, x.defaultForm],
    });
    expect(Object.fromEntries(opened.custom.filter((f) => f.value).map((f) => [f.id, f.value]))).toEqual({ [x.f.multi]: { type: 'multiple_choice', optionIds: [x.o.malay] } });
    const key = (n: TemplateNote) => JSON.stringify(n);
    const expectedNotes: TemplateNote[] = [
      { kind: 'process' }, { kind: 'department' }, { kind: 'businessUnit' }, { kind: 'jobLevels', count: 1 }, { kind: 'interviewRound', round: 1 },
      { kind: 'customValue', fieldId: x.f.single }, { kind: 'customValue', fieldId: x.f.multi }, { kind: 'customValue', fieldId: x.f.num }, { kind: 'customFields', count: 2 },
    ];
    expect(opened.notes.map(key).sort()).toEqual(expectedNotes.map(key).sort());
    expect(opened.notes).toHaveLength(9);
    // The template form opens the same way. Round 1's form is gone, so the plan as shown ([empty, default]) has a gap: it cannot be
    // saved until round 1 is filled or the rounds from it on are removed (no silent renumbering).
    const editor = await positionTemplateEditor(admin, base.companyId, tpl);
    expect(editor.notes.map(key).sort()).toEqual(expectedNotes.map(key).sort());
    expect(editor.draft.interviewPlan).toEqual([null, x.defaultForm]);
    const saveEditor = (plan: string[]) => savePositionTemplate(admin, {
      id: tpl, name: 'QZTNAME Fictional analyst template', title: editor.draft.title, description: editor.draft.description, workLocation: editor.draft.workLocation,
      employmentType: editor.draft.employmentType, recruitmentType: editor.draft.recruitmentType, jobGradeIds: editor.draft.jobGradeIds, businessUnitId: '', departmentId: '',
      processId: '', interviewPlanFormIds: plan, enabled: 'on', custom: { [x.f.multi]: [x.o.malay] },
    });
    const refused = await saveEditor(editor.draft.interviewPlan.map((f) => f ?? '')).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(RecruitmentError);
    expect([(refused as RecruitmentError).code, (refused as RecruitmentError).detail]).toEqual(['invalid_input', ['interviewPlan']]);
    expect((await owner.db.execute<{ p: string[] }>(sql`select interview_plan_form_ids as p from recruitment_position_template where id = ${tpl}::uuid`))[0].p).toEqual([x.tech, x.defaultForm]);
    expect(await code(saveEditor(['', '']))).toBe('ok'); // the rounds from the empty one on are removed
    expect((await owner.db.execute<{ p: string[] }>(sql`select interview_plan_form_ids as p from recruitment_position_template where id = ${tpl}::uuid`))[0].p).toEqual([]);
    await saveEditor([x.defaultForm, x.defaultForm]); // or round 1 is filled
    const [stored] = await owner.db.execute<Record<string, unknown>>(sql`select process_id, department_id, business_unit_id, job_grade_ids, interview_plan_form_ids
      from recruitment_position_template where id = ${tpl}::uuid`);
    expect(stored).toEqual({ process_id: null, department_id: null, business_unit_id: null, job_grade_ids: [x.g1], interview_plan_form_ids: [x.defaultForm, x.defaultForm] });
    expect((await owner.db.execute<{ field_id: string; option_id: string }>(sql`select field_id, option_id from recruitment_position_template_value where template_id = ${tpl}::uuid`)))
      .toEqual([{ field_id: x.f.multi, option_id: x.o.malay }]);
    expect((await newPositionFromTemplate(admin, tpl)).notes).toEqual([]);
  });

  it('template values are checked by slice 14\'s rules (service and database); a template may leave a required field empty', async () => {
    const x = await setup();
    const save = (custom: Record<string, string | string[]>) => code(savePositionTemplate(admin, { companyId: base.companyId, name: `Fictional ${randomUUID()}`, title: 'Fictional job', custom }));
    expect(await save({ [x.f.num]: '51' })).toBe('custom_value_invalid');
    expect(await save({ [x.f.num]: '2.5' })).toBe('custom_value_invalid');
    expect(await save({ [x.f.single]: x.o.malay })).toBe('custom_value_invalid');
    expect(await save({ [x.f.single]: [x.o.trackA, x.o.trackB] })).toBe('custom_value_invalid');
    expect(await save({ [x.f.yes]: 'maybe' })).toBe('custom_value_invalid');
    await saveCustomFieldOption(admin, { id: x.o.trackB, label_en: 'Track B', enabled: '' });
    expect(await save({ [x.f.single]: x.o.trackB })).toBe('custom_value_invalid');
    expect(await save({ [x.f.single]: x.o.trackA, [x.f.num]: '50' })).toBe('ok'); // the required cost centre is left empty
    // Directly as the administrator, past the service: the database refuses the same.
    const { id: tpl } = await savePositionTemplate(admin, { companyId: base.companyId, name: 'Fictional direct values', title: 'Fictional job' });
    const insert = (fieldId: string, type: string, cols: ReturnType<typeof sql>) => constraintOf(rows(admin, sql`insert into recruitment_position_template_value
      (tenant_id, company_id, template_id, field_id, field_type, text_value, number_value, bool_value, option_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${tpl}::uuid, ${fieldId}::uuid, ${type}, ${cols}, ${base.adminUserId}::uuid)`));
    expect(await insert(x.f.single, 'single_choice', sql`null, null, null, ${x.o.trackB}::uuid`)).toBe('recruitment_custom_option_disabled');
    expect(await insert(x.f.single, 'single_choice', sql`null, null, null, ${x.o.malay}::uuid`)).toBe('recruitment_custom_option_disabled');
    expect(await insert(x.f.num, 'number', sql`null, 51, null, null`)).toBe('recruitment_custom_value_range');
    expect(await insert(x.f.num, 'short_text', sql`'twelve', null, null, null`)).toBe('recruitment_custom_field_disabled');
    expect(await insert(x.f.yes, 'yes_no', sql`'text', null, null, null`)).toBe('recruitment_position_template_value_typed_ck');
    const { id: candidateField } = await saveCustomField(admin, { companyId: base.companyId, kind: 'candidate', type: 'yes_no', label_en: 'Fictional candidate flag' });
    expect(await insert(candidateField, 'yes_no', sql`null, null, true, null`)).toBe('recruitment_custom_field_disabled');
    expect(await insert(x.f.single, 'single_choice', sql`null, null, null, ${x.o.trackA}::uuid`)).toBe('ok');
    // A reference set directly must be the company's and usable now.
    await updateProcess(admin, x.fast, { name: 'Fictional fast-track process', enabled: '' });
    expect(await constraintOf(rows(admin, sql`update recruitment_position_template set process_id = ${x.fast}::uuid where id = ${tpl}::uuid`))).toBe('recruitment_position_template_reference');
    const [{ id: foreignDept }] = await owner.db.insert(department).values({ tenantId: base.tenantId, companyId: otherCompanyId, name: 'Fictional foreign dept' }).returning({ id: department.id });
    expect(await constraintOf(rows(admin, sql`update recruitment_position_template set department_id = ${foreignDept}::uuid where id = ${tpl}::uuid`))).toBe('recruitment_position_template_reference');
    expect(await code(savePositionTemplate(admin, { id: tpl, name: 'Fictional direct values', title: 'Fictional job', processId: x.fast }))).toBe('invalid_input');
    expect(await code(savePositionTemplate(admin, { id: tpl, name: 'Fictional direct values', title: 'Fictional job', departmentId: foreignDept }))).toBe('invalid_input');
    // Unique names per company (case-insensitive), the other company may reuse it.
    expect(await code(savePositionTemplate(admin, { companyId: base.companyId, name: 'fictional DIRECT values', title: 'Fictional job' }))).toBe('name_taken');
    expect(await code(savePositionTemplate(admin, { companyId: otherCompanyId, name: 'Fictional direct values', title: 'Fictional job' }))).toBe('ok');
  });
});

describe('case 105 — requisition "Create job" with a template: the requisition\'s values win', () => {
  it('merges, saves the job onto the requisition, and records the template', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    const { id: req, reqNumber } = await createRequisition(admin, {
      companyId: base.companyId, title: 'Fictional requisition analysts', vacancies: '4', workLocation: 'Penang', employmentType: 'full_time', recruitmentType: 'replacement',
      jobGradeIds: [x.g2], departmentId: x.dept2,
    });
    const opened = await newPositionFromTemplate(admin, tpl, { requisitionId: req });
    expect(opened.requisition).toEqual({ id: req, reqNumber, recruiterUserId: null });
    expect(opened.draft).toEqual({
      // The requisition's: title, levels, work location, both types and the department. The template's: what the requisition lacks.
      title: 'Fictional requisition analysts', jobGradeIds: [x.g2], workLocation: 'Penang', employmentType: 'full_time', recruitmentType: 'replacement', departmentId: x.dept2,
      description: 'Fictional analyst description', businessUnitId: x.bu, processId: x.fast, interviewPlan: [x.tech, x.defaultForm],
    });
    expect(opened.custom.find((f) => f.id === x.f.text)?.value).toEqual({ type: 'short_text', text: 'Rotating' });
    const { id: jobId } = await createJob(admin, {
      companyId: base.companyId, requisitionId: req, templateId: tpl, title: opened.draft.title, description: opened.draft.description, jobGradeIds: opened.draft.jobGradeIds,
      workLocation: opened.draft.workLocation, employmentType: opened.draft.employmentType, recruitmentType: opened.draft.recruitmentType, departmentId: opened.draft.departmentId,
      businessUnitId: opened.draft.businessUnitId, processId: opened.draft.processId, interviewPlanFormIds: [x.tech, x.defaultForm], custom: { [x.f.costCentre]: 'CC-02' },
    });
    expect(await jobRow(jobId)).toMatchObject({ title: 'Fictional requisition analysts', work_location: 'Penang', department_id: x.dept2, business_unit_id: x.bu,
      process_id: x.fast, created_from_template_id: tpl });
    expect(await owner.db.execute(sql`select 1 from recruitment_requisition_job where requisition_id = ${req}::uuid and job_id = ${jobId}::uuid`)).toHaveLength(1);
    // Another company's requisition does not combine with this template; a closed requisition refuses as before.
    const otherPartner = await partnerOf(otherCompanyId, 'Fictional Other Partner');
    const { id: otherReq } = await createRequisition(otherPartner, { companyId: otherCompanyId, title: 'Fictional other', vacancies: '1', workLocation: 'KL', employmentType: 'full_time', recruitmentType: 'budgeted' });
    expect(await code(newPositionFromTemplate(admin, tpl, { requisitionId: otherReq }))).toBe('template_unavailable');
    await changeRequisitionStatus(admin, req, 'cancelled');
    expect(await code(newPositionFromTemplate(admin, tpl, { requisitionId: req }))).toBe('requisition_terminal');
  });
});

describe('review follow-ups — the job\'s interview plan, scheduling as planned, cross-company forms, the template record, scope', () => {
  const jobInput = async (jobId: string) => {
    const [j] = await owner.db.execute<{ title: string; work_location: string; recruitment_type: string; employment_type: string; job_grade_ids: string[]; process_id: string }>(sql`
      select title, work_location, recruitment_type, employment_type, job_grade_ids, process_id from recruitment_job_opening where id = ${jobId}::uuid`);
    return { title: j.title, workLocation: j.work_location, recruitmentType: j.recruitment_type, employmentType: j.employment_type, jobGradeIds: j.job_grade_ids, processId: j.process_id };
  };
  const plan = async (jobId: string) => (await owner.db.execute<{ p: string[] }>(sql`select interview_plan_form_ids as p from recruitment_job_opening where id = ${jobId}::uuid`))[0].p;
  const job = (x: Setup, over: Record<string, unknown> = {}) => createJob(admin, { companyId: base.companyId, title: 'Fictional planned job', jobGradeIds: [x.g1], workLocation: 'KL',
    recruitmentType: 'budgeted', employmentType: 'full_time', custom: { [x.f.costCentre]: 'CC-09' }, ...over });

  it('Job settings: sets the plan, keeps a form disabled since, refuses a newly added disabled form or a gap, and leaves the plan alone without the marker', async () => {
    const x = await setup();
    const { id: jobId } = await job(x, { interviewPlanFormIds: [x.tech] });
    expect(await plan(jobId)).toEqual([x.tech]);
    await updateJob(admin, jobId, { ...(await jobInput(jobId)), interviewPlanFormIds: [x.tech, x.defaultForm] });
    expect(await plan(jobId)).toEqual([x.tech, x.defaultForm]);
    await saveEvaluationForm(admin, { id: x.tech, name: 'Fictional technical form', source: FORM_SOURCE, enabled: '' });
    // The kept (now disabled) form stays; reordering keeps it too.
    expect(await code(updateJob(admin, jobId, { ...(await jobInput(jobId)), interviewPlanFormIds: [x.defaultForm, x.tech] }))).toBe('ok');
    expect(await plan(jobId)).toEqual([x.defaultForm, x.tech]);
    // A newly added disabled form is refused (service and database); so is a gap.
    await saveEvaluationForm(admin, { companyId: base.companyId, name: 'Fictional extra form', source: FORM_SOURCE, enabled: '' });
    const [{ id: extra }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_evaluation_form where company_id = ${base.companyId}::uuid and name = 'Fictional extra form'`);
    expect(await code(updateJob(admin, jobId, { ...(await jobInput(jobId)), interviewPlanFormIds: [x.defaultForm, x.tech, extra] }))).toBe('invalid_input');
    expect(await constraintOf(rows(admin, sql`update recruitment_job_opening set interview_plan_form_ids = array[${x.defaultForm}::uuid, ${x.tech}::uuid, ${extra}::uuid]
      where id = ${jobId}::uuid`))).toBe('recruitment_job_interview_plan_form');
    const gap = await updateJob(admin, jobId, { ...(await jobInput(jobId)), interviewPlanFormIds: ['', x.defaultForm] }).then(() => null, (e: unknown) => e);
    expect([(gap as RecruitmentError).code, (gap as RecruitmentError).detail]).toEqual(['invalid_input', ['interviewPlan']]);
    // The Job info form carries no plan (no marker): the plan is left as it is.
    await updateJob(admin, jobId, { ...(await jobInput(jobId)), title: 'Fictional renamed job' });
    expect(await plan(jobId)).toEqual([x.defaultForm, x.tech]);
    // Trailing empty rounds end the plan.
    await updateJob(admin, jobId, { ...(await jobInput(jobId)), interviewPlanFormIds: [x.defaultForm, x.tech, '', ''] });
    expect(await plan(jobId)).toEqual([x.defaultForm, x.tech]);
  });

  it('"As planned" for a round whose form was disabled since uses the company default form; the hint says so', async () => {
    const x = await setup();
    const { id: jobId } = await job(x, { interviewPlanFormIds: [x.tech, x.tech] });
    const recruiter = await login('Fictional Recruiter');
    const interviewer = await login('Fictional Interviewer');
    await addJobMember(admin, jobId, 'recruiter', recruiter.userId);
    const app = await addApplication(recruiter, { jobId, fullName: 'Fictional Candidate', email: 'planned-candidate@example.test' });
    await saveEvaluationForm(admin, { id: x.tech, name: 'Fictional technical form', source: FORM_SOURCE, enabled: '' });
    expect((await interviewFormOptions(recruiter, app.applicationId)).plan).toEqual([
      { round: 1, formId: x.tech, formName: 'Fictional technical form', enabled: false }, { round: 2, formId: x.tech, formName: 'Fictional technical form', enabled: false },
    ]);
    const { id: iv } = await scheduleInterview(recruiter, { applicationId: app.applicationId, roundNo: '2', type: 'video', startsAt: future(24), interviewerIds: [interviewer.userId] });
    const [row] = await owner.db.execute<{ evaluation_form_id: string }>(sql`select evaluation_form_id from recruitment_interview where id = ${iv}::uuid`);
    expect(row.evaluation_form_id).toBe(x.defaultForm);
  });

  it('another company\'s evaluation form is refused in a template plan and a job plan, by the service and the database', async () => {
    const x = await setup();
    await saveEvaluationForm(admin, { companyId: otherCompanyId, name: 'Fictional other company form', source: FORM_SOURCE, enabled: 'on' });
    const [{ id: foreign }] = await owner.db.execute<{ id: string }>(sql`select id from recruitment_evaluation_form where company_id = ${otherCompanyId}::uuid`);
    const refusal = async (op: Promise<unknown>) => { const e = await op.then(() => null, (err: unknown) => err); return [(e as RecruitmentError).code, (e as RecruitmentError).detail]; };
    expect(await refusal(savePositionTemplate(admin, { companyId: base.companyId, name: 'Fictional foreign plan', title: 'Fictional job', interviewPlanFormIds: [foreign] })))
      .toEqual(['invalid_input', ['interviewPlan']]);
    const { id: tpl } = await savePositionTemplate(admin, { companyId: base.companyId, name: 'Fictional own plan', title: 'Fictional job', interviewPlanFormIds: [x.defaultForm] });
    expect(await constraintOf(rows(admin, sql`update recruitment_position_template set interview_plan_form_ids = array[${foreign}::uuid] where id = ${tpl}::uuid`)))
      .toBe('recruitment_position_template_reference');
    expect(await refusal(job(x, { interviewPlanFormIds: [foreign] }))).toEqual(['invalid_input', ['interviewPlan']]);
    const { id: jobId } = await job(x, { interviewPlanFormIds: [x.defaultForm] });
    expect(await code(updateJob(admin, jobId, { ...(await jobInput(jobId)), interviewPlanFormIds: [x.defaultForm, foreign] }))).toBe('invalid_input');
    expect(await constraintOf(rows(admin, sql`update recruitment_job_opening set interview_plan_form_ids = array[${foreign}::uuid] where id = ${jobId}::uuid`)))
      .toBe('recruitment_job_interview_plan_form');
    expect(await plan(jobId)).toEqual([x.defaultForm]);
  });

  it('a job\'s template record is cleared only by the template\'s delete, never directly', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    const { id: jobId } = await job(x, { templateId: tpl });
    expect(await constraintOf(rows(admin, sql`update recruitment_job_opening set created_from_template_id = null where id = ${jobId}::uuid`))).toBe('recruitment_job_template_unavailable');
    expect((await jobRow(jobId)).created_from_template_id).toBe(tpl);
    // Other job edits still work (the record is untouched).
    expect(await code(updateJob(admin, jobId, { ...(await jobInput(jobId)), title: 'Fictional renamed' }))).toBe('ok');
    await deletePositionTemplate(admin, tpl);
    expect((await jobRow(jobId)).created_from_template_id).toBeNull();
  });

  it('a template of a company outside the viewer\'s current scope is unavailable, even to a group-wide administrator', async () => {
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    expect(await code(newPositionFromTemplate(admin, tpl, { scopeCompanyIds: [otherCompanyId] }))).toBe('template_unavailable');
    expect(await code(newPositionFromTemplate(admin, tpl, { scopeCompanyIds: [] }))).toBe('template_unavailable');
    expect((await newPositionFromTemplate(admin, tpl, { scopeCompanyIds: [otherCompanyId, base.companyId] })).companyId).toBe(base.companyId);
  });
});

describe('case 106 — company deletion, forced row security, grants, write-free reads and the owner rehearsal', () => {
  it('forces row security with exact grants and none to PUBLIC; guards are not callable; read paths write nothing', async () => {
    const meta = await owner.db.execute<{ relname: string; forced: boolean; enabled: boolean; app: string | null; public_grants: number }>(sql`
      select c.relname, c.relforcerowsecurity as forced, c.relrowsecurity as enabled,
        (select string_agg(a.privilege_type, ',' order by a.privilege_type) from aclexplode(c.relacl) a where a.grantee = 'ai_hr_app'::regrole) as app,
        (select count(*)::int from aclexplode(c.relacl) a where a.grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${NEW_TABLES.join(',')}}`}::text[]) order by c.relname`);
    expect(meta).toEqual(NEW_TABLES.map((relname) => ({ relname, forced: true, enabled: true, app: 'DELETE,INSERT,SELECT,UPDATE', public_grants: 0 })));
    const fns = await owner.db.execute<{ proname: string; app_exec: boolean; public_exec: boolean; secdef: boolean }>(sql`select p.proname,
      has_function_privilege('ai_hr_app', p.oid, 'execute') as app_exec, has_function_privilege('public', p.oid, 'execute') as public_exec, p.prosecdef as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
        and p.proname in ('recruitment_guard_position_template', 'recruitment_guard_position_template_value', 'recruitment_guard_job_template') order by p.proname collate "C"`);
    expect(fns).toEqual(['recruitment_guard_job_template', 'recruitment_guard_position_template', 'recruitment_guard_position_template_value']
      .map((proname) => ({ proname, app_exec: false, public_exec: false, secdef: false })));
    // "New position from template" and the chooser read in a READ ONLY transaction and take no transaction id.
    const x = await setup();
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    const partner = await partnerOf(base.companyId, 'Fictional Partner');
    for (const who of [admin, partner]) {
      const out = await withTenant(who, async (tx) => {
        const opened = await newPositionFromTemplateTx(tx, who, tpl);
        const choices = await positionTemplateChoicesTx(tx, who, base.companyId);
        const [xid] = await tx.execute<{ x: string | null }>(sql`select pg_current_xact_id_if_assigned()::text as x`);
        const [mode] = await tx.execute<{ ro: string }>(sql`select current_setting('transaction_read_only') as ro`);
        return { title: opened.draft.title, choices: choices.templates.length, xid: xid.x, ro: mode.ro };
      }, { readOnlySnapshot: true });
      expect(out).toEqual({ title: 'Fictional payroll analyst', choices: 1, xid: null, ro: 'on' });
    }
  });

  it('restates the company delete byte for byte with added steps; leaves the candidate removal as it was', () => {
    const read = (file: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${file}`, import.meta.url)), 'utf8');
    const fn = (source: string, name: string) => {
      const start = source.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf('END $$;', start) + 'END $$;'.length);
    };
    const b = fn(read('5715_recruitment_custom_fields.sql'), 'app.recruitment_delete_company_setup').split('\n');
    const a = fn(read('5716_recruitment_position_templates.sql'), 'app.recruitment_delete_company_setup').split('\n');
    // 5715's body is exactly a prefix plus a suffix of 5716's: one inserted block, nothing else changed.
    let i = 0;
    while (i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    expect(i + j).toBe(b.length);
    expect(b.length).toBeGreaterThan(100);
    const added = a.slice(i, a.length - j);
    expect(added).toHaveLength(7);
    expect(added.filter((l) => /DELETE FROM/.test(l)).map((l) => l.trim().split(' ')[2])).toEqual(['public.recruitment_position_template_value', 'public.recruitment_position_template']);
    expect(read('5716_recruitment_position_templates.sql')).not.toContain('recruitment_destroy_candidate(p_candidate');
  });

  it('company deletion covers the new tables; the delete and the template guards work under a NOBYPASSRLS owner with forced row security', async () => {
    const x = await setup();
    const bystander = await login('Fictional Bystander');
    // The empty company's setup: two templates (one with two values) and the setting.
    const partnerB = await partnerOf(otherCompanyId, 'Fictional Other Partner');
    const { id: emptyField } = await saveCustomField(admin, { companyId: otherCompanyId, kind: 'job', type: 'multiple_choice', label_en: 'Fictional other field' });
    const [e1, e2] = [(await saveCustomFieldOption(admin, { fieldId: emptyField, label_en: 'One' })).id, (await saveCustomFieldOption(admin, { fieldId: emptyField, label_en: 'Two' })).id];
    await savePositionTemplate(partnerB, { companyId: otherCompanyId, name: 'QZTEMPTY one', title: 'Fictional job one', custom: { [emptyField]: [e1, e2] } });
    await savePositionTemplate(partnerB, { companyId: otherCompanyId, name: 'QZTEMPTY two', title: 'Fictional job two' });
    await updatePositionTemplateSetting(partnerB, otherCompanyId, 'on');
    // This company has a job made from a template.
    await updatePositionTemplateSetting(admin, base.companyId, 'on');
    const { id: tpl } = await savePositionTemplate(admin, fullTemplate(x));
    await createJob(admin, { companyId: base.companyId, title: 'Fictional job', jobGradeIds: [x.g1], workLocation: 'KL', recruitmentType: 'budgeted', employmentType: 'full_time',
      templateId: tpl, custom: { [x.f.costCentre]: 'CC-03' } });
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
      expect(fns.map((f) => f.sig)).toEqual(expect.arrayContaining(['app.recruitment_delete_company_setup(uuid)', 'app.recruitment_guard_position_template()',
        'app.recruitment_guard_position_template_value()', 'app.recruitment_guard_job_template()']));
      for (const f of fns) await tx.unsafe(`alter function ${f.sig} owner to ai_hr_owner`);
      await tx`grant usage on schema app, public to ai_hr_owner`;
      await tx`grant execute on all functions in schema app to ai_hr_owner`;
      expect(await tx`select relname from pg_class where relname = any(${NEW_TABLES}) and relforcerowsecurity and relrowsecurity`).toHaveLength(NEW_TABLES.length);
      const as = async (userId: string, roles: string, grants: unknown) => {
        await tx.unsafe('set local role ai_hr_app');
        await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${userId}, true), set_config('app.roles', ${roles}, true),
          set_config('app.grants', ${JSON.stringify(grants)}, true)`;
      };
      const adminGrants = [{ role: 'hr_admin', companyId: null }];
      const employee = [{ role: 'employee', companyId: null }];
      // The owner itself, outside a company delete, sees no template of a company the session does not administer.
      await tx.unsafe('set local role ai_hr_owner');
      await tx`select set_config('app.tenant_id', ${base.tenantId}, true), set_config('app.user_id', ${bystander.userId}, true), set_config('app.roles', 'employee', true),
        set_config('app.grants', ${JSON.stringify(employee)}, true)`;
      for (const t of NEW_TABLES) expect(await tx.unsafe(`select 1 from public.${t}`), t).toEqual([]);
      // The guards run as the caller under the new owner: an administrator writes; a bystander's write is refused.
      await as(base.adminUserId, 'hr_admin', adminGrants);
      await tx`update recruitment_position_template set title = 'Fictional rehearsal title' where id = ${tpl}::uuid`;
      await as(bystander.userId, 'employee', employee);
      expect(await tx`update recruitment_position_template set title = 'Rogue' where id = ${tpl}::uuid returning 1`).toEqual([]);
      // The company delete removes the empty company's templates and values (and its setting row) as the owner under forced row security.
      await as(base.adminUserId, 'hr_admin', adminGrants);
      const [removed] = await tx`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid) as n`;
      // Independently: 2 template values + 2 templates + 2 field options + 1 field + 1 setting row + the seeded setup of a company that
      // never opened Recruitment (none here: no stages, processes, forms or reasons were seeded for it).
      expect(Number(removed.n)).toBe(8);
      await tx`reset role`;
      for (const t of NEW_TABLES) {
        const [n] = await tx.unsafe(`select count(*)::int as n from public.${t} where company_id = '${otherCompanyId}'::uuid`);
        expect(n.n, t).toBe(0);
      }
      expect(await tx`select 1 from recruitment_position_template where id = ${tpl}::uuid`).toHaveLength(1);
      throw new Error(ROLLBACK);
    }).catch((err: unknown) => (err instanceof Error && err.message === ROLLBACK ? 'rolled back' : Promise.reject(err)));
    expect(done).toBe('rolled back');
    // Through the default owner as well; the company with a job keeps everything (its job opening refuses the delete first).
    await withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${otherCompanyId}::uuid)`));
    for (const t of NEW_TABLES) expect(await owner.db.execute(sql`select 1 from ${sql.identifier(t)} where company_id = ${otherCompanyId}::uuid`), t).toHaveLength(0);
    expect(await code(withTenant(adminCtx(base), (tx) => tx.execute(sql`select app.recruitment_delete_company_setup(${base.companyId}::uuid)`)))).toBe('23503');
    expect(await owner.db.execute(sql`select 1 from recruitment_position_template where company_id = ${base.companyId}::uuid`)).toHaveLength(1);
  });
});
