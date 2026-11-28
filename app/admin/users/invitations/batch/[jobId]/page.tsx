import {randomUUID} from 'node:crypto';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getFormatter,getTranslations} from 'next-intl/server';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {ActionNavigateForm} from '@/components/action-navigate-form';
import {ActionButton} from '@/components/ui/action-button';
import {Card,ErrorBanner,PageHeader,btnGhost,btnPrimary,tableWrapCls,tbodyCls,theadCls,thCls} from '@/components/ui';
import {bulkJobActive,bulkJobPercent} from '@/lib/bulk-job';
import {InvitationBatchError,readInvitationBatch,type InvitationOutcome} from '@/core/account-invitation-batch';
import {cancelInvitationBatchAction,retryFailedInvitationsAction} from '../actions';
import {RefreshWhileRunning} from './refresh-while-running';

/**
 * Board 0735d1b7 — one invitation batch: its progress while it runs, then who was sent, who failed and why, who was
 * skipped and why, and whose email could not be confirmed. Only the administrator who started it can open it
 * (bulk_job row security). One page of results at a time; names are read for that page only.
 */
const BASE='/admin/users/invitations/batch';
const OUTCOMES:readonly InvitationOutcome[]=['sent','failed','skipped','uncertain'];
const PROBLEMS=['nothingToRetry','running','installing','notStoppable','failed','forbidden','unavailable'] as const;
export default async function InvitationBatchPage({params,searchParams}:{params:Promise<{jobId:string}>;searchParams:Promise<{outcome?:string;after?:string;problem?:string;dropped?:string}>}){
 const s=await requireGroupAdministration(),{jobId}=await params,sp=await searchParams;
 const view=await readInvitationBatch(s,{jobId,outcome:sp.outcome,after:sp.after}).catch(error=>{if(error instanceof InvitationBatchError)notFound();throw error;});
 const [t,users,formatter]=await Promise.all([getTranslations('admin.users.batchInvite'),getTranslations('admin.users'),getFormatter()]);
 const {job,result}=view,active=bulkJobActive(job.state);
 const problem=PROBLEMS.find(p=>p===sp.problem),dropped=Number(sp.dropped);
 const counts=result?.counts??{sent:job.counters.sent??0,failed:job.counters.failed??0,skipped:job.counters.skipped??0,uncertain:job.counters.uncertain??0};
 const reasonText=(reason:string|null)=>reason?(t.has(`reason.${reason}` as never)?t(`reason.${reason}` as never):t('reason.other')):'—';
 const tone=(o:InvitationOutcome)=>o==='sent'?'text-emerald-700 dark:text-emerald-400':o==='failed'?'text-destructive':o==='uncertain'?'text-amber-800 dark:text-amber-300':'text-muted-foreground';
 const filterHref=(o:string)=>o==='all'?`${BASE}/${job.id}`:`${BASE}/${job.id}?outcome=${o}`;
 const settings=result&&result.mode==='send'&&result.role?t('settingsLine',{role:users(`role.${result.role}`),scope:result.companyId?t('companyScoped'):users('groupWide')}):null;
 return <div className="mx-auto w-full max-w-6xl space-y-6">
  <PageHeader title={t(result?.mode==='retry'?'retryTitle':'resultsTitle')} back={{href:BASE,label:t('title')}}
   description={t('startedAt',{at:formatter.dateTime(new Date(job.createdAt),{dateStyle:'medium',timeStyle:'short'})})}/>
  <RefreshWhileRunning running={active}/>
  {problem&&<div role="alert"><ErrorBanner message={t(`problem.${problem}`,{count:0})}/></div>}
  {Number.isSafeInteger(dropped)&&dropped>0&&<p role="status" className="rounded-lg border border-border p-4 text-sm">{t('dropped',{count:dropped})}</p>}
  <Card className="space-y-3 p-4">
   <p className="font-medium">{t(`state.${job.state}`)}</p>
   {settings&&<p className="text-sm text-muted-foreground">{settings}</p>}
   {active&&<><progress className="w-full" value={bulkJobPercent(job)} max={100} aria-label={t('progressLabel')}/>
    <p className="text-sm tabular-nums text-muted-foreground">{t('progress',{done:job.stepsDone,total:job.stepsTotal})}</p></>}
   <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{OUTCOMES.map(o=><div key={o} className="rounded-md border border-border p-3">
    <dt className="text-xs text-muted-foreground">{t(`outcome.${o}`)}</dt><dd className={`text-lg font-semibold tabular-nums ${tone(o)}`}>{counts[o]??0}</dd></div>)}</dl>
   <p className="text-sm text-muted-foreground">{t('pendingNote')}</p>
   {counts.uncertain>0&&<p className="text-sm text-amber-800 dark:text-amber-300">{t('uncertainHelp')}</p>}
   {job.state==='failed'&&<p className="text-sm text-destructive">{t('stoppedError')}</p>}
   <div className="flex flex-wrap gap-2">
    {active&&!job.cancelRequested&&<ActionNavigateForm action={cancelInvitationBatchAction} className="space-y-1"><input type="hidden" name="jobId" value={job.id}/>
     <ActionButton type="submit" className={`${btnGhost} min-h-11`}>{t('cancel')}</ActionButton><p className="text-xs text-muted-foreground">{t('cancelHelp')}</p></ActionNavigateForm>}
    {active&&job.cancelRequested&&<p className="text-sm text-muted-foreground">{t('cancelRequested')}</p>}
    {view.canRetry&&<ActionNavigateForm action={retryFailedInvitationsAction} className="space-y-1"><input type="hidden" name="jobId" value={job.id}/><input type="hidden" name="operationKey" value={randomUUID()}/>
     <ActionButton type="submit" className={`${btnPrimary} min-h-11`}>{t('retry',{count:counts.failed})}</ActionButton><p className="text-xs text-muted-foreground">{t('retryHelp')}</p></ActionNavigateForm>}
   </div>
  </Card>
  {result&&<section className="space-y-3" aria-labelledby="batch-results">
   <h2 id="batch-results" className="font-medium">{t('resultsHeading')}</h2>
   <nav className="flex flex-wrap gap-2" aria-label={t('resultsFilter')}>{(['all',...OUTCOMES] as const).map(o=><Link key={o} href={filterHref(o)} aria-current={view.filter===o?'page':undefined}
    className={`rounded-full border px-3 py-1 text-sm ${view.filter===o?'border-primary bg-primary/10 font-medium':'border-border hover:bg-muted'}`}>{o==='all'?t('filterAll',{count:result.outcomes.length}):`${t(`outcome.${o}`)} (${counts[o]??0})`}</Link>)}</nav>
   {view.lines.length===0?<p className="text-sm text-muted-foreground">{t('noResults')}</p>:<div className={tableWrapCls}><table className="w-full min-w-[640px] text-left text-sm">
    <thead className={theadCls}><tr><th scope="col" className={thCls}>{t('colName')}</th><th scope="col" className={thCls}>{t('colEmployeeId')}</th>
     <th scope="col" className={thCls}>{t('colResult')}</th><th scope="col" className={thCls}>{t('colReason')}</th></tr></thead>
    <tbody className={tbodyCls}>{view.lines.map((line,index)=><tr key={`${line.personId??'x'}:${index}`}>
     <td className="px-3 py-2 font-medium">{line.name??t('unknownPerson')}</td>
     <td className="px-3 py-2 tabular-nums">{line.employeeCode??'—'}</td>
     <td className={`px-3 py-2 ${tone(line.outcome)}`}>{t(`outcome.${line.outcome}`)}</td>
     <td className="px-3 py-2">{reasonText(line.reason)}</td></tr>)}</tbody>
   </table></div>}
   {view.hasNext&&view.nextAfter&&<Link className={`${btnGhost} min-h-11`} href={`${filterHref(view.filter)}${view.filter==='all'?'?':'&'}after=${view.nextAfter}`}>{t('more')}</Link>}
   {sp.after&&<Link className="ml-2 text-sm underline" href={filterHref(view.filter)}>{t('firstPage')}</Link>}
  </section>}
 </div>;
}
