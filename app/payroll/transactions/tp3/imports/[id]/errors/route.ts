import { getTranslations } from 'next-intl/server';
import { BulkJobError } from '@/core/bulk-job';
import { readTp3Import } from '@/core/tp3-import-job';
import { toCsv } from '@/lib/csv';
import { scopedAdmin } from '@/lib/scope';
import { tp3ColumnLabel, tp3RowResult } from '../../../tp3-import-text';

/**
 * 5084d02e — one Form TP3 import's row problems as CSV: row, Employee ID, year, column and reason, in the reader's
 * language. No amount is in it (the job never keeps one). Same guard and the same scoped read as the page.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { s, scopeIds } = await scopedAdmin();
  const { id } = await params;
  try {
    const [job, t] = await Promise.all([readTp3Import(s, id, scopeIds), getTranslations('payroll.tp3Import')]);
    const rows = job.rows.filter((row) => row.reason);
    if (!rows.length) return new Response(null, { status: 404 });
    const csv = toCsv([
      [t('colRow'), t('colEmployeeId'), t('colYear'), t('colColumn'), t('colReason')],
      ...rows.map((row) => [row.rowNum, row.employeeId, row.year ?? '', tp3ColumnLabel(t, row.field), tp3RowResult(t, row)]),
    ]);
    // A byte-order mark so Excel opens the file as UTF-8 (names and reasons in any of the six languages).
    return new Response(`﻿${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="form-tp3-import-problems-${job.id.slice(0, 8)}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof BulkJobError) return new Response(null, { status: 404 });
    throw error;
  }
}
