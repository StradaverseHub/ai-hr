import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import type {RewardDashboard} from '@/packs/rewards/service';
import {REWARD_DASHBOARD_PLANS,REWARD_SALARY_COMPONENTS,rewardSalaryDisplay,type RewardDashboardBar} from '@/packs/rewards/dashboard-model';
import {deskMoney,DeskMeter} from './[unitId]/desk/salary-increase-table';
import {RewardsDashboardFilters} from './dashboard-filters';

export function RewardsDashboard({value}:{value:RewardDashboard}){
 const t=useTranslations('rewardDashboard'),r=useTranslations('rewards'),prep=useTranslations('rewardsPreparation'),locale=useLocale();
 const money=(n:number)=>deskMoney(n,locale),salary=(n:number)=>money(rewardSalaryDisplay(n,value.choice.period));
 const percent=(bp:number|null)=>bp===null?'—':new Intl.NumberFormat(locale,{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1}).format(bp/10000);
 const date=(iso:string)=>new Intl.DateTimeFormat(locale==='en'?'en-GB':locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
 const waiting=value.waiting.slice(0,5),figures=value.figures,ctx=value.context;
 const hasScope=value.businessUnits.length>0;
 const barRow=(label:string,b:RewardDashboardBar,show:(n:number)=>string,withBalance:boolean)=><div className="space-y-1">
  <div className="flex flex-wrap justify-between gap-x-3"><span>{label}</span><span className={`tabular-nums ${b.balance<0?'font-medium text-destructive':''}`}>{show(b.used)} / {show(b.pool)} · {percent(b.shareBp)}</span></div>
  <DeskMeter used={b.used} pool={b.pool} label={label}/>
  {withBalance&&<p className={`text-xs ${b.balance<0?'font-medium text-destructive':'text-muted-foreground'}`}>{r(b.balance<0?'desk.amountOver':'desk.amountLeft',{amount:show(Math.abs(b.balance))})}</p>}
  {b.overCompanies.length>0&&<p className="text-xs font-medium text-destructive">{t('overOwnPool',{companies:b.overCompanies.join(', ')})}</p>}
 </div>;
 const box=(kind:'salary'|'bonus')=><Card className="min-w-0"><h2 className="border-b border-border p-5 font-semibold">{t(kind)}</h2>
  {figures?<div className="divide-y divide-border">{REWARD_DASHBOARD_PLANS.map(plan=><section key={plan} className="space-y-3 p-5 text-sm"><h3 className="font-medium">{r(plan)}</h3>
   {kind==='salary'?REWARD_SALARY_COMPONENTS.map(component=><div key={component}>{barRow(`${r(plan)} · ${r(component)}`,figures.salary[plan][component],salary,true)}</div>)
    :barRow(`${r(plan)} · ${t('bonus')}`,figures.bonus[plan],money,false)}
  </section>)}</div>:<p className="p-5 text-sm text-muted-foreground">{value.excluded.length?t('noCombinedFigures'):value.preparing.length?t('preparingYear',{year:value.year}):t('empty')}</p>}
 </Card>;
 const excludedOf=(reason:'restricted'|'uploaded')=>value.excluded.filter(e=>e.reason===reason).map(e=>e.company);
 return <div className="space-y-5">
  {hasScope&&<RewardsDashboardFilters value={value} showPeriod={!!figures}/>}
  {ctx&&<p className="text-sm text-muted-foreground" data-testid="reward-dashboard-context">{[
   t('showing',{scope:ctx.businessUnit??t('allBusinessUnits')}),
   t('companyCount',{count:ctx.companies}),
   ctx.cycleVaries?t('cyclesVary'):ctx.cycle,
   ctx.snapshotVaries?t('snapshotsVary'):ctx.snapshot?t('snapshot',{date:date(ctx.snapshot)}):null,
  ].filter(Boolean).join(' · ')}</p>}
  {value.preparing.length>0&&<Card className="space-y-2 p-5"><h2 role="status" className="font-medium">{t('preparingYear',{year:value.year})}</h2>
   <ul className="space-y-1 text-sm">{value.preparing.map(notice=><li key={notice.unitId} className="flex flex-wrap gap-x-3"><Link href={`/rewards/${notice.unitId}`} className="text-primary hover:underline">{notice.company}</Link>
    <span className="text-muted-foreground">{notice.expectedRelease?prep('expectedOn',{date:date(notice.expectedRelease)}):prep('datePending')}</span></li>)}</ul></Card>}
  {(['restricted','uploaded'] as const).map(reason=>excludedOf(reason).length>0&&<p key={reason} className="text-sm text-muted-foreground">{t(reason==='restricted'?'excludedRestricted':'excludedUploaded',{companies:excludedOf(reason).join(', ')})}</p>)}
  {value.roles.length>0&&<p className="text-sm text-muted-foreground">{t('yourRoles')}: {value.roles.map(role=>r(`board.seat.${role}`)).join(', ')} · {t('separate')}</p>}
  <div className="grid items-start gap-5 xl:grid-cols-3">{box('salary')}{box('bonus')}<Card className="min-w-0"><div className="flex items-center justify-between gap-3 border-b border-border p-5"><h2 className="font-semibold">{t('waiting',{count:value.waiting.length})}</h2><Link href="/rewards/approvals" className="text-sm text-primary hover:underline">{t('open')}</Link></div>
   {waiting.length?<ul className="divide-y divide-border">{waiting.map(unit=><li key={unit.id} className="space-y-2 p-5 text-sm"><Link href={`/rewards/${unit.id}`} className="font-medium text-primary hover:underline">{unit.company} · {unit.name}</Link><p>{r('openReview')}</p><p className={unit.daysUntilDue!==null&&unit.daysUntilDue<0?'text-destructive':'text-muted-foreground'}>{unit.due?`${r('dueOn',{date:unit.due})}${unit.daysUntilDue!==null&&unit.daysUntilDue<0?' · '+t('overdue'):''}`:t('noDue')}</p><Link href={`/rewards/${unit.id}#checks`} className={unit.blocking?'font-medium text-destructive hover:underline':'text-muted-foreground hover:underline'}>{r('reviewList.blocking',{count:unit.blocking})} · {r('reviewList.exceptions',{count:unit.exceptions})}</Link></li>)}</ul>:<p className="p-5 text-sm text-muted-foreground">{r('board.noneWaiting')}</p>}
   {value.waiting.length>5&&<Link href="/rewards/approvals" className="block border-t border-border p-5 text-sm text-primary underline">{t('more',{count:value.waiting.length-5})}</Link>}
  </Card></div>
 </div>;
}
