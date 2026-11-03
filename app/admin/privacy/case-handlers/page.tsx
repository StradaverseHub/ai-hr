import {getLocale,getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {caseHandlerAdmin} from '@/core/private-cases';
import {Button,Card,Field,PageHeader,inputCls,pageWideCls} from '@/components/ui';
import {designateCaseHandlerAction,revokeCaseHandlerAction} from './actions';
export const dynamic='force-dynamic';

const NOTICES=['added','removed'] as const;
const ERRORS=['invalid','not_allowed','unavailable','conflict','not_found'] as const;

/** AI v2 W11 — who receives private cases, per company (ADR-0173). HR administrators of a company and group
 * administrators reach it; the database admits each designation only for a company the caller administers, and an HR
 * administrator never for themself. Designating someone does not let the designator read any case. */
export default async function CaseHandlersPage({searchParams}:{searchParams:Promise<{companyId?:string;notice?:string;error?:string}>}){
 const s=await requireAdmin(),sp=await searchParams,t=await getTranslations('privateCases'),locale=await getLocale();
 const admin=await caseHandlerAdmin(s,sp.companyId);
 const date=(value:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(value);
 const notice=NOTICES.find(code=>code===sp.notice),error=ERRORS.find(code=>code===sp.error);
 const current=admin.grants.filter(grant=>!grant.revokedAt),earlier=admin.grants.filter(grant=>grant.revokedAt);
 const name=(value:string|null)=>value??t('admin.noRecord');
 return <div className="mx-auto max-w-3xl space-y-6">
  <PageHeader title={t('admin.title')} description={t('admin.description')} back={{href:'/admin/privacy',label:t('admin.back')}}/>
  {notice&&<p role="status" className="rounded-md border p-4 text-sm">{t(`admin.${notice}`)}</p>}
  {error&&<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{t(`errors.${error}`)}</p>}
  {!admin.companyId?<Card className="p-6 text-sm text-muted-foreground">{t('admin.noCompanies')}</Card>:<>
   {admin.companies.length>1&&<Card className="p-4"><form method="get" className="flex flex-wrap items-end gap-3">
    <Field label={t('admin.company')}><select name="companyId" defaultValue={admin.companyId} className={inputCls}>{admin.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></Field>
    <Button type="submit" variant="outline" className="pointer-coarse:min-h-11">{t('admin.show')}</Button></form></Card>}
   <Card className="space-y-3 p-4"><h2 className="text-sm font-semibold">{t('admin.current')}</h2>
    {current.length===0?<p className="text-sm text-muted-foreground">{t('admin.none')}</p>:<ul className="divide-y divide-border">{current.map(grant=><li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
     <div className="min-w-0"><p className="text-sm font-medium">{name(grant.name)}</p><p className="text-xs text-muted-foreground">{t('admin.since',{date:date(grant.grantedAt)})}</p></div>
     <form action={revokeCaseHandlerAction}><input type="hidden" name="handlerId" value={grant.id}/><input type="hidden" name="companyId" value={admin.companyId!}/>
      <Button type="submit" variant="outline" size="sm" className="pointer-coarse:min-h-11">{t('admin.revoke')}</Button></form></li>)}</ul>}
   </Card>
   <Card className="space-y-3 p-4"><h2 className="text-sm font-semibold">{t('admin.designate')}</h2>
    <form action={designateCaseHandlerAction} className="flex flex-wrap items-end gap-3"><input type="hidden" name="companyId" value={admin.companyId}/>
     <Field label={t('admin.person')}><select name="appUserId" required className={inputCls}><option value="">—</option>{admin.candidates.map(candidate=><option key={candidate.userId} value={candidate.userId}>{name(candidate.name)}</option>)}</select></Field>
     <Button type="submit" className="pointer-coarse:min-h-11">{t('admin.add')}</Button></form>
    {!admin.selfAllowed&&<p className="text-xs text-muted-foreground">{t('admin.selfNote')}</p>}
   </Card>
   {earlier.length>0&&<Card className="space-y-3 p-4"><h2 className="text-sm font-semibold">{t('admin.history')}</h2>
    <ul className="space-y-1 text-sm">{earlier.map(grant=><li key={grant.id} className="flex flex-wrap justify-between gap-2"><span>{name(grant.name)}</span>
     <span className="text-muted-foreground">{t('admin.revoked',{date:date(grant.revokedAt!)})}</span></li>)}</ul></Card>}
  </>}
 </div>;
}
