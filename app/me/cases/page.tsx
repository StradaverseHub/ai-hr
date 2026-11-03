import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {handlesPrivateCases,listOwnPrivateCases,privateCaseIntake} from '@/core/private-cases';
import {Card,PageHeader,StatusBadge,btnGhost,btnPrimary,pageWideCls} from '@/components/ui';
export const dynamic='force-dynamic';

/** AI v2 W11 — the person's own private cases with HR (ADR-0173). Every signed-in person reaches it; the list is their
 * own cases only (row-level security), without text: opening one is an audited read. Start is offered only where a
 * company the person works in has case handlers. */
export default async function MyPrivateCasesPage(){
 const {s}=await scopedSession(),t=await getTranslations('privateCases'),locale=await getLocale();
 const [cases,intake,handles]=await Promise.all([listOwnPrivateCases(s),privateCaseIntake(s),handlesPrivateCases(s)]);
 const date=(value:Date)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(value);
 const canStart=intake.companies.length>0&&intake.storable;
 return <div className={pageWideCls}>
  <PageHeader title={t('me.title')} description={t('me.description')}
   actions={<>{handles&&<Link href="/cases" className={btnGhost+' pointer-coarse:min-h-11'}>{t('me.handle')}</Link>}{canStart&&<Link href="/me/cases/new" className={btnPrimary+' pointer-coarse:min-h-11'}>{t('me.start')}</Link>}</>}/>
  {!canStart&&<Card role="note" className="p-4 text-sm text-muted-foreground">{intake.companies.length>0?t('new.notStorable'):t('me.notSetUp')}</Card>}
  <section aria-labelledby="own-private-cases" className="space-y-3">
   <h2 id="own-private-cases" className="text-sm font-semibold">{t('me.listTitle')}</h2>
   {cases.length===0?<Card className="p-6 text-sm text-muted-foreground">{t('me.empty')}</Card>:<ul className="space-y-3">{cases.map(row=><li key={row.id}>
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
     <div className="min-w-0 space-y-1">
      <p className="font-medium">{t(`categories.${row.category}`)}</p>
      <p className="text-sm text-muted-foreground">{[row.companyName,t('me.opened',{date:date(row.openedAt)}),t('me.updated',{date:date(row.statusChangedAt)})].filter(Boolean).join(' · ')}</p>
      {!row.reachable&&<p className="text-xs font-medium text-destructive">{t('me.unreachable')}</p>}
     </div>
     <div className="flex items-center gap-3"><StatusBadge status={row.status} label={t(`statuses.${row.status}`)}/>
      <Link href={'/me/cases/'+row.id} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">{t('me.view')}</Link></div>
    </Card></li>)}</ul>}
  </section>
 </div>;
}
