import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { BulkJobAuthorityLost, type BulkJobHandler } from './bulk-job-worker';
import {
  INDIVIDUAL_TXN_STATUS_FILTERS, readTransactionExport,
  type FixedTransactionViewRow, type IndividualTxnViewRow, type TransactionExportQuery,
} from './payroll-view';
import { TXN_KINDS } from './payroll-individual-txn';

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
]);

function exportJobQuery(job: {input: unknown; company_ids: string[]}): TransactionExportQuery {
  const query = exportQuery.parse(job.input);
  const allowed = new Set(job.company_ids);
  if (allowed.size !== new Set(query.filters.companyIds).size ||
      query.filters.companyIds.some((id) => !allowed.has(id))) throw new BulkJobAuthorityLost();
  return query;
}

const dateCell = (date: string | null) => date ? { date } : null;

type TransactionWorkbookReceipt = {
  kind: TransactionExportQuery['kind'];
  employmentId?: string;
  rows: number;
  bytes: number;
  fileSha256: string;
  parts: number;
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

export function enqueueTransactionExport(ctx: SessionContext, query: TransactionExportQuery) {
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
      const receipt = await readTransactionExport(ctx, query, async (total, rows) => {
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
  if (!receipt || (receipt.kind !== 'fixed' && receipt.kind !== 'individual') ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || !Number.isSafeInteger(receipt.parts) ||
      receipt.parts !== Math.ceil(receipt.bytes / partBytes) || !/^[a-f0-9]{64}$/.test(receipt.fileSha256)) {
    throw new BulkJobError('Workbook unavailable.', 404);
  }
  return receipt;
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
