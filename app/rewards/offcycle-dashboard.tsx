import Link from 'next/link';
import {useLocale,useTranslations} from 'next-intl';
import {Card} from '@/components/ui';
import type {RewardOffcycleDashboard} from '@/packs/rewards/service';
import {deskMoney} from './[unitId]/desk/salary-increase-table';

/** b945f0cc: the Off-cycle side of "Reviewing Team Rewards". Every amount comes from the service (database aggregates);
 * the page only lays them out. Drafts hold no budget. */
export function RewardsOffcycleDashboard({value}:{value:RewardOffcycleDashboard}){
 const t=useTranslations('rewardDashboard'),r=useTranslations('rewards'),locale=useLocale();
 const money=(n:number)=>deskMoney(n,locale);
 const date=(iso:string)=>new Intl.DateTimeFormat(locale==='en'?'en-GB':locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
 const width=(part:number,whole:number)=>whole>0?`${Math.max(0,Math.min(100,part/whole*100))}%`:'0%';
 if(!value.cycle)return <Card className="space-y-3 p-5"><p role="status" className="text-sm">{t('offcycle.notOpen')}</p>
  {value.canConfigure&&<Link href="/rewards/offcycle/settings" className="text-sm text-primary hover:underline">{t('offcycle.settings')}</Link>}</Card>;
 const status=(row:RewardOffcycleDashboard['requests'][number])=>row.returned?t('offcycle.returned'):row.status==='draft'?r('stages.draft'):row.status==='approved'?r('stages.approved'):t('offcycle.inApproval',{stage:r(`stages.${row.status}`)});
 return <div className="space-y-5">
  <div className="flex flex-wrap items-center justify-between gap-3">
   <p className="text-sm text-muted-foreground" data-testid="offcycle-context">{[value.cycle.name,value.window?.from&&value.window.to?t('offcycle.window',{from:date(value.window.from),to:date(value.window.to)}):t('offcycle.noWindow')].join(' · ')}</p>
   <div className="flex flex-wrap gap-2">
    {value.canRaise&&<Link href="/rewards/offcycle/new?kind=midyear" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">{t('offcycle.addMidyear')}</Link>}
    {value.canRaise&&<Link href="/rewards/offcycle/new?kind=adhoc" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">{t('offcycle.newAdhoc')}</Link>}
    {value.canConfigure&&<Link href="/rewards/offcycle/settings" className="px-1 py-1.5 text-sm text-primary hover:underline">{t('offcycle.settings')}</Link>}
   </div>
  </div>
  {value.blackout&&<p role="status" className="rounded-md border border-border p-3 text-sm">{t('offcycle.blackout')}</p>}
  {!value.blackout&&!value.midyearOpen&&<p className="text-sm text-muted-foreground">{t('offcycle.midyearClosed')}</p>}
  <div className="grid items-start gap-5 xl:grid-cols-2">
   <Card className="min-w-0"><h2 className="border-b border-border p-5 font-semibold">{t('offcycle.balanceTitle')}</h2>
    {value.balances.length?<ul className="divide-y divide-border">{value.balances.map(b=><li key={b.companyId} className="space-y-2 p-5 text-sm" data-testid="offcycle-company-balance">
     <div className="flex flex-wrap justify-between gap-x-3"><span className="font-medium">{b.company}</span><span className="tabular-nums">{t('offcycle.left',{amount:money(b.availableCents)})}</span></div>
     <div role="meter" aria-label={t('offcycle.meter',{company:b.company})} aria-valuemin={0} aria-valuemax={b.frozenCents} aria-valuenow={b.heldCents+b.consumedCents} className="flex h-2 overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-emerald-800 dark:bg-emerald-400" style={{width:width(b.consumedCents,b.frozenCents)}}/>
      <div className="h-full bg-amber-600 dark:bg-amber-400" style={{width:width(b.heldCents,b.frozenCents)}}/>
     </div>
     <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
      <div><dt>{t('offcycle.remainder')}</dt><dd className="tabular-nums text-foreground">{money(b.frozenCents)}</dd></div>
      <div><dt>{t('offcycle.held')}</dt><dd className="tabular-nums text-foreground">{money(b.heldCents)}</dd></div>
      <div><dt>{t('offcycle.consumed')}</dt><dd className="tabular-nums text-foreground">{money(b.consumedCents)}</dd></div>
      <div><dt>{t('offcycle.available')}</dt><dd className="tabular-nums text-foreground">{money(b.availableCents)}</dd></div>
     </dl></li>)}</ul>:<p className="p-5 text-sm text-muted-foreground">{t('offcycle.noBalance')}</p>}
    <p className="border-t border-border p-5 text-xs text-muted-foreground">{t('offcycle.balanceHelp')}</p>
   </Card>
   <Card className="min-w-0"><h2 className="border-b border-border p-5 font-semibold">{t('offcycle.myRequests',{count:value.requests.length})}</h2>
    {value.requests.length?<ul className="divide-y divide-border">{value.requests.map(row=><li key={row.id} className="space-y-1 p-5 text-sm" data-testid="offcycle-request">
     <Link href={`/rewards/${row.id}`} className="font-medium text-primary hover:underline">{row.company} · {row.unit}</Link>
     <p>{r(`kinds.${row.kind}`)}{row.exception?` · ${r('budgetException')}`:''} · {status(row)}</p>
     <p className={row.daysUntilDue!==null&&row.daysUntilDue<0?'text-destructive':'text-muted-foreground'}>{row.due?`${r('dueOn',{date:row.due})}${row.daysUntilDue!==null&&row.daysUntilDue<0?' · '+t('overdue'):''}`:t('noDue')}</p>
    </li>)}</ul>:<p className="p-5 text-sm text-muted-foreground">{t('offcycle.noRequests')}</p>}
   </Card>
  </div>
 </div>;
}
