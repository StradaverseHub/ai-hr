import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {requireModule} from '@/lib/authz';
import {rewardVisibleCompanies} from '@/packs/rewards/access-policy';
import {rewardOffcycleSources} from '@/packs/rewards/service';
import {Card,PageHeader} from '@/components/ui';

/** b945f0cc: choose the funding review (company · business unit) for a new mid-year set or ad hoc request. Only reviews
 * of an open off-cycle year where the viewer may raise requests are listed; creating the request re-checks everything. */
export default async function NewOffcycleRequestPage({searchParams}:{searchParams:Promise<{kind?:string}>}){
 await requireModule('rewards');const {s}=await scopedSession(),sp=await searchParams;
 const kind=sp.kind==='midyear'?'midyear':'adhoc';
 const companies=await rewardVisibleCompanies(s),allowedIds=companies.map(c=>c.id),scopeIds=companies.some(c=>c.wholeGroup)?allowedIds:await getScopeIds(allowedIds);
 const [sources,t,r]=await Promise.all([rewardOffcycleSources(s,scopeIds),getTranslations('rewardDashboard'),getTranslations('rewards')]);
 return <div className="w-full max-w-3xl space-y-5"><Link href="/rewards" className="text-sm text-primary hover:underline">← {t('offcycle.back')}</Link>
  <PageHeader title={t(kind==='midyear'?'offcycle.addMidyear':'offcycle.newAdhoc')} description={t(kind==='midyear'?'offcycle.midyearHelp':'offcycle.adhocHelp')}/>
  <Card>{sources.length?<ul className="divide-y divide-border">{sources.map(source=><li key={source.id} className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
   <span><span className="font-medium">{source.company}</span> · {source.unit} · {source.cycle}</span>
   <Link href={`/rewards/${source.id}?offcycle=${kind}#start-offcycle`} className="text-primary hover:underline">{r('startOffcycle')}</Link></li>)}</ul>
   :<p className="p-5 text-sm text-muted-foreground">{t('offcycle.noSources')}</p>}</Card>
 </div>;
}
