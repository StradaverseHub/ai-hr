import {randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {Card,ErrorBanner,PageHeader,btnGhost,inputCls} from '@/components/ui';
import {Pager} from '@/components/pager';
import {keysetPageState,parseKeysetPageQuery} from '@/lib/pagination';
import {bulkJobActive} from '@/lib/bulk-job';
import {listCompanies} from '@/core/read';
import {latestInvitationBatch,normalizeBatchSearch,readInvitationBatchCandidates} from '@/core/account-invitation-batch';
import {ROLES} from '../../data';
import {BatchInviteForm} from './batch-invite-form';

/**
 * Board 0735d1b7 — Security Center › Users › By Batch Send Invitation. Group administrators only (the same people
 * who invite one person). Everyone Pending Activation is listed by name, one keyset page at a time with a capped
 * count; those without a work email, or whose email another login or invitation already uses, are shown with the
 * reason and cannot be ticked. The invitations are sent by a background job; this page reads, it never locks.
 */
const BASE='/admin/users/invitations/batch';
const PROBLEMS=['countChanged','tooMany','empty','running','installing','invalid','forbidden','failed'] as const;
export default async function BatchInvitationPage({searchParams}:{searchParams:Promise<{q?:string;page?:string;size?:string;after?:string;before?:string;last?:string;count?:string;problem?:string}>}){
 const s=await requireGroupAdministration(),sp=await searchParams;
 const [t,users,tAll,locale]=await Promise.all([getTranslations('admin.users.batchInvite'),getTranslations('admin.users'),getTranslations(),getLocale()]);
 const search=normalizeBatchSearch(sp.q),pq=parseKeysetPageQuery(sp);
 const [read,companies,latest]=await Promise.all([readInvitationBatchCandidates(s,{search,page:pq}),listCompanies(s),latestInvitationBatch(s)]);
 const state=keysetPageState(pq,read,read.rows.map(r=>r.id));
 const problem=PROBLEMS.find(p=>p===sp.problem);
 const problemCount=Number(sp.count);
 const languages=['en','ms','zh','vi','ta','th'].map(value=>({value,label:tAll(`emailDesign.languages.${value}`)}));
 return <div className="mx-auto w-full max-w-6xl space-y-6">
  <PageHeader title={t('title')} description={t('intro')} back={{href:'/admin/users',label:t('backToUsers')}}/>
  {problem&&<div role="alert"><ErrorBanner message={t(`problem.${problem}`,{count:Number.isSafeInteger(problemCount)?problemCount:0})}/></div>}
  {latest&&bulkJobActive(latest.state)&&<p role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">{t('running')} <Link className="font-medium underline" href={`${BASE}/${latest.id}`}>{t('openRunning')}</Link></p>}
  {latest&&!bulkJobActive(latest.state)&&<p className="text-sm text-muted-foreground"><Link className="underline" href={`${BASE}/${latest.id}`}>{t('lastBatch')}</Link></p>}
  <Card className="space-y-4 p-4">
   <form method="get" action={BASE} className="flex flex-wrap items-end gap-2" role="search">
    <label className="min-w-64 flex-1 space-y-1 text-sm"><span className="text-xs font-medium text-muted-foreground">{t('searchLabel')}</span>
     <input type="search" name="q" defaultValue={search} placeholder={t('searchPlaceholder')} className={`${inputCls} min-h-11`}/></label>
    <button type="submit" className={`${btnGhost} min-h-11`}>{t('searchSubmit')}</button>
    {search&&<Link href={BASE} className={`${btnGhost} min-h-11`}>{t('clear')}</Link>}
   </form>
   <p className="text-sm">{read.eligible.capped?t('eligibleCapped',{count:read.eligible.count}):t('eligibleCount',{count:read.eligible.count})}</p>
   {read.rows.length===0?<p className="py-8 text-center text-sm text-muted-foreground">{t(search?'emptySearch':'empty')}</p>:<>
    <BatchInviteForm key={`${search}:${state.firstId??''}`} rows={read.rows} eligibleCount={read.eligible.count} eligibleCapped={read.eligible.capped} search={search} operationKey={randomUUID()}
     roles={ROLES.map(value=>({value,label:users(`role.${value}`)}))}
     companies={[{value:'group',label:users('groupWide')},...companies.map(c=>({value:c.id,label:c.name}))]}
     languages={languages} defaultLanguage={languages.some(l=>l.value===locale)?locale:'en'}/>
    <Pager basePath={BASE} params={{q:search||undefined}} state={state}/>
   </>}
  </Card>
 </div>;
}
