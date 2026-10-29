import {useLocale,useTranslations} from 'next-intl';
import {Card,theadCls,thCls,tbodyCls} from '@/components/ui';
import {formatMoney} from '@/lib/money';
import type {PlanBudget} from '@/packs/rewards/engine';
export const deskMoney=(cents:number,locale:string)=>formatMoney(cents===0?0:cents/100,'MYR',locale);
export function DeskMeter({used,pool,label}:{used:number;pool:number;label:string}){
 const value=pool>0?Math.max(0,Math.min(100,used/pool*100)):used>0?100:0;
 return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full ${used>pool?'bg-destructive':'bg-emerald-700 dark:bg-emerald-500'}`} style={{width:`${value}%`}}/></div>;
}
export function SalaryIncreaseTable({budgets}:{budgets:Record<'standard'|'h',PlanBudget>}){
 const t=useTranslations('rewards'),locale=useLocale();
 const percent=(used:number,payroll:number)=>payroll>0?new Intl.NumberFormat(locale,{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1}).format(used/payroll):'—';
 return <Card><div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">{t('desk.salary')}</caption><thead className={theadCls}><tr><th className={thCls} scope="col">{t('type')}</th>{(['standard','h'] as const).map(plan=><th key={plan} scope="col" className={`${thCls} text-right`}>{t(plan)} · {t('usedPool')}</th>)}</tr></thead><tbody className={tbodyCls}>{[0,1,2,3].map(index=><tr key={index} className={index===3?'bg-muted/30 font-semibold':''}><th scope="row" className="px-4 py-4 text-left">{index===3?t('desk.total'):t(['merit','promotion','special'][index])}</th>{(['standard','h'] as const).map(plan=>{
  const b=budgets[plan],used=index===3?b.used.reduce((a,n)=>a+n,0):b.used[index],pool=index===3?b.pools.reduce((a,n)=>a+n,0):b.pools[index],balance=pool-used;
  return <td key={plan} className="min-w-64 space-y-2 px-4 py-4 text-right tabular-nums"><div className={balance<0?'font-semibold text-destructive':''}>{deskMoney(used,locale)} / {deskMoney(pool,locale)}</div><p className="text-xs text-muted-foreground">{t('desk.payrollShare',{percent:percent(used,b.payrollCents)})}</p><DeskMeter used={used} pool={pool} label={`${t(plan)} · ${index===3?t('desk.total'):t(['merit','promotion','special'][index])}`}/><p className={`text-xs ${balance<0?'font-semibold text-destructive':'text-emerald-800 dark:text-emerald-300'}`}>{t(balance<0?'desk.amountOver':'desk.amountLeft',{amount:deskMoney(Math.abs(balance),locale)})}</p></td>;
 })}</tr>)}</tbody></table></div></Card>;
}
