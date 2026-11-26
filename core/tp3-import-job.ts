/**
 * Board 5084d02e — the Form TP3 Excel import, as a client of the shared bulk-job kernel (core/bulk-job*.ts;
 * docs/adr/2026-11-10-employee-import-staged-job.md "Shared job kernel"; kind row in migration 7570).
 *
 * ── CHECK, THEN CONFIRM: TWO JOBS OF ONE KIND ─────────────────────────────────────────────────────────────────
 * The kernel has no "waiting for the user" state, so the approved check-then-confirm is two jobs of kind `tp3_import`:
 *  1. CHECK (input `{mode:'check'}`): the worker reads the file and checks every row exactly as a save would
 *     (`prepareTp3`, the employee in the importer's companies, duplicates, the statutory profile), and stores ONLY the
 *     row outcomes on the plan (row, Employee ID, year, reason, column; never an amount). No step, nothing written.
 *  2. SAVE (input `{mode:'save', checkJobId}`), started by Confirm: the browser sends the same file again (the kernel
 *     clears an uploaded file when a job ends, which is what we want for personal tax figures), and admission checks
 *     that the check job is the caller's own, completed, and was run on the same file (hash and name) for the same
 *     companies. The operation key is derived from the check job id, so pressing Confirm twice, or refreshing and
 *     confirming again, returns the SAME save job. The save job checks every row again and saves, one step per row,
 *     only rows that were ready when checked and are still ready now; each step is one `saveImportedTp3Tx` in the
 *     kernel's per-step savepoint, so a row is saved whole or not at all and a refused row never stops the others.
 *
 * ── THE LOG ───────────────────────────────────────────────────────────────────────────────────────────────────
 * `bulk_job` row security is creator-only. The Import Log lists every TP3 import for the companies the viewer
 * administers through `app.tp3_import_log` (7570), a SECURITY DEFINER read bounded by `app.is_admin_for` over each
 * job's companies (the admin set is computed once per call), returning totals and row outcomes only. A check job that
 * was confirmed is shown through its save job.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { anyUuid, uuidArrayParam } from '../db/sql-arrays';
import { isAdmin } from '../lib/authz-model';
import { parseCsv } from '../lib/csv';
import { bulkJobActive, type BulkJobRowError, type BulkJobState, type BulkJobWorkerStatus } from '../lib/bulk-job';
import {
  TP3_IMPORT_MAX_CSV_BYTES, TP3_IMPORT_MAX_ROWS, readTp3ImportRow, resolveTp3ImportHeader, tp3ImportColumns,
  type Tp3ImportCatalogue, type Tp3ImportRowInput, type Tp3ImportRowProblem,
} from '../lib/tp3-import-columns';
import { BulkJobError, bulkJobId, bulkJobTx, bulkJobWorkerStatusTx, enqueueBulkJobTx, type BulkJobRow } from './bulk-job';
import { isTransientBulkJobError, type BulkJobHandler, type BulkJobStepOutcome } from './bulk-job-worker';
import { withPayrollTenant } from './module-gate';
import { lockPayrollHistoryReadTx } from './payroll-history-lock';
import {
  deriveAccumulatorSeed, prepareTp3, saveImportedTp3Tx, tp3SeedCarriesMoney, Tp3Error,
  TP3_MAX_EMPLOYERS, TP3_SECTION_C, TP3_SECTION_D, TP3_TEXT_LIMITS,
} from './tp3';

export const TP3_IMPORT_KIND = 'tp3_import';

/** The form's definition the template and the reader are generated from (plain data, safe to hand the browser). */
export function tp3ImportCatalogue(): Tp3ImportCatalogue {
  return { sectionC: TP3_SECTION_C, sectionD: TP3_SECTION_D, maxEmployers: TP3_MAX_EMPLOYERS, textLimits: TP3_TEXT_LIMITS };
}

type Mode = 'check' | 'save';
type Input = { mode: Mode; checkJobId?: string };
/** One row's outcome as the job keeps it: identity, year, reason and column. Never an amount. */
export type Tp3ImportPlanRow = {
  rowNum: number;
  employeeId: string;
  year?: number;
  reason?: string;
  field?: string;
  detail?: Record<string, string | number>;
};
type Plan = { mode: Mode; checkJobId?: string; rows: Tp3ImportPlanRow[]; fileDetail?: Record<string, string | number> };
type Step = { rowNum: number; employeeId: string; personId: string; input: Tp3ImportRowInput };
type Note = { rowNum: number; o: 'formOnly' | 'unchanged'; heldBy?: number };

const modeOf = (job: Pick<BulkJobRow, 'plan' | 'input'>): Mode | null =>
  (job.plan as Plan | null)?.mode ?? (job.input as Input | null)?.mode ?? null;
const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');
/** The save job's operation key: one per check job, so a second Confirm returns the same job (SQL: 7570's log). */
export function tp3ImportSaveKey(checkJobId: string) {
  const h = createHash('md5').update(`tp3-import-save:${checkJobId.toLowerCase()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const sameCompanies = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));
const sameSource = (row: BulkJobRow, content: Buffer, name: string, companyIds: readonly string[]) =>
  row.source_hash === sha256(content) && row.source_name === name && sameCompanies(row.company_ids, companyIds);

function assertActor(ctx: SessionContext, ids: readonly string[]) {
  if (!ctx.userId || ctx.agent || !isAdmin(ctx) || !ids.length) throw new BulkJobError('importAccessDenied', 403);
}
/** The importer administers every company of the import (the TP3 screen's own scope rule, app.is_admin_for). */
async function assertScopeTx(tx: Tx, ctx: SessionContext, ids: readonly string[]) {
  assertActor(ctx, ids);
  const [scope] = await tx.execute<{ allowed: boolean }>(sql`
    select coalesce(bool_and(app.is_admin_for(company_scope.id)), false) as allowed
    from unnest(${uuidArrayParam(ids)}) as company_scope(id)`);
  if (!scope?.allowed) throw new BulkJobError('importAccessDenied', 403);
}
/**
 * The companies of the caller's selected scope that they administer, in one statement. The switcher's scope also
 * holds the companies a company-scoped administrator is only EMPLOYED in (lib/scope.ts allowedCompanies); an import
 * belongs to the administered ones, and is refused only when there is none.
 */
async function administeredTx(tx: Tx, ctx: SessionContext, ids: readonly string[]) {
  assertActor(ctx, ids);
  const rows = await tx.execute<{ id: string }>(sql`
    select company_scope.id::text as id from unnest(${uuidArrayParam(ids)}) with ordinality as company_scope(id, n)
    where app.is_admin_for(company_scope.id) order by company_scope.n`);
  const administered = rows.map((row) => row.id);
  if (!administered.length) throw new BulkJobError('importAccessDenied', 403);
  return administered;
}
function fileOf(p: { csv: string; fileName: string }) {
  const content = Buffer.from(p.csv, 'utf8');
  if (!content.length || content.length > TP3_IMPORT_MAX_CSV_BYTES) throw new BulkJobError('fileTooLarge');
  if (!/\.xlsx$/i.test(p.fileName) || p.fileName.length > 255) throw new BulkJobError('invalidFormat');
  return content;
}

/** Upload: store the file on a CHECK job. Idempotent per operation key; a different file under the same key is refused. */
export async function queueTp3ImportCheck(ctx: SessionContext, p: { csv: string; fileName: string; operationKey: string; companyIds: string[] }) {
  const content = fileOf(p);
  return withPayrollTenant(ctx, async (tx) => {
    const companyIds = await administeredTx(tx, ctx, [...new Set(p.companyIds)]);
    const { row, existing } = await enqueueBulkJobTx(tx, ctx, {
      kind: TP3_IMPORT_KIND, operationKey: p.operationKey, companyIds, source: { name: p.fileName, content }, input: { mode: 'check' },
    });
    if (existing && (!sameSource(row, content, p.fileName, companyIds) || modeOf(row) !== 'check')) throw new BulkJobError('operationChanged', 409);
    return row.id;
  });
}

/** Confirm: start (or return) the SAVE job for the caller's own completed check of the same file. */
export async function confirmTp3Import(ctx: SessionContext, p: { checkJobId: string; csv: string; fileName: string; companyIds: string[] }) {
  const content = fileOf(p);
  const checkJobId = bulkJobId(p.checkJobId);
  return withPayrollTenant(ctx, async (tx) => {
    const companyIds = await administeredTx(tx, ctx, [...new Set(p.companyIds)]);
    // Row security returns only the caller's own job.
    const check = await bulkJobTx(tx, checkJobId, { kind: TP3_IMPORT_KIND }).catch((error) => {
      if (error instanceof BulkJobError) throw new BulkJobError('checkUnavailable', 404);
      throw error;
    });
    if (check.state !== 'completed' || modeOf(check) !== 'check') throw new BulkJobError('checkUnavailable', 409);
    if (!sameSource(check, content, p.fileName, companyIds)) throw new BulkJobError('checkChanged', 409);
    if (!((check.counters?.ready ?? 0) > 0)) throw new BulkJobError('noReadyRows', 409);
    const { row, existing } = await enqueueBulkJobTx(tx, ctx, {
      kind: TP3_IMPORT_KIND, operationKey: tp3ImportSaveKey(check.id), companyIds,
      source: { name: p.fileName, content }, input: { mode: 'save', checkJobId: check.id },
    });
    if (existing && (!sameSource(row, content, p.fileName, companyIds) || modeOf(row) !== 'save')) throw new BulkJobError('operationChanged', 409);
    return row.id;
  });
}

// ── Checking a file ───────────────────────────────────────────────────────────────────────────────────────────

type Analysis = { rows: Tp3ImportPlanRow[]; ready: Step[] } | { fileError: string; detail?: Record<string, string | number> };

/**
 * Every row of the file, checked as a save would check it, with ONE read for all of its Employee IDs. Reason order
 * per row: Employee ID, year, the same employee and year twice in the file, the cell formats, the form's own checks
 * (`prepareTp3`), and last the statutory profile the figures must land on (the test `saveTp3` applies).
 */
export async function analyseTp3Import(ctx: SessionContext, text: string, companyIds: readonly string[]): Promise<Analysis> {
  const columns = tp3ImportColumns(tp3ImportCatalogue());
  const table = parseCsv(text).filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (!table.length) return { fileError: 'noRows' };
  const header = resolveTp3ImportHeader(table[0], columns);
  if ('fileError' in header) return header;
  const data = table.slice(1);
  if (!data.length) return { fileError: 'noRows' };
  if (data.length > TP3_IMPORT_MAX_ROWS) return { fileError: 'tooManyRows', detail: { max: TP3_IMPORT_MAX_ROWS } };
  // Excel row numbers: the header is row 1.
  const reads = data.map((cells, i) => ({ rowNum: i + 2, ...readTp3ImportRow(cells, header.byIndex, TP3_MAX_EMPLOYERS) }));

  // One statement for every Employee ID in the file, within the importer's companies (and row security). The codes
  // go in as typed and in both cases so the (tenant, employee_code) index answers; matching is case-insensitive.
  const codes = [...new Set(reads.flatMap((r) => (r.employeeId ? [r.employeeId, r.employeeId.toUpperCase(), r.employeeId.toLowerCase()] : [])))];
  const found = codes.length && companyIds.length
    ? await withPayrollTenant(ctx, (tx) => tx.execute<{ code: string; personId: string; hasStatutory: boolean }>(sql`
        select e.employee_code as code, e.person_id::text as "personId",
          exists(select 1 from public.employee_statutory_my s where s.tenant_id = e.tenant_id and s.person_id = e.person_id) as "hasStatutory"
        from public.employment e
        where e.tenant_id = ${ctx.tenantId}::uuid and ${anyUuid(sql`e.company_id`, companyIds)}
          and e.employee_code = any(array(select jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb)))`))
    : [];
  const byCode = new Map<string, Map<string, boolean>>();
  for (const f of found) {
    const key = f.code.trim().toUpperCase();
    const persons = byCode.get(key) ?? new Map<string, boolean>();
    persons.set(f.personId, (persons.get(f.personId) ?? false) || f.hasStatutory);
    byCode.set(key, persons);
  }

  type Resolved = { base: Tp3ImportPlanRow; problem: Tp3ImportRowProblem }
    | { base: Tp3ImportPlanRow; personId: string; hasStatutory: boolean; read: (typeof reads)[number] };
  const resolved = reads.map((r): Resolved => {
    const base: Tp3ImportPlanRow = { rowNum: r.rowNum, employeeId: r.employeeId.slice(0, 64), ...(r.year != null ? { year: r.year } : {}) };
    if (!r.employeeId) return { base, problem: { reason: 'employeeIdRequired', field: 'employeeId' } };
    const persons = byCode.get(r.employeeId.toUpperCase());
    if (!persons) return { base, problem: { reason: 'employeeNotFound', field: 'employeeId' } };
    if (persons.size > 1) return { base, problem: { reason: 'employeeAmbiguous', field: 'employeeId' } };
    const [[personId, hasStatutory]] = [...persons];
    if (r.year == null) return { base, problem: { reason: 'yearInvalid', field: 'assessmentYear' } };
    return { base, personId, hasStatutory, read: r };
  });
  // The same person and year twice in one file: every such row is a problem, whichever row is right.
  const rowsByKey = new Map<string, number[]>();
  for (const r of resolved) if ('personId' in r) {
    const key = `${r.personId}|${r.base.year}`;
    const list = rowsByKey.get(key);
    if (list) list.push(r.base.rowNum); else rowsByKey.set(key, [r.base.rowNum]);
  }
  const rows: Tp3ImportPlanRow[] = [];
  const ready: Step[] = [];
  for (const r of resolved) {
    if (!('personId' in r)) { rows.push({ ...r.base, ...r.problem }); continue; }
    const twins = rowsByKey.get(`${r.personId}|${r.base.year}`)!;
    if (twins.length > 1) { rows.push({ ...r.base, reason: 'duplicateInFile', detail: { rows: twins.join(', ') } }); continue; }
    if (r.read.problem || !r.read.input) { rows.push({ ...r.base, ...(r.read.problem ?? { reason: 'unexpected' }) }); continue; }
    try {
      const prepared = prepareTp3({ ...r.read.input, personId: r.personId });
      const seed = deriveAccumulatorSeed(prepared.payload);
      if (!r.hasStatutory && seed && tp3SeedCarriesMoney(seed)) { rows.push({ ...r.base, reason: 'noStatutoryProfile' }); continue; }
    } catch (error) {
      if (!(error instanceof Tp3Error)) throw error;
      rows.push({ ...r.base, reason: error.reason ?? 'unexpected', ...(error.field ? { field: error.field } : {}), ...(error.detail ? { detail: { ...error.detail } } : {}) });
      continue;
    }
    rows.push(r.base);
    ready.push({ rowNum: r.base.rowNum, employeeId: r.read.employeeId, personId: r.personId, input: r.read.input });
  }
  return { rows, ready };
}

// ── Reading the log ───────────────────────────────────────────────────────────────────────────────────────────

export type Tp3ImportStatus = 'waiting' | 'checking' | 'checked' | 'saving' | 'completed' | 'completedWithProblems' | 'failed' | 'cancelled';
export type Tp3ImportSummary = {
  id: string; mode: Mode | null; state: BulkJobState; status: Tp3ImportStatus; sourceName: string; uploadedBy: string | null; mine: boolean;
  createdAt: string; finishedAt: string | null;
  /** The Import Log's page cursor: `createdAt` at the database's full precision. */
  cursorAt: string;
  total: number; ready: number; saved: number; unchanged: number; failed: number;
  stepsTotal: number; stepsDone: number; error: string | null; savedAs: string | null;
};
export type Tp3ImportRowState = 'ready' | 'problem' | 'notSaved' | 'saved' | 'formOnly' | 'unchanged' | 'failed' | 'pending';
export type Tp3ImportResultRow = Tp3ImportPlanRow & { state: Tp3ImportRowState; heldBy?: number };
export type Tp3ImportDetail = Tp3ImportSummary & {
  rows: Tp3ImportResultRow[]; fileDetail: Record<string, string | number> | null; workerStatus: BulkJobWorkerStatus | null;
};
type LogRow = {
  id: string; created_by_me: boolean; uploaded_by: string | null; mode: Mode | null; state: BulkJobState; source_name: string;
  steps_total: number; steps_done: number; counters: Record<string, number> | null; error: string | null;
  errors: BulkJobRowError[] | null; plan: Plan | null; result: { notes?: Note[] } | null;
  created_at: Date | string; finished_at: Date | string | null; saved_as: string | null; cursor_at: string;
};
const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());

function statusOf(mode: Mode | null, state: BulkJobState, failed: number): Tp3ImportStatus {
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'queued') return 'waiting';
  if (state === 'completed') return mode === 'check' ? 'checked' : failed ? 'completedWithProblems' : 'completed';
  return mode === 'save' ? 'saving' : 'checking';
}
function summaryOf(row: LogRow): Tp3ImportSummary {
  const c = row.counters ?? {};
  const failed = row.mode === 'check' ? (c.invalid ?? 0) : (c.invalid ?? 0) + (c.failed ?? 0);
  return {
    id: row.id, mode: row.mode, state: row.state, status: statusOf(row.mode, row.state, failed), sourceName: row.source_name,
    uploadedBy: row.uploaded_by, mine: row.created_by_me, createdAt: iso(row.created_at)!, finishedAt: iso(row.finished_at), cursorAt: row.cursor_at,
    total: c.total ?? 0, ready: c.ready ?? 0, saved: row.mode === 'save' ? (c.written ?? 0) : 0, unchanged: c.unchanged ?? 0, failed,
    stepsTotal: row.steps_total, stepsDone: row.steps_done, error: row.error, savedAs: row.saved_as,
  };
}
/** A refused step's stored message: `reason {"field":…,…}` (see applyStepTx), or anything else as unexpected. */
function refusalOf(message: string): Pick<Tp3ImportPlanRow, 'reason' | 'field' | 'detail'> {
  const split = message.indexOf(' ');
  const reason = split === -1 ? message : message.slice(0, split);
  if (!/^[a-zA-Z]+$/.test(reason)) return { reason: 'unexpected' };
  if (split === -1) return { reason };
  try {
    const { field, ...detail } = JSON.parse(message.slice(split + 1)) as Record<string, string | number>;
    return { reason, ...(typeof field === 'string' ? { field } : {}), ...(Object.keys(detail).length ? { detail } : {}) };
  } catch { return { reason }; }
}
function rowsOf(row: LogRow): Tp3ImportResultRow[] {
  const plan = row.plan;
  if (!plan) return [];
  if (plan.mode === 'check') return plan.rows.map((r): Tp3ImportResultRow => ({ ...r, state: r.reason ? 'problem' : 'ready' }));
  const failed = new Map((row.errors ?? []).map((e) => [e.rowNum, e.message]));
  const notes = new Map((row.result?.notes ?? []).map((n) => [n.rowNum, n]));
  let remaining = row.steps_done;
  return plan.rows.map((r): Tp3ImportResultRow => {
    if (r.reason) return { ...r, state: 'notSaved' };
    const considered = remaining-- > 0;
    const refused = failed.get(r.rowNum);
    if (refused != null) return { ...r, ...refusalOf(refused), state: 'failed' };
    const note = notes.get(r.rowNum);
    if (note) return { ...r, state: note.o, ...(note.heldBy != null ? { heldBy: note.heldBy } : {}) };
    // A ready row the job reached was saved; one it has not reached yet is pending, or not saved if the job ended.
    return { ...r, state: considered ? 'saved' : bulkJobActive(row.state) ? 'pending' : 'notSaved' };
  });
}
function logTx(tx: Tx, scopeIds: readonly string[], p: { id?: string; before?: { at: string; id: string }; limit: number }) {
  return tx.execute<LogRow>(sql`
    select id, created_by_me, uploaded_by, mode, state, source_name, steps_total, steps_done, counters, error, errors, plan, result,
      created_at, finished_at, saved_as, cursor_at
    from app.tp3_import_log(${uuidArrayParam(scopeIds)}, ${p.id ?? null}::uuid, ${p.before?.at ?? null}::timestamptz,
      ${p.before?.id ?? null}::uuid, ${p.limit})`);
}

/** One import of the companies the caller administers (in `scopeIds`), with its row results. 404 otherwise. */
export async function readTp3Import(ctx: SessionContext, id: string, scopeIds: readonly string[]): Promise<Tp3ImportDetail> {
  const jobId = bulkJobId(id);
  if (!scopeIds.length) throw new BulkJobError('Job unavailable.', 404);
  assertActor(ctx, scopeIds);
  return withPayrollTenant(ctx, async (tx) => {
    const [row] = await logTx(tx, scopeIds, { id: jobId, limit: 1 });
    if (!row) throw new BulkJobError('Job unavailable.', 404);
    const workerStatus = row.state === 'queued' ? await bulkJobWorkerStatusTx(tx, TP3_IMPORT_KIND) : null;
    return { ...summaryOf(row), rows: rowsOf(row), fileDetail: row.plan?.fileDetail ?? null, workerStatus };
  });
}

/** The Import Log: newest first, 50 a page by (created_at, id); the 51st row only says there are older ones. */
export async function listTp3Imports(ctx: SessionContext, scopeIds: readonly string[], before?: { at: string; id: string }): Promise<Tp3ImportSummary[]> {
  if (!scopeIds.length) return [];
  assertActor(ctx, scopeIds);
  return withPayrollTenant(ctx, async (tx) => (await logTx(tx, scopeIds, { before, limit: 51 })).map(summaryOf));
}

// ── The worker ────────────────────────────────────────────────────────────────────────────────────────────────

const refusalMessage = (reason: string, field?: string, detail?: Readonly<Record<string, string | number>>) =>
  `${reason} ${JSON.stringify({ ...(field ? { field } : {}), ...(detail ?? {}) })}`;

export const tp3ImportJobHandler: BulkJobHandler<Step> = {
  kind: TP3_IMPORT_KIND,
  mode: 'per-step',
  // One row's save takes the statutory and payroll-input locks of that person; a chunk keeps them short.
  chunkBudgetMs: 100,
  maxStepsPerChunk: 4,
  phaseOf: () => 'rows',
  stepRef: (step) => step.payload.employeeId,
  // The creator watches a check on the TP3 screen; only a save sends the completion notice.
  quietNotice: (job) => modeOf(job) === 'check',
  async prepare(ctx, job) {
    const input = job.input as Input | null;
    const mode: Mode = input?.mode === 'save' ? 'save' : 'check';
    const base = { mode, ...(input?.checkJobId ? { checkJobId: input.checkJobId } : {}) };
    await withPayrollTenant(ctx, (tx) => assertScopeTx(tx, ctx, job.company_ids));
    if (!job.source_content?.length || job.source_content.length > TP3_IMPORT_MAX_CSV_BYTES) return { refused: 'fileTooLarge', plan: { ...base, rows: [] } };
    const analysis = await analyseTp3Import(ctx, Buffer.from(job.source_content).toString('utf8'), job.company_ids);
    if ('fileError' in analysis) return { refused: analysis.fileError, plan: { ...base, rows: [], ...(analysis.detail ? { fileDetail: analysis.detail } : {}) } };
    if (mode === 'check') {
      return { steps: [], plan: { ...base, rows: analysis.rows } satisfies Plan,
        counters: { total: analysis.rows.length, ready: analysis.ready.length, invalid: analysis.rows.length - analysis.ready.length } };
    }
    // Save: only rows that were ready when the file was checked AND are still ready now. A row that was a problem
    // at the check keeps the reason the user was shown; a row that became a problem since shows its new reason.
    const [check] = input?.checkJobId
      ? await withTenant(ctx, (tx) => tx.execute<{ plan: Plan | null; state: BulkJobState }>(sql`
          select plan, state from public.bulk_job where id = ${bulkJobId(input.checkJobId!)}::uuid and kind = ${TP3_IMPORT_KIND}`))
      : [];
    if (!check || check.state !== 'completed' || check.plan?.mode !== 'check') return { refused: 'checkUnavailable', plan: { ...base, rows: [] } };
    const atCheck = new Map(check.plan.rows.map((r) => [r.rowNum, r]));
    const rows = analysis.rows.map((r): Tp3ImportPlanRow => {
      const before = atCheck.get(r.rowNum);
      return !r.reason && before?.reason
        ? { ...r, reason: before.reason, ...(before.field ? { field: before.field } : {}), ...(before.detail ? { detail: before.detail } : {}) }
        : r;
    });
    const steps = analysis.ready.filter((s) => { const before = atCheck.get(s.rowNum); return before != null && !before.reason; })
      .map((payload) => ({ kind: 'row', rowNum: payload.rowNum, payload }));
    return { steps, plan: { ...base, rows } satisfies Plan,
      counters: { total: rows.length, ready: steps.length, invalid: rows.length - steps.length } };
  },
  /** The payroll-history barrier first (the order `saveTp3` takes it in, under `withPayrollTenant`), then the scope. */
  async beginChunkTx(tx, ctx, job) {
    await lockPayrollHistoryReadTx(tx, ctx.tenantId);
    await assertScopeTx(tx, ctx, job.company_ids);
  },
  async applyStepTx(tx, ctx, job, { payload }): Promise<BulkJobStepOutcome> {
    // The employee is still in the import's companies and visible to the importer (row security).
    const [target] = await tx.execute<{ ok: number }>(sql`
      select 1 as ok from public.employment e
      where e.tenant_id = ${ctx.tenantId}::uuid and e.person_id = ${payload.personId}::uuid and ${anyUuid(sql`e.company_id`, job.company_ids)}
        and upper(btrim(e.employee_code)) = ${payload.employeeId.trim().toUpperCase()}
      limit 1`);
    if (!target) throw new Error(refusalMessage('employeeNotFound', 'employeeId'));
    try {
      const saved = await saveImportedTp3Tx(tx, ctx, { ...payload.input, personId: payload.personId }, { jobId: job.id, rowNumber: payload.rowNum });
      if (saved.unchanged) return { result: { o: 'unchanged' }, counters: { unchanged: 1 } };
      const seed = saved.seed;
      if (seed && !seed.applied && seed.reason === 'laterYearHoldsColumns') return { result: { o: 'formOnly', heldBy: seed.heldBy }, counters: { written: 1 } };
      return { result: { o: 'saved' }, counters: { written: 1 } };
    } catch (error) {
      if (isTransientBulkJobError(error)) throw error;
      if (error instanceof Tp3Error && error.reason) throw new Error(refusalMessage(error.reason, error.field, error.detail));
      throw new Error('unexpected');
    }
  },
  /** The rows saved with a note (form only, or unchanged) onto the job's result: the steps are cleared when it ends. */
  async finalize(ctx, job) {
    if (modeOf(job) !== 'save') return { result: null };
    const steps = await withTenant(ctx, (tx) => tx.execute<{ row_num: number; result: { o: string; heldBy?: number } }>(sql`
      select row_num, result from public.bulk_job_step
      where job_id = ${job.id}::uuid and state = 'applied' and result is not null and result->>'o' <> 'saved'
      order by seq`));
    const notes: Note[] = steps.flatMap((s) => (s.result.o === 'formOnly' || s.result.o === 'unchanged'
      ? [{ rowNum: s.row_num, o: s.result.o, ...(s.result.heldBy != null ? { heldBy: s.result.heldBy } : {}) }] : []));
    return { result: { notes } };
  },
};
