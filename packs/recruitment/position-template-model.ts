/**
 * Recruitment slice 15 — position templates: the pure rules (docs/recruitment-reconstruction/specification.md "Slice 15").
 * Deterministic and client-safe: no database, no clock, no model. ./position-templates runs every template write through
 * validateTemplateInput and every "New position from template" through resolveTemplate (and mergeRequisition for a requisition's
 * "Create job"); 5216's guards refuse the same references independently.
 *
 * A template is a STARTING POINT, never a link: resolving copies what is still usable into a draft of the ordinary new-position
 * form, and the person edits it before saving through the normal job rules. Whatever has since been disabled or removed — the
 * process, the department, the business unit, a job level, a round's scorecard template, a custom field, or a chosen option — is
 * left empty and named in a plain note; it is never copied.
 */
import { JOB_EMPLOYMENT_TYPES, RECRUITMENT_TYPES, isUuid, parseInterviewPlan, type JobEmploymentType, type RecruitmentType } from './model';
import { formValue, validateCustomValues, type FieldRule, type TypedValue } from './custom-field-model';

/** The longest template name, and the most templates a company keeps. */
export const POSITION_TEMPLATE_NAME_MAX = 120;
export const POSITION_TEMPLATES_MAX = 200;

/** A template as an administrator's form sends it. Everything arrives as untrusted text. */
export type TemplateInput = {
  name?: unknown; title?: unknown; description?: unknown; workLocation?: unknown; employmentType?: unknown; recruitmentType?: unknown;
  jobGradeIds?: unknown; businessUnitId?: unknown; departmentId?: unknown; processId?: unknown; interviewPlanFormIds?: unknown; enabled?: unknown;
};
export type ValidTemplate = {
  name: string; title: string; description: string | null; workLocation: string | null; employmentType: JobEmploymentType | null;
  recruitmentType: RecruitmentType | null; jobGradeIds: string[]; businessUnitId: string | null; departmentId: string | null; processId: string | null;
  interviewPlanFormIds: string[]; enabled: boolean;
};

const text = (value: unknown, max: number): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return null;
  return t.length <= max ? t : undefined;
};
const optionalId = (value: unknown): string | null | undefined => (value == null || value === '' ? null : isUuid(value) ? value : undefined);
const optionalMember = <T extends string>(set: readonly T[], value: unknown): T | null | undefined =>
  value == null || value === '' ? null : typeof value === 'string' && (set as readonly string[]).includes(value) ? (value as T) : undefined;
const flag = (value: unknown) => value === true || value === 'on' || value === 'true';

/**
 * Check a template. The name (≤120) and the job title (≤200) are required; every other field is optional and, when given, must be
 * of the job form's kind (description ≤20,000, work location ≤200, a known employment and recruitment type, up to 50 job levels,
 * ids for the business unit, department and process, an interview plan of at most INTERVIEW_PLAN_MAX rounds). Whether the
 * referenced items are the company's and usable is the service's and the database's check.
 */
export function validateTemplateInput(input: TemplateInput): { ok: true; value: ValidTemplate } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const name = text(input.name, POSITION_TEMPLATE_NAME_MAX);
  const title = text(input.title, 200);
  const missing = [...(name === null ? ['name'] : []), ...(title === null ? ['title'] : [])];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const invalid: string[] = [];
  if (name === undefined) invalid.push('name');
  if (title === undefined) invalid.push('title');
  const description = input.description == null || input.description === '' ? null
    : typeof input.description === 'string' && input.description.length <= 20000 ? (input.description.trim() ? input.description : null) : undefined;
  if (description === undefined) invalid.push('description');
  const workLocation = text(input.workLocation, 200);
  if (workLocation === undefined) invalid.push('workLocation');
  const employmentType = optionalMember(JOB_EMPLOYMENT_TYPES, input.employmentType);
  if (employmentType === undefined) invalid.push('employmentType');
  const recruitmentType = optionalMember(RECRUITMENT_TYPES, input.recruitmentType);
  if (recruitmentType === undefined) invalid.push('recruitmentType');
  const grades = (Array.isArray(input.jobGradeIds) ? input.jobGradeIds : input.jobGradeIds == null || input.jobGradeIds === '' ? [] : [input.jobGradeIds])
    .filter((id) => id !== '');
  const jobGradeIds = [...new Set(grades)];
  if (jobGradeIds.length > 50 || !jobGradeIds.every(isUuid)) invalid.push('jobLevel');
  const refs = { businessUnitId: optionalId(input.businessUnitId), departmentId: optionalId(input.departmentId), processId: optionalId(input.processId) };
  for (const [key, value] of Object.entries(refs)) if (value === undefined) invalid.push(key);
  const plan = parseInterviewPlan(input.interviewPlanFormIds);
  if (plan === null) invalid.push('interviewPlan');
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return {
    ok: true,
    value: {
      name: name!, title: title!, description: description ?? null, workLocation: workLocation ?? null, employmentType: employmentType ?? null,
      recruitmentType: recruitmentType ?? null, jobGradeIds: jobGradeIds as string[], businessUnitId: refs.businessUnitId ?? null,
      departmentId: refs.departmentId ?? null, processId: refs.processId ?? null, interviewPlanFormIds: plan!, enabled: input.enabled === undefined ? true : flag(input.enabled),
    },
  };
}

/** A stored template, as the resolver reads it. */
export type TemplateRecord = {
  title: string; description: string | null; workLocation: string | null; employmentType: JobEmploymentType | null; recruitmentType: RecruitmentType | null;
  jobGradeIds: readonly string[]; businessUnitId: string | null; departmentId: string | null; processId: string | null;
  interviewPlanFormIds: readonly string[];
  /** The template's custom job field values, by field id. */
  values: ReadonlyMap<string, TypedValue>;
};

/** What the company offers NOW: enabled processes, live job levels offered to it, its live (or global) departments and business
 *  units, enabled evaluation forms, and its enabled custom job fields with their ENABLED options. */
export type TemplateAvailability = {
  processIds: ReadonlySet<string>; gradeIds: ReadonlySet<string>; departmentIds: ReadonlySet<string>; businessUnitIds: ReadonlySet<string>;
  formIds: ReadonlySet<string>; fields: readonly FieldRule[];
};

/** A plain note about something the template named that is no longer usable (left empty in the draft). */
export type TemplateNote =
  | { kind: 'process' } | { kind: 'department' } | { kind: 'businessUnit' }
  | { kind: 'jobLevels'; count: number }
  | { kind: 'interviewRound'; round: number }
  /** A value of a field that is still enabled no longer fits it (a disabled or removed option, a narrowed range): left empty. */
  | { kind: 'customValue'; fieldId: string }
  /** Values of fields that are now disabled, removed or of another type: not copied. */
  | { kind: 'customFields'; count: number };

/** The new-position form's starting values. `interviewPlan` keeps the template's rounds; a round whose scorecard template is no
 *  longer usable is null (an empty choice the person fills or leaves out). */
export type PositionDraft = {
  title: string; description: string | null; workLocation: string | null; employmentType: JobEmploymentType | null; recruitmentType: RecruitmentType | null;
  jobGradeIds: string[]; businessUnitId: string | null; departmentId: string | null; processId: string | null;
  interviewPlan: (string | null)[]; custom: Map<string, TypedValue>;
};

/**
 * The draft a template opens as, with a note for every part left empty. Nothing that is no longer usable is copied: a disabled
 * or removed process, department or business unit is left empty; archived or withdrawn job levels are left out; a round whose
 * scorecard template is disabled or removed stays as an empty round; a custom value is copied only for an ENABLED job field of the
 * same type and only if it passes slice 14's value rules today (options must be enabled; a number must fit the current range and
 * decimals) — a multiple choice keeps its still-enabled options.
 */
export function resolveTemplate(t: TemplateRecord, a: TemplateAvailability): { draft: PositionDraft; notes: TemplateNote[] } {
  const notes: TemplateNote[] = [];
  const keep = (id: string | null, set: ReadonlySet<string>, kind: 'process' | 'department' | 'businessUnit') => {
    if (id == null) return null;
    if (set.has(id)) return id;
    notes.push({ kind });
    return null;
  };
  const processId = keep(t.processId, a.processIds, 'process');
  const departmentId = keep(t.departmentId, a.departmentIds, 'department');
  const businessUnitId = keep(t.businessUnitId, a.businessUnitIds, 'businessUnit');
  const jobGradeIds = t.jobGradeIds.filter((id) => a.gradeIds.has(id));
  if (jobGradeIds.length < t.jobGradeIds.length) notes.push({ kind: 'jobLevels', count: t.jobGradeIds.length - jobGradeIds.length });
  const interviewPlan = t.interviewPlanFormIds.map((id, i) => {
    if (a.formIds.has(id)) return id;
    notes.push({ kind: 'interviewRound', round: i + 1 });
    return null;
  });
  const custom = new Map<string, TypedValue>();
  let dropped = 0;
  for (const [fieldId, value] of t.values) {
    const f = a.fields.find((x) => x.id === fieldId && x.enabled);
    if (!f || f.type !== value.type) { dropped++; continue; }
    let raw = formValue(value);
    if (Array.isArray(raw)) {
      const usable = raw.filter((id) => f.options.some((o) => o.id === id && o.enabled));
      if (usable.length < raw.length) notes.push({ kind: 'customValue', fieldId });
      raw = usable;
      if (!raw.length) continue;
    }
    const v = validateCustomValues([{ ...f, required: false }], { [fieldId]: raw });
    const next = v.ok ? v.values.get(fieldId) ?? null : null;
    if (next) custom.set(fieldId, next);
    else if (!notes.some((n) => n.kind === 'customValue' && n.fieldId === fieldId)) notes.push({ kind: 'customValue', fieldId });
  }
  if (dropped) notes.push({ kind: 'customFields', count: dropped });
  return {
    draft: {
      title: t.title, description: t.description, workLocation: t.workLocation, employmentType: t.employmentType, recruitmentType: t.recruitmentType,
      jobGradeIds, businessUnitId, departmentId, processId, interviewPlan, custom,
    },
    notes,
  };
}

/** A requisition's job values (slice 4 "Create job"). */
export type RequisitionValues = {
  title: string; description: string | null; jobGradeIds: readonly string[]; workLocation: string; recruitmentType: string; employmentType: string;
  departmentId: string | null;
};

const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null);

/**
 * "Create job" from a requisition, started from a template: the REQUISITION's value wins wherever it has one (title, description,
 * job levels, work location, recruitment and employment type, department — vacancies are the requisition's own and never a job
 * field); the template fills only what the requisition leaves empty, and everything a requisition does not carry (business unit,
 * process, interview plan, custom job fields) comes from the template.
 */
export function mergeRequisition(draft: PositionDraft, r: RequisitionValues): PositionDraft {
  const pick = <T>(req: T, tpl: T): T => (filled(req) ? req : tpl);
  return {
    ...draft,
    title: pick(r.title, draft.title),
    description: pick(r.description, draft.description),
    jobGradeIds: [...pick(r.jobGradeIds, draft.jobGradeIds)],
    workLocation: pick<string | null>(r.workLocation, draft.workLocation),
    recruitmentType: (filled(r.recruitmentType) && (RECRUITMENT_TYPES as readonly string[]).includes(r.recruitmentType) ? r.recruitmentType : draft.recruitmentType) as RecruitmentType | null,
    employmentType: (filled(r.employmentType) && (JOB_EMPLOYMENT_TYPES as readonly string[]).includes(r.employmentType) ? r.employmentType : draft.employmentType) as JobEmploymentType | null,
    departmentId: pick(r.departmentId, draft.departmentId),
  };
}
