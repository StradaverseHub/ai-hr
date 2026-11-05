import Link from 'next/link';
import {getTranslations,getLocale} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {rewardViewAsState} from '@/packs/rewards/access-policy';
import {readOnlyRewardProjection} from '@/packs/rewards/service';
import {PageHeader,Card,Button,tableWrapCls,theadCls,thCls,tbodyCls} from '@/components/ui';
import {endRewardViewAsAction} from '../policy-actions';
export default async function RewardViewAsPage({searchParams}:{searchParams:Promise<{unit?:string}>}){
 const{s}=await scopedSession(),sp=await searchParams,t=await getTranslations('rewardAccessPolicy'),r=await getTranslations('rewards'),locale=await getLocale();const state=await rewardViewAsState(s);
 const selected=state?.units.find(u=>u.id===sp.unit)??state?.units[0];const projection=state&&selected?await readOnlyRewardProjection(state.principal,selected.id):null;
 const rows=projection?.rows.filter(row=>row.source.personId!==s.personId)??[],money=(v:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:'MYR'}).format(v/100);
 return <div className="space-y-6"><PageHeader title={t('viewAs')} description={t('readOnlyHelp')}/><div role="status" className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-muted p-4"><p>{state?t('viewingAs',{name:state.targetName??t('restrictedName')}):t('noSession')}</p><form action={endRewardViewAsAction}><Button variant="outline">{t('endView')}</Button></form></div>
  {state&&<nav className="flex flex-wrap gap-3" aria-label={r('review')}>{state.units.map(u=><Link key={u.id} className="text-sm text-primary underline underline-offset-2" href={`/admin/rewards/access/view-as?unit=${u.id}`}>{u.company} · {u.cycle}</Link>)}</nav>}
  {projection&&<Card className="p-4"><h2 className="mb-4 font-semibold">{projection.companyName} · {projection.name}</h2><div className={tableWrapCls}><table className="w-full text-sm"><thead className={theadCls}><tr>{['employee','grade','currentPay','newPay','bonus'].map(k=><th key={k} className={thCls}>{r(k)}</th>)}</tr></thead><tbody className={tbodyCls}>{rows.map(row=><tr key={row.id}><td className="px-3 py-3">{row.source.name}<span className="block text-muted-foreground">{row.source.employeeCode}</span></td><td className="px-3 py-3">{row.source.grade}</td><td className="px-3 py-3 tabular-nums">{money(row.source.basicCents)}</td><td className="px-3 py-3 tabular-nums">{money(row.newBasicCents)}</td><td className="px-3 py-3 tabular-nums">{money(row.bonusCents)}</td></tr>)}</tbody></table>{!rows.length&&<p className="p-4 text-sm text-muted-foreground">{r('noPeople')}</p>}</div></Card>}
 </div>;
}
