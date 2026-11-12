/**
 * Recruitment slice 15 — position templates (docs/recruitment-reconstruction/specification.md "Slice 15"). Reached from outside the
 * pack ONLY through ./service.
 *
 * Recruitment administrators keep their company's templates under Settings › Position templates and turn the feature on or off
 * for the company (5216 row security admits administrators only; the service checks first for a clear refusal). Everyone who may
 * create a position — today exactly those administrators (slice 1) — starts "New position from template" from the company's
 * ENABLED templates while the feature is on. The template opens as a pre-filled DRAFT of the ordinary new-position form (nothing is
 * saved here): whatever the template names that has since been disabled or removed is left empty with a plain note
 * (./position-template-model resolveTemplate), and a requisition's "Create job" merges its own values over the template's
 * (mergeRequisition). Saving goes through the normal createJob, which records the template id and nothing else (no link: later
 * template edits change no position). There is no industry JD library (D-054). Templates hold no personal data. Events carry ids
 * and flags only. Read paths write nothing.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type JobEmploymentType, type RecruitmentType } from './model';
import { customInputName, validateCustomValues, type FieldRule, type RawCustomValues, type TypedValue } from './custom-field-model';
import type { CustomFieldView } from './custom-field-store';
import { actorId, assertCompanyTx, jobFormOptionsTx, userLabelsTx, uuidArray, type JobFormOptions } from './data';
import { requisitionJobPrefillTx } from './requisitions';
import {
  POSITION_TEMPLATES_MAX, mergeRequisition, resolveTemplate, validateTemplateInput,
  type PositionDraft, type TemplateAvailability, type TemplateInput, type TemplateNote, type TemplateRecord,
} from './position-template-model';

const iso = (d: Date | string) => new Date(d).toISOString();
const templateEvent = (tx: Tx, s: SessionContext, templateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-position-template', aggregateId: templateId, eventType, actor: actorOf(s), payload });

const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};
/** A database refusal of a template write, as the service's code (never SQL or a bound value). */
const asError = (e: unknown): never => {
  const named = constraintOf(e) ?? '';
  const code = pgSqlState(e);
  if (code === '23505' && named === 'recruitment_position_template_name_uq') throw new RecruitmentError('name_taken');
  if (named === 'recruitment_position_template_reference') throw new RecruitmentError('invalid_input');
  if (/^recruitment_custom_(field_disabled|value_range|option_disabled)$/.test(named) || named === 'recruitment_position_template_value_typed_ck') {
    throw new RecruitmentError('custom_value_invalid');
  }
  if (code === '42501') throw new RecruitmentError('forbidden');
  throw e;
};

// ── Reading a template ──────────────────────────────────────────────────────────────────────────────────────

type TemplateRow = {
  id: string; company_id: string; name: string; title: string; description: string | null; work_location: string | null;
  employment_type: JobEmploymentType | null; recruitment_type: RecruitmentType | null; job_grade_ids: string[]; business_unit_id: string | null;
  department_id: string | null; process_id: string | null; interview_plan_form_ids: string[]; enabled: boolean;
  updated_by_user_id: string; updated_at: string | Date;
};
const templateColumns = sql`id, company_id, name, title, description, work_location, employment_type, recruitment_type, job_grade_ids, business_unit_id,
  department_id, process_id, interview_plan_form_ids, enabled, updated_by_user_id, updated_at`;

/** The template (visible to the caller: an administrator of its company), or not_found. */
async function templateRowTx(tx: Tx, s: SessionContext, templateId: unknown, forUpdate = false): Promise<TemplateRow> {
  if (!isUuid(templateId)) throw new RecruitmentError('not_found');
  const [row] = await tx.execute<TemplateRow>(sql`select ${templateColumns} from recruitment_position_template
    where id = ${templateId}::uuid and tenant_id = ${s.tenantId}::uuid ${forUpdate ? sql`for update` : sql``}`);
  if (!row) throw new RecruitmentError('not_found');
  return row;
}

type ValueRow = { field_id: string; field_type: TypedValue['type']; text_value: string | null; number_value: string | null; date_value: string | null;
  bool_value: boolean | null; option_id: string | null };
/** The template's stored custom values, typed (one per field; a multiple choice's options in one value). */
async function templateValuesTx(tx: Tx, templateId: string): Promise<Map<string, TypedValue>> {
  const rows = await tx.execute<ValueRow>(sql`select field_id, field_type, text_value, number_value::text as number_value,
    to_char(date_value, 'YYYY-MM-DD') as date_value, bool_value, option_id from recruitment_position_template_value
    where template_id = ${templateId}::uuid order by field_id, option_id`);
  const out = new Map<string, TypedValue>();
  for (const r of rows) {
    const t = r.field_type;
    if (t === 'single_choice' || t === 'multiple_choice') {
      const before = out.get(r.field_id);
      out.set(r.field_id, { type: t, optionIds: [...(before && 'optionIds' in before ? before.optionIds : []), r.option_id!] });
    } else if (t === 'short_text' || t === 'long_text') out.set(r.field_id, { type: t, text: r.text_value! });
    else if (t === 'number') out.set(r.field_id, { type: t, number: r.number_value! });
    else if (t === 'date' || t === 'year_month') out.set(r.field_id, { type: t, date: r.date_value! });
    else out.set(r.field_id, { type: 'yes_no', bool: r.bool_value! });
  }
  return out;
}

const recordOf = (t: TemplateRow, values: Map<string, TypedValue>): TemplateRecord => ({
  title: t.title, description: t.description, workLocation: t.work_location, employmentType: t.employment_type, recruitmentType: t.recruitment_type,
  jobGradeIds: t.job_grade_ids, businessUnitId: t.business_unit_id, departmentId: t.department_id, processId: t.process_id,
  interviewPlanFormIds: t.interview_plan_form_ids, values,
});

/** Custom job fields as the value rules see them (enabled fields; their ENABLED options only). */
const rulesOf = (fields: readonly CustomFieldView[]): FieldRule[] => fields.map((f) => ({
  id: f.id, type: f.type, required: false, enabled: true, numberMin: f.numberMin, numberMax: f.numberMax, numberDecimals: f.numberDecimals,
  options: f.options.filter((o) => o.enabled).map((o) => ({ id: o.id, enabled: true })),
}));

/** What the company offers now, from the job form's own lists (the same ones the new-position form shows). */
const availabilityOf = (o: JobFormOptions): TemplateAvailability => ({
  processIds: new Set(o.processes.filter((p) => p.enabled).map((p) => p.id)), gradeIds: new Set(o.grades.map((g) => g.id)),
  departmentIds: new Set(o.departments.map((d) => d.id)), businessUnitIds: new Set(o.businessUnits.map((b) => b.id)),
  formIds: new Set(o.forms.filter((f) => f.enabled).map((f) => f.id)), fields: rulesOf(o.customFields),
});

/** The company's "position templates" setting (default off). */
async function templatesOnTx(tx: Tx, s: SessionContext, companyId: string): Promise<boolean> {
  const [row] = await tx.execute<{ on: boolean }>(sql`select position_templates_enabled as on from recruitment_company_setting
    where company_id = ${companyId}::uuid and tenant_id = ${s.tenantId}::uuid`);
  return row?.on === true;
}

// ── Settings › Position templates ──────────────────────────────────────────────────────────────────────────

export type PositionTemplateRow = {
  id: string; name: string; title: string; enabled: boolean; processName: string | null; rounds: number; customValues: number;
  /** Positions created from this template (reporting; none stays linked). */
  positions: number; updatedBy: string | null; updatedAt: string;
};
export type PositionTemplateSettings = { companyId: string; on: boolean; templates: PositionTemplateRow[] };

/** Settings › Position templates: the company setting and every template (enabled and disabled), by name. Administrators only. */
export async function positionTemplateSettings(s: SessionContext, companyId: string): Promise<PositionTemplateSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<TemplateRow & { process_name: string | null; value_count: number; positions: number }>(sql`
      select t.id, t.company_id, t.name, t.title, t.enabled, t.interview_plan_form_ids, t.updated_by_user_id, t.updated_at, p.name as process_name,
        (select count(distinct v.field_id)::int from recruitment_position_template_value v where v.template_id = t.id) as value_count,
        (select count(*)::int from recruitment_job_opening j where j.created_from_template_id = t.id) as positions
      from recruitment_position_template t left join recruitment_process p on p.id = t.process_id and p.company_id = t.company_id
      where t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${companyId}::uuid
      order by lower(t.name), t.id`);
    const labels = rows.length ? await userLabelsTx(tx, companyId) : new Map();
    return {
      companyId, on: await templatesOnTx(tx, s, companyId),
      templates: rows.map((r) => ({
        id: r.id, name: r.name, title: r.title, enabled: r.enabled, processName: r.process_name, rounds: r.interview_plan_form_ids.length,
        customValues: r.value_count, positions: r.positions, updatedBy: labels.get(r.updated_by_user_id)?.name ?? null, updatedAt: iso(r.updated_at),
      })),
    };
  });
}

/** A template opened for editing or as a new position: the draft, its notes, and the job form's lists and custom fields (filled). */
export type TemplateDraftView = {
  draft: Omit<PositionDraft, 'custom'>; notes: TemplateNote[];
  /** The company's enabled custom job fields with the draft's values. */
  custom: CustomFieldView[];
  options: JobFormOptions;
};
const draftView = (draft: PositionDraft, notes: TemplateNote[], options: JobFormOptions): TemplateDraftView => {
  const { custom, ...rest } = draft;
  return { draft: rest, notes, options, custom: options.customFields.map((f) => ({ ...f, value: custom.get(f.id) ?? null })) };
};

export type PositionTemplateEditor = TemplateDraftView & { companyId: string; template: { id: string; name: string; enabled: boolean } | null };

/**
 * The template form (administrators): a new template (no id) or an existing one, opened like a new position — references that are
 * no longer usable are left empty with a note, so saving the form stores only usable ones. Read-only.
 */
export async function positionTemplateEditor(s: SessionContext, companyId: string, templateId?: unknown): Promise<PositionTemplateEditor> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const options = await jobFormOptionsTx(tx, s, companyId);
    if (templateId == null || templateId === '' || templateId === 'new') {
      const empty: PositionDraft = { title: '', description: null, workLocation: null, employmentType: null, recruitmentType: null, jobGradeIds: [],
        businessUnitId: null, departmentId: null, processId: null, interviewPlan: [], custom: new Map() };
      return { companyId, template: null, ...draftView(empty, [], options) };
    }
    const t = await templateRowTx(tx, s, templateId);
    if (t.company_id !== companyId) throw new RecruitmentError('not_found');
    const { draft, notes } = resolveTemplate(recordOf(t, await templateValuesTx(tx, t.id)), availabilityOf(options));
    return { companyId, template: { id: t.id, name: t.name, enabled: t.enabled }, ...draftView(draft, notes, options) };
  });
}

/**
 * Create (with `companyId`) or edit (with `id`) a template: name (unique in the company, ≤120) and title required; the job form's
 * other fields, the process, the interview plan and custom job field values optional. A reference that is set or changed must be
 * the company's and usable now; one left as it was may since have been disabled (5216 checks the same). Custom values follow slice
 * 14's value rules without "required" (a template may leave any field empty) and are replaced as a whole when the form carried
 * them. At most POSITION_TEMPLATES_MAX templates per company. Administrators only.
 */
export async function savePositionTemplate(s: SessionContext, input: TemplateInput & { id?: unknown; companyId?: unknown; custom?: RawCustomValues }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateTemplateInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const val = v.value;
  return withRecruitmentTenant(s, async (tx) => {
    const existing = input.id !== undefined && input.id !== '' ? await templateRowTx(tx, s, input.id) : null;
    const companyId = existing?.company_id ?? (typeof input.companyId === 'string' ? input.companyId : '');
    await assertCompanyTx(tx, companyId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recruitment-position-templates:${s.tenantId}:${companyId}`}, 0))`);
    const current = existing ? await templateRowTx(tx, s, existing.id, true) : null;
    const options = await jobFormOptionsTx(tx, s, companyId);
    const a = availabilityOf(options);
    // Set or changed references must be usable now (the field names match the form's).
    const bad: string[] = [];
    const changed = (next: string, before: string | null | undefined) => current === null || next !== before;
    if (val.processId && changed(val.processId, current?.process_id) && !a.processIds.has(val.processId)) bad.push('processId');
    if (val.departmentId && changed(val.departmentId, current?.department_id) && !a.departmentIds.has(val.departmentId)) bad.push('departmentId');
    if (val.businessUnitId && changed(val.businessUnitId, current?.business_unit_id) && !a.businessUnitIds.has(val.businessUnitId)) bad.push('businessUnitId');
    if (val.jobGradeIds.some((id) => !(current?.job_grade_ids ?? []).includes(id) && !a.gradeIds.has(id))) bad.push('jobLevel');
    if (val.interviewPlanFormIds.some((id) => !(current?.interview_plan_form_ids ?? []).includes(id) && !a.formIds.has(id))) bad.push('interviewPlan');
    if (bad.length) throw new RecruitmentError('invalid_input', bad);
    let values: Map<string, TypedValue | null> | null = null;
    if (input.custom) {
      const checked = validateCustomValues(a.fields, input.custom);
      if (!checked.ok) throw new RecruitmentError(checked.code, checked.fields.map((id) => customInputName(id)));
      values = checked.values;
    }
    let id: string;
    if (current) {
      id = current.id;
      await tx.execute(sql`update recruitment_position_template set name = ${val.name}, title = ${val.title}, description = ${val.description},
        work_location = ${val.workLocation}, employment_type = ${val.employmentType}, recruitment_type = ${val.recruitmentType},
        job_grade_ids = ${uuidArray(val.jobGradeIds)}::uuid[], business_unit_id = ${val.businessUnitId}::uuid, department_id = ${val.departmentId}::uuid,
        process_id = ${val.processId}::uuid, interview_plan_form_ids = ${uuidArray(val.interviewPlanFormIds)}::uuid[], enabled = ${val.enabled},
        updated_by_user_id = ${user}::uuid
        where id = ${id}::uuid`).catch(asError);
    } else {
      const [count] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_position_template
        where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`);
      if ((count?.n ?? 0) >= POSITION_TEMPLATES_MAX) throw new RecruitmentError('template_limit');
      const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_position_template (tenant_id, company_id, name, title, description,
          work_location, employment_type, recruitment_type, job_grade_ids, business_unit_id, department_id, process_id, interview_plan_form_ids, enabled,
          created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${companyId}::uuid, ${val.name}, ${val.title}, ${val.description}, ${val.workLocation}, ${val.employmentType},
          ${val.recruitmentType}, ${uuidArray(val.jobGradeIds)}::uuid[], ${val.businessUnitId}::uuid, ${val.departmentId}::uuid, ${val.processId}::uuid,
          ${uuidArray(val.interviewPlanFormIds)}::uuid[], ${val.enabled}, ${user}::uuid, ${user}::uuid)
        returning id`).catch(asError);
      id = row.id;
    }
    let fieldIds: string[] = [];
    if (values) {
      await tx.execute(sql`delete from recruitment_position_template_value where template_id = ${id}::uuid`).catch(asError);
      for (const f of a.fields) {
        const next = values.get(f.id);
        if (!next) continue;
        const rows = 'optionIds' in next
          ? next.optionIds.map((o) => sql`(${o}::uuid, null::text, null::numeric, null::date, null::boolean)`)
          : [sql`(null::uuid, ${'text' in next ? next.text : null}::text, ${'number' in next ? next.number : null}::numeric,
              ${'date' in next ? next.date : null}::date, ${'bool' in next ? next.bool : null}::boolean)`];
        await tx.execute(sql`insert into recruitment_position_template_value (tenant_id, company_id, template_id, field_id, field_type, option_id, text_value,
            number_value, date_value, bool_value, updated_by_user_id)
          select ${s.tenantId}::uuid, ${companyId}::uuid, ${id}::uuid, ${f.id}::uuid, ${f.type}, x.o, x.t, x.n, x.d, x.b, ${user}::uuid
          from (values ${sql.join(rows, sql`, `)}) as x(o, t, n, d, b)`).catch(asError);
      }
      fieldIds = a.fields.filter((f) => values!.get(f.id)).map((f) => f.id);
    }
    await templateEvent(tx, s, id, current ? 'recruitment-position-template.changed' : 'recruitment-position-template.created', {
      companyId, enabled: val.enabled, processId: val.processId, rounds: val.interviewPlanFormIds.length, ...(values ? { customFieldIds: fieldIds } : {}),
    });
    return { id };
  });
}

/** Enable or disable a template (a disabled one is kept but not offered for new positions). Administrators only. */
export async function setPositionTemplateEnabled(s: SessionContext, templateId: unknown, enabled: unknown): Promise<void> {
  const user = actorId(s);
  const on = enabled === true || enabled === 'on' || enabled === 'true';
  await withRecruitmentTenant(s, async (tx) => {
    const t = await templateRowTx(tx, s, templateId);
    await assertCompanyTx(tx, t.company_id);
    await tx.execute(sql`update recruitment_position_template set enabled = ${on}, updated_by_user_id = ${user}::uuid where id = ${t.id}::uuid`).catch(asError);
    await templateEvent(tx, s, t.id, on ? 'recruitment-position-template.enabled' : 'recruitment-position-template.disabled', { companyId: t.company_id });
  });
}

/** Delete a template and its values. Positions created from it keep everything they were saved with; only their record of which
 *  template they came from is cleared (5216's foreign key). Administrators only. */
export async function deletePositionTemplate(s: SessionContext, templateId: unknown): Promise<void> {
  actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const t = await templateRowTx(tx, s, templateId);
    await assertCompanyTx(tx, t.company_id);
    await tx.execute(sql`delete from recruitment_position_template where id = ${t.id}::uuid`).catch(asError);
    await templateEvent(tx, s, t.id, 'recruitment-position-template.deleted', { companyId: t.company_id });
  });
}

/** Turn "New position from template" on or off for the company. Templates are kept either way. Administrators only. */
export async function updatePositionTemplateSetting(s: SessionContext, companyId: unknown, enabled: unknown): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const user = actorId(s);
  const on = enabled === true || enabled === 'on' || enabled === 'true';
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const before = await templatesOnTx(tx, s, companyId);
    await tx.execute(sql`insert into recruitment_company_setting (company_id, tenant_id, created_by_user_id, updated_by_user_id)
      values (${companyId}::uuid, ${s.tenantId}::uuid, ${user}::uuid, ${user}::uuid) on conflict do nothing`);
    await tx.execute(sql`update recruitment_company_setting set position_templates_enabled = ${on}, updated_at = now(), updated_by_user_id = ${user}::uuid
      where company_id = ${companyId}::uuid`);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-setting.templates-updated',
      actor: actorOf(s), payload: { companyId, before: { on: before }, after: { on } } });
  });
}

// ── New position from template ─────────────────────────────────────────────────────────────────────────────

export type PositionTemplateChoices = { on: boolean; templates: { id: string; name: string; title: string }[] };

/** The templates "New position from template" offers in the company: its ENABLED ones while the setting is on (none otherwise),
 *  for whoever may create a position there. Read-only. */
export async function positionTemplateChoicesTx(tx: Tx, s: SessionContext, companyId: string): Promise<PositionTemplateChoices> {
  await assertCompanyTx(tx, companyId);
  if (!(await templatesOnTx(tx, s, companyId))) return { on: false, templates: [] };
  const rows = await tx.execute<{ id: string; name: string; title: string }>(sql`select id, name, title from recruitment_position_template
    where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and enabled order by lower(name), id`);
  return { on: true, templates: [...rows] };
}
export async function positionTemplateChoices(s: SessionContext, companyId: string): Promise<PositionTemplateChoices> {
  return withRecruitmentTenant(s, (tx) => positionTemplateChoicesTx(tx, s, companyId));
}

export type PositionFromTemplate = TemplateDraftView & {
  templateId: string; templateName: string; companyId: string;
  /** "Create job" from a requisition: its values won over the template's. */
  requisition: { id: string; reqNumber: string; recruiterUserId: string | null } | null;
};

export type NewPositionFromTemplateOptions = {
  /** "Create job" from this requisition (same company). */
  requisitionId?: unknown;
  /** The companies of the viewer's current scope: a template of a company outside it is unavailable here, even to a group-wide
   *  administrator (the page then never shows another company's form under the scoped one). */
  scopeCompanyIds?: readonly string[];
};

/**
 * "New position from template": the company's ENABLED template (while the setting is on) as a pre-filled draft of the new-position
 * form, NOT saved. Parts that are no longer usable are left empty with notes. With `requisitionId` ("Create job" from a
 * requisition of the same company), the requisition's values win where both have one. Refuses `template_unavailable` for a
 * disabled, deleted, other company's or out-of-scope template or when the feature is off; a closed requisition keeps its own
 * refusal (`requisition_terminal`). Read-only.
 */
export async function newPositionFromTemplateTx(tx: Tx, s: SessionContext, templateId: unknown, opts: NewPositionFromTemplateOptions = {}): Promise<PositionFromTemplate> {
  if (!isUuid(templateId)) throw new RecruitmentError('template_unavailable');
  const [visible] = await tx.execute<{ company_id: string }>(sql`select company_id from recruitment_position_template
    where id = ${templateId}::uuid and tenant_id = ${s.tenantId}::uuid`);
  if (!visible || (opts.scopeCompanyIds && !opts.scopeCompanyIds.includes(visible.company_id))) throw new RecruitmentError('template_unavailable');
  await assertCompanyTx(tx, visible.company_id);
  const t = await templateRowTx(tx, s, templateId);
  if (!t.enabled || !(await templatesOnTx(tx, s, t.company_id))) throw new RecruitmentError('template_unavailable');
  const options = await jobFormOptionsTx(tx, s, t.company_id);
  const resolved = resolveTemplate(recordOf(t, await templateValuesTx(tx, t.id)), availabilityOf(options));
  let draft = resolved.draft;
  let requisition: PositionFromTemplate['requisition'] = null;
  if (opts.requisitionId != null && opts.requisitionId !== '') {
    const r = await requisitionJobPrefillTx(tx, s, opts.requisitionId);
    if (r.companyId !== t.company_id) throw new RecruitmentError('template_unavailable');
    draft = mergeRequisition(draft, r.values);
    requisition = { id: r.requisitionId, reqNumber: r.reqNumber, recruiterUserId: r.recruiterUserId };
  }
  return { templateId: t.id, templateName: t.name, companyId: t.company_id, requisition, ...draftView(draft, resolved.notes, options) };
}
export async function newPositionFromTemplate(s: SessionContext, templateId: unknown, opts: NewPositionFromTemplateOptions = {}): Promise<PositionFromTemplate> {
  return withRecruitmentTenant(s, (tx) => newPositionFromTemplateTx(tx, s, templateId, opts));
}
