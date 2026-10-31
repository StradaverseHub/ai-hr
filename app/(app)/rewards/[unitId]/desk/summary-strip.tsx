import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import type {getRewardUnit} from '@/packs/rewards/service';
import {rewardDaysUntil,rewardDueWording} from '@/packs/rewards/calendar';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {Card} from '@/components/ui';
import {deskMoney,DeskMeter} from './salary-increase-table';
type View=Awaited<ReturnType<typeof getRewardUnit>>;
export function SummaryStrip({value:v,holders}:{value:View;holders:readonly (string|null)[]}){
 const t=useTranslations('rewards'),locale=useLocale();
 const salaryUsed=v.budgets.standard.used.reduce((a,b)=>a+b,0)+v.budgets.h.used.reduce((a,b)=>a+b,0),salaryPool=v.budgets.standard.pools.reduce((a,b)=>a+b,0)+v.budgets.h.pools.reduce((a,b)=>a+b,0);
 const bonusUsed=v.budgets.standard.bonusUsedCents+v.budgets.h.bonusUsedCents,bonusPool=v.budgets.standard.bonusPoolCents+v.budgets.h.bonusPoolCents;
 const amounts=[{id:'salary-increase',label:t('desk.salary'),used:salaryUsed,pool:salaryPool,over:(['standard','h'] as const).some(plan=>v.budgets[plan].used.some((n,i)=>n>v.budgets[plan].pools[i]))},{id:'bonus',label:t('desk.bonus'),used:bonusUsed,pool:bonusPool,over:(['standard','h'] as const).some(plan=>v.budgets[plan].bonusUsedCents>v.budgets[plan].bonusPoolCents)}];
 const dueDays=v.due?rewardDaysUntil(v.due,todayInKualaLumpur()):null,relative=dueDays===null?null:rewardDueWording(dueDays);
 return <div className="grid gap-3 md:grid-cols-3">{amounts.map(row=>{
  const state=row.over?'over':row.pool===0?'notSet':'within';
  return <Card key={row.id} className="flex min-w-0 flex-col gap-4 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{row.label}</h2><span className={`rounded-full px-2 py-1 text-xs font-medium ${state==='over'?'bg-destructive/10 text-destructive':state==='within'?'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100':'bg-muted text-muted-foreground'}`}>{t(`desk.${state}`)}</span></div><p className="text-sm tabular-nums">{t('desk.usedOf',{used:deskMoney(row.used,locale),pool:deskMoney(row.pool,locale)})}</p><DeskMeter used={row.used} pool={row.pool} label={row.label}/><Link href={`#${row.id}`} className="mt-auto text-sm font-medium text-primary hover:underline">{t('desk.goToSection')}</Link></Card>;
 })}<Card className="flex min-w-0 flex-col gap-3 p-5"><h2 className="font-semibold">{t('desk.where')}</h2><p className="text-sm font-medium">{v.returned?t(`returnedTo.${v.returned.toSeat}`):t(`stages.${v.unit.status}`)}</p>{holders.length>0&&<p className="text-sm text-muted-foreground">{holders.map(name=>name??t('aReviewer')).join(', ')}</p>}<p className="text-sm text-muted-foreground">{v.due?t('dueOn',{date:new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(`${v.due}T00:00:00Z`))}):t('desk.noDue')}{relative&&<span className={dueDays!==null&&dueDays<0?'ml-1 text-destructive':'ml-1'}>({t(`board.${relative.key}`,{days:relative.days})})</span>}</p><Link href="#approvals" className="mt-auto text-sm font-medium text-primary hover:underline">{t('desk.approvalHistory')}</Link></Card></div>;
}
