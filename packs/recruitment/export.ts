/**
 * Recruitment slice 16 — list exports and saved column sets. Reached from outside the pack ONLY through ./service.
 *
 * Who: the Candidates board and a job's interview feedback for recruitment administrators and the company's recruiters and
 * assistants (operators); the talent pool for those who may open it (slice 4: administrators). Every value comes from a read under
 * the exporter's own row security in ONE READ ONLY transaction with its own statement timeout — the same rows they read on screen;
 * restricted values (slice 5) and restricted custom fields (slice 14) are read from their restricted tables, which return nothing
 * for anyone who may not read them, so such a cell is simply empty. At most EXPORT_MAX_ROWS rows (the read asks for one more to
 * know). Then one short transaction appends the audit event — who (the actor), the kind, a summary of the filters as ids and keys,
 * the format, the column count and the row count, never a value. The file is generated on request and not stored.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { RecruitmentError, isUuid, type ApplicationState } from './model';
import { pgSqlState } from '../../lib/db-error';
import { assertCompanyTx, jobTx, userLabelsTx, uuidArray } from './data';
import { customFilterChoicesTx, customFilterSql, labelsOf } from './custom-field-store';
import { CUSTOM_FIELD_LOCALES, labelFor, type CustomFieldType } from './custom-field-model';
import { assertOperatesCompanyTx } from './import';
import type { EvaluationFormDefinition } from './hiring-model';
import {
  EXPORT_COLUMNS, EXPORT_MAX_ROWS, EXPORT_TEMPLATES_MAX, assertExportSize, chooseExportColumns, customColumnField, isCustomColumn, isExportKind,
  validateExportTemplate, type ExportCell, type ExportFormat, type ExportKind,
} from './export-model';

/** Statement timeout of an export read: a large company's 10,000 rows read well inside it; a pathological filter stops here. */
export const EXPORT_TIMEOUT_MS = 20_000;
export type ExportTable = { kind: ExportKind; columns: string[]; customLabels: Record<string, string>; rows: ExportCell[][] };

const labelCols = sql.raw(CUSTOM_FIELD_LOCALES.map((l) => `label_${l}`).join(', '));
type LabelRow = Record<`label_${(typeof CUSTOM_FIELD_LOCALES)[number]}`, string | null>;
type FieldDef = { id: string; type: CustomFieldType; label: string; options: Map<string, string> };
/** The custom candidate fields the exporter may see (restricted definitions only for operators: 5215), enabled, with option labels. */
async function customDefsTx(tx: Tx, s: SessionContext, companyIds: readonly string[], locale: string): Promise<FieldDef[]> {
  if (!companyIds.length) return [];
  const fields = await tx.execute<LabelRow & { id: string; field_type: CustomFieldType }>(sql`select id, field_type, ${labelCols} from recruitment_custom_field
    where tenant_id = ${s.tenantId}::uuid and company_id = any(${uuidArray(companyIds)}::uuid[]) and record_kind = 'candidate' and enabled
    order by company_id, position, lower(label_en), id`);
  const options = fields.length ? await tx.execute<LabelRow & { id: string; field_id: string }>(sql`select id, field_id, ${labelCols} from recruitment_custom_field_option
    where field_id = any(${uuidArray(fields.map((f) => f.id))}::uuid[])`) : [];
  return fields.map((f) => ({ id: f.id, type: f.field_type, label: labelFor(labelsOf(f), locale),
    options: new Map(options.filter((o) => o.field_id === f.id).map((o) => [o.id, labelFor(labelsOf(o), locale)])) }));
}

/** The columns an exporter may choose for a list (fixed, then the custom candidate fields they may see). Read-only. */
export async function exportColumnChoices(s: SessionContext, companyIds: readonly string[], kind: ExportKind, locale: string): Promise<{ fixed: string[]; custom: { key: string; label: string }[] }> {
  const fixed = EXPORT_COLUMNS[kind].map(([k]) => k);
  if (kind === 'interview_feedback') return { fixed, custom: [] };
  const ids = companyIds.filter(isUuid);
  return withRecruitmentTenant(s, async (tx) => ({ fixed, custom: (await customDefsTx(tx, s, ids, locale)).map((f) => ({ key: `cf.${f.id}`, label: f.label })) }),
    { readOnlySnapshot: true });
}

type ValueRow = { candidate_id: string; field_id: string; field_type: CustomFieldType; text_value: string | null; number_value: string | null; date_value: string | null;
  bool_value: boolean | null; option_id: string | null };
/** The chosen custom columns' values of these candidates, as text: open values for anyone who reads the candidate, restricted ones
 *  only from the restricted table (row security returns them to administrators and the candidate's job operators only). */
async function customCellsTx(tx: Tx, defs: readonly FieldDef[], columns: readonly string[], candidateIds: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const wanted = columns.filter(isCustomColumn).map(customColumnField).filter((id) => defs.some((d) => d.id === id));
  const out = new Map<string, Map<string, string>>();
  if (!wanted.length || !candidateIds.length) return out;
  const cols = sql`candidate_id, field_id, field_type, text_value, number_value::text as number_value, to_char(date_value, 'YYYY-MM-DD') as date_value, bool_value, option_id`;
  for (let i = 0; i < candidateIds.length; i += 2000) {
    const chunk = uuidArray(candidateIds.slice(i, i + 2000));
    const rows = await tx.execute<ValueRow>(sql`select ${cols} from recruitment_candidate_custom_value where candidate_id = any(${chunk}::uuid[]) and field_id = any(${uuidArray(wanted)}::uuid[])
      union all select ${cols} from recruitment_candidate_custom_restricted where candidate_id = any(${chunk}::uuid[]) and field_id = any(${uuidArray(wanted)}::uuid[])`);
    for (const r of rows) {
      const def = defs.find((d) => d.id === r.field_id)!;
      const text = r.option_id ? def.options.get(r.option_id) ?? '' : r.text_value ?? r.number_value ?? (r.field_type === 'year_month' ? r.date_value?.slice(0, 7) : r.date_value)
        ?? (r.bool_value === null ? '' : r.bool_value ? 'yes' : 'no');
      const forCandidate = out.get(r.candidate_id) ?? new Map<string, string>();
      const before = forCandidate.get(r.field_id);
      forCandidate.set(r.field_id, before ? `${before}; ${text}` : text);
      out.set(r.candidate_id, forCandidate);
    }
  }
  return out;
}
/** Exports running at once: one per person, and at most EXPORTS_PER_TENANT per tenant (transaction-scoped advisory locks, so they
 *  hold across application servers and end with the export's own transaction). A refused export says "try again in a moment". */
export const EXPORTS_PER_TENANT = 3;
async function exportGateTx(tx: Tx, s: SessionContext): Promise<void> {
  const [mine] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('recruitment-export-user:' || ${s.tenantId}::text || ':' || ${s.userId ?? ''}::text, 0)) as ok`);
  if (mine?.ok !== true) throw new RecruitmentError('export_busy');
  for (let slot = 0; slot < EXPORTS_PER_TENANT; slot++) {
    const [got] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('recruitment-export-tenant:' || ${s.tenantId}::text || ':' || ${slot}::text, 0)) as ok`);
    if (got?.ok === true) return;
  }
  throw new RecruitmentError('export_busy');
}
/** The export's own statement time limit, after the admission gate. */
const timeout = async (tx: Tx, s: SessionContext) => {
  await exportGateTx(tx, s);
  await tx.execute(sql`select set_config('statement_timeout', ${String(Number(process.env.RECRUITMENT_EXPORT_TIMEOUT_MS ?? EXPORT_TIMEOUT_MS))}, true)`);
};
/** An export that runs out of time is a plain refusal ("narrow the filters"), never retried: inside the READ ONLY transaction a
 *  cancelled statement (57014) would otherwise be read again by the idempotent-read retry. */
async function bounded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    if (pgSqlState(e) === '57014') throw new RecruitmentError('export_too_slow');
    throw e;
  }
}
const isoDay = (v: string | null) => v;

/** The companies of `companyIds` the caller operates in (administrators included); refuse when none. */
async function operatedCompaniesTx(tx: Tx, companyIds: readonly string[]): Promise<string[]> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) throw new RecruitmentError('forbidden');
  const rows = await tx.execute<{ id: string }>(sql`select x.id from unnest(${uuidArray(ids)}::uuid[]) as x(id) where app.recruitment_operates_in_company(x.id)`);
  if (!rows.length) throw new RecruitmentError('forbidden');
  return rows.map((r) => r.id);
}

type ListRow = {
  application_id: string; candidate_id: string; company_id: string; full_name: string; destroyed: boolean; email: string | null; phone: string | null; title: string;
  job_number: string; stage: string; state: ApplicationState; applied_on: string; archived_on: string | null; source: string | null; owner: string | null; reason: string | null;
  location: string | null; current_company: string | null; current_title: string | null; highest_education: string | null; notice_period: string | null;
  id_type: string | null; id_number: string | null; tags: string | null; review: boolean | null; pools: string | null;
};
const listColumns = (needsReview: boolean, pools: boolean) => sql`
  a.id as application_id, a.candidate_id, a.company_id, c.full_name, c.destroyed_at is not null as destroyed, c.email, c.phone, j.title, j.job_number,
  st.name as stage, a.state, to_char((a.applied_at at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') as applied_on,
  case when a.state = 'archived' then to_char((a.state_changed_at at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') end as archived_on,
  coalesce(a.source, c.source) as source, c.owner_user_id as owner, r.internal_reason as reason, c.location, c.current_company, c.current_title, c.highest_education,
  c.notice_period, rr.id_type, rr.id_number,
  (select string_agg(t.name, '; ' order by t.name) from recruitment_candidate_tag ct join recruitment_tag t on t.id = ct.tag_id where ct.candidate_id = a.candidate_id) as tags,
  ${needsReview ? sql`app.recruitment_application_needs_review(a.id)` : sql`null::boolean`} as review,
  ${pools ? sql`(select string_agg(p.name, '; ' order by p.name) from recruitment_talent_pool_member m join recruitment_talent_pool p on p.id = m.pool_id
    where m.candidate_id = a.candidate_id)` : sql`null::text`} as pools`;
const listJoins = sql`
  join recruitment_candidate c on c.id = a.candidate_id
  join recruitment_job_opening j on j.id = a.job_id
  join recruitment_stage st on st.id = coalesce(a.stage_left_at_archive, a.current_stage_id)
  left join recruitment_archive_reason r on r.id = a.archive_reason_id
  left join recruitment_candidate_restricted rr on rr.candidate_id = a.candidate_id`;

async function listTable(tx: Tx, s: SessionContext, kind: 'board' | 'talent_pool', companies: string[], columns: string[], locale: string, from: SQL, where: SQL): Promise<ExportTable> {
  const rows = await tx.execute<ListRow>(sql`select ${listColumns(columns.includes('needsReview'), columns.includes('pools'))} from ${from} ${listJoins}
    where ${where} order by a.applied_at desc, a.id limit ${EXPORT_MAX_ROWS + 1}`);
  assertExportSize(rows.length);
  const defs = await customDefsTx(tx, s, companies, locale);
  const visible = new Set(defs.map((d) => d.id));
  const cols = columns.filter((c) => !isCustomColumn(c) || visible.has(customColumnField(c)));
  const custom = await customCellsTx(tx, defs, cols, [...new Set(rows.map((r) => r.candidate_id))]);
  const owners = new Map<string, string>();
  if (cols.includes('owner')) for (const id of companies) for (const [k, v] of await userLabelsTx(tx, id)) owners.set(k, v.name);
  const cell = (r: ListRow, key: string): ExportCell => {
    if (isCustomColumn(key)) return r.destroyed ? null : custom.get(r.candidate_id)?.get(customColumnField(key)) ?? null;
    switch (key) {
      case 'candidateName': return r.destroyed ? null : r.full_name;
      case 'email': return r.email;
      case 'mobile': return r.phone;
      case 'jobTitle': return r.title;
      case 'jobNumber': return r.job_number;
      case 'stage': case 'stageLeft': return r.stage;
      case 'status': return r.state;
      case 'appliedOn': return isoDay(r.applied_on);
      case 'archivedOn': return isoDay(r.archived_on);
      case 'source': return r.source;
      case 'owner': return r.owner ? owners.get(r.owner) ?? null : null;
      case 'tags': return r.tags;
      case 'pools': return r.pools;
      case 'archiveReason': return r.reason;
      case 'needsReview': return r.review === true ? 'yes' : 'no';
      case 'location': return r.location;
      case 'currentCompany': return r.current_company;
      case 'currentTitle': return r.current_title;
      case 'highestEducation': return r.highest_education;
      case 'noticePeriod': return r.notice_period;
      case 'idType': return r.id_type;
      case 'idNumber': return r.id_number;
      default: return null;
    }
  };
  return {
    kind, columns: cols, rows: rows.map((r) => cols.map((k) => cell(r, k))),
    customLabels: Object.fromEntries(defs.map((d) => [`cf.${d.id}`, d.label])),
  };
}

export type BoardExportFilter = { jobId?: string; tab?: string; tagId?: string; custom?: string };
/**
 * The Candidates board as the exporter sees it (row security: an administrator's companies, a team member's own jobs) with the
 * board's job, stage tab ('hired', 'archived' or a stage id; none = every application), tag and custom-field filters, in the
 * companies they operate in.
 */
export async function exportBoard(s: SessionContext, companyIds: readonly string[], filter: BoardExportFilter, asked: readonly unknown[] | null, locale: string): Promise<ExportTable> {
  return withRecruitmentTenant(s, async (tx) => bounded(async () => {
    await timeout(tx, s);
    const companies = await operatedCompaniesTx(tx, companyIds);
    const ids = uuidArray(companies);
    const choices = await customFilterChoicesTx(tx, s, companies, 'candidate');
    const custom = customFilterSql(choices, filter.custom, 'candidate', sql`a.candidate_id`);
    const job = filter.jobId && isUuid(filter.jobId) ? filter.jobId : null;
    const tag = filter.tagId && isUuid(filter.tagId) ? filter.tagId : null;
    const tab = filter.tab === 'hired' ? sql`and a.state = 'hired'` : filter.tab === 'archived' ? sql`and a.state = 'archived'`
      : filter.tab && isUuid(filter.tab) ? sql`and a.state = 'active' and a.current_stage_id = ${filter.tab}::uuid` : sql``;
    const defs = await customDefsTx(tx, s, companies, locale);
    const columns = chooseExportColumns('board', asked, new Set(defs.map((d) => d.id)));
    return listTable(tx, s, 'board', companies, columns, locale, sql`recruitment_application a`, sql`a.tenant_id = ${s.tenantId}::uuid and a.company_id = any(${ids}::uuid[])
      ${job ? sql`and a.job_id = ${job}::uuid` : sql``} ${tab}
      ${tag ? sql`and exists (select 1 from recruitment_candidate_tag ct where ct.candidate_id = a.candidate_id and ct.tag_id = ${tag}::uuid)` : sql``} ${custom.condition}`);
  }), { readOnlySnapshot: true });
}

export type PoolExportFilter = { jobId?: string; reasonId?: string; since?: string; tagId?: string; custom?: string };
/** The talent pool (slice 4: each candidate's latest archived application) with its filters, for those who may open it. */
export async function exportTalentPool(s: SessionContext, companyIds: readonly string[], filter: PoolExportFilter, asked: readonly unknown[] | null, locale: string): Promise<ExportTable> {
  const scope = companyIds.filter(isUuid);
  if (!scope.length) throw new RecruitmentError('forbidden');
  return withRecruitmentTenant(s, async (tx) => bounded(async () => {
    await timeout(tx, s);
    // The companies in scope whose talent pool the caller may open (slice 4: those they administer), as the page lists them.
    const companies = (await tx.execute<{ id: string }>(sql`select x.id from unnest(${uuidArray(scope)}::uuid[]) as x(id) where app.can_admin_recruitment_for(x.id)`)).map((r) => r.id);
    if (!companies.length) throw new RecruitmentError('forbidden');
    const ids = uuidArray(companies);
    const choices = await customFilterChoicesTx(tx, s, companies, 'candidate');
    const custom = customFilterSql(choices, filter.custom, 'candidate', sql`a.candidate_id`);
    const job = filter.jobId && isUuid(filter.jobId) ? filter.jobId : null;
    const reason = filter.reasonId && isUuid(filter.reasonId) ? filter.reasonId : null;
    const since = filter.since && /^\d{4}-\d{2}-\d{2}$/.test(filter.since) ? filter.since : null;
    const tag = filter.tagId && isUuid(filter.tagId) ? filter.tagId : null;
    const pool = sql`(select distinct on (x.candidate_id) x.* from recruitment_application x
      where x.tenant_id = ${s.tenantId}::uuid and x.company_id = any(${ids}::uuid[]) and x.state = 'archived'
      order by x.candidate_id, x.state_changed_at desc, x.id desc) a`;
    const defs = await customDefsTx(tx, s, companies, locale);
    const columns = chooseExportColumns('talent_pool', asked, new Set(defs.map((d) => d.id)));
    return listTable(tx, s, 'talent_pool', companies, columns, locale, pool, sql`true ${job ? sql`and a.job_id = ${job}::uuid` : sql``}
      ${reason ? sql`and a.archive_reason_id = ${reason}::uuid` : sql``}
      ${since ? sql`and (a.state_changed_at at time zone 'Asia/Kuala_Lumpur')::date >= ${since}::date` : sql``}
      ${tag ? sql`and exists (select 1 from recruitment_candidate_tag ct where ct.candidate_id = a.candidate_id and ct.tag_id = ${tag}::uuid)` : sql``} ${custom.condition}`);
  }), { readOnlySnapshot: true });
}

/**
 * One job's interview feedback (its operators and administrators): one row per scorecard they may read (row security: the job's
 * reviewers, slice 2), with the round, stage, interview date, interviewer, overall result, average and per-criterion scores, and —
 * only when the `comments` column is chosen — the overview and criterion notes.
 */
export async function exportInterviewFeedback(s: SessionContext, jobId: unknown, asked: readonly unknown[] | null): Promise<ExportTable & { companyId: string }> {
  if (!isUuid(jobId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => bounded(async () => {
    await timeout(tx, s);
    const job = await jobTx(tx, s, jobId, 'operate');
    const columns = chooseExportColumns('interview_feedback', asked);
    const rows = await tx.execute<{ full_name: string; destroyed: boolean; round_no: number; stage: string; starts_on: string; interviewer: string; result: string | null;
      ratings: Record<string, { rating: number; notes?: string }>; overview: string | null; definition: EvaluationFormDefinition }>(sql`
      select c.full_name, c.destroyed_at is not null as destroyed, i.round_no, st.name as stage,
        to_char((i.starts_at at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') as starts_on, sc.interviewer_user_id as interviewer, sc.result, sc.ratings,
        sc.overview, f.definition
      from recruitment_scorecard sc
      join recruitment_interview i on i.id = sc.interview_id
      join recruitment_application a on a.id = sc.application_id
      join recruitment_candidate c on c.id = a.candidate_id
      join recruitment_stage st on st.id = i.stage_id
      join recruitment_evaluation_form f on f.id = sc.evaluation_form_id
      where sc.job_id = ${job.id}::uuid and sc.tenant_id = ${s.tenantId}::uuid
      order by i.starts_at, i.round_no, c.full_name, sc.id limit ${EXPORT_MAX_ROWS + 1}`);
    assertExportSize(rows.length);
    const people = await userLabelsTx(tx, job.companyId);
    const criteria = (d: EvaluationFormDefinition) => d.sections.flatMap((x) => x.criteria);
    const cell = (r: (typeof rows)[number], key: string): ExportCell => {
      const list = criteria(r.definition).filter((c) => r.ratings?.[c.key]);
      switch (key) {
        case 'candidateName': return r.destroyed ? null : r.full_name;
        case 'round': return r.round_no;
        case 'stage': return r.stage;
        case 'interviewDate': return r.starts_on;
        case 'interviewer': return people.get(r.interviewer)?.name ?? null;
        case 'result': return r.result;
        case 'averageScore': {
          const n = list.map((c) => Number(r.ratings[c.key].rating)).filter((x) => Number.isFinite(x));
          return n.length ? Math.round((n.reduce((a, b) => a + b, 0) / n.length) * 100) / 100 : null;
        }
        case 'scores': return list.map((c) => `${c.label}: ${r.ratings[c.key].rating}`).join('; ') || null;
        case 'comments': return [r.overview, ...list.filter((c) => r.ratings[c.key].notes).map((c) => `${c.label}: ${r.ratings[c.key].notes}`)].filter(Boolean).join('\n') || null;
        default: return null;
      }
    };
    return { kind: 'interview_feedback' as const, companyId: job.companyId, columns, customLabels: {}, rows: rows.map((r) => columns.map((k) => cell(r, k))) };
  }), { readOnlySnapshot: true });
}

/** The audit event of an export: who, what kind, a summary of the filters (ids and keys), format, columns and rows — never a value. */
export async function recordExport(s: SessionContext, input: { kind: ExportKind; companyIds: readonly string[]; format: ExportFormat; filters: Record<string, string | undefined>;
  columns: number; rows: number }): Promise<void> {
  const companyIds = input.companyIds.filter(isUuid);
  const filters = Object.fromEntries(Object.entries(input.filters).filter(([, v]) => typeof v === 'string' && v !== '' && v.length <= 120)
    .map(([k, v]) => [k, /^[0-9a-zA-Z:._-]+$/.test(v!) ? v : 'set']));
  await withRecruitmentTenant(s, (tx) => appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-export', aggregateId: companyIds[0] ?? s.tenantId,
    eventType: 'recruitment-export.created', actor: actorOf(s), payload: { kind: input.kind, companyIds, format: input.format, filters, columns: input.columns, rows: input.rows } }));
}

// ── Export templates (saved column sets) ─────────────────────────────────────────────────────────────────────

export type ExportTemplateRow = { id: string; companyId: string; kind: ExportKind; name: string; columns: string[]; updatedAt: string };
/** The saved column sets of these companies the caller may use (operators read; administrators manage). Read-only. */
export async function exportTemplates(s: SessionContext, companyIds: readonly string[], kind?: ExportKind): Promise<ExportTemplateRow[]> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) return [];
  return withRecruitmentTenant(s, async (tx) => (await tx.execute<{ id: string; company_id: string; kind: ExportKind; name: string; columns: string[]; updated_at: string }>(sql`
    select id, company_id, kind, name, columns, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at from recruitment_export_template
    where tenant_id = ${s.tenantId}::uuid and company_id = any(${uuidArray(ids)}::uuid[]) ${kind ? sql`and kind = ${kind}` : sql``}
    order by kind, lower(name), id`)).map((r) => ({ id: r.id, companyId: r.company_id, kind: r.kind, name: r.name, columns: r.columns, updatedAt: r.updated_at })),
  { readOnlySnapshot: true });
}
const nameTaken = (e: unknown) => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) if (cur.constraint_name === 'recruitment_export_template_name_uq') return true;
  return false;
};
/** Create or change a saved column set (administrators of the company). */
export async function saveExportTemplate(s: SessionContext, input: { id?: unknown; companyId?: unknown; kind?: unknown; name?: unknown; columns?: unknown }): Promise<{ id: string }> {
  if (!s.userId) throw new RecruitmentError('forbidden');
  const v = validateExportTemplate(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  return withRecruitmentTenant(s, async (tx) => {
    try {
      if (input.id != null && input.id !== '') {
        if (!isUuid(input.id)) throw new RecruitmentError('not_found');
        const [row] = await tx.execute<{ company_id: string; kind: ExportKind }>(sql`select company_id, kind from recruitment_export_template where id = ${input.id}::uuid`);
        if (!row) throw new RecruitmentError('not_found');
        await assertCompanyTx(tx, row.company_id);
        if (row.kind !== v.value.kind) throw new RecruitmentError('invalid_input', ['kind']);
        await tx.execute(sql`update recruitment_export_template set name = ${v.value.name}, columns = ${`{${v.value.columns.join(',')}}`}::text[] where id = ${input.id}::uuid`);
        await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: input.id, eventType: 'recruitment-export-template.updated',
          actor: actorOf(s), payload: { companyId: row.company_id, templateId: input.id, kind: row.kind, columns: v.value.columns.length } });
        return { id: input.id };
      }
      if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
      await assertCompanyTx(tx, input.companyId);
      const [{ n }] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_export_template where company_id = ${input.companyId}::uuid`);
      if (n >= EXPORT_TEMPLATES_MAX) throw new RecruitmentError('template_limit');
      const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_export_template (tenant_id, company_id, kind, name, columns, created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${input.companyId}::uuid, ${v.value.kind}, ${v.value.name}, ${`{${v.value.columns.join(',')}}`}::text[], ${s.userId}::uuid, ${s.userId}::uuid)
        returning id`);
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: row.id, eventType: 'recruitment-export-template.created',
        actor: actorOf(s), payload: { companyId: input.companyId, templateId: row.id, kind: v.value.kind, columns: v.value.columns.length } });
      return { id: row.id };
    } catch (e) {
      if (nameTaken(e)) throw new RecruitmentError('name_taken', ['name']);
      throw e;
    }
  });
}
/** Delete a saved column set (administrators of the company). */
export async function deleteExportTemplate(s: SessionContext, id: unknown): Promise<void> {
  if (!isUuid(id)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ company_id: string; kind: ExportKind }>(sql`select company_id, kind from recruitment_export_template where id = ${id}::uuid`);
    if (!row) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, row.company_id);
    await tx.execute(sql`delete from recruitment_export_template where id = ${id}::uuid`);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: id, eventType: 'recruitment-export-template.deleted',
      actor: actorOf(s), payload: { companyId: row.company_id, templateId: id, kind: row.kind } });
  });
}
/** A saved set's columns, if the caller may use it for this kind (operators of its company). */
export async function exportTemplateColumns(s: SessionContext, id: unknown, kind: ExportKind): Promise<string[] | null> {
  if (!isUuid(id) || !isExportKind(kind)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ columns: string[]; company_id: string }>(sql`select columns, company_id from recruitment_export_template where id = ${id}::uuid and kind = ${kind}`);
    if (!row) return null;
    await assertOperatesCompanyTx(tx, row.company_id);
    return row.columns;
  }, { readOnlySnapshot: true });
}
