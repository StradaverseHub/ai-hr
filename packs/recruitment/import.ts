/**
 * Recruitment slice 16 — candidate import and the To assign list. Reached from outside the pack ONLY through ./service.
 *
 * Who: recruitment administrators and the company's recruiters and assistants (app.recruitment_operates_in_company). The database
 * refuses the same (5217): the import record, its rows and the To assign list are theirs only, candidates are inserted under the
 * slice 2 insert policy, applications under the job's operate policy, restricted and custom values under slices 5 and 14.
 *
 * The import (D-055): the web request validates the whole file and previews it (READ ONLY), and on confirmation (with the slice 5
 * permission confirmation) only ENQUEUES a job on the shared bulk-job kernel (core/bulk-job.ts) — the file is the job's source
 * content, cleared by the kernel when the job ends. The kernel's worker (core/recruitment-candidate-import-worker.ts) runs one step
 * per file row in short chunk transactions under the importer's freshly resolved authority, through importCandidateRowTx below:
 * each row independently, in its own savepoint, so a refused row is recorded and the rest continue. Each good row is ONE new
 * candidate (possible duplicates are imported and flagged by slice 5's count, never merged) and, for an Open job the importer may
 * add applications to, one application at the job's first enabled stage through the ordinary insert (the repeat guard, slice 13's
 * blocked-list matching). Without a usable job the candidate goes on the To assign list.
 *
 * Events carry ids and counts only. Nothing here calls a model, parses a résumé or infers anything about a candidate (D-056).
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import {
  BULK_JOB_ALREADY_RUNNING, BulkJobError, bulkJobProgress, bulkJobTx, bulkJobWorkerStatusTx, enqueueBulkJobTx, listBulkJobsTx, requestBulkJobCancel,
} from '../../core/bulk-job';
import { bulkJobActive, type BulkJobProgress, type BulkJobWorkerStatus } from '../../lib/bulk-job';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, appliedEvent, firstStage, isUuid } from './model';
import { recruitmentApplicationEvent, recruitmentCandidate, recruitmentCandidateRestricted } from './schema';
import { actorId, assertNotRepeatedTx, insertApplicationTx, processStagesTx, userLabelsTx, uuidArray } from './data';
import { labelsOf, saveRecordCustomValuesTx } from './custom-field-store';
import { CUSTOM_FIELD_LOCALES, type CustomFieldType, type RawCustomValues } from './custom-field-model';
import { normEmail, normIdNumber, normMobile, normName } from './privacy-model';
import {
  CANDIDATE_IMPORT_KIND, IMPORT_PREVIEW_ISSUES_MAX, ImportFileRefusal, assertPermission, fileDuplicates, jobResultOf, needsJobIssues, parseCandidateImport, requiredIssues,
  importTemplateHeader, type ImportField, type ImportFileError, type ImportValues, type JobChoice, type JobResult, type RowIssue,
} from './import-model';

// ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Refuse unless the caller administers the company's recruitment or is a recruiter or assistant of one of its jobs (5202). */
export async function assertOperatesCompanyTx(tx: Tx, companyId: unknown): Promise<{ admin: boolean }> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const [row] = await tx.execute<{ operates: boolean; admin: boolean }>(sql`select app.recruitment_operates_in_company(${companyId}::uuid) as operates,
    app.can_admin_recruitment_for(${companyId}::uuid) as admin`);
  if (row?.operates !== true) throw new RecruitmentError('forbidden');
  return { admin: row.admin === true };
}

// ── The template and the file's columns ──────────────────────────────────────────────────────────────────────

const labelCols = sql.raw(CUSTOM_FIELD_LOCALES.map((l) => `label_${l}`).join(', '));
type LabelRow = Record<`label_${(typeof CUSTOM_FIELD_LOCALES)[number]}`, string | null>;
/** The company's ENABLED custom candidate fields, in order, with every option (an import names options by label; only enabled
 *  ones are accepted). Restricted fields too: the caller operates in the company, so their definitions are visible (5215). */
export async function importFieldsTx(tx: Tx, s: SessionContext, companyId: string): Promise<ImportField[]> {
  const fields = await tx.execute<LabelRow & { id: string; field_type: CustomFieldType; required: boolean; restricted: boolean; number_min: string | null;
    number_max: string | null; number_decimals: number | null }>(sql`
    select id, field_type, ${labelCols}, required, restricted, number_min::text as number_min, number_max::text as number_max, number_decimals
    from recruitment_custom_field where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid and record_kind = 'candidate' and enabled
    order by position, lower(label_en), id`);
  const options = fields.length ? await tx.execute<LabelRow & { id: string; field_id: string; enabled: boolean }>(sql`
    select id, field_id, ${labelCols}, enabled from recruitment_custom_field_option where field_id = any(${uuidArray(fields.map((f) => f.id))}::uuid[])
    order by position, lower(label_en), id`) : [];
  return fields.map((f) => ({
    id: f.id, type: f.field_type, labels: labelsOf(f), required: f.required, restricted: f.restricted,
    numberMin: f.number_min, numberMax: f.number_max, numberDecimals: f.number_decimals,
    options: options.filter((o) => o.field_id === f.id).map((o) => ({ id: o.id, labels: labelsOf(o), enabled: o.enabled })),
  }));
}

export type ImportTemplate = { header: string[]; customFields: { id: string; label: string; type: CustomFieldType; required: boolean; options: string[] }[] };
/** The import template's columns for the company (the template download and the page's column list). Read-only. */
export async function candidateImportTemplate(s: SessionContext, companyId: unknown): Promise<ImportTemplate> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertOperatesCompanyTx(tx, companyId);
    const fields = await importFieldsTx(tx, s, companyId as string);
    return {
      header: importTemplateHeader(fields),
      customFields: fields.map((f) => ({ id: f.id, label: f.labels.en ?? '', type: f.type, required: f.required,
        options: f.options.filter((o) => o.enabled).map((o) => o.labels.en ?? '') })),
    };
  }, { readOnlySnapshot: true });
}

// ── Preview ──────────────────────────────────────────────────────────────────────────────────────────────────

export const importHash = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** The jobs a file names, as the importer may see them (row security: a job they cannot see is unknown). */
async function jobsByNumberTx(tx: Tx, s: SessionContext, companyId: string, numbers: readonly string[]): Promise<Map<string, JobChoice & { processId: string }>> {
  const wanted = [...new Set(numbers)].filter((n) => /^[A-Z0-9-]{1,40}$/.test(n));
  if (!wanted.length) return new Map();
  const rows = await tx.execute<{ id: string; job_number: string; status: string; process_id: string; operate: boolean }>(sql`
    select j.id, j.job_number, j.status, j.process_id, app.can_operate_recruitment_job(j.company_id, j.id) as operate from recruitment_job_opening j
    where j.tenant_id = ${s.tenantId}::uuid and j.company_id = ${companyId}::uuid and j.job_number = any(${`{${wanted.join(',')}}`}::text[])`);
  return new Map(rows.map((r) => [r.job_number, { id: r.id, status: r.status, operate: r.operate === true, processId: r.process_id }]));
}

export type ImportPreviewRow = {
  rowNum: number; name: string | null; issues: RowIssue[];
  /** A possible duplicate (slice 5): of a candidate the company has, or of an earlier row of this file. */
  duplicate: 'existing' | 'file' | null; duplicateOfRow: number | null;
  /** Why the row's job number gives no application (absent when the job is usable or the row names none). */
  job: Exclude<JobResult, 'applied' | 'no_job'> | null;
};
export type ImportPreview =
  | {
    ok: true; companyId: string; fileName: string; previewHash: string;
    rows: number; ready: number; invalid: number; withJob: number; toAssign: number; duplicates: number; unknownJobs: number;
    issues: ImportPreviewRow[]; issuesTruncated: boolean; ignoredColumns: string[];
  }
  | { ok: false; fileError: ImportFileError };

const fileNameOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\\/]/g, '_').slice(0, 200) : 'candidates.csv');

/** At most this many previews per person per Kuala Lumpur day (5217 recruitment_import_preview_quota). */
export const IMPORT_PREVIEWS_PER_DAY = 20;
/** A preview's statement time limit: a heavier file is refused with a plain message, never retried. */
export const IMPORT_PREVIEW_TIMEOUT_MS = 15_000;
const previewTimeoutMs = () => Number(process.env.RECRUITMENT_PREVIEW_TIMEOUT_MS ?? IMPORT_PREVIEW_TIMEOUT_MS);
const TIMEOUT = '57014';
/** The importer's preview count for today (the database's Kuala Lumpur day), refused past the daily limit. A short write of its own. */
async function takePreviewQuota(s: SessionContext): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ previews: number }>(sql`insert into recruitment_import_preview_quota (tenant_id, app_user_id, day)
      values (${s.tenantId}::uuid, ${user}::uuid, (now() at time zone 'Asia/Kuala_Lumpur')::date)
      on conflict (tenant_id, app_user_id, day) do update set previews = recruitment_import_preview_quota.previews + 1
        where recruitment_import_preview_quota.previews < ${IMPORT_PREVIEWS_PER_DAY}
      returning previews`);
    if (!row) throw new RecruitmentError('import_preview_limit');
  });
}
/** The normalised identity of a probe (slice 5's normalisers): the same person is probed once. */
const probeKey = (v: ImportValues) => JSON.stringify([normName(v.fullName), normEmail(v.email), normMobile(v.phone), normIdNumber(v.idNumber)]);

/**
 * Validate a whole file and say what would happen (spec: counts, errors per row and field, possible duplicates, unknown jobs),
 * before anything is written. One READ ONLY transaction under its own statement time limit: possible duplicates are one statement
 * over the file's DISTINCT identities (app.recruitment_candidate_duplicate_flags: each stops at its first match, returns keys only,
 * never a count or a row of someone else's). A timeout is a plain refusal (import_too_heavy), never retried. Before it, the
 * person's daily preview count; after it, one audit event with counts only — a preview tells whether someone is already a candidate,
 * so it is bounded and recorded.
 */
export async function previewCandidateImport(s: SessionContext, input: { companyId?: unknown; text?: unknown; fileName?: unknown }): Promise<ImportPreview> {
  if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
  if (typeof input.text !== 'string') throw new RecruitmentError('missing_fields', ['file']);
  const companyId = input.companyId, text = input.text;
  // Access first (a refused caller uses no quota), then the quota.
  await withRecruitmentTenant(s, (tx) => assertOperatesCompanyTx(tx, companyId), { readOnlySnapshot: true });
  await takePreviewQuota(s);
  const preview = await withRecruitmentTenant(s, async (tx): Promise<ImportPreview> => {
    try {
      await tx.execute(sql`select set_config('statement_timeout', ${String(previewTimeoutMs())}, true)`);
      return await previewTx(tx, s, companyId, text, input.fileName);
    } catch (e) {
      // Not retried: a cancelled preview would only be cancelled again.
      if (pgSqlState(e) === TIMEOUT) throw new RecruitmentError('import_too_heavy');
      throw e;
    }
  }, { readOnlySnapshot: true });
  await withRecruitmentTenant(s, (tx) => appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-import', aggregateId: companyId,
    eventType: 'recruitment-import.previewed', actor: actorOf(s), payload: preview.ok
      ? { companyId, rows: preview.rows, invalid: preview.invalid, flaggedDuplicates: preview.duplicates, unknownJobs: preview.unknownJobs }
      : { companyId, fileError: preview.fileError } }));
  return preview;
}

async function previewTx(tx: Tx, s: SessionContext, companyId: string, text: string, fileName: unknown): Promise<ImportPreview> {
  const { admin } = await assertOperatesCompanyTx(tx, companyId);
  const fields = await importFieldsTx(tx, s, companyId);
  let parsed: ReturnType<typeof parseCandidateImport>;
  try { parsed = parseCandidateImport(text, fields, { required: false }); } catch (e) {
    if (e instanceof ImportFileRefusal) return { ok: false, fileError: e.code };
    throw e;
  }
  const jobs = await jobsByNumberTx(tx, s, companyId, parsed.rows.flatMap((r) => (r.values?.jobNumber ? [r.values.jobNumber] : [])));
  const good = parsed.rows.filter((r) => r.values);
  const keys = [...new Set(good.map((r) => probeKey(r.values!)))];
  const flagged = keys.length ? new Set((await tx.execute<{ k: number }>(sql`select k from app.recruitment_candidate_duplicate_flags(${companyId}::uuid,
    ${JSON.stringify(keys.map((key, k) => { const [n, e, m, i] = JSON.parse(key) as (string | null)[]; return { k, n, e, m, i }; }))}::jsonb) as k`)).map((r) => keys[Number(r.k)])) : new Set<string>();
  const inFile = fileDuplicates(parsed.rows);
  const out: ImportPreviewRow[] = [];
  let ready = 0, invalid = 0, withJob = 0, toAssign = 0, duplicates = 0, unknownJobs = 0;
  for (const r of parsed.rows) {
    const issues = [...r.issues];
    let job: ImportPreviewRow['job'] = null;
    if (r.values) {
      const result = jobResultOf(r.values.jobNumber, r.values.jobNumber ? jobs.get(r.values.jobNumber) : undefined);
      if (result !== 'usable' && result !== 'no_job') job = result;
      if (result !== 'usable' && !admin) issues.push(...needsJobIssues(r.values, r.custom));
      // Required custom fields: every row that gets an application, and every row an administrator imports.
      else issues.push(...requiredIssues(fields, r.custom));
      if (!issues.length) {
        ready++;
        if (result === 'usable') withJob++; else toAssign++;
        if (job) unknownJobs++;
      }
    }
    if (issues.length) invalid++;
    const dup = r.values && flagged.has(probeKey(r.values)) ? 'existing' : inFile.has(r.rowNum) ? 'file' : null;
    if (dup && !issues.length) duplicates++;
    if (issues.length || dup || job) {
      out.push({ rowNum: r.rowNum, name: r.values?.fullName ?? null, issues, duplicate: dup, duplicateOfRow: dup === 'file' ? inFile.get(r.rowNum)! : null, job });
    }
  }
  return {
    ok: true, companyId, fileName: fileNameOf(fileName), previewHash: importHash(text), rows: parsed.rows.length, ready, invalid, withJob, toAssign,
    duplicates, unknownJobs, issues: out.slice(0, IMPORT_PREVIEW_ISSUES_MAX), issuesTruncated: out.length > IMPORT_PREVIEW_ISSUES_MAX,
    ignoredColumns: parsed.ignoredColumns,
  };
}

// ── Starting, following and stopping an import ───────────────────────────────────────────────────────────────

/** What the job's admission stores (bulk_job_kind.input_shape, 5217). The file is the job's source content. */
export type CandidateImportJobInput = { companyId: string; previewHash: string; locale: string; permissionConfirmed: boolean };

/**
 * Start the previewed import: the same file (its sha256 must be the preview's), the permission confirmation (slice 5; consent stays
 * "not recorded"). Only enqueues: the import record and the job are written together; nothing is imported in this request.
 */
export async function startCandidateImport(s: SessionContext, input: {
  companyId?: unknown; text?: unknown; fileName?: unknown; previewHash?: unknown; permissionConfirmed?: unknown; locale?: unknown; operationKey?: unknown;
}): Promise<{ importId: string; existing: boolean }> {
  assertPermission(input.permissionConfirmed);
  if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
  if (typeof input.text !== 'string') throw new RecruitmentError('missing_fields', ['file']);
  const companyId = input.companyId, text = input.text;
  if (typeof input.previewHash !== 'string' || input.previewHash !== importHash(text)) throw new RecruitmentError('import_changed');
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    await assertOperatesCompanyTx(tx, companyId);
    let rows: number;
    try { rows = parseCandidateImport(text, await importFieldsTx(tx, s, companyId), { required: false }).rows.length; } catch (e) {
      if (e instanceof ImportFileRefusal) throw new RecruitmentError('import_file_invalid', [e.code]);
      throw e;
    }
    const jobInput: CandidateImportJobInput = { companyId, previewHash: input.previewHash as string, locale: typeof input.locale === 'string' ? input.locale.slice(0, 10) : 'en',
      permissionConfirmed: true };
    let admitted: Awaited<ReturnType<typeof enqueueBulkJobTx>>;
    try {
      admitted = await enqueueBulkJobTx(tx, s, { kind: CANDIDATE_IMPORT_KIND, operationKey: typeof input.operationKey === 'string' ? input.operationKey : undefined,
        companyIds: [companyId], source: { name: fileNameOf(input.fileName), content: Buffer.from(text, 'utf8') }, input: jobInput });
    } catch (e) {
      if (e instanceof BulkJobError && e.message === BULK_JOB_ALREADY_RUNNING) throw new RecruitmentError('import_running');
      throw e;
    }
    const importId = admitted.row.id;
    if (!admitted.existing) {
      await tx.execute(sql`insert into recruitment_candidate_import (id, tenant_id, company_id, created_by_user_id, permission_confirmed_at, file_rows)
        values (${importId}::uuid, ${s.tenantId}::uuid, ${companyId}::uuid, ${user}::uuid, now(), ${rows})`);
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-import', aggregateId: importId, eventType: 'recruitment-import.started',
        actor: actorOf(s), payload: { companyId, importId, rows } });
    }
    return { importId, existing: admitted.existing };
  });
}

export type ImportCounters = { rows: number; created: number; applications: number; toAssign: number; possibleDuplicates: number; needsReview: number; failed: number; invalid: number };
export type CandidateImportJob = {
  importId: string; companyId: string; job: BulkJobProgress | null; worker: BulkJobWorkerStatus; counters: ImportCounters;
  outcome: 'completed' | 'cancelled' | 'failed' | null; createdAt: string; fileRows: number;
};
const COUNTER_KEYS: (keyof ImportCounters)[] = ['rows', 'created', 'applications', 'toAssign', 'possibleDuplicates', 'needsReview', 'failed', 'invalid'];
const countersOf = (raw: Record<string, number> | undefined): ImportCounters =>
  Object.fromEntries(COUNTER_KEYS.map((k) => [k, Number(raw?.[k] ?? 0) || 0])) as ImportCounters;

/** The import's progress (its importer, from the job) or its record (an administrator of the company). Read-only. */
export async function candidateImportJob(s: SessionContext, importId: unknown): Promise<CandidateImportJob> {
  if (!isUuid(importId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [rec] = await tx.execute<{ id: string; company_id: string; outcome: CandidateImportJob['outcome']; created_at: string; file_rows: number }>(sql`
      select id, company_id, outcome, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, file_rows
      from recruitment_candidate_import where id = ${importId}::uuid`);
    if (!rec) throw new RecruitmentError('not_found');
    const [jobRow] = await tx.execute<{ id: string }>(sql`select id from bulk_job where id = ${importId}::uuid and kind = ${CANDIDATE_IMPORT_KIND}`);
    const job = jobRow ? bulkJobProgress(await bulkJobTx(tx, importId, { kind: CANDIDATE_IMPORT_KIND })) : null;
    const worker: BulkJobWorkerStatus = job?.state === 'queued' ? await bulkJobWorkerStatusTx(tx, CANDIDATE_IMPORT_KIND) : 'running';
    // Counters from the job while it is readable; otherwise (an administrator, or a finished job) from the recorded rows.
    let counters = job ? countersOf(job.counters) : null;
    if (!counters || (job && !bulkJobActive(job.state))) {
      const [c] = await tx.execute<Record<string, number>>(sql`select count(*)::int as rows,
        count(*) filter (where outcome = 'created')::int as created, count(*) filter (where application_id is not null)::int as applications,
        count(*) filter (where outcome = 'created' and application_id is null)::int as "toAssign", count(*) filter (where possible_duplicate)::int as "possibleDuplicates",
        count(*) filter (where needs_review)::int as "needsReview", count(*) filter (where outcome = 'failed')::int as failed,
        count(*) filter (where outcome = 'invalid')::int as invalid
        from recruitment_candidate_import_row where import_id = ${importId}::uuid`);
      counters = countersOf(c);
    }
    return { importId: rec.id, companyId: rec.company_id, job, worker, counters, outcome: rec.outcome, createdAt: rec.created_at, fileRows: rec.file_rows };
  }, { readOnlySnapshot: true });
}

/** The importer asks their running import to stop. Rows already imported stay (per-row kind); the result page says what was done. */
export async function cancelCandidateImport(s: SessionContext, importId: unknown): Promise<void> {
  if (!isUuid(importId)) throw new RecruitmentError('not_found');
  try { await requestBulkJobCancel(s, importId, CANDIDATE_IMPORT_KIND); } catch (e) {
    if (e instanceof BulkJobError) throw new RecruitmentError(e.status === 409 ? 'import_finished' : 'not_found');
    throw e;
  }
}

export type ImportResultRow = {
  rowNum: number; outcome: 'created' | 'failed' | 'invalid'; candidateId: string | null; candidateName: string | null; applicationId: string | null;
  jobTitle: string | null; jobNumber: string | null; jobResult: JobResult | null; possibleDuplicate: boolean; needsReview: boolean;
  errorCode: string | null; errorFields: { field: string; code: string }[];
};
/** The import's result, row by row in file order (at most `limit` rows from `fromRow`); names under the reader's row security. */
export async function candidateImportResult(s: SessionContext, importId: unknown, opts: { fromRow?: number; limit?: number; problemsOnly?: boolean } = {}): Promise<ImportResultRow[]> {
  if (!isUuid(importId)) throw new RecruitmentError('not_found');
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  return withRecruitmentTenant(s, async (tx) => {
    const [rec] = await tx.execute<{ id: string }>(sql`select id from recruitment_candidate_import where id = ${importId}::uuid`);
    if (!rec) throw new RecruitmentError('not_found');
    const rows = await tx.execute<{ row_num: number; outcome: ImportResultRow['outcome']; candidate_id: string | null; full_name: string | null; destroyed: boolean | null;
      application_id: string | null; title: string | null; job_number: string | null; job_result: JobResult | null; possible_duplicate: boolean; needs_review: boolean;
      error_code: string | null; error_fields: string[] }>(sql`
      select r.row_num, r.outcome, r.candidate_id, c.full_name, c.destroyed_at is not null as destroyed, r.application_id, j.title, j.job_number, r.job_result,
        r.possible_duplicate, r.needs_review, r.error_code, r.error_fields
      from recruitment_candidate_import_row r
      left join recruitment_candidate c on c.id = r.candidate_id
      left join recruitment_job_opening j on j.id = r.job_id
      where r.import_id = ${importId}::uuid and r.row_num >= ${Math.max(2, Math.trunc(opts.fromRow ?? 2))}
        ${opts.problemsOnly ? sql`and (r.outcome <> 'created' or r.possible_duplicate or r.needs_review or r.job_result not in ('applied', 'no_job'))` : sql``}
      order by r.row_num limit ${limit}`);
    return rows.map((r) => ({
      rowNum: r.row_num, outcome: r.outcome, candidateId: r.candidate_id, candidateName: r.destroyed ? null : r.full_name, applicationId: r.application_id,
      jobTitle: r.title, jobNumber: r.job_number, jobResult: r.job_result, possibleDuplicate: r.possible_duplicate, needsReview: r.needs_review,
      errorCode: r.error_code, errorFields: (r.error_fields ?? []).map((x) => { const [field, code] = x.split('|'); return { field, code: code ?? 'invalid' }; }),
    }));
  }, { readOnlySnapshot: true });
}

export type RecentImport = { importId: string; companyId: string; createdAt: string; fileRows: number; outcome: CandidateImportJob['outcome']; active: boolean };
/** The caller's own recent imports (newest first), to rejoin a running one. Read-only. */
export async function recentCandidateImports(s: SessionContext, companyIds: readonly string[]): Promise<RecentImport[]> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length || !s.userId) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const jobs = await listBulkJobsTx(tx, s, CANDIDATE_IMPORT_KIND, 10);
    const rows = await tx.execute<{ id: string; company_id: string; created_at: string; file_rows: number; outcome: RecentImport['outcome'] }>(sql`
      select id, company_id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, file_rows, outcome
      from recruitment_candidate_import where tenant_id = ${s.tenantId}::uuid and created_by_user_id = ${s.userId}::uuid
        and company_id = any(${uuidArray(ids)}::uuid[]) order by created_at desc, id limit 10`);
    return rows.map((r) => ({ importId: r.id, companyId: r.company_id, createdAt: r.created_at, fileRows: r.file_rows, outcome: r.outcome,
      active: jobs.some((j) => j.id === r.id && bulkJobActive(j.state)) }));
  }, { readOnlySnapshot: true });
}

// ── The worker's per-row work (core/recruitment-candidate-import-worker.ts) ───────────────────────────────────

export type ImportStepPayload =
  | { rowNum: number; values: ImportValues; custom: RawCustomValues }
  | { rowNum: number; issues: RowIssue[] };
export type ImportStep = { kind: 'row' | 'invalid'; rowNum: number; payload: ImportStepPayload };
/** A job's file, read once by the worker under the importer's authority: every row as a step, in file order. */
export async function prepareCandidateImport(s: SessionContext, job: { id: string; input: unknown; source_content: Buffer | null; source_hash: string | null }):
  Promise<{ steps: ImportStep[] } | { refused: string }> {
  const input = job.input as CandidateImportJobInput | null;
  if (!input || !isUuid(input.companyId) || !input.permissionConfirmed) return { refused: 'The import could not be started. Start it again from the preview.' };
  if (!job.source_content || job.source_hash !== input.previewHash) return { refused: 'The file is not the one that was previewed. Upload it again.' };
  const text = job.source_content.toString('utf8');
  return withRecruitmentTenant(s, async (tx) => {
    await assertOperatesCompanyTx(tx, input.companyId);
    const [rec] = await tx.execute<{ id: string }>(sql`select id from recruitment_candidate_import where id = ${job.id}::uuid and company_id = ${input.companyId}::uuid
      and outcome is null`);
    if (!rec) return { refused: 'The import record is unavailable.' };
    try {
      const parsed = parseCandidateImport(text, await importFieldsTx(tx, s, input.companyId), { required: false });
      return {
        steps: parsed.rows.map((r): ImportStep => (r.values
          ? { kind: 'row', rowNum: r.rowNum, payload: { rowNum: r.rowNum, values: r.values, custom: r.custom } }
          : { kind: 'invalid', rowNum: r.rowNum, payload: { rowNum: r.rowNum, issues: r.issues } })),
      };
    } catch (e) {
      if (e instanceof ImportFileRefusal) return { refused: 'The file can no longer be read as an import file. Check it and upload it again.' };
      throw e;
    }
  });
}

type RowRecord = {
  outcome: 'created' | 'failed' | 'invalid'; candidateId?: string | null; applicationId?: string | null; jobId?: string | null; jobResult?: JobResult | null;
  possibleDuplicate?: boolean; needsReview?: boolean; errorCode?: string | null; errorFields?: string[];
};
async function recordRowTx(tx: Tx, s: SessionContext, importId: string, companyId: string, rowNum: number, r: RowRecord): Promise<void> {
  await tx.execute(sql`insert into recruitment_candidate_import_row (import_id, tenant_id, company_id, row_num, outcome, candidate_id, application_id, job_id, job_result,
      possible_duplicate, needs_review, error_code, error_fields)
    values (${importId}::uuid, ${s.tenantId}::uuid, ${companyId}::uuid, ${rowNum}, ${r.outcome}, ${r.candidateId ?? null}::uuid, ${r.applicationId ?? null}::uuid,
      ${r.jobId ?? null}::uuid, ${r.jobResult ?? null}, ${r.possibleDuplicate ?? false}, ${r.needsReview ?? false}, ${r.errorCode ?? null},
      ${`{${(r.errorFields ?? []).map((f) => `"${f.replace(/["\\]/g, '')}"`).join(',')}}`}::text[])`);
}
const issueKeys = (issues: readonly RowIssue[]) => issues.map((i) => `${i.field}|${i.code}`.slice(0, 120));
/** A database refusal of a row, as one of the service's codes (never SQL or a value). */
function rowRefusal(e: unknown): string {
  if (e instanceof RecruitmentError) return e.code;
  const state = pgSqlState(e);
  if (state === '42501') return 'forbidden';
  if (state === '23505') return 'duplicate_application';
  if (state === '23514' || state === '23502' || state === '22001' || state === '23503') return 'invalid_input';
  return 'refused';
}
const transient = (e: unknown) => ['40P01', '40001', '55P03', '53300', '57P03'].includes(pgSqlState(e) ?? '');

export type ImportRowOutcome = { result: { outcome: RowRecord['outcome']; candidateId: string | null; applicationId: string | null }; counters: Record<string, number> };
/**
 * One file row, inside the worker's chunk transaction (the kernel's savepoint), under the importer's authority. Never throws for a
 * row the database or the rules refuse: the row's own savepoint is rolled back and the refusal recorded (D-055). A transient
 * database refusal (deadlock, serialization, lock timeout) is thrown so the kernel retries the chunk.
 */
export async function importCandidateRowTx(tx: Tx, s: SessionContext, ref: { importId: string; companyId: string }, step: ImportStep,
  cache: Map<string, unknown>): Promise<ImportRowOutcome> {
  const { importId, companyId } = ref;
  if (step.kind === 'invalid') {
    const payload = step.payload as { rowNum: number; issues: RowIssue[] };
    await recordRowTx(tx, s, importId, companyId, step.rowNum, { outcome: 'invalid', errorCode: 'invalid_row', errorFields: issueKeys(payload.issues) });
    return { result: { outcome: 'invalid', candidateId: null, applicationId: null }, counters: { invalid: 1 } };
  }
  const { values, custom } = step.payload as { rowNum: number; values: ImportValues; custom: RawCustomValues };
  const user = actorId(s);
  // The caller's administration of the company: resolved once per chunk transaction (the worker clears `cache` at every chunk).
  let admin = cache.get('admin') as boolean | undefined;
  if (admin === undefined) { admin = (await assertOperatesCompanyTx(tx, companyId)).admin; cache.set('admin', admin); }
  // The job, read for THIS row (never from an earlier row or chunk): a job closed, put on hold or no longer operable since the file
  // was read sends the row to To assign with that job result, rather than refusing it.
  const job = values.jobNumber ? (await jobsByNumberTx(tx, s, companyId, [values.jobNumber])).get(values.jobNumber) : undefined;
  const usable = jobResultOf(values.jobNumber, job);
  if (usable !== 'usable' && !admin) {
    const needs = needsJobIssues(values, custom);
    if (needs.length) {
      await recordRowTx(tx, s, importId, companyId, step.rowNum, { outcome: 'invalid', errorCode: 'needs_job', errorFields: issueKeys(needs), jobResult: usable });
      return { result: { outcome: 'invalid', candidateId: null, applicationId: null }, counters: { invalid: 1 } };
    }
  }
  // Slice 14's required rule applies to every row that gets an application and every row an administrator imports — whether or
  // not the row carries other custom values (a recruiter's To assign row is completed by whoever assigns it).
  const checkCustom = usable === 'usable' || admin;
  if (checkCustom) {
    let fields = cache.get('fields') as ImportField[] | undefined;
    if (!fields) { fields = await importFieldsTx(tx, s, companyId); cache.set('fields', fields); }
    const missing = requiredIssues(fields, custom);
    if (missing.length) {
      await recordRowTx(tx, s, importId, companyId, step.rowNum, { outcome: 'invalid', errorCode: 'invalid_row', errorFields: issueKeys(missing), jobResult: usable === 'usable' ? null : usable });
      return { result: { outcome: 'invalid', candidateId: null, applicationId: null }, counters: { invalid: 1 } };
    }
  }
  try {
    const done = await tx.transaction(async (sp) => {
      // Slice 5's rule, as the early-exit flags (a name shared by thousands of candidates is never aggregated).
      const [dup] = await sp.execute<{ n: number }>(sql`select count(*)::int as n from app.recruitment_candidate_duplicate_flags(${companyId}::uuid,
        ${JSON.stringify([{ k: 0, n: values.fullName, e: values.email, m: values.phone, i: values.idNumber }])}::jsonb)`);
      const candidateId = randomUUID();
      await sp.insert(recruitmentCandidate).values({
        id: candidateId, tenantId: s.tenantId, companyId, fullName: values.fullName, email: values.email, phone: values.phone, source: values.source,
        ownerUserId: user, createdByUserId: user, updatedByUserId: user,
      });
      let applicationId: string | null = null;
      if (usable === 'usable' && job) {
        const start = firstStage(await processStagesTx(sp, job.processId));
        if (!start) throw new RecruitmentError('process_unavailable');
        applicationId = await insertApplicationTx(sp, {
          tenantId: s.tenantId, companyId, jobId: job.id, candidateId, currentStageId: start, source: values.source, createdByUserId: user, updatedByUserId: user,
        });
        await sp.insert(recruitmentApplicationEvent).values({ tenantId: s.tenantId, companyId, applicationId, actorUserId: user, ...appliedEvent(start) });
      }
      if (values.idNumber) {
        await sp.insert(recruitmentCandidateRestricted).values({ tenantId: s.tenantId, companyId, candidateId, idType: values.idType, idNumber: values.idNumber, updatedByUserId: user });
      }
      if (checkCustom) await saveRecordCustomValuesTx(sp, s, 'candidate', { id: candidateId, companyId }, custom);
      if (values.notes) {
        await sp.execute(sql`insert into recruitment_candidate_import_note (candidate_id, tenant_id, company_id, import_id, note, created_by_user_id)
          values (${candidateId}::uuid, ${s.tenantId}::uuid, ${companyId}::uuid, ${importId}::uuid, ${values.notes}, ${user}::uuid)`);
      }
      if (!applicationId) {
        await sp.execute(sql`insert into recruitment_to_assign (candidate_id, tenant_id, company_id, import_id, job_title_as_written, possible_duplicate, created_by_user_id)
          values (${candidateId}::uuid, ${s.tenantId}::uuid, ${companyId}::uuid, ${importId}::uuid, ${values.jobTitle}, ${Number(dup?.n ?? 0) > 0}, ${user}::uuid)`);
      }
      let needsReview = false;
      if (applicationId) {
        // Slice 13's blocked-list matching runs at commit (a deferred constraint trigger, so the ID number written after the
        // application is seen). Run it now for this application, then defer it again for the next row, so the row records its flag.
        await sp.execute(sql`set constraints public.recruitment_application_blocked_match immediate`);
        await sp.execute(sql`set constraints public.recruitment_application_blocked_match deferred`);
        const [mark] = await sp.execute<{ r: boolean }>(sql`select app.recruitment_application_needs_review(${applicationId}::uuid) as r`);
        needsReview = mark?.r === true;
      }
      const possibleDuplicate = Number(dup?.n ?? 0) > 0;
      await recordRowTx(sp, s, importId, companyId, step.rowNum, { outcome: 'created', candidateId, applicationId, jobId: applicationId ? job!.id : job?.id ?? null,
        jobResult: applicationId ? 'applied' : usable === 'usable' ? 'no_job' : usable, possibleDuplicate, needsReview });
      return { candidateId, applicationId, possibleDuplicate, needsReview };
    });
    return {
      result: { outcome: 'created', candidateId: done.candidateId, applicationId: done.applicationId },
      counters: { created: 1, ...(done.applicationId ? { applications: 1 } : { toAssign: 1 }), ...(done.possibleDuplicate ? { possibleDuplicates: 1 } : {}),
        ...(done.needsReview ? { needsReview: 1 } : {}) },
    };
  } catch (e) {
    if (transient(e)) throw e;
    await recordRowTx(tx, s, importId, companyId, step.rowNum, { outcome: 'failed', errorCode: rowRefusal(e), jobResult: usable === 'usable' ? null : usable });
    return { result: { outcome: 'failed', candidateId: null, applicationId: null }, counters: { failed: 1 } };
  }
}

/** The import's ending, once (a repeated call changes nothing): the record's outcome and one event with counts only. */
export async function finishCandidateImportTx(tx: Tx, s: SessionContext, importId: string, outcome: 'completed' | 'cancelled' | 'failed'): Promise<ImportCounters | null> {
  // Only while the importer may still write the record (else the worker's owner settle ends it: app.recruitment_settle_candidate_import).
  const [own] = await tx.execute<{ company_id: string; operates: boolean }>(sql`select company_id, app.recruitment_operates_in_company(company_id) as operates
    from recruitment_candidate_import where id = ${importId}::uuid and outcome is null and created_by_user_id = app.current_user_id()`);
  if (!own?.operates) return null;
  // A step the kernel itself refused (it threw past its retries) still gets its row, so the results stay row for row.
  await tx.execute(sql`insert into recruitment_candidate_import_row (import_id, tenant_id, company_id, row_num, outcome, error_code)
    select ${importId}::uuid, ${s.tenantId}::uuid, ${own.company_id}::uuid, st.row_num, 'failed', 'refused' from bulk_job_step st
    where st.job_id = ${importId}::uuid and st.state = 'failed' and st.row_num is not null
    on conflict (import_id, row_num) do nothing`);
  const [rec] = await tx.execute<{ company_id: string }>(sql`update recruitment_candidate_import set outcome = ${outcome}
    where id = ${importId}::uuid and outcome is null returning company_id`);
  if (!rec) return null;
  const [c] = await tx.execute<Record<string, number>>(sql`select count(*)::int as rows,
    count(*) filter (where outcome = 'created')::int as created, count(*) filter (where application_id is not null)::int as applications,
    count(*) filter (where outcome = 'created' and application_id is null)::int as "toAssign", count(*) filter (where possible_duplicate)::int as "possibleDuplicates",
    count(*) filter (where needs_review)::int as "needsReview", count(*) filter (where outcome = 'failed')::int as failed,
    count(*) filter (where outcome = 'invalid')::int as invalid
    from recruitment_candidate_import_row where import_id = ${importId}::uuid`);
  const counters = countersOf(c);
  await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-import', aggregateId: importId, eventType: 'recruitment-import.finished',
    actor: actorOf(s), payload: { companyId: rec.company_id, importId, outcome, ...counters } });
  return counters;
}

// ── The To assign list (EV-066) ──────────────────────────────────────────────────────────────────────────────

export type ToAssignEntry = {
  candidateId: string; name: string; email: string | null; phone: string | null; source: string | null; jobTitleAsWritten: string | null;
  importedAt: string; importedBy: string | null; note: string | null; hidden: boolean; possibleDuplicate: boolean;
};
export type ToAssignList = {
  companyId: string; groups: { title: string | null; entries: ToAssignEntry[] }[]; total: number; hiddenCount: number; showingHidden: boolean;
  jobs: { id: string; title: string; jobNumber: string }[]; truncated: boolean;
};
export const TO_ASSIGN_LIST_MAX = 500;
export const TO_ASSIGN_COUNT_CAP = 10000;
/**
 * The company's candidates with no application (the To assign markers the caller may read: the company's operators), grouped by
 * the job title as written (no title last), newest first, with source, import date and importer; hidden ones only on request. The
 * Open jobs offered for "Assign to job" are those the caller may add applications to. Read-only.
 */
export async function toAssignList(s: SessionContext, companyId: unknown, opts: { hidden?: boolean } = {}): Promise<ToAssignList> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertOperatesCompanyTx(tx, companyId);
    const cid = companyId as string;
    const rows = await tx.execute<{ candidate_id: string; full_name: string; email: string | null; phone: string | null; source: string | null; title: string | null;
      created_at: string; created_by: string; hidden: boolean; note: string | null; dup: boolean | null }>(sql`
      select t.candidate_id, c.full_name, c.email, c.phone, c.source, t.job_title_as_written as title,
        to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, t.created_by_user_id as created_by, t.hidden_at is not null as hidden,
        n.note, t.possible_duplicate as dup
      from recruitment_to_assign t
      join recruitment_candidate c on c.id = t.candidate_id and c.destroyed_at is null
      left join recruitment_candidate_import_note n on n.candidate_id = t.candidate_id
      where t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${cid}::uuid and (t.hidden_at is null) = ${!opts.hidden}
      order by t.created_at desc, t.candidate_id limit ${TO_ASSIGN_LIST_MAX + 1}`);
    // Counted after the one access check above, each stopping at TO_ASSIGN_COUNT_CAP (shown as "N+" beyond it).
    const counted = (hidden: boolean) => sql`(select count(*)::int from (select 1 from recruitment_to_assign where tenant_id = ${s.tenantId}::uuid
      and company_id = ${cid}::uuid and (hidden_at is null) = ${!hidden} limit ${TO_ASSIGN_COUNT_CAP}) x)`;
    const [counts] = await tx.execute<{ shown: number; hidden: number }>(sql`select ${counted(false)} as shown, ${counted(true)} as hidden`);
    const names = rows.length ? await userLabelsTx(tx, cid) : new Map<string, { name: string }>();
    const jobs = await tx.execute<{ id: string; title: string; job_number: string }>(sql`
      select j.id, j.title, j.job_number from recruitment_job_opening j where j.tenant_id = ${s.tenantId}::uuid and j.company_id = ${cid}::uuid and j.status = 'open'
        and app.can_operate_recruitment_job(j.company_id, j.id) order by j.title, j.job_number`);
    const entries = rows.slice(0, TO_ASSIGN_LIST_MAX).map((r): ToAssignEntry => ({
      candidateId: r.candidate_id, name: r.full_name, email: r.email, phone: r.phone, source: r.source, jobTitleAsWritten: r.title, importedAt: r.created_at,
      importedBy: names.get(r.created_by)?.name ?? null, note: r.note, hidden: r.hidden, possibleDuplicate: r.dup === true,
    }));
    const groups = new Map<string, ToAssignEntry[]>();
    for (const e of entries) {
      const key = e.jobTitleAsWritten ? e.jobTitleAsWritten.toLowerCase() : '';
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return {
      companyId: cid, total: counts?.shown ?? 0, hiddenCount: counts?.hidden ?? 0, showingHidden: opts.hidden === true, truncated: rows.length > TO_ASSIGN_LIST_MAX,
      groups: [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([, list]) => ({ title: list[0].jobTitleAsWritten, entries: list })),
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number })),
    };
  }, { readOnlySnapshot: true });
}

/** A To assign candidate the caller may work (the marker is readable only by the company's operators). */
async function toAssignCandidateTx(tx: Tx, s: SessionContext, candidateId: unknown) {
  if (!isUuid(candidateId)) throw new RecruitmentError('not_found');
  const [row] = await tx.execute<{ company_id: string; destroyed: boolean; source: string | null }>(sql`select t.company_id, c.destroyed_at is not null as destroyed, c.source
    from recruitment_to_assign t join recruitment_candidate c on c.id = t.candidate_id where t.candidate_id = ${candidateId}::uuid and t.tenant_id = ${s.tenantId}::uuid`);
  if (!row) throw new RecruitmentError('not_to_assign');
  await assertOperatesCompanyTx(tx, row.company_id);
  if (row.destroyed) throw new RecruitmentError('candidate_removed');
  return row;
}

/**
 * "Assign to job": a normal application on an Open job of the candidate's company that the caller may add applications to, at its
 * first enabled stage — the repeat window and slice 13's blocked-list matching (at commit) apply as for any application; the
 * candidate is never merged with another. The database takes the candidate off the To assign list (5217).
 */
export async function assignToJob(s: SessionContext, candidateId: unknown, jobId: unknown): Promise<{ applicationId: string }> {
  const user = actorId(s);
  if (!isUuid(jobId)) throw new RecruitmentError('missing_fields', ['job']);
  return withRecruitmentTenant(s, async (tx) => {
    // The candidate's lock first (the 5205 order: candidate, then the application's own locks), so a removal never interleaves.
    if (isUuid(candidateId)) await tx.execute(sql`select pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(${s.tenantId}::uuid, ${candidateId}::uuid))`);
    const c = await toAssignCandidateTx(tx, s, candidateId);
    const [job] = await tx.execute<{ id: string; company_id: string; status: string; process_id: string; operate: boolean }>(sql`
      select j.id, j.company_id, j.status, j.process_id, app.can_operate_recruitment_job(j.company_id, j.id) as operate from recruitment_job_opening j
      where j.id = ${jobId}::uuid and j.tenant_id = ${s.tenantId}::uuid`);
    if (!job || job.company_id !== c.company_id) throw new RecruitmentError('not_found');
    if (!job.operate) throw new RecruitmentError('forbidden');
    if (job.status !== 'open') throw new RecruitmentError('job_not_open');
    await assertNotRepeatedTx(tx, job.company_id, candidateId as string, job.id);
    const start = firstStage(await processStagesTx(tx, job.process_id));
    if (!start) throw new RecruitmentError('process_unavailable');
    const applicationId = await insertApplicationTx(tx, {
      tenantId: s.tenantId, companyId: job.company_id, jobId: job.id, candidateId: candidateId as string, currentStageId: start, source: c.source,
      createdByUserId: user, updatedByUserId: user,
    });
    await tx.insert(recruitmentApplicationEvent).values({ tenantId: s.tenantId, companyId: job.company_id, applicationId, actorUserId: user, ...appliedEvent(start) });
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: applicationId, eventType: 'recruitment-to-assign.assigned',
      actor: actorOf(s), payload: { companyId: job.company_id, candidateId, jobId: job.id } });
    return { applicationId };
  });
}

/** "Remove from list" (hidden: true) and "Show again" (false). Nothing is deleted or archived; the candidate stays a candidate. */
export async function setToAssignHidden(s: SessionContext, candidateId: unknown, hidden: boolean): Promise<void> {
  actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await toAssignCandidateTx(tx, s, candidateId);
    const changed = await tx.execute<{ candidate_id: string }>(sql`update recruitment_to_assign set hidden_at = ${hidden ? sql`now()` : sql`null`}
      where candidate_id = ${candidateId as string}::uuid and (hidden_at is null) = ${hidden} returning candidate_id`);
    if (changed.length) {
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-candidate', aggregateId: candidateId as string,
        eventType: hidden ? 'recruitment-to-assign.hidden' : 'recruitment-to-assign.shown', actor: actorOf(s), payload: { companyId: c.company_id, candidateId } });
    }
  });
}
