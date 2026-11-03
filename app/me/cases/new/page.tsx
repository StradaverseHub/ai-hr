import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {PRIVATE_CASE_CATEGORIES,PRIVATE_CASE_LIMITS,privateCaseIntake} from '@/core/private-cases';
import {Button,Card,Field,PageHeader,inputCls,pageWideCls} from '@/components/ui';
import {openPrivateCaseAction} from '../actions';
export const dynamic='force-dynamic';

const ERRORS=['invalid','not_set_up','not_allowed','unavailable'] as const;

/** AI v2 W11 — the private case form (ADR-0173). The person writes the case here, never through the AI: the AI Centre's
 * sensitive reply only links to this page and passes nothing to it. Everyone who could read it (the company's handlers
 * and the group administrators) is named, so the person it is about, or anyone who must not see it, can be left out;
 * with every handler left out, or on request, it goes to the group administrator. */
export default async function NewPrivateCasePage({searchParams}:{searchParams:Promise<{companyId?:string;error?:string}>}){
 const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('privateCases');
 const intake=await privateCaseIntake(s,sp.companyId);
 const error=ERRORS.find(code=>code===sp.error);
 const back={href:'/me/cases',label:t('new.back')};
 if(!intake.companyId||!intake.storable)return <div className={pageWideCls}><PageHeader title={t('new.title')} back={back}/>
  <Card role="note" className="p-4 text-sm text-muted-foreground">{intake.companyId?t('new.notStorable'):t('me.notSetUp')}</Card></div>;
 return <div className={pageWideCls}>
  <PageHeader title={t('new.title')} description={t('new.description')} back={back}/>
  {error&&<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{t(`errors.${error}`)}</p>}
  {intake.companies.length>1&&<Card className="p-4"><form method="get" className="flex flex-wrap items-end gap-3">
   <Field label={t('new.company')}><select name="companyId" defaultValue={intake.companyId} className={inputCls}>{intake.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></Field>
   <Button type="submit" variant="outline" className="pointer-coarse:min-h-11">{t('new.chooseCompany')}</Button></form></Card>}
  <Card className="p-4 sm:p-6"><form action={openPrivateCaseAction} className="space-y-5">
   <input type="hidden" name="companyId" value={intake.companyId}/>
   <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">{t('new.category')}</legend>
    <div className="flex flex-wrap gap-x-5 gap-y-1">{PRIVATE_CASE_CATEGORIES.map(category=><label key={category} className="flex min-h-11 items-center gap-2 text-sm">
     <input type="radio" name="category" value={category} required className="size-4"/>{t(`categories.${category}`)}</label>)}</div></fieldset>
   <Field label={t('new.text')}><textarea name="text" required maxLength={PRIVATE_CASE_LIMITS.textChars} rows={8} className={inputCls+' h-auto min-h-40 py-2'}/></Field>
   <p className="-mt-3 text-xs text-muted-foreground">{t('new.textHelp')}</p>
   <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">{t('new.handlers')}</legend>
    <p className="text-sm text-muted-foreground">{t('new.handlersHelp')}</p>
    <ul className="space-y-1">{intake.readers.map(reader=><li key={reader.userId}><label className="flex min-h-11 items-center gap-3 text-sm">
     <input type="checkbox" name="excludedUserIds" value={reader.userId} className="size-4 shrink-0"/>
     <span>{t('new.exclude',{name:reader.name??t('new.unnamed'),role:t(reader.kind==='group_admin'?'new.readerGroupAdmin':'new.readerHandler')})}</span></label></li>)}</ul>
    <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="sendTo" value="group_admin" className="size-4 shrink-0"/><span>{t('new.groupAdmin')}</span></label>
    <p className="text-xs text-muted-foreground">{t('new.groupAdminHelp')}</p>
   </fieldset>
   <p className="rounded-md bg-muted p-3 text-sm">{t('new.privacy')}</p>
   <Button type="submit" className="pointer-coarse:min-h-11">{t('new.submit')}</Button>
  </form></Card>
 </div>;
}
