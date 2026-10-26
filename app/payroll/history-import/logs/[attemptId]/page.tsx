import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations,getFormatter} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {getPayrollHistoryAttempt} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import {RevisionPreview} from '../../revision-preview';
import {RevertControl} from './revert-control';
export default async function PayrollHistoryLogPage({params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),t=await getTranslations('payroll.historyRevisions'),format=await getFormatter();
 const {attemptId}=await params,item=await getPayrollHistoryAttempt(ctx,attemptId);if(!item)notFound();
 const committed=item.events.find(event=>event.kind==='confirmed'),reverted=item.events.some(event=>event.kind==='reverted');
 return <div className={pageWideCls}><PageHeader title={item.sourceName} description={item.id} back={{href:'/payroll/history-import/logs',label:t('logFile')}}/>
  <section className="space-y-4 rounded-xl border p-5"><dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('time')}</dt><dd>{format.dateTime(item.createdAt,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</dd></div><div><dt className="text-muted-foreground">{t('user')}</dt><dd className="break-words" title={item.createdBy}>{item.createdByName??item.createdBy}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">{t('fingerprint')}</dt><dd className="break-all font-mono text-xs">{item.sourceHash}</dd></div></dl><div className="flex flex-wrap gap-3"><Link className="rounded-lg border px-4 py-2 text-sm font-medium" href={'/payroll/history-import/logs/'+item.id+'/source'}>{t('downloadSource')}</Link><Link className="rounded-lg border px-4 py-2 text-sm font-medium" href={'/payroll/history-import/logs/'+item.id+'/report'}>{t('downloadReport')}</Link></div></section>
  <section className="space-y-4 rounded-xl border p-5"><h2 className="font-semibold">{t('audit')}</h2><p className="text-sm text-muted-foreground">{t('auditHint')}</p>{item.events.length===0?<p className="text-sm">{t('states.validated')}</p>:<ol className="divide-y">{item.events.map(event=><li key={event.id} className="space-y-1 py-3 text-sm"><p className="font-medium">{t(`events.${event.kind}`)} · {format.dateTime(event.createdAt,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})}</p><p className="text-xs text-muted-foreground" title={event.actorId}>{event.actorName??event.actorId}</p>{typeof event.detail.reason==='string'&&<p className="text-destructive">{event.detail.reason}</p>}</li>)}</ol>}</section>
  <RevisionPreview plan={item.plan}/>
  {committed&&committed.changes.length>0&&!reverted&&<RevertControl attemptId={item.id} count={committed.changes.length}/>}
 </div>;
}
