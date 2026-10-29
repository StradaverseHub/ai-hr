import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import type {RewardReviewListRow} from '@/packs/rewards/service';
import {rewardDueWording} from '@/packs/rewards/calendar';
import {rewardStages} from '@/packs/rewards/model';
import {filterRewardReviews,rewardReviewHref,rewardReviewUpcoming,type RewardReviewFilters} from '@/packs/rewards/review-list-model';
import {Button,inputCls,tableWrapCls,theadCls,thCls,tbodyCls} from '@/components/ui';
import {RewardStageLabel} from './returned-status';

type Props={rows:RewardReviewListRow[];filters:RewardReviewFilters;emptyReason:'noScope'|'noCycle'|'noRole'|'otherScope'|null;year:number;canConfigure:boolean};
export function RewardReviewList({rows:all,filters,emptyReason,year,canConfigure}:Props){
 const t=useTranslations('rewards'),locale=useLocale(),rows=filterRewardReviews(all,filters),waiting=all.filter(row=>row.waiting).length;
 const choices=(key:'cycleId'|'companyId'|'businessUnitId',label:'cycle'|'company'|'unit')=>[...new Map(all.map(row=>[row[key],row[label]])).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
 const percent=(bp:number|null|undefined)=>bp==null?'—':new Intl.NumberFormat(locale,{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1}).format(bp/10000);
 const date=(iso:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
 const relative=(days:number)=>{const phrase=rewardDueWording(days);return t(`board.${phrase.key}`,{days:phrase.days});};
 return <>
  <Link href={rewardReviewHref({...filters,waiting:filters.waiting==='1'?undefined:'1'})} aria-current={filters.waiting==='1'?'page':undefined} className="inline-flex rounded-md border px-4 py-3 font-medium text-primary hover:bg-accent">{t('reviewList.waiting',{count:waiting})}</Link>
  {rewardReviewUpcoming(all).map(({seat,count})=><p key={seat} className="text-sm text-muted-foreground">{t('reviewList.upcoming',{count,stage:t(`board.seat.${seat}`)})}</p>)}
  {all.length>0&&<form method="get" className="flex flex-wrap items-end gap-3" aria-label={t('reviewList.filters')}>
   {([['cycle',choices('cycleId','cycle')],['company',choices('companyId','company')],['unit',choices('businessUnitId','unit')]] as const).map(([key,options])=><label key={key} className="space-y-1 text-sm"><span className="block">{t(key)}</span><select name={key} defaultValue={filters[key]??''} className={inputCls}><option value="">{t('reviewList.all')}</option>{options.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}
   <label className="space-y-1 text-sm"><span className="block">{t('stage')}</span><select name="stage" defaultValue={filters.stage??''} className={inputCls}><option value="">{t('reviewList.all')}</option>{rewardStages.map(stage=><option key={stage} value={stage}>{t(`stages.${stage}`)}</option>)}<option value="returned">{t('reviewList.returned')}</option></select></label>
   <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" name="waiting" value="1" defaultChecked={filters.waiting==='1'}/>{t('reviewList.waitingOnly')}</label>
   <Button type="submit">{t('reviewList.apply')}</Button><Link href="/rewards" className="py-2 text-sm text-primary hover:underline">{t('reviewList.clear')}</Link>
  </form>}
  <div data-tour="rewards-review-units" className={tableWrapCls}>{rows.length>0?<table className="w-full text-sm"><thead className={theadCls}><tr>{['cycle','company','unit','myRole','with','due','salary','bonus','blocks','action'].map(key=><th scope="col" key={key} className={thCls}>{['cycle','company','unit','action'].includes(key)?t(key):t(`reviewList.${key}`)}</th>)}</tr></thead>
   <tbody className={tbodyCls}>{rows.map(row=><tr key={row.id} className="align-top"><td className="px-3 py-3 font-medium">{row.cycle} · {t(`kinds.${row.kind}`)}<span className="ml-2 text-muted-foreground">{row.year}</span></td><td className="px-3 py-3">{row.company}</td><td className="px-3 py-3">{row.unit}</td><td className="px-3 py-3">{row.roles.length?row.roles.map(role=>t(`board.seat.${role}`)).join(', '):t('reviewList.unavailable')}</td>
    <td className="px-3 py-3"><RewardStageLabel status={row.status} returnedTo={row.returnedTo}/>{row.seat&&<p className="mt-1 text-muted-foreground">{t(`board.seat.${row.seat}`)}</p>}{row.holders.length>0&&<p className="mt-1 text-muted-foreground">{row.holders.map(name=>name??t('reviewList.restrictedName')).join(', ')}</p>}</td>
    <td className="px-3 py-3">{row.due&&row.daysUntilDue!==null?<><span className="whitespace-nowrap tabular-nums">{date(row.due)}</span><p className={`text-xs ${row.daysUntilDue<0?'font-semibold text-destructive':'text-muted-foreground'}`}>{relative(row.daysUntilDue)}</p></>:'—'}</td>
    <td className="px-3 py-3 text-right tabular-nums">{row.roles.length?percent(row.salary?.poolShareBp):t('reviewList.unavailable')}</td><td className="px-3 py-3 text-right tabular-nums">{row.roles.length?percent(row.bonus?.budgetShareBp):t('reviewList.unavailable')}</td>
    <td className="px-3 py-3">{row.blocking===null?t('reviewList.unavailable'):<><span className={row.blocking?'font-semibold text-destructive':''}>{t('reviewList.blocking',{count:row.blocking})}</span><p>{t('reviewList.exceptions',{count:row.exceptions??0})}</p></>}</td>
    <td className="px-3 py-3"><Link href={`/rewards/${row.id}`} className="font-medium text-primary hover:underline">{t('openReview')}</Link></td></tr>)}</tbody></table>:<div className="max-w-2xl space-y-3 px-5 py-10 text-sm text-muted-foreground"><p>{all.length?t('reviewList.noMatches'):t(`reviewList.empty.${emptyReason??'noRole'}`,{year})}</p>{!all.length&&emptyReason==='noCycle'&&canConfigure&&<Link href="/admin/rewards" className="inline-flex font-medium text-primary hover:underline">{t('reviewList.create')}</Link>}</div>}</div>
 </>;
}
