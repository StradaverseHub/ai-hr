import Link from 'next/link';
import {getTranslations,getFormatter} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {listPayrollHistoryAttempts} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
export default async function PayrollHistoryLogsPage({searchParams}:{searchParams:Promise<{before?:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('payroll.historyRevisions'),format=await getFormatter();
 const {before}=await searchParams;
 const result=await listPayrollHistoryAttempts(ctx,{before});
 return <div className={pageWideCls}><PageHeader title={t('logFile')} description={t('logHint')} back={{href:'/payroll/history-import',label:t('backImport')}}/>
  <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['reference','file','time','user','companies','outcome'].map(key=><th key={key} className="p-3">{t(key)}</th>)}</tr></thead><tbody>{result.items.map(item=>{const state=item.events.some(event=>event.kind==='reverted')?'reverted':item.events.some(event=>event.kind==='confirmed')?'confirmed':item.events.some(event=>event.kind==='failed')?'failed':item.plan.counts.invalid?'invalid':'validated';return <tr key={item.id} className="border-t align-top"><td className="p-3"><Link href={'/payroll/history-import/logs/'+item.id} className="font-mono text-xs text-primary underline">{item.id}</Link></td><td className="p-3">{item.sourceName}</td><td className="p-3 whitespace-nowrap">{format.dateTime(item.createdAt,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</td><td className="p-3"><span title={item.createdBy}>{item.createdByName??item.createdBy}</span></td><td className="p-3">{[...new Set(item.plan.rows.map(row=>row.companyName))].filter(Boolean).join(', ')||'—'}</td><td className="p-3"><p className="font-medium">{t(`states.${state}`)}</p><p className="mt-1 text-xs text-muted-foreground">{t('counts',{...item.plan.counts})}</p></td></tr>;})}</tbody></table>{result.items.length===0&&<p className="p-6 text-sm text-muted-foreground">{t('noAttempts')}</p>}</div>
  {result.nextCursor&&<Link className="inline-flex rounded-lg border px-4 py-2 text-sm" href={'?before='+result.nextCursor}>{t('older')}</Link>}
 </div>;
}
