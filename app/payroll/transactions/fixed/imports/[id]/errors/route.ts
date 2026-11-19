import { getTranslations } from 'next-intl/server';
import { BulkJobError } from '@/core/bulk-job';
import { readFixedTransactionImport } from '@/core/fixed-transaction-import-job';
import { TXN_IMPORT_ERROR_FILENAME } from '@/lib/payroll-txn-import-schema';
import { scopedAdmin } from '@/lib/scope';
import { buildXlsx } from '@/lib/spreadsheet';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { id } = await params;
  try {
    const [job, t, log] = await Promise.all([
      readFixedTransactionImport(s, id, scopeIds), getTranslations('payroll.txnImport'), getTranslations('payroll.individualImport'),
    ]);
    const rows = job.rows.flatMap(({ rowNum, employeeId, payItemCode, reason, detail }) => {
      if (!reason) return [];
      const message = reason !== 'unexpected' && t.has(`reason.${reason}` as never)
        ? t(`reason.${reason}` as never, (detail ?? {}) as never) : log('importFailed');
      return [[String(rowNum), employeeId, payItemCode, message]];
    });
    if (!rows.length) return new Response(null, { status: 404 });
    const bytes = await buildXlsx([t('colRow'), t('colEmployeeId'), t('colPayItemCode'), t('colError')], rows, {
      sheetName: 'Import Errors', textColumns: [1, 2],
    });
    return new Response(Uint8Array.from(bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${TXN_IMPORT_ERROR_FILENAME.fixed}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof BulkJobError) return new Response(null, { status: 404 });
    throw error;
  }
}
