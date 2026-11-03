import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {handlesPrivateCases,listHandledPrivateCases} from '@/core/private-cases';
import {Card,PageHeader,StatusBadge,pageWideCls} from '@/components/ui';
export const dynamic='force-dynamic';

/** AI v2 W11 — the private cases this person handles (ADR-0173). Every signed-in person reaches the address; only a
 * current case handler (or a group administrator, who receives the cases no eligible handler can) sees a queue, and
 * the queue holds only what row-level security returns: never a case they wrote or were left out of. No text or
 * author here: opening a case is an audited read. */
export default async function HandledPrivateCasesPage({searchParams}:{searchParams:Promise<{notice?:string}>}){
 const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('privateCases'),locale=await getLocale();
 const handles=await handlesPrivateCases(s);
 const cases=handles?await listHandledPrivateCases(s):[];
 const date=(value:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(value);
 return <div className={pageWideCls}>
  <PageHeader title={t('handle.title')} description={t('handle.description')}/>
  {sp.notice==='erased'&&<p role="status" className="rounded-md border p-4 text-sm">{t('handle.erased')}</p>}
  {!handles?<Card role="note" className="p-6 text-sm text-muted-foreground">{t('handle.none')}</Card>
   :cases.length===0?<Card className="p-6 text-sm text-muted-foreground">{t('handle.empty')}</Card>
   :<ul className="space-y-3">{cases.map(row=><li key={row.id}><Card className="flex flex-wrap items-center justify-between gap-3 p-4">
    <div className="min-w-0 space-y-1">
     <p className="font-medium">{t(`categories.${row.category}`)}</p>
     <p className="text-sm text-muted-foreground">{[row.companyName,t('handle.opened',{date:date(row.openedAt)})].filter(Boolean).join(' · ')}</p>
     {row.route==='group_admin'&&<p className="text-xs text-muted-foreground">{t('handle.toGroupAdmin')}</p>}
     {row.erasureRequested&&<p className="text-xs text-muted-foreground">{t('handle.erasure')}</p>}
    </div>
    <div className="flex items-center gap-3"><StatusBadge status={row.status} label={t(`statuses.${row.status}`)}/>
     <Link href={'/cases/'+row.id} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">{t('handle.view')}</Link></div>
   </Card></li>)}</ul>}
 </div>;
}
