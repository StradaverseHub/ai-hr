import { recordPayrollExportReceiptAcross } from '@/core/payroll-audit/access-log';
import {
  readTransactionExportJob, readTransactionWorkbookPart, transactionWorkbookReceipt,
} from '@/core/payroll-transaction-export';
import { BulkJobError } from '@/core/bulk-job';
import { BulkJobAuthorityLost } from '@/core/bulk-job-worker';
import { scopedAdmin } from '@/lib/scope';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { id } = await params;
  try {
    const job = await readTransactionExportJob(s, id);
    if (job.state !== 'completed' || job.company_ids.some((companyId) => !scopeIds.includes(companyId))) {
      return new Response(null, { status: 404 });
    }
    const receipt = transactionWorkbookReceipt(job.result);
    const first = await readTransactionWorkbookPart(s, id, 0);
    await recordPayrollExportReceiptAcross(s, {
      surface: 'transaction_export', companyIds: job.company_ids, format: 'xlsx', detail: receipt.kind,
    }, receipt);
    let part = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (part >= receipt.parts) return controller.close();
        const buffer = part === 0 ? first : await readTransactionWorkbookPart(s, id, part);
        controller.enqueue(new Uint8Array(buffer));
        part++;
      },
    });
    return new Response(stream, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Length': String(receipt.bytes),
        'Content-Disposition': `attachment; filename="${receipt.kind}-transactions.xlsx"`,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
  } catch (error) {
    if (error instanceof BulkJobError || error instanceof BulkJobAuthorityLost) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}
