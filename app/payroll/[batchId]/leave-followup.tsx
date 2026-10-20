import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { listPayrollLeaveExceptionAdjustments, listPayrollLeaveExceptions } from '@/packs/payroll/service';
import { Button, Card, EmployeeCode, ErrorBanner, Field, SectionHeader, inputCls } from '@/components/ui';
import { resolveLeavePayrollExceptionAction } from './leave-followup-actions';

export async function PayrollLeaveFollowup({ session, batchId, failed }: { session: SessionContext; batchId: string; failed?: boolean }) {
  const [t, format, rows, adjustments] = await Promise.all([
    getTranslations('payrollLeaveFollowup'), getFormatter(), listPayrollLeaveExceptions(session, batchId), listPayrollLeaveExceptionAdjustments(session, batchId),
  ]);
  if (!rows.length) return null;
  return <Card id="leave-followup" className="scroll-mt-6">
    <SectionHeader title={t('title')} subtitle={t('description')} />
    {failed && <ErrorBanner message={t('error')} />}
    <p className="mb-4 text-sm text-muted-foreground">{t('noMoneyChange')}</p>
    <div className="divide-y">{rows.map(row => <details key={row.id} className="py-3" open={row.status === 'open'}>
      <summary className="cursor-pointer text-sm font-medium">{row.employee} · {row.leave_request_id.slice(0, 8)} · {t(`states.${row.status}`)}</summary>
      <div className="mt-3 space-y-3 text-sm">
        <EmployeeCode code={row.employee_no} />
        <p>{t(`sources.${row.source_action}`)} · {format.dateTime(new Date(row.created_at), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' })}</p>
        <p>{t('dates')}: {row.affected_dates.map(date => format.dateTime(new Date(`${date}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' })).join(', ')}</p>
        {row.status === 'resolved' ? <>
          <p className="font-medium">{t(`outcomes.${row.resolution}`)}</p>
          <p className="whitespace-pre-wrap">{row.explanation}</p>
          {row.adjustment_batch_id && <p>{t('adjustmentReference')}: <a href={`/payroll/${row.adjustment_batch_id}`} className="underline">{row.adjustment_batch_id.slice(0, 8)}</a></p>}
          {row.resolved_at && <p className="text-xs text-muted-foreground">{t('resolvedAt')}: {format.dateTime(new Date(row.resolved_at), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' })}</p>}
        </> : <form action={resolveLeavePayrollExceptionAction} className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="exceptionId" value={row.id} />
          <Field label={t('resolution')}><select required name="resolution" defaultValue="" className={inputCls}>
            <option value="" disabled>{t('chooseResolution')}</option>
            <option value="adjustment">{t('outcomes.adjustment')}</option>
            <option value="no_adjustment">{t('outcomes.no_adjustment')}</option>
          </select></Field>
          <Field label={t('adjustmentReference')}><select name="adjustmentBatchId" defaultValue="" className={inputCls}>
            <option value="">{t('chooseAdjustment')}</option>
            {adjustments.filter(choice => choice.exceptionId === row.id).map(choice => <option key={choice.id} value={choice.id}>{choice.payPeriod} · {choice.batchDate} · {choice.runSeq}</option>)}
          </select></Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('adjustmentHelp')}</p>
          <div className="sm:col-span-2"><Field label={t('explanation')}><textarea name="explanation" required minLength={10} maxLength={2000} rows={3} className={inputCls} /></Field></div>
          <Button type="submit" className="w-fit">{t('resolve')}</Button>
        </form>}
      </div>
    </details>)}</div>
  </Card>;
}
