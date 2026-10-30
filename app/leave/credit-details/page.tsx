import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listOwnEarnedLeaveCredits } from '@/packs/leave/service';
import { ownCreditRegisterQuery } from '@/lib/own-credit-register-query';
import { CREDIT_REGISTER_STATUSES } from '@/lib/leave-credit-register';
import { pageState } from '@/lib/pagination';
import { Card, ErrorBanner, PageHeader, inputCls, btnPrimary, btnGhost, thCls, theadCls, tbodyCls, tableWrapCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { EarnedCreditCells } from '@/components/leave/earned-credit-cells';

const PAGE='/leave/credit-details';
export default async function LeaveCreditDetailsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {s}=await scopedSession(), q=ownCreditRegisterQuery(await searchParams);
  const t=await getTranslations('leaveCreditDetails'), tr=await getTranslations('admin.leaveCreditRegister'), th=await getTranslations('admin.leaveCredit');
  const labels={available:tr('available'),partially_used:tr('partiallyUsed'),fully_used:tr('fullyUsed'),expired:tr('expired'),reversed:tr('reversed'),paid_out:tr('paidOut')};
  if(!q.valid)return <div className="space-y-4"><PageHeader title={t('title')} description={t('subtitle')}/><ErrorBanner message={t('invalid')}/><Link href={PAGE} className={btnGhost}>{th('filterClear')}</Link></div>;
  // Scope is always the signed-in person, including their historical employments. The company cookie
  // cannot hide or reveal personal credits. Existing credits remain readable during module wind-down.
  const register=await listOwnEarnedLeaveCredits(s,{...q.filters,limit:q.query.limit,offset:q.query.offset});
  const state=pageState(q.query,register.matched,register.rows.length);
  const emptyMessage=register.matched>0?t('emptyPage'):(q.filters.status||q.filters.from||q.filters.to)?t('emptyFiltered'):t('empty');
  return <div className="w-full min-w-0 space-y-4">
    <PageHeader title={t('title')} description={t('subtitle')}/>
    <Card className="space-y-4 p-4">
      <form method="get" action={PAGE} className="grid items-end gap-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm"><span>{tr('filterStatus')}</span><select name="status" defaultValue={q.filters.status??''} className={inputCls}><option value="">{tr('allStatuses')}</option>{CREDIT_REGISTER_STATUSES.map(status=><option key={status} value={status}>{labels[status]}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>{tr('workedFrom')}</span><input type="date" name="from" defaultValue={q.filters.from} className={inputCls}/></label>
        <label className="space-y-1 text-sm"><span>{tr('workedTo')}</span><input type="date" name="to" defaultValue={q.filters.to} className={inputCls}/></label>
        <input type="hidden" name="size" value={q.query.size}/>
        <div className="flex gap-2 sm:col-span-3"><button className={btnPrimary}>{th('filterApply')}</button><Link href={PAGE} className={btnGhost}>{th('filterClear')}</Link></div>
      </form>
    </Card>
    <Card className="overflow-hidden p-0">
      <Pager state={state} basePath={PAGE} params={q.filters} truncatedHint={t('truncatedHint')}/>
      <div className={tableWrapCls} tabIndex={0} role="region" aria-label={t('title')}>
        <table className="w-full min-w-[58rem] text-sm" data-testid="own-earned-credit-register"><thead className={theadCls}><tr>
          {[th('col.dateWorked'),tr('earned'),tr('used'),tr('availableBalance'),th('col.expires'),th('col.reason'),tr('addedBy'),th('col.status')].map(label=><th key={label} scope="col" className={thCls}>{label}</th>)}
        </tr></thead><tbody className={tbodyCls}>{register.rows.length?register.rows.map(row=><tr className="align-top" key={row.accrualId}><EarnedCreditCells row={row}/></tr>):<tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">{emptyMessage}</td></tr>}</tbody></table>
      </div>
    </Card>
  </div>;
}
