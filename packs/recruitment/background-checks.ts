/**
 * Recruitment slice 12 — background checks (docs/recruitment-reconstruction/specification.md "Slice 12"). Reached from
 * outside the pack ONLY through ./service.
 *
 * HR records checks a provider runs outside AI HR (D-043). Who does what:
 *   check types (Settings)                 — recruitment administrators;
 *   add, authorise, start, complete, cancel, read everything, upload and download files
 *                                          — the job's recruiter and assistants, and recruitment administrators;
 *   types, status, outcome and dates       — also the job's hiring managers (D-045);
 *   anything else                          — nobody (an interviewer, approver or referrer gets "forbidden", which the
 *                                            application page turns into no Background checks tab at all).
 * A check the removal of the candidate's personal data cancelled shows as Cancelled with `systemCancelled` (5212).
 * Every entry point runs inside `withRecruitmentTenant` as the caller, under the caller's own row security (5212): the
 * restricted details and files are in tables whose only policies admit the job's operators and administrators, so a
 * hiring manager's read cannot return them whatever this code asks. The service checks first for a clear refusal; the 5212
 * guards refuse the same again (status machine, authorisation first, outcome to complete, final states, the stage rule).
 * Audit events carry ids, status codes and the file kind — never a summary, outcome, provider, reference or file name.
 * Read paths write nothing (they work in read-only transactions). Dates come from lib/hr-date (Kuala Lumpur).
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { resolveDocumentUpload } from '../../core/employee-documents';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type ApplicationState, type RecruitmentErrorCode } from './model';
import {
  CHECK_FILE_MAX_BYTES, DEFAULT_CHECK_TYPES, canMoveCheck, checkOverdue, checkStageAllowed, checkStatusCounts, fileMimeAllowed,
  isFinalCheck, validateAddCheckInput, validateAuthorisationInput, validateCancelInput, validateCheckTypeInput, validateCompleteInput,
  type AddCheckInput, type AuthorisationInput, type AuthorisationMethod, type CheckFileKind, type CheckOutcome, type CheckStatus, type CompleteInput,
} from './background-check-model';
import { actorId, assertCompanyTx, jobLevelTx, userLabelsTx, uuidArray } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const klDay = (d: Date | string) => todayInKualaLumpur(new Date(d));
const event = (tx: Tx, s: SessionContext, applicationId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: applicationId, eventType, actor: actorOf(s), payload });
const settingsEvent = (tx: Tx, s: SessionContext, typeId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-background-check-type', aggregateId: typeId, eventType, actor: actorOf(s), payload });

/** The CHECK-style name a guard gave its refusal (RAISE … CONSTRAINT), from the error or its causes. */
const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};
/** A database refusal as a stable code: a named guard rule first, then the SQLSTATE (the message is never shown or logged). */
const NAMED: Record<string, RecruitmentErrorCode> = {
  recruitment_background_check_application_active: 'application_closed',
  recruitment_background_check_stage: 'check_stage',
  recruitment_background_check_final: 'check_closed',
  recruitment_background_check_transition: 'check_state',
  recruitment_background_check_authorisation: 'authorisation_required',
  recruitment_background_check_authorisation_once: 'check_state',
  recruitment_background_check_authorisation_date: 'invalid_input',
  recruitment_background_check_outcome: 'missing_fields',
  recruitment_background_check_cancel_reason: 'missing_fields',
  recruitment_background_check_type_enabled: 'check_type_unavailable',
  recruitment_background_check_types_fixed: 'check_state',
  recruitment_background_check_file_status: 'check_state',
  recruitment_background_check_type_name_uq: 'name_taken',
  recruitment_background_check_file_kind_uq: 'check_state',
};
const asError = (e: unknown, map: Record<string, RecruitmentErrorCode> = {}): never => {
  const named = constraintOf(e);
  if (named && NAMED[named]) throw new RecruitmentError(NAMED[named]);
  const code = pgSqlState(e);
  if (code && map[code]) throw new RecruitmentError(map[code]);
  throw e;
};
const DB_MAP: Record<string, RecruitmentErrorCode> = { '42501': 'forbidden', '23514': 'check_state', '23505': 'name_taken', '23503': 'type_in_use' };

// ── Check types (administrators) ─────────────────────────────────────────────────────────────────────────────

export type BackgroundCheckTypeRow = {
  id: string; name: string; description: string | null; enabled: boolean; used: number; updatedBy: string | null; updatedAt: string;
};
export type BackgroundCheckTypes = {
  companyId: string; types: BackgroundCheckTypeRow[];
  /** The company has no type yet: the six defaults are offered (nothing is created until an administrator adds them). */
  defaultsOffered: boolean;
};
/** Settings › Background checks: the company's types with how many checks use each (administrators). Read-only. */
export async function backgroundCheckTypes(s: SessionContext, companyId: string): Promise<BackgroundCheckTypes> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<{ id: string; name: string; description: string | null; enabled: boolean; used: number; updated_by_user_id: string; updated_at: string | Date }>(sql`
      select t.id, t.name, t.description, t.enabled, t.updated_by_user_id, t.updated_at,
        (select count(*)::int from recruitment_background_check_type_link l where l.type_id = t.id) as used
      from recruitment_background_check_type t where t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${companyId}::uuid
      order by lower(t.name), t.id`);
    const labels = rows.length ? await userLabelsTx(tx, companyId) : new Map();
    return {
      companyId, defaultsOffered: rows.length === 0,
      types: rows.map((r) => ({
        id: r.id, name: r.name, description: r.description, enabled: r.enabled, used: r.used,
        updatedBy: labels.get(r.updated_by_user_id)?.name ?? null, updatedAt: iso(r.updated_at),
      })),
    };
  });
}

/** Add (with `companyId`) or change (with `id`) a type: name unique in the company (≤80), description (≤500), enabled. */
export async function saveBackgroundCheckType(s: SessionContext, input: { id?: unknown; companyId?: unknown; name?: unknown; description?: unknown; enabled?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateCheckTypeInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  return withRecruitmentTenant(s, async (tx) => {
    if (input.id) {
      if (!isUuid(input.id)) throw new RecruitmentError('not_found');
      const [t] = await tx.execute<{ id: string; company_id: string }>(sql`select id, company_id from recruitment_background_check_type
        where id = ${input.id}::uuid and tenant_id = ${s.tenantId}::uuid`);
      if (!t) throw new RecruitmentError('not_found');
      await assertCompanyTx(tx, t.company_id);
      await tx.execute(sql`update recruitment_background_check_type set name = ${v.value.name}, description = ${v.value.description},
        enabled = ${v.value.enabled}, updated_by_user_id = ${user}::uuid where id = ${t.id}::uuid`).catch((e) => asError(e, DB_MAP));
      await settingsEvent(tx, s, t.id, 'recruitment-background-check-type.changed', { companyId: t.company_id, enabled: v.value.enabled });
      return { id: t.id };
    }
    const companyId = typeof input.companyId === 'string' ? input.companyId : '';
    await assertCompanyTx(tx, companyId);
    const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_background_check_type
      (tenant_id, company_id, name, description, enabled, created_by_user_id, updated_by_user_id)
      values (${s.tenantId}::uuid, ${companyId}::uuid, ${v.value.name}, ${v.value.description}, ${v.value.enabled}, ${user}::uuid, ${user}::uuid) returning id`)
      .catch((e) => asError(e, DB_MAP));
    await settingsEvent(tx, s, row.id, 'recruitment-background-check-type.added', { companyId, enabled: v.value.enabled });
    return row;
  });
}

/** Delete a type no check uses (a used one can only be disabled; the link's foreign key refuses too). */
export async function deleteBackgroundCheckType(s: SessionContext, typeId: unknown): Promise<void> {
  actorId(s);
  if (!isUuid(typeId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [t] = await tx.execute<{ id: string; company_id: string; used: boolean }>(sql`select t.id, t.company_id,
      exists (select 1 from recruitment_background_check_type_link l where l.type_id = t.id) as used
      from recruitment_background_check_type t where t.id = ${typeId}::uuid and t.tenant_id = ${s.tenantId}::uuid for update`);
    if (!t) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, t.company_id);
    if (t.used) throw new RecruitmentError('type_in_use');
    await tx.execute(sql`delete from recruitment_background_check_type where id = ${t.id}::uuid`).catch((e) => asError(e, DB_MAP));
    await settingsEvent(tx, s, t.id, 'recruitment-background-check-type.deleted', { companyId: t.company_id });
  });
}

/** "Add these types": the six defaults, for a company that has none (each skipped when its seed or name already exists). */
export async function addDefaultBackgroundCheckTypes(s: SessionContext, companyId: string): Promise<{ added: number }> {
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    let added = 0;
    for (const d of DEFAULT_CHECK_TYPES) {
      const rows = await tx.execute<{ id: string }>(sql`insert into recruitment_background_check_type
        (tenant_id, company_id, name, seed_key, created_by_user_id, updated_by_user_id)
        select ${s.tenantId}::uuid, ${companyId}::uuid, ${d.name}, ${d.seedKey}, ${user}::uuid, ${user}::uuid
        where not exists (select 1 from recruitment_background_check_type x where x.tenant_id = ${s.tenantId}::uuid and x.company_id = ${companyId}::uuid
          and (x.seed_key = ${d.seedKey} or lower(btrim(x.name)) = lower(btrim(${d.name}))))
        on conflict do nothing returning id`).catch((e) => asError(e, DB_MAP));
      if (rows.length) {
        added += 1;
        await settingsEvent(tx, s, rows[0].id, 'recruitment-background-check-type.added', { companyId, enabled: true, seedKey: d.seedKey });
      }
    }
    return { added };
  });
}

// ── Recording a check (the job's operators and administrators) ───────────────────────────────────────────────

type CheckRow = { id: string; company_id: string; job_id: string; application_id: string; status: CheckStatus };

/** A check the caller OPERATES (row-locked), else not_found (cannot see it) or forbidden (a hiring manager). */
async function operatedCheckTx(tx: Tx, s: SessionContext, checkId: unknown): Promise<CheckRow> {
  if (!isUuid(checkId)) throw new RecruitmentError('not_found');
  const [c] = await tx.execute<CheckRow>(sql`select id, company_id, job_id, application_id, status from recruitment_background_check
    where id = ${checkId}::uuid and tenant_id = ${s.tenantId}::uuid`);
  if (!c) throw new RecruitmentError('not_found');
  const access = await jobLevelTx(tx, c.company_id, c.job_id);
  if (!access.operate) throw new RecruitmentError('forbidden');
  const [locked] = await tx.execute<CheckRow>(sql`select id, company_id, job_id, application_id, status from recruitment_background_check
    where id = ${c.id}::uuid for update`).catch((e) => asError(e, DB_MAP));
  return locked;
}
function assertCanMove(c: CheckRow, to: CheckStatus): void {
  if (isFinalCheck(c.status)) throw new RecruitmentError('check_closed');
  if (!canMoveCheck(c.status, to)) throw new RecruitmentError('check_state');
}

/** A file as the service accepts it: bytes, a name, and the uploader's confirmation that the candidate permitted storing it. */
export type CheckFileInput = { fileName?: unknown; content?: unknown; permissionConfirmed?: unknown };
/** Validate a file (type read from its own bytes and cross-checked with its extension; 10 MB); null when none was sent. */
function checkFile(kind: CheckFileKind, file: CheckFileInput | undefined): { fileName: string; mimeType: string; content: Buffer } | null {
  if (!file) return null;
  const content = Buffer.isBuffer(file.content) ? file.content : null;
  if (!content || content.byteLength === 0) return null;
  const fileName = typeof file.fileName === 'string' ? file.fileName.trim().slice(-200) : '';
  if (!fileName) throw new RecruitmentError('missing_fields', ['file']);
  if (!(file.permissionConfirmed === true || file.permissionConfirmed === 'on' || file.permissionConfirmed === 'true')) throw new RecruitmentError('permission_required');
  if (content.byteLength > CHECK_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
  let mimeType: string;
  try {
    ({ mimeType } = resolveDocumentUpload(fileName, content));
  } catch {
    throw new RecruitmentError('file_type');
  }
  if (!fileMimeAllowed(kind, mimeType)) throw new RecruitmentError('file_type');
  return { fileName, mimeType, content };
}
async function insertFileTx(tx: Tx, s: SessionContext, c: CheckRow, kind: CheckFileKind, f: { fileName: string; mimeType: string; content: Buffer }): Promise<string> {
  const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_background_check_file
    (tenant_id, company_id, job_id, application_id, check_id, kind, file_name, mime_type, size_bytes, content, permission_confirmed, uploaded_by_user_id)
    values (${s.tenantId}::uuid, ${c.company_id}::uuid, ${c.job_id}::uuid, ${c.application_id}::uuid, ${c.id}::uuid, ${kind}, ${f.fileName}, ${f.mimeType},
      ${f.content.byteLength}, ${f.content}, true, ${actorId(s)}::uuid) returning id`).catch((e) => asError(e, DB_MAP));
  await event(tx, s, c.application_id, 'recruitment-application.background-check-file-uploaded', { companyId: c.company_id, jobId: c.job_id, checkId: c.id, fileId: row.id, kind });
  return row.id;
}
async function moveTx(tx: Tx, s: SessionContext, c: CheckRow, to: CheckStatus, outcome: CheckOutcome | null = null): Promise<void> {
  await tx.execute(sql`update recruitment_background_check set status = ${to}, outcome = ${outcome}, status_changed_by_user_id = ${actorId(s)}::uuid
    where id = ${c.id}::uuid`).catch((e) => asError(e, DB_MAP));
  await event(tx, s, c.application_id, 'recruitment-application.background-check-status-changed', { companyId: c.company_id, jobId: c.job_id, checkId: c.id, from: c.status, to });
}

/**
 * "Add background check" (case 83): on an ACTIVE application the caller operates, at or after the job's Offer stage or at a
 * stage named for background checks; one or more ENABLED types of the company, the provider and an optional reference.
 * Starts Awaiting authorisation.
 */
export async function addBackgroundCheck(s: SessionContext, input: AddCheckInput): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateAddCheckInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  return withRecruitmentTenant(s, async (tx) => {
    const a = await applicationStageTx(tx, s, v.value.applicationId);
    if (!a) throw new RecruitmentError('not_found');
    const access = await jobLevelTx(tx, a.company_id, a.job_id, a.id);
    if (!access.operate) throw new RecruitmentError(access.read ? 'forbidden' : 'not_found');
    if (a.state !== 'active') throw new RecruitmentError('application_closed');
    if (!checkStageAllowed(stageOf(a))) throw new RecruitmentError('check_stage');
    const types = await tx.execute<{ id: string }>(sql`select id from recruitment_background_check_type
      where id = any(${uuidArray(v.value.typeIds)}::uuid[]) and tenant_id = ${s.tenantId}::uuid and company_id = ${a.company_id}::uuid and enabled`);
    if (types.length !== v.value.typeIds.length) throw new RecruitmentError('check_type_unavailable');
    const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_background_check
      (tenant_id, company_id, job_id, application_id, created_by_user_id, status_changed_by_user_id)
      values (${s.tenantId}::uuid, ${a.company_id}::uuid, ${a.job_id}::uuid, ${a.id}::uuid, ${user}::uuid, ${user}::uuid) returning id`)
      .catch((e) => asError(e, DB_MAP));
    for (const typeId of [...v.value.typeIds].sort()) {
      await tx.execute(sql`insert into recruitment_background_check_type_link (check_id, type_id, tenant_id, company_id, job_id, application_id)
        values (${row.id}::uuid, ${typeId}::uuid, ${s.tenantId}::uuid, ${a.company_id}::uuid, ${a.job_id}::uuid, ${a.id}::uuid)`).catch((e) => asError(e, DB_MAP));
    }
    await tx.execute(sql`insert into recruitment_background_check_detail (check_id, tenant_id, company_id, job_id, application_id, provider, provider_reference, updated_by_user_id)
      values (${row.id}::uuid, ${s.tenantId}::uuid, ${a.company_id}::uuid, ${a.job_id}::uuid, ${a.id}::uuid, ${v.value.provider}, ${v.value.providerReference}, ${user}::uuid)`)
      .catch((e) => asError(e, DB_MAP));
    await event(tx, s, a.id, 'recruitment-application.background-check-added', { companyId: a.company_id, jobId: a.job_id, checkId: row.id, typeIds: [...v.value.typeIds].sort() });
    return row;
  });
}

/**
 * Record the candidate's written authorisation (D-044, case 83): date (not after today in Kuala Lumpur) and method, with an
 * optional authorisation file (slice 5 file rules) and, optionally, the provider's reference; with `start`, the check moves
 * to In progress in the same transaction. Only while the check awaits authorisation; once.
 */
export async function recordBackgroundCheckAuthorisation(s: SessionContext, checkId: unknown, input: AuthorisationInput, file?: CheckFileInput): Promise<void> {
  const user = actorId(s);
  const v = validateAuthorisationInput(input, todayInKualaLumpur());
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const f = checkFile('authorisation', file);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCheckTx(tx, s, checkId);
    if (isFinalCheck(c.status)) throw new RecruitmentError('check_closed');
    if (c.status !== 'awaiting_authorisation') throw new RecruitmentError('check_state');
    const [d] = await tx.execute<{ authorised_on: string | null }>(sql`select authorised_on from recruitment_background_check_detail where check_id = ${c.id}::uuid`);
    if (!d || d.authorised_on) throw new RecruitmentError('check_state');
    await tx.execute(sql`update recruitment_background_check_detail set authorised_on = ${v.value.authorisedOn}::date, authorisation_method = ${v.value.method},
      authorisation_recorded_by_user_id = ${user}::uuid, authorisation_recorded_at = now()
      ${v.value.providerReference ? sql`, provider_reference = ${v.value.providerReference}` : sql``} where check_id = ${c.id}::uuid`).catch((e) => asError(e, DB_MAP));
    const fileId = f ? await insertFileTx(tx, s, c, 'authorisation', f) : null;
    await event(tx, s, c.application_id, 'recruitment-application.background-check-authorised', { companyId: c.company_id, jobId: c.job_id, checkId: c.id, fileId });
    if (v.value.start) await moveTx(tx, s, c, 'in_progress');
  });
}

/** "Start check": Awaiting authorisation → In progress, only with the authorisation recorded (the guard refuses too). */
export async function startBackgroundCheck(s: SessionContext, checkId: unknown): Promise<void> {
  actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCheckTx(tx, s, checkId);
    assertCanMove(c, 'in_progress');
    const [d] = await tx.execute<{ ok: boolean }>(sql`select authorised_on is not null as ok from recruitment_background_check_detail where check_id = ${c.id}::uuid`);
    if (d?.ok !== true) throw new RecruitmentError('authorisation_required');
    await moveTx(tx, s, c, 'in_progress');
  });
}

/** "Complete" (case 83): In progress → Completed with an outcome, an optional summary (≤2,000), reference and report file. */
export async function completeBackgroundCheck(s: SessionContext, checkId: unknown, input: CompleteInput, report?: CheckFileInput): Promise<void> {
  actorId(s);
  const v = validateCompleteInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const f = checkFile('report', report);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCheckTx(tx, s, checkId);
    assertCanMove(c, 'completed');
    if (v.value.summary || v.value.providerReference) {
      await tx.execute(sql`update recruitment_background_check_detail set summary = coalesce(${v.value.summary}, summary),
        provider_reference = coalesce(${v.value.providerReference}, provider_reference) where check_id = ${c.id}::uuid`).catch((e) => asError(e, DB_MAP));
    }
    if (f) await insertFileTx(tx, s, c, 'report', f);
    await moveTx(tx, s, c, 'completed', v.value.outcome);
  });
}

/** "Cancel": from Awaiting authorisation or In progress, with a reason (≤500). Final. */
export async function cancelBackgroundCheck(s: SessionContext, checkId: unknown, input: { reason?: unknown }): Promise<void> {
  actorId(s);
  const v = validateCancelInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCheckTx(tx, s, checkId);
    assertCanMove(c, 'cancelled');
    await tx.execute(sql`update recruitment_background_check_detail set cancel_reason = ${v.value.reason} where check_id = ${c.id}::uuid`).catch((e) => asError(e, DB_MAP));
    await moveTx(tx, s, c, 'cancelled');
  });
}

/**
 * Download a check's authorisation file or report (the job's operators and administrators: the bytes are in a table whose
 * only policies admit them, so anybody else gets null — a 404). Every download appends an audit event with the check id,
 * file id and kind — never the name or the bytes.
 */
export async function getBackgroundCheckFile(s: SessionContext, fileId: unknown): Promise<{ fileName: string; mimeType: string; content: Buffer } | null> {
  if (!isUuid(fileId) || !s.userId) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [f] = await tx.execute<{ id: string; company_id: string; job_id: string; application_id: string; check_id: string; kind: CheckFileKind; file_name: string; mime_type: string; content: Buffer }>(sql`
      select id, company_id, job_id, application_id, check_id, kind, file_name, mime_type, content from recruitment_background_check_file
      where id = ${fileId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!f) return null;
    await event(tx, s, f.application_id, 'recruitment-application.background-check-file-downloaded', { companyId: f.company_id, jobId: f.job_id, checkId: f.check_id, fileId: f.id, kind: f.kind });
    return { fileName: f.file_name, mimeType: f.mime_type, content: Buffer.from(f.content) };
  });
}

// ── An application's Background checks section ────────────────────────────────────────────────────────────────

type ApplicationStageRow = {
  id: string; company_id: string; job_id: string; state: ApplicationState; stage_type: string; stage_seed_key: string | null;
  stage_position: number | null; offer_position: number | null;
};
/** The application (if the caller may read it) and where it stands for the stage rule. Read-only. */
async function applicationStageTx(tx: Tx, s: SessionContext, applicationId: string): Promise<ApplicationStageRow | undefined> {
  const [a] = await tx.execute<ApplicationStageRow>(sql`
    select a.id, a.company_id, a.job_id, a.state, st.stage_type, st.seed_key as stage_seed_key, ps.position as stage_position,
      (select min(p2.position) from recruitment_process_stage p2 join recruitment_stage s2 on s2.id = p2.stage_id and s2.stage_type = 'offer'
        where p2.process_id = j.process_id)::int as offer_position
    from recruitment_application a
    join recruitment_job_opening j on j.id = a.job_id
    join recruitment_stage st on st.id = a.current_stage_id
    left join recruitment_process_stage ps on ps.process_id = j.process_id and ps.stage_id = a.current_stage_id
    where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
  return a;
}
const stageOf = (a: ApplicationStageRow) => ({ stageType: a.stage_type, stageSeedKey: a.stage_seed_key, stagePosition: a.stage_position, offerPosition: a.offer_position });

export type BackgroundCheckFileView = { id: string; kind: CheckFileKind; fileName: string; sizeBytes: number; uploadedAt: string; uploadedBy: string | null };
/** What only the job's operators and administrators see. */
export type BackgroundCheckRestricted = {
  provider: string; providerReference: string | null; recordedBy: string | null;
  authorisation: { on: string; method: AuthorisationMethod; recordedAt: string; recordedBy: string | null } | null;
  summary: string | null; cancelReason: string | null; files: BackgroundCheckFileView[];
};
export type BackgroundCheckView = {
  id: string; status: CheckStatus; outcome: CheckOutcome | null; types: { id: string; name: string }[];
  createdAt: string; startedAt: string | null; completedAt: string | null; cancelledAt: string | null;
  /** Cancelled by the system when the candidate's personal data was removed (not by a person, so no reason exists). */
  systemCancelled: boolean;
  /** In progress for more than 14 Kuala Lumpur days. */
  overdue: boolean;
  /** Operators and administrators only; null for a hiring manager. */
  restricted: BackgroundCheckRestricted | null;
  can: { authorise: boolean; start: boolean; complete: boolean; cancel: boolean };
};
export type ApplicationBackgroundChecks = {
  applicationId: string; active: boolean;
  /** The viewer operates the job or administers recruitment: everything, and the actions. */
  full: boolean;
  /** The stage rule allows adding a check now (active applications only). */
  stageAllowed: boolean;
  /** Operators only: the company's enabled types for "Add background check". */
  types: { id: string; name: string }[];
  checks: BackgroundCheckView[];
};

/**
 * The Background checks section of an application (cases 82–84): the job's operators and administrators see every detail;
 * its hiring managers see types, status, outcome and dates only; anyone else is refused (forbidden or not_found).
 */
export async function applicationBackgroundChecks(s: SessionContext, applicationId: unknown, opts: { now?: Date } = {}): Promise<ApplicationBackgroundChecks> {
  return withRecruitmentTenant(s, (tx) => applicationBackgroundChecksTx(tx, s, applicationId, opts));
}
/** The section's read inside the caller's transaction (read-only works: nothing here writes). */
export async function applicationBackgroundChecksTx(tx: Tx, s: SessionContext, applicationId: unknown, opts: { now?: Date } = {}): Promise<ApplicationBackgroundChecks> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  const a = await applicationStageTx(tx, s, applicationId);
  if (!a) throw new RecruitmentError('not_found');
  const access = await jobLevelTx(tx, a.company_id, a.job_id, a.id);
  // Review = administrators, recruiter, assistants and hiring managers; anybody else (an interviewer) sees nothing here.
  if (!access.review) throw new RecruitmentError('forbidden');
  const full = access.operate;
  const today = todayInKualaLumpur(opts.now ?? new Date());
  const checks = await tx.execute<{
    id: string; status: CheckStatus; outcome: CheckOutcome | null; created_at: string | Date; created_by_user_id: string; started_at: string | Date | null;
    completed_at: string | Date | null; cancelled_at: string | Date | null; system_cancelled: boolean;
  }>(sql`select id, status, outcome, created_at, created_by_user_id, started_at, completed_at, cancelled_at,
      system_cancel_reason is not null as system_cancelled from recruitment_background_check
    where application_id = ${a.id}::uuid and tenant_id = ${s.tenantId}::uuid order by created_at, id`);
  const ids = checks.map((c) => c.id);
  const links = ids.length ? await tx.execute<{ check_id: string; id: string; name: string }>(sql`
    select l.check_id, t.id, t.name from recruitment_background_check_type_link l join recruitment_background_check_type t on t.id = l.type_id
    where l.check_id = any(${uuidArray(ids)}::uuid[]) order by lower(t.name), t.id`) : [];
  // The restricted tables are read only for a viewer who operates the job (row security would return nothing to anyone else).
  const details = full && ids.length ? await tx.execute<{
    check_id: string; provider: string; provider_reference: string | null; authorised_on: string | null; authorisation_method: AuthorisationMethod | null;
    authorisation_recorded_at: string | Date | null; authorisation_recorded_by_user_id: string | null; summary: string | null; cancel_reason: string | null;
  }>(sql`select check_id, provider, provider_reference, to_char(authorised_on, 'YYYY-MM-DD') as authorised_on, authorisation_method,
      authorisation_recorded_at, authorisation_recorded_by_user_id, summary, cancel_reason
    from recruitment_background_check_detail where check_id = any(${uuidArray(ids)}::uuid[])`) : [];
  const files = full && ids.length ? await tx.execute<{ id: string; check_id: string; kind: CheckFileKind; file_name: string; size_bytes: number; uploaded_at: string | Date; uploaded_by_user_id: string }>(sql`
    select id, check_id, kind, file_name, size_bytes, uploaded_at, uploaded_by_user_id from recruitment_background_check_file
    where check_id = any(${uuidArray(ids)}::uuid[]) order by kind, uploaded_at`) : [];
  const types = full ? await tx.execute<{ id: string; name: string }>(sql`select id, name from recruitment_background_check_type
    where tenant_id = ${s.tenantId}::uuid and company_id = ${a.company_id}::uuid and enabled order by lower(name), id`) : [];
  const labels = full && ids.length ? await userLabelsTx(tx, a.company_id) : new Map<string, { name: string }>();
  const name = (id: string | null) => (id ? labels.get(id)?.name ?? null : null);
  const active = a.state === 'active';
  return {
    applicationId: a.id, active, full, stageAllowed: active && checkStageAllowed(stageOf(a)), types: [...types],
    checks: checks.map((c) => {
      const d = details.find((x) => x.check_id === c.id);
      const open = !isFinalCheck(c.status);
      return {
        id: c.id, status: c.status, outcome: c.outcome,
        types: links.filter((l) => l.check_id === c.id).map((l) => ({ id: l.id, name: l.name })),
        createdAt: iso(c.created_at), startedAt: c.started_at ? iso(c.started_at) : null, completedAt: c.completed_at ? iso(c.completed_at) : null,
        cancelledAt: c.cancelled_at ? iso(c.cancelled_at) : null, systemCancelled: c.system_cancelled === true,
        overdue: c.status === 'in_progress' && !!c.started_at && checkOverdue(klDay(c.started_at), today),
        restricted: full ? {
          provider: d?.provider ?? '', providerReference: d?.provider_reference ?? null, recordedBy: name(c.created_by_user_id),
          authorisation: d?.authorised_on && d.authorisation_method && d.authorisation_recorded_at ? {
            on: d.authorised_on, method: d.authorisation_method, recordedAt: iso(d.authorisation_recorded_at), recordedBy: name(d.authorisation_recorded_by_user_id),
          } : null,
          summary: d?.summary ?? null, cancelReason: d?.cancel_reason ?? null,
          files: files.filter((f) => f.check_id === c.id).map((f) => ({
            id: f.id, kind: f.kind, fileName: f.file_name, sizeBytes: f.size_bytes, uploadedAt: iso(f.uploaded_at), uploadedBy: name(f.uploaded_by_user_id),
          })),
        } : null,
        can: {
          // A removed candidate's checks have no details any more: nothing more can be recorded on them.
          authorise: full && !!d && c.status === 'awaiting_authorisation' && !d.authorised_on,
          start: full && !!d && c.status === 'awaiting_authorisation' && !!d.authorised_on,
          complete: full && !!d && c.status === 'in_progress',
          cancel: full && !!d && open,
        },
      };
    }),
  };
}

// ── Reports (counts only) ───────────────────────────────────────────────────────────────────────────────────

export type BackgroundCheckCounts = { companyId: string; counts: Record<CheckStatus, number> }[];
/**
 * Checks by status, per company the caller administers among `companyIds` (Reports › Overview). Counts only: no candidate,
 * application, outcome, provider or name leaves this function. Read-only.
 */
export async function backgroundCheckCounts(s: SessionContext, companyIds: readonly string[]): Promise<BackgroundCheckCounts> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const admin = await tx.execute<{ id: string }>(sql`select c.id from unnest(${uuidArray(ids)}::uuid[]) c(id) where app.can_admin_recruitment_for(c.id)`);
    if (!admin.length) return [];
    const rows = await tx.execute<{ company_id: string; status: CheckStatus; n: number }>(sql`select company_id, status, count(*)::int as n
      from recruitment_background_check where tenant_id = ${s.tenantId}::uuid and company_id = any(${uuidArray(admin.map((r) => r.id))}::uuid[]) group by 1, 2`);
    return admin.map((c) => ({ companyId: c.id, counts: checkStatusCounts(rows.filter((r) => r.company_id === c.id)) }));
  });
}
