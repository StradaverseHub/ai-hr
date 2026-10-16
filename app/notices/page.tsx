import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {myEmployment} from '@/core/read';
import {ownLiveEmployment} from '@/core/own-employment-selection';
import {noticesForEmployment} from '@/core/notice';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {Card,PageHeader,SectionHeader,Button,inputCls} from '@/components/ui';
const categories=['general','holiday','benefits','policy'] as const;
export default async function MyNoticesPage({searchParams}:{searchParams:Promise<{employmentId?:string;q?:string;category?:string}>}){
 const {s,scopeIds}=await scopedSession(),sp=await searchParams,t=await getTranslations('notices'),h=await getTranslations('homeNotice');
 const selected=sp.employmentId!==undefined?await ownLiveEmployment(s,sp.employmentId).catch(()=>null):null;
 if(sp.employmentId!==undefined&&(!selected||!scopeIds.includes(selected.companyProof.companyId!))){const own=await getTranslations('ownEmployment');return <Card className="p-8">{own('unavailable')}</Card>;}
 const me=selected??await myEmployment(s),q=typeof sp.q==='string'?sp.q.slice(0,200):'',category=categories.find(value=>value===sp.category);
 const rows=me?await noticesForEmployment(s,me.employmentId,{search:q,category,limit:201}):[];
 const query=selected?'?employmentId='+encodeURIComponent(selected.employmentId):'';
 return <div className="mx-auto max-w-3xl space-y-6"><PageHeader title={t('myTitle')} description={t('myDescription')}/><form className="flex flex-wrap items-end gap-3" method="get">{selected&&<input type="hidden" name="employmentId" value={selected.employmentId}/>}<label className="flex-1 text-sm">{h('search')}<input name="q" defaultValue={q} maxLength={200} className={inputCls}/></label><label className="text-sm">{h('category')}<select name="category" defaultValue={category??''} className={inputCls}><option value="">{h('allCategories')}</option>{categories.map(value=><option key={value} value={value}>{h('categories.'+value)}</option>)}</select></label><Button type="submit">{h('filter')}</Button></form><Card data-tour="notices-mine"><SectionHeader title={t('myListTitle')} count={Math.min(rows.length,200)}/><ul className="divide-y divide-border">{!rows.length&&<li className="px-4 py-6 text-sm text-muted-foreground">{t('myEmpty')}</li>}{rows.slice(0,200).map(n=><li key={n.id} className="px-4 py-3"><Link href={'/notices/'+n.id+query} className="flex min-h-11 flex-wrap items-center justify-between gap-3"><span className="min-w-0"><span className="block break-words text-sm font-medium">{n.title}</span><span className="text-xs text-muted-foreground">{h('categories.'+n.category)} · {t('publishedOn',{date:n.publishedAt?todayInKualaLumpur(n.publishedAt):'—'})}</span></span><span className="flex flex-wrap gap-2 text-xs">{n.pinned&&<span>{h('pinned')}</span>}{n.firstViewedAt==null&&<span>{t('newBadge')}</span>}{n.requiresAcknowledgement&&<span>{h(n.acknowledgedAt?'ackDone':'requiresAck')}</span>}</span></Link></li>)}</ul></Card>{rows.length>200&&<p className="text-sm text-muted-foreground">{h('bounded')}</p>}</div>;
}
