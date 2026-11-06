import {notFound} from 'next/navigation';
import {getFormatter,getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {readIndividualImport} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import type {IndividualImportOutcome} from '@/lib/individual-txn-import-model';
import {IndividualImportRows} from './result-rows';
import {IndividualImportRevert} from './revert-control';
export default async function IndividualImportDetailsPage({params}:{params:Promise<{attemptId:string}>}){
 const {s,scopeIds}=await scopedAdmin(),t=await getTranslations('payroll.individualImport'),old=await getTranslations('payroll.txnImport'),f=await getFormatter();
 const {attemptId}=await params,item=await readIndividualImport(s,attemptId,scopeIds).catch(()=>notFound());
 const outcomes:IndividualImportOutcome[]=item.state==='validated'?item.preview.rows.map(row=>({row,state:'invalid' as const})):item.outcomes;
 return <div className={pageWideCls}><PageHeader title={t('details')} description={item.sourceName} back={{href:'/payroll/transactions/individual/imports',label:t('log')}}/><section className="space-y-3 rounded-xl border border-border p-5"><p className="font-mono text-xs">{item.id}</p><p>{t(item.state)} · {t(item.method)}</p><p>{t('time')}: {f.dateTime(new Date(item.createdAt),{dateStyle:'medium',timeStyle:'short'})}</p><p>{t('user')}: {item.createdBy}</p><p>{t('resultCounts',{written:item.written,failed:item.outcomes.filter(o=>o.state==='failed').length,invalid:item.preview.invalid})}</p>{item.revertedAt&&<p>{t('revertedAt')}: {f.dateTime(new Date(item.revertedAt),{dateStyle:'medium',timeStyle:'short'})} · {item.revertedBy}</p>}</section>
 {item.preview.fileError&&<p role="alert" className="mt-4 text-destructive">{t.has(item.preview.fileError)?t(item.preview.fileError as never):old.has(`fileError.${item.preview.fileError}`)?old(`fileError.${item.preview.fileError}` as never):t('failed')}</p>}
 {outcomes.some(outcome=>!outcome.row.ok)&&<a className="mt-4 inline-block text-primary underline" href={`/payroll/transactions/individual/imports/${item.id}/errors`}>{t('downloadErrors')}</a>}
 <IndividualImportRows item={item}/>
 <section className="my-6 space-y-3 rounded-xl border border-border p-5"><h2 className="font-semibold">{t('audit')}</h2>{item.events?.map((event,index)=><p key={index} className="text-sm">{f.dateTime(new Date(event.at),{dateStyle:'medium',timeStyle:'short'})} · {event.actorId} · {t.has(`event.${event.type}`)?t(`event.${event.type}` as never):event.type}{event.reason&&<> — {t.has(event.reason)?t(event.reason as never):t('revertFailed')}</>}</p>)}</section>
 {item.state==='completed' &&item.written>0&&<IndividualImportRevert id={item.id} file={item.sourceName} count={item.written}/>}
 </div>;
}
