import {getTranslations} from 'next-intl/server';
import {toCsv} from '@/lib/csv';
import {scopedAdmin} from '@/lib/scope';
import {readIndividualImport} from '@/packs/payroll/service';

export async function GET(_request: Request, {params}: {params: Promise<{attemptId: string}>}) {
  const {s, scopeIds} = await scopedAdmin();
  const {attemptId} = await params;
  const item = await readIndividualImport(s, attemptId, scopeIds).catch(() => null);
  if (!item) return new Response(null, {status: 404});

  const t = await getTranslations('payroll.individualImport');
  const old = await getTranslations('payroll.txnImport');
  const rows = item.state === 'validated' ? item.preview.rows : item.outcomes.map(outcome => outcome.row);
  const failures = rows.filter(row => !row.ok);
  if (!failures.length) return new Response(null, {status: 404});

  const header = ['row', 'employee', 'payItem', 'month', 'cycle', 'effectiveDate', 'inputType', 'quantity', 'amount', 'outcome'] as const;
  const csv = toCsv([header.map(key => t(key)), ...failures.map(row => {
    const input = item.records[row.rowNum - 2];
    const key = `reason.${row.reason}` as const;
    return [
      row.rowNum, [row.employeeId, row.employeeName].filter(Boolean).join(' · '),
      row.payItemCode, input?.__pay_period, input?.__configured_cycle, row.effectiveFrom,
      input?.__input_unit, input?.quantity, input?.amount ?? row.amount,
      old.has(key as never) ? old(key as never, (row.detail ?? {}) as never) : t('failed'),
    ];
  })]);
  return new Response('\uFEFF' + csv, {headers: {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="individual-import-errors.csv"',
    'Cache-Control': 'private, no-store',
  }});
}
