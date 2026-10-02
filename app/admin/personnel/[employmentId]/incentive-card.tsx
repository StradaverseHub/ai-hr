import { getTranslations } from 'next-intl/server';
import { Card, Field, SectionHeader, Button, inputCls } from '@/components/ui';
import { saveIncentiveDeclarationAction, revokeIncentiveDeclarationAction } from './incentive-actions';

type Declaration = {
  id: string;
  scheme: 'rep' | 'knowledge_worker' | 'c_suite';
  validFrom: string;
  validTo: string;
  approvalReference: string;
  declaredAt: Date | string;
  archivedAt: Date | string | null;
};
export type IncentiveDeclarationView = { companyId: string; companyName: string; rows: Declaration[];payrollBatchId?:string;payPeriod?:string;configuredScheme?:string;effectiveScheme?:string;readinessCode?:string };

/** Separate forms intentionally remain outside the tab's full-row statutory save. */
export async function IncentiveDeclarationCard({ employmentId, view, from, asOf, error,payrollFrom,payrollJob }: {
  employmentId: string; view: IncentiveDeclarationView; from?: string; asOf?: string; error?: string;payrollFrom?:string;payrollJob?:string;
}) {
  const t = await getTranslations('people.detail.incentiveDeclarations');
  const context = <><input type="hidden" name="employmentId" value={employmentId} />
    <input type="hidden" name="tab" value="bankStatutory" />
    {from === 'org' && <input type="hidden" name="from" value="org" />}
    {asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) && <input type="hidden" name="asOf" value={asOf} />}
    {view.payrollBatchId&&<><input type="hidden" name="payrollBatchId" value={view.payrollBatchId}/><input type="hidden" name="expectedPayPeriod" value={view.payPeriod}/>{payrollFrom&&<input type="hidden" name="payrollFrom" value={payrollFrom}/>} {payrollJob&&<input type="hidden" name="payrollJob" value={payrollJob}/>}</>}</>;
  const errorKey = ['invalid', 'unavailable', 'saveFailed', 'revokeFailed', 'invalid_scheme', 'invalid_period',
    'approval_required', 'missing_reference', 'not_found', 'not_resident', 'citizenship_unknown', 'overlap', 'missing_declaration', 'declaration_revoked', 'declaration_outside_period', 'stale_context'].includes(error ?? '') ? error : null;
  return <Card>
    <SectionHeader title={t('title')} />
    <div className="space-y-4 p-4">
      <p className="text-sm"><span className="text-muted-foreground">{t('employer')}: </span>{view.companyName}</p>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <p className="text-xs text-muted-foreground">{t('legacyHint')}</p>
      {view.payrollBatchId&&<div className="grid gap-3 rounded-md border border-border p-3 text-sm sm:grid-cols-2">
        <div><span className="text-muted-foreground">{t('payrollPeriod')}: </span>{view.payPeriod}</div>
        <div><span className="text-muted-foreground">{t('configuredCategory')}: </span>{t(`scheme_${view.configuredScheme}`)}</div>
        <div><span className="text-muted-foreground">{t('effectiveCategory')}: </span>{view.effectiveScheme?t(`scheme_${view.effectiveScheme}`):t('notReady')}</div>
        <div role="status">{view.readinessCode?t(`error_${view.readinessCode}`):t('ready')}</div>
      </div>}
      {errorKey && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{t(`error_${errorKey}`)}</p>}
      {view.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> :
        <ul className="space-y-3">{view.rows.map(row => <li key={row.id} className="rounded-md border border-border p-3">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">{t('scheme')}</dt><dd>{t(`scheme_${row.scheme}`)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{row.archivedAt ? t('statusRevoked') : t('statusActive')}</dt><dd>{row.validFrom} — {row.validTo}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t('approvalReference')}</dt><dd className="break-words">{row.approvalReference}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('declaredAt')}</dt><dd>{typeof row.declaredAt === 'string' ? row.declaredAt : row.declaredAt.toISOString()}</dd></div>
          </dl>
          {!row.archivedAt && <form action={revokeIncentiveDeclarationAction} className="mt-3 space-y-2">
            {context}<input type="hidden" name="id" value={row.id} />{view.payrollBatchId&&<input type="hidden" name="expectedCompanyId" value={view.companyId}/>}
            <p className="text-xs text-muted-foreground">{t('revokeHint')}</p>
            <Button type="submit" variant="destructive" size="sm">{t('revoke')}</Button>
          </form>}
        </li>)}</ul>}
      <form action={saveIncentiveDeclarationAction} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        {context}
        {/* Optimistic display-context precondition only; service derives and locks the real company. */}
        <input type="hidden" name="expectedCompanyId" value={view.companyId} />
        <Field label={t('scheme')}><select name="scheme" required defaultValue={view.payrollBatchId&&['rep','knowledge_worker','c_suite'].includes(view.effectiveScheme??view.configuredScheme??'')?(view.effectiveScheme??view.configuredScheme):''} className={inputCls}>
          <option value="" disabled>{t('scheme')}</option>
          {(['rep','knowledge_worker','c_suite'] as const).map(scheme => <option key={scheme} value={scheme}>{t(`scheme_${scheme}`)}</option>)}
        </select></Field>
        <Field label={t('approvalReference')}><input name="approvalReference" required maxLength={300} className={inputCls} /></Field>
        <Field label={t('validFrom')}><input name="validFrom" type="month" required defaultValue={view.payPeriod} className={inputCls} /></Field>
        <Field label={t('validTo')}><input name="validTo" type="month" required defaultValue={view.payPeriod} className={inputCls} /></Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><input name="eligibilityConfirmed" type="checkbox" value="confirmed" required className="mt-1" /><span>{t('eligibilityConfirmed')}</span></label>
        <div className="sm:col-span-2"><Button type="submit">{t('save')}</Button></div>
      </form>
    </div>
  </Card>;
}
