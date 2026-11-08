import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Card,Button,inputCls} from '@/components/ui';
import type {RewardDashboard} from '@/packs/rewards/service';
import {rewardSalaryDisplay} from '@/packs/rewards/dashboard-model';
import {deskMoney,DeskMeter} from './[unitId]/desk/salary-increase-table';
import {saveDashboardAction} from './dashboard-actions';
export function RewardsDashboard({value}:{value:RewardDashboard}){
 const t=useTranslations('rewardDashboard'),r=useTranslations('rewards'),locale=useLocale();
 const money=(n:number)=>deskMoney(n,locale),salary=(n:number)=>money(rewardSalaryDisplay(n,value.choice.period));
 const units=value.units.slice(0,3),waiting=value.waiting.slice(0,5);
 const section=(kind:'salary'|'bonus')=><Card className="min-w-0"><div className="flex items-center justify-between gap-3 border-b border-border p-5"><h2 className="font-semibold">{t(kind)}</h2><Link href="/rewards/reviews" aria-label={t('allReviews')} className="text-sm text-primary hover:underline">{t('open')}</Link></div>
  <div className="divide-y divide-border">{units.map(unit=><section key={unit.id} className="space-y-4 p-5"><div><h3 className="font-medium">{unit.company}</h3><Link href={`/rewards/${unit.id}#${kind==='salary'?'salary-increase':'bonus'}`} className="text-sm text-primary hover:underline">{unit.name}</Link><p className="mt-1 text-xs text-muted-foreground">{unit.cycle} · {r('snapshotDate')}: {unit.snapshotDate}</p></div>
   {!unit.budgets?<p className="text-sm text-muted-foreground">{t(unit.restricted?'restricted':'uploaded')}</p>:<>
    {kind==='bonus'&&<p className="text-xs text-muted-foreground">{t('oneOff')} · {r(`governance.status.${unit.poolStatus}`)}</p>}
    {(['standard','h'] as const).map(plan=>{const b=unit.budgets![plan];return <div key={plan} className="space-y-2 text-sm"><h4 className="font-medium">{r(plan)}</h4>{kind==='salary'?b.used.map((used,index)=><div key={index} className="space-y-1"><div className="flex flex-wrap justify-between gap-x-3"><span>{r(['merit','promotion','special'][index])}</span><span className={`tabular-nums ${used>b.pools[index]?'font-medium text-destructive':''}`}>{salary(used)} / {salary(b.pools[index])}</span></div><DeskMeter used={used} pool={b.pools[index]} label={`${unit.company} · ${unit.name} · ${r(plan)} · ${r(['merit','promotion','special'][index])}`}/></div>):<><p className={`tabular-nums ${b.bonusUsedCents+b.lumpCents>b.bonusPoolCents?'font-medium text-destructive':''}`}>{money(b.bonusUsedCents+b.lumpCents)} / {money(b.bonusPoolCents)}</p><DeskMeter used={b.bonusUsedCents+b.lumpCents} pool={b.bonusPoolCents} label={`${unit.company} · ${unit.name} · ${r(plan)} · ${t('bonus')}`}/></>}</div>;})}
    {kind==='bonus'&&unit.poolStatus==='not-set'&&<Link href={unit.setupVisible?`/rewards/${unit.id}/setup#budget`:`/rewards/${unit.id}#checks`} className="inline-block text-sm text-primary underline">{t('missingInputs')}</Link>}
   </>}
  </section>)}</div>{value.units.length>3&&<p className="border-t border-border p-5 text-sm"><Link href="/rewards/reviews" className="text-primary underline">{t('more',{count:value.units.length-3})}</Link></p>}
  {!units.length&&<p className="p-5 text-sm text-muted-foreground">{t('empty')}</p>}
 </Card>;
 return <div className="space-y-5">
  <form action={saveDashboardAction} className="flex flex-wrap items-end gap-3" aria-label={t('preferences')}>
   <label className="min-w-0 space-y-1 text-sm"><span className="block">{r('unit')}</span><select name="scope" defaultValue={value.choice.scope} className={`${inputCls} max-w-full sm:max-w-xl`}>{value.canSelectAll&&<option value="all">{t('allAssigned')}</option>}{value.scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label>
   <label className="space-y-1 text-sm"><span className="block">{t('salaryPeriod')}</span><select name="period" defaultValue={value.choice.period} className={inputCls}><option value="monthly">{t('monthly')}</option><option value="annual">{t('annual')}</option></select></label><Button type="submit">{r('reviewList.apply')}</Button>
  </form>
  {value.units.length>0&&<p className="text-sm text-muted-foreground">{t('yourRoles')}: {[...new Set(value.units.flatMap(unit=>unit.roles))].map(role=>r(`board.seat.${role}`)).join(', ')} · {t('separate')}</p>}
  <div className="grid items-start gap-5 xl:grid-cols-3">{section('salary')}{section('bonus')}<Card className="min-w-0"><div className="flex items-center justify-between gap-3 border-b border-border p-5"><h2 className="font-semibold">{t('waiting',{count:value.waiting.length})}</h2><Link href="/rewards/approvals" className="text-sm text-primary hover:underline">{t('open')}</Link></div>
   {waiting.length?<ul className="divide-y divide-border">{waiting.map(unit=><li key={unit.id} className="space-y-2 p-5 text-sm"><Link href={`/rewards/${unit.id}`} className="font-medium text-primary hover:underline">{unit.company} · {unit.name}</Link><p>{r('openReview')}</p><p className={unit.daysUntilDue!==null&&unit.daysUntilDue<0?'text-destructive':'text-muted-foreground'}>{unit.due?`${r('dueOn',{date:unit.due})}${unit.daysUntilDue!==null&&unit.daysUntilDue<0?' · '+t('overdue'):''}`:t('noDue')}</p><Link href={`/rewards/${unit.id}#checks`} className={unit.blocking?'font-medium text-destructive hover:underline':'text-muted-foreground hover:underline'}>{r('reviewList.blocking',{count:unit.blocking})} · {r('reviewList.exceptions',{count:unit.exceptions})}</Link></li>)}</ul>:<p className="p-5 text-sm text-muted-foreground">{r('board.noneWaiting')}</p>}
   {value.waiting.length>5&&<Link href="/rewards/approvals" className="block border-t border-border p-5 text-sm text-primary underline">{t('more',{count:value.waiting.length-5})}</Link>}
  </Card></div>
 </div>;
}
