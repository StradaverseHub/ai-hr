import {useLocale,useTranslations} from 'next-intl';
import type {getRewardUnit} from '@/packs/rewards/service';
import {Card} from '@/components/ui';
import {deskMoney} from './salary-increase-table';
type View=Awaited<ReturnType<typeof getRewardUnit>>;
export function BonusPoolWorking({value:v}:{value:View}){
 const t=useTranslations('rewards'),locale=useLocale(),p=v.unit.policy;
 const decimal=(n:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(n);
 return <Card className="space-y-4 p-5"><h3 className="font-semibold">{t('showWorking')}</h3><p className="text-sm text-muted-foreground">{t('desk.poolFormula')}</p><div className="grid gap-4 sm:grid-cols-2">{(['standard','h'] as const).map(plan=><dl key={plan} className="divide-y divide-border text-sm"><div className="py-2 font-semibold">{t(plan)}</div>{[...(v.roles.includes('gr')?[[t('bonusPresentation.achievement'),p.patTarget>0?`${decimal(p.patActual/p.patTarget*100)}%`:'—']]:[]),[t('targetMonths'),decimal(p.targetMonthsBp/10000)],[t('bonusPresentation.eligiblePayroll'),deskMoney(v.budgets[plan].bonusPayrollCents,locale)],[t('bonusPoolCents'),deskMoney(v.budgets[plan].bonusPoolCents,locale)]].map(([label,value])=><div key={label} className="flex justify-between gap-3 py-2"><dt>{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl>)}</div></Card>;
}
