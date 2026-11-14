/**
 * Recruitment slice 15 — the pure rules of position templates (packs/recruitment/position-template-model.ts and the interview plan
 * in packs/recruitment/model.ts): template checks, resolving a template into a new-position draft with notes for parts no longer
 * usable (case 104), and the requisition merge where the requisition's values win (case 105). No database. The database
 * behaviour (cases 102–106) is test/recruitment-position-templates.test.ts.
 *
 * Expected values are written out by hand from each fixture, never computed with the module under test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INTERVIEW_PLAN_FORM_MARKER, INTERVIEW_PLAN_MAX, interviewPlanFromForm, mergeRequisition, parseInterviewPlan, resolveTemplate, validateTemplateInput,
  type FieldRule, type TemplateAvailability, type TemplateRecord, type TypedValue,
} from '../packs/recruitment/service';
import { validateJobInput } from '../packs/recruitment/model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [PROC, PROC_OFF, DEPT, DEPT_GONE, BU, BU_GONE, G1, G2, G_GONE, FORM1, FORM2, FORM_OFF] = Array.from({ length: 12 }, (_, i) => id(i + 1));
const [F_TEXT, F_NUM, F_SINGLE, F_MULTI, F_YES, F_GONE, F_RETYPED] = Array.from({ length: 7 }, (_, i) => id(100 + i));
const [O_A, O_B, O_OFF, O_GONE] = Array.from({ length: 4 }, (_, i) => id(200 + i));

const rule = (fieldId: string, type: FieldRule['type'], extra: Partial<FieldRule> = {}): FieldRule => ({
  id: fieldId, type, required: true, enabled: true, numberMin: null, numberMax: null, numberDecimals: null, options: [], ...extra,
});
const available: TemplateAvailability = {
  processIds: new Set([PROC]), gradeIds: new Set([G1, G2]), departmentIds: new Set([DEPT]), businessUnitIds: new Set([BU]), formIds: new Set([FORM1, FORM2]),
  fields: [
    rule(F_TEXT, 'short_text'),
    rule(F_NUM, 'number', { numberMin: '0', numberMax: '10', numberDecimals: 0 }),
    rule(F_SINGLE, 'single_choice', { options: [{ id: O_A, enabled: true }, { id: O_OFF, enabled: false }] }),
    rule(F_MULTI, 'multiple_choice', { options: [{ id: O_A, enabled: true }, { id: O_B, enabled: true }, { id: O_OFF, enabled: false }] }),
    rule(F_YES, 'yes_no'),
    rule(F_RETYPED, 'long_text'),
  ],
};
const template = (over: Partial<TemplateRecord> = {}): TemplateRecord => ({
  title: 'Fictional payroll analyst', description: 'Fictional description', workLocation: 'Kuala Lumpur', employmentType: 'full_time',
  recruitmentType: 'budgeted', jobGradeIds: [G1, G2], businessUnitId: BU, departmentId: DEPT, processId: PROC, interviewPlanFormIds: [FORM1, FORM2],
  values: new Map<string, TypedValue>([[F_TEXT, { type: 'short_text', text: 'Hybrid' }], [F_YES, { type: 'yes_no', bool: true }]]),
  ...over,
});

describe('template checks', () => {
  it('requires the name and the title only; everything else is optional', () => {
    expect(validateTemplateInput({})).toEqual({ ok: false, code: 'missing_fields', fields: ['name', 'title'] });
    expect(validateTemplateInput({ name: '  ', title: 'Analyst' })).toEqual({ ok: false, code: 'missing_fields', fields: ['name'] });
    expect(validateTemplateInput({ name: 'Analyst template', title: 'Analyst' })).toEqual({
      ok: true, value: {
        name: 'Analyst template', title: 'Analyst', description: null, workLocation: null, employmentType: null, recruitmentType: null, jobGradeIds: [],
        businessUnitId: null, departmentId: null, processId: null, interviewPlanFormIds: [], enabled: true,
      },
    });
  });
  it('refuses a name over 120 characters, unknown types, bad ids and an oversized plan, naming each field', () => {
    const r = validateTemplateInput({
      name: 'x'.repeat(121), title: 'Analyst', employmentType: 'zero_hours', recruitmentType: 'whim', jobGradeIds: ['nope'], processId: 'nope',
      departmentId: 'nope', businessUnitId: 'nope', interviewPlanFormIds: Array.from({ length: 11 }, (_, i) => id(500 + i)),
    });
    expect(r).toEqual({ ok: false, code: 'invalid_input', fields: ['name', 'employmentType', 'recruitmentType', 'jobLevel', 'businessUnitId', 'departmentId', 'processId', 'interviewPlan'] });
    expect(validateTemplateInput({ name: 'x'.repeat(120), title: 'Analyst' }).ok).toBe(true);
  });
  it('keeps the plan in round order, dropping trailing empty rounds, refusing a gap, and reads "on" as enabled', () => {
    const r = validateTemplateInput({ name: 'T', title: 'A', interviewPlanFormIds: [FORM2, FORM1, FORM2, '', ''], enabled: '' });
    expect(r).toMatchObject({ ok: true, value: { interviewPlanFormIds: [FORM2, FORM1, FORM2], enabled: false } });
    expect(validateTemplateInput({ name: 'T', title: 'A', interviewPlanFormIds: [FORM2, '', FORM1] })).toEqual({ ok: false, code: 'invalid_input', fields: ['interviewPlan'] });
    expect(validateTemplateInput({ name: 'T', title: 'A', enabled: 'on' })).toMatchObject({ ok: true, value: { enabled: true } });
  });
});

describe('the interview plan of a job', () => {
  it('parses at most INTERVIEW_PLAN_MAX form ids; trailing empty rounds end the plan; a gap is refused, never renumbered', () => {
    expect(INTERVIEW_PLAN_MAX).toBe(10);
    expect(parseInterviewPlan([FORM1, FORM2, '', ' '])).toEqual([FORM1, FORM2]);
    expect(parseInterviewPlan([FORM1, FORM1])).toEqual([FORM1, FORM1]);
    expect(parseInterviewPlan(['', FORM1])).toBeNull();
    expect(parseInterviewPlan([FORM1, ' ', FORM2])).toBeNull();
    expect(parseInterviewPlan(['', '', ''])).toEqual([]);
    expect(parseInterviewPlan([...Array.from({ length: 10 }, () => FORM1), '', ''])).toHaveLength(10);
    expect(parseInterviewPlan(undefined)).toEqual([]);
    expect(parseInterviewPlan(['not-an-id'])).toBeNull();
    expect(parseInterviewPlan(Array.from({ length: 11 }, () => FORM1))).toBeNull();
  });
  it('a job left without the plan on its form keeps its plan (undefined); a bad plan is refused by name', () => {
    const job = { companyId: id(900), title: 'Analyst', jobGradeIds: [G1], workLocation: 'KL', recruitmentType: 'budgeted', employmentType: 'full_time' };
    expect(validateJobInput(job)).toMatchObject({ ok: true, value: { interviewPlanFormIds: undefined } });
    expect(validateJobInput({ ...job, interviewPlanFormIds: [FORM1, ''] })).toMatchObject({ ok: true, value: { interviewPlanFormIds: [FORM1] } });
    expect(validateJobInput({ ...job, interviewPlanFormIds: ['x'] })).toEqual({ ok: false, code: 'invalid_input', fields: ['interviewPlan'] });
    expect(validateJobInput({ ...job, interviewPlanFormIds: ['', FORM1] })).toEqual({ ok: false, code: 'invalid_input', fields: ['interviewPlan'] });
  });
  it('reads the plan from a form only when the form carried it (the marker); otherwise the job keeps its plan', () => {
    const form = (entries: [string, string][]) => { const f = new FormData(); for (const [k, v] of entries) f.append(k, v); return f; };
    expect(interviewPlanFromForm(form([['interviewPlanFormIds', FORM1]]))).toBeUndefined();
    expect(interviewPlanFromForm(form([['title', 'x']]))).toBeUndefined();
    expect(interviewPlanFromForm(form([[INTERVIEW_PLAN_FORM_MARKER, '1'], ['interviewPlanFormIds', FORM1], ['interviewPlanFormIds', '']]))).toEqual([FORM1, '']);
    expect(interviewPlanFromForm(form([[INTERVIEW_PLAN_FORM_MARKER, '1']]))).toEqual([]);
  });
});

describe('case 104 — resolving: every stored field copied; disabled or removed references left empty with a note', () => {
  it('copies a fully usable template unchanged, with no note', () => {
    const { draft, notes } = resolveTemplate(template(), available);
    expect(notes).toEqual([]);
    expect(draft).toEqual({
      title: 'Fictional payroll analyst', description: 'Fictional description', workLocation: 'Kuala Lumpur', employmentType: 'full_time',
      recruitmentType: 'budgeted', jobGradeIds: [G1, G2], businessUnitId: BU, departmentId: DEPT, processId: PROC, interviewPlan: [FORM1, FORM2],
      custom: new Map([[F_TEXT, { type: 'short_text', text: 'Hybrid' }], [F_YES, { type: 'yes_no', bool: true }]]),
    });
  });

  it('leaves out a disabled process, removed department and business unit, withdrawn levels and a disabled round form — each named', () => {
    const { draft, notes } = resolveTemplate(template({
      processId: PROC_OFF, departmentId: DEPT_GONE, businessUnitId: BU_GONE, jobGradeIds: [G1, G_GONE], interviewPlanFormIds: [FORM1, FORM_OFF, FORM2],
      values: new Map(),
    }), available);
    expect(draft).toMatchObject({ processId: null, departmentId: null, businessUnitId: null, jobGradeIds: [G1], interviewPlan: [FORM1, null, FORM2] });
    expect(notes).toEqual([{ kind: 'process' }, { kind: 'department' }, { kind: 'businessUnit' }, { kind: 'jobLevels', count: 1 }, { kind: 'interviewRound', round: 2 }]);
  });

  it('custom values follow slice 14: disabled or removed options and fields are never copied; out-of-range numbers are left empty', () => {
    const { draft, notes } = resolveTemplate(template({
      values: new Map<string, TypedValue>([
        [F_SINGLE, { type: 'single_choice', optionIds: [O_OFF] }],
        [F_MULTI, { type: 'multiple_choice', optionIds: [O_A, O_GONE, O_B] }],
        [F_NUM, { type: 'number', number: '12' }],
        [F_GONE, { type: 'short_text', text: 'field removed' }],
        [F_RETYPED, { type: 'short_text', text: 'field now long text' }],
        [F_YES, { type: 'yes_no', bool: false }],
      ]),
    }), available);
    expect([...draft.custom.entries()]).toEqual([
      [F_MULTI, { type: 'multiple_choice', optionIds: [O_A, O_B] }],
      [F_YES, { type: 'yes_no', bool: false }],
    ]);
    expect(notes).toEqual([
      { kind: 'customValue', fieldId: F_SINGLE }, { kind: 'customValue', fieldId: F_MULTI }, { kind: 'customValue', fieldId: F_NUM },
      { kind: 'customFields', count: 2 },
    ]);
  });
});

describe('case 105 — a requisition\'s values win over the template\'s', () => {
  it('takes every value the requisition has and fills only the rest from the template', () => {
    const { draft } = resolveTemplate(template({ departmentId: null }), { ...available });
    const merged = mergeRequisition(draft, {
      title: 'Requisition title', description: null, jobGradeIds: [G2], workLocation: 'Penang', recruitmentType: 'replacement', employmentType: 'contract',
      departmentId: DEPT,
    });
    expect(merged).toEqual({
      title: 'Requisition title', description: 'Fictional description', jobGradeIds: [G2], workLocation: 'Penang', recruitmentType: 'replacement',
      employmentType: 'contract', departmentId: DEPT, businessUnitId: BU, processId: PROC, interviewPlan: [FORM1, FORM2], custom: draft.custom,
    });
  });
  it('an empty requisition value never blanks the template\'s', () => {
    const { draft } = resolveTemplate(template(), available);
    const merged = mergeRequisition(draft, { title: '  ', description: '', jobGradeIds: [], workLocation: '', recruitmentType: '', employmentType: '', departmentId: null });
    expect(merged).toMatchObject({ title: 'Fictional payroll analyst', description: 'Fictional description', jobGradeIds: [G1, G2], workLocation: 'Kuala Lumpur',
      recruitmentType: 'budgeted', employmentType: 'full_time', departmentId: DEPT });
  });
});

describe('5716 static shape', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  const migration = read('db/migrations/5716_recruitment_position_templates.sql');
  const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
  it('is journalled once at idx 5116 / when 1793330005416, right after 5715', () => {
    const at = journal.entries.findIndex((e) => e.tag === '5716_recruitment_position_templates');
    expect(journal.entries.filter((e) => e.tag === '5716_recruitment_position_templates')).toEqual([expect.objectContaining({ idx: 5116, when: 1793330005416 })]);
    expect(journal.entries[at - 1]).toEqual(expect.objectContaining({ tag: '5715_recruitment_custom_fields', idx: 5115, when: 1793330005415 }));
  });
  it('forces row security on its tables, grants nothing to PUBLIC and does not restate the candidate removal', () => {
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, ai_hr_app/);
    expect(migration).not.toMatch(/TO PUBLIC/);
    expect(migration).not.toMatch(/FUNCTION app\.recruitment_destroy_candidate/);
    expect(migration).toMatch(/ON DELETE SET NULL \(created_from_template_id\)/);
  });
});
