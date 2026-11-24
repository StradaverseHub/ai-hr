import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { isCalendarDate } from '../lib/calendar-date';
import { type SessionContext, type Tx } from '../db/client';
import { withPayrollTenant as withTenant } from './module-gate';
import { transactionXlsxStream, type TransactionCell } from '../lib/transaction-xlsx-stream';
import { bulkJobTx, BulkJobError, enqueueBulkJobTx } from './bulk-job';
import { bulkJobActive, type BulkJobState } from '../lib/bulk-job';
import { BulkJobAuthorityLost, type BulkJobHandler } from './bulk-job-worker';
import {
  INDIVIDUAL_TXN_STATUS_FILTERS, listPayComponents, readProcessedPayslipsForExport, readTransactionExport, TXN_KINDS,
  type FixedTransactionViewRow, type IndividualTxnViewRow, type TransactionExportQuery,
} from '../packs/payroll/service';
import { packFor } from '../localization/registry';
import { toXlsxReport } from '../lib/report-export';
// The History sheet's pure, i18n-free builder (no React, no DB). It lives beside the screen it mirrors so the screen,
// the panel and this file share one column rule; the worker only calls it.
import { buildHistoryExport } from '../app/payroll/transaction-view/history-export';

export const TRANSACTION_EXPORT_KIND = 'payroll_transaction_export';
const partBytes = 256 * 1024;
const fixedHeaders = [
  'Employee ID', 'Employee', 'Company', 'Pay Item Code', 'Pay Item', 'Amount',
  'Pay Cycle Code', 'Pay Cycle', 'Start Date', 'End Date', 'Status', 'Remarks',
];
const individualHeaders = [
  'Employee ID', 'Employee', 'Company', 'Pay Period', 'Transaction Date', 'Pay Item Code', 'Pay Item',
  'Classification', 'Amount', 'Quantity', 'Unit', 'Pay Cycle Code', 'Pay Cycle', 'Status', 'Source',
  'Created By', 'Created Date', 'Notes',
];
const guid = z.guid();
const calendarDate = z.string().refine(isCalendarDate);
const scope = z.object({ companyIds: z.array(guid).min(1), employmentId: guid.optional() });
const caption = (max: number) => z.string().max(max);
/**
 * Production 2026-11-23 — Transaction View › History "Export to Excel". Both choices ("This view" and "All processed
 * payroll") run here instead of in the web request, because "All processed payroll" reads every processed payslip
 * the caller may see: in production that passed the 5,000 retained-document ceiling and every download failed.
 * The captions are translated by the page when the job is queued, so the worker stays i18n-free like the builder.
 */
// `exportScope` and `sheet` ride INSIDE `filters`: the job kind's database-declared input shape (migration 6980,
// checked by app.bulk_job_enqueue) admits only the top-level keys kind, filters and asOf.
const historyWorkbook = z.object({
  kind: z.literal('history'),
  filters: scope.extend({
    year: z.number().int().min(2000).max(2100).optional(), month: z.number().int().min(1).max(12).optional(),
    cycle: z.enum(['regular', 'off_cycle', 'bonus', 'adjustment']).optional(), payrollCycleId: guid.optional(),
    exportScope: z.enum(['current', 'all']),
    sheet: z.object({
      title: caption(120).min(1), filename: z.string().regex(/^[a-z0-9-]{1,80}$/),
      filterCaption: caption(600), filterDescription: caption(1200), detailNote: caption(2000),
      cycleLabels: z.object({
        regular: caption(120), off_cycle: caption(120), bonus: caption(120), adjustment: caption(120),
      }).strict(),
      statusLabels: z.object({ draft: caption(120), processed: caption(120), closed: caption(120) }).strict(),
    }).strict(),
  }).strict(),
}).strict();
export type HistoryWorkbookQuery = z.infer<typeof historyWorkbook>;
export type TransactionWorkbookQuery = TransactionExportQuery | HistoryWorkbookQuery;
const exportQuery = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed'), asOf: calendarDate,
    filters: scope.extend({ componentId: guid.optional(), status: z.enum(['active', 'ended']).optional() }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('individual'),
    filters: scope.extend({
      year: z.number().int().min(2000).max(2100).optional(), month: z.number().int().min(1).max(12).optional(),
      kind: z.enum(TXN_KINDS).optional(), batchStatus: z.enum(INDIVIDUAL_TXN_STATUS_FILTERS).optional(),
      departmentId: guid.optional(), createdBy: guid.optional(),
      createdFrom: calendarDate.optional(), createdTo: calendarDate.optional(),
    }).strict(),
  }).strict(),
  historyWorkbook,
]);

function exportJobQuery(job: {input: unknown; company_ids: string[]}): TransactionWorkbookQuery {
  const query = exportQuery.parse(job.input);
  const allowed = new Set(job.company_ids);
  if (allowed.size !== new Set(query.filters.companyIds).size ||
      query.filters.companyIds.some((id) => !allowed.has(id))) throw new BulkJobAuthorityLost();
  return query;
}

const dateCell = (date: string | null) => date ? { date } : null;

type TransactionWorkbookReceipt = {
  kind: TransactionWorkbookQuery['kind'];
  employmentId?: string;
  rows: number;
  bytes: number;
  fileSha256: string;
  parts: number;
  /** History only: the builder's filename stem; its file is the SpreadsheetML `.xls` the History export has always been. */
  filename?: string;
};

function fixedCells(row: FixedTransactionViewRow, asOf: string): TransactionCell[] {
  return [
    row.employeeCode, row.employeeName, row.company, row.code, row.name, Number(row.amount),
    row.payrollCycleCode ?? null, row.payrollCycleName ?? row.runType, dateCell(row.validFrom), dateCell(row.validTo),
    row.validTo && row.validTo < asOf ? 'Ended' : 'Active', row.remarks,
  ];
}

function individualCells(row: IndividualTxnViewRow): TransactionCell[] {
  return [
    row.employeeCode, row.employeeName, row.company, row.payPeriod, dateCell(row.txnDate),
    row.componentCode, row.componentName, row.kind, Number(row.amount), row.quantity == null ? null : Number(row.quantity),
    row.unit, row.batchCycleCode ?? row.intendedCycleCode ?? null,
    row.batchCycleName ?? row.intendedCycleName ?? row.runType,
    row.reprocessRequired ? 'Pending reprocessing' : row.batchStatus ?? 'Unattached',
    row.source ?? 'manual', row.createdBy, dateCell(row.createdOn), row.notes,
  ];
}

async function assertCompanyAccess(tx: Tx, companyIds: readonly string[], employmentId?: string) {
  if (!companyIds.length) throw new BulkJobAuthorityLost();
  const [row] = await tx.execute<{ allowed: boolean }>(sql`
    select not exists (
      select from jsonb_array_elements_text(${JSON.stringify(companyIds)}::jsonb) company(id)
      where not coalesce(app.can_admin_payroll_for(company.id::uuid), false)
    ) and (${employmentId ?? null}::uuid is null or exists (
      select from public.employment e
      where e.id=${employmentId ?? null}::uuid and app.can_admin_payroll_for(e.company_id)
    )) as allowed
  `);
  if (!row?.allowed) throw new BulkJobAuthorityLost();
}

export function enqueueTransactionExport(ctx: SessionContext, query: TransactionWorkbookQuery) {
  query = exportQuery.parse(query);
  return withTenant(ctx, async (tx) => {
    await assertCompanyAccess(tx, query.filters.companyIds, query.filters.employmentId);
    return enqueueBulkJobTx(tx, ctx, {
      kind: TRANSACTION_EXPORT_KIND,
      companyIds: query.filters.companyIds,
      input: query,
    });
  });
}

/**
 * Every processed payslip the query covers, through the period-sliced reader (never clipped, never refused for the
 * scope's size), folded by the same builder the History screen's columns follow. Written to a private temporary file;
 * the caller stores it in parts exactly like the Fixed and Individual workbooks.
 */
async function writeHistoryWorkbook(ctx: SessionContext, query: HistoryWorkbookQuery, path: string): Promise<TransactionWorkbookReceipt> {
  const f = query.filters;
  const rows = await readProcessedPayslipsForExport(ctx, {
    companyIds: f.companyIds, year: f.year, month: f.month, employmentId: f.employmentId,
    cycle: f.cycle, payrollCycleId: f.payrollCycleId,
  });
  const hrdfRegisteredCompanyIds = ((await packFor('MY')?.companyStatutory.list(ctx)) ?? [])
    .filter((row) => row.hrdfStatus !== 'not_registered').map((row) => row.companyId);
  // 417d4937 — the same catalogue read the screen does, archived items included, so a column is named as on screen.
  const payItemNames: Record<string, string> = Object.fromEntries(
    (await listPayComponents(ctx, { includeArchived: true })).map((c) => [c.code, c.name]),
  );
  const sheet = f.sheet;
  const data = buildHistoryExport({
    rows, hrdfRegisteredCompanyIds, payItemNames,
    cycleLabels: sheet.cycleLabels, statusLabels: sheet.statusLabels,
    title: sheet.title, filename: sheet.filename,
    filterCaption: sheet.filterCaption, filterDescription: sheet.filterDescription,
    detailNote: sheet.detailNote,
  });
  const file = toXlsxReport(data);
  await writeFile(path, file.bytes, { mode: 0o600 });
  const bytes = file.bytes.byteLength;
  return {
    kind: 'history', employmentId: f.employmentId, rows: rows.length, bytes,
    fileSha256: createHash('sha256').update(file.bytes).digest('hex'), parts: Math.ceil(bytes / partBytes),
    filename: data.filename,
  };
}

export const transactionExportJobHandler: BulkJobHandler = {
  kind: TRANSACTION_EXPORT_KIND,
  mode: 'per-step',
  async prepare(ctx, job) {
    const query = exportJobQuery(job);
    await withTenant(ctx, (tx) => assertCompanyAccess(tx, job.company_ids, query.filters.employmentId));
    return { steps: [], phase: 'exporting' };
  },
  async applyStepTx() {
    throw new Error('The payroll workbook has no import steps.');
  },
  async finalize(ctx, job, unit) {
    const query = exportJobQuery(job);
    const directory = await mkdtemp(join(tmpdir(), 'aihr-transaction-export-'));
    const path = join(directory, 'transactions.xlsx');
    try {
      const receipt = query.kind === 'history' ? await writeHistoryWorkbook(ctx, query, path) : await readTransactionExport(ctx, query, async (total, rows) => {
        const hash = createHash('sha256');
        let bytes = 0;
        const digest = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        async function* cells() {
          for await (const row of rows) {
            yield query.kind === 'fixed'
              ? fixedCells(row as FixedTransactionViewRow, query.asOf)
              : individualCells(row as IndividualTxnViewRow);
          }
        }
        await pipeline(
          transactionXlsxStream(query.kind === 'fixed' ? fixedHeaders : individualHeaders, cells(), total),
          digest,
          createWriteStream(path, { mode: 0o600 }),
        );
        return {
          kind: query.kind, employmentId: query.filters.employmentId,
          rows: total, bytes, fileSha256: hash.digest('hex'), parts: Math.ceil(bytes / partBytes),
        } satisfies TransactionWorkbookReceipt;
      });
      await withTenant(ctx, async (tx) => {
        await unit.fenceTx(tx);
        await assertCompanyAccess(tx, job.company_ids, query.filters.employmentId);
        let part = 0;
        for await (const bytes of createReadStream(path, { highWaterMark: partBytes })) {
          await tx.execute(sql`select app.payroll_transaction_export_store(${job.id}::uuid, ${part++}, ${bytes as Buffer}::bytea)`);
        }
        if (part !== receipt.parts) throw new Error('The payroll workbook file is incomplete.');
      });
      return { result: receipt, counters: { rows: receipt.rows } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};

/** One row of the Workbooks list: which export, its state and its times. */
export type TransactionWorkbookItem = {
  id: string; state: BulkJobState; exportKind: string | null; createdAt: Date; finishedAt: Date | null;
};
/** The viewer's own most recent transaction workbooks (at most 25), newest first, keeping those whose every company is
 * in the selected scope. One indexed read of the list's columns only (listBulkJobSummariesTx). The Workbooks page and
 * its "still preparing" poll both read through here, so the poll answers for exactly the rows the page shows. */
export async function listTransactionWorkbooks(ctx: SessionContext, scopeIds: readonly string[]): Promise<TransactionWorkbookItem[]> {
  // listBulkJobsTx's rows and order (the creator index bulk_job_creator) with only the list's columns: never the
  // captured session, plan, counters or row errors. Read under the viewer's row security like every job read.
  const rows = await withTenant(ctx, (tx) => tx.execute<{
    id: string; state: BulkJobState; company_ids: string[]; input: unknown; result: unknown; created_at: Date | string; finished_at: Date | string | null;
  }>(sql`select id, state, company_ids, input, result, created_at, finished_at from bulk_job
    where tenant_id = ${ctx.tenantId}::uuid and created_by = ${ctx.userId ?? null}::uuid and kind = ${TRANSACTION_EXPORT_KIND}
    order by created_at desc limit 25`));
  return rows
    .filter((row) => row.company_ids.length > 0 && row.company_ids.every((id) => scopeIds.includes(id)))
    .map((row) => {
      const result = row.result as { kind?: unknown } | null;
      const input = row.input as { kind?: unknown } | null;
      const exportKind = result?.kind ?? input?.kind;
      return {
        id: row.id, state: row.state, exportKind: typeof exportKind === 'string' ? exportKind : null,
        createdAt: new Date(row.created_at), finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
      };
    });
}
/** Whether any workbook the list shows is still being prepared (the page's poll; no page render). */
export async function transactionWorkbooksPreparing(ctx: SessionContext, scopeIds: readonly string[]): Promise<boolean> {
  return (await listTransactionWorkbooks(ctx, scopeIds)).some((item) => bulkJobActive(item.state));
}
export function readTransactionExportJob(ctx: SessionContext, id: string) {
  return withTenant(ctx, async (tx) => {
    const job = await bulkJobTx(tx, id, { kind: TRANSACTION_EXPORT_KIND });
    await assertCompanyAccess(tx, job.company_ids,
      job.state === 'completed' ? transactionWorkbookReceipt(job.result).employmentId : undefined);
    return job;
  });
}

export function transactionWorkbookReceipt(result: unknown): TransactionWorkbookReceipt {
  const receipt = result as TransactionWorkbookReceipt | null;
  if (!receipt || (receipt.kind !== 'fixed' && receipt.kind !== 'individual' && receipt.kind !== 'history') ||
      (receipt.kind === 'history' && !/^[a-z0-9-]{1,80}$/.test(receipt.filename ?? '')) ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || !Number.isSafeInteger(receipt.parts) ||
      receipt.parts !== Math.ceil(receipt.bytes / partBytes) || !/^[a-f0-9]{64}$/.test(receipt.fileSha256)) {
    throw new BulkJobError('Workbook unavailable.', 404);
  }
  return receipt;
}

/** The download's name and type. History keeps the SpreadsheetML `.xls` its in-request export always produced. */
export function transactionWorkbookFile(receipt: TransactionWorkbookReceipt): { name: string; contentType: string } {
  return receipt.kind === 'history'
    ? { name: `${receipt.filename}.xls`, contentType: 'application/vnd.ms-excel; charset=utf-8' }
    : { name: `${receipt.kind}-transactions.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

export async function readTransactionWorkbookPart(ctx: SessionContext, id: string, part: number) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ content: Buffer | null }>(sql`
      select app.payroll_transaction_export_read(${id}::uuid, ${part}) as content
    `);
    if (!row?.content) throw new BulkJobError('Workbook unavailable.', 404);
    return row.content;
  });
}
