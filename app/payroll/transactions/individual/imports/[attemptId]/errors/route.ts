import {getTranslations} from 'next-intl/server';
import {toCsv} from '@/lib/csv';
import {scopedAdmin} from '@/lib/scope';
import {listIndividualImportFailures} from '@/packs/payroll/service';

/** The refused rows with their uploaded values. 0ec0ee00 — only those rows are read, filtered in SQL. */
export async function GET(_request: Request, {params}: {params: Promise<{attemptId: string}>}) {
  const {s, scopeIds} = await scopedAdmin();
  const {attemptId} = await params;
  const failures = await listIndividualImportFailures(s, attemptId, scopeIds).catch(() => null);
  if (!failures?.length) return new Response(null, {status: 404});

  const t = await getTranslations('payroll.individualImport');
  const old = await getTranslations('payroll.txnImport');
  const header = ['row', 'employee', 'payItem', 'month', 'cycle', 'effectiveDate', 'inputType', 'quantity', 'amount', 'outcome'] as const;
  const csv = toCsv([header.map(key => t(key)), ...failures.map(({row, record: input}) => {
    const key = `reason.${row.reason}` as const;
    return [
      row.rowNum, [row.employeeId, row.employeeName].filter(Boolean).join(' · '),
      row.payItemCode, input?.__pay_period, input?.__configured_cycle, row.effectiveFrom,
      row.inputType ?? input?.__input_unit, row.inputValue == null ? input?.quantity : String(row.inputValue), input?.amount ?? row.amount,
      old.has(key as never) ? old(key as never, (row.detail ?? {}) as never) : t('failed'),
    ];
  })]);
  return new Response('﻿' + csv, {headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="individual-import-errors.csv"',
    'Cache-Control': 'private, no-store',
  }});
}
