import type { getRewardUnit } from '@/packs/rewards/service';
import { Card } from '@/components/ui';
import { formatMoney } from '@/lib/money';

type RewardView=Awaited<ReturnType<typeof getRewardUnit>>;
type BudgetView=Pick<RewardView,'budgets'|'bonusCounts'|'suggestedMultiplierBp'> & {unit:Pick<RewardView['unit'],'policy'>};
/** Presentation of the canonical calculated pools; no award or policy is calculated here. */
/** The unit multiplier has its own card on the page (8296a4d9); this section is the two plans' pools only. */
export function BonusBudgetCards({value:v,t,locale,hideWorking=false}:{value:BudgetView;t:(key:string)=>string;locale:string;hideWorking?:boolean}) {
  const money=(cents:number)=>formatMoney(cents/100,'MYR');
  const decimal=(number:number,digits=2)=>new Intl.NumberFormat(locale,{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(number);
  const percent=(amount:number,pool:number)=>pool>0?`${decimal(amount/pool*100,1)}%`:'—';
  const policy=v.unit.policy;
  return <section className="space-y-4" aria-label={t('bonusBudget')}>
    <h2 className="text-base font-semibold">{t('bonusBudget')}</h2>
    <p className="max-w-3xl text-sm text-muted-foreground">{t('bonusPresentation.separatePools')}</p>
    <div className="grid items-start gap-4 xl:grid-cols-2">
      {(['standard','h'] as const).map(plan=>{
        const b=v.budgets[plan],counts=v.bonusCounts[plan];
        const state=b.bonusUsedCents>b.bonusPoolCents?'over':b.bonusPoolCents===0?'empty':b.bonusUsedCents*100<b.bonusPoolCents*80?'under':'within';
        const rows=[
          {key:'standardBonusCents',count:counts?.eligible,amount:b.standardBonusCents,help:'standardHelp'},
          {key:'increasesCents',count:counts?.increases,amount:b.increasesCents,help:'increaseHelp'},
          {key:'reductionsCents',count:counts?.reductions,amount:-b.reductionsCents,help:'reductionHelp'},
          {key:'lumpCents',count:counts?.lump,amount:b.lumpCents,help:'lumpHelp'},
        ];
        return <Card key={plan} className="min-w-0 space-y-4 p-5">
          <header className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-semibold">{t(plan)}</h3><span className={`rounded-full px-2 py-1 text-xs font-medium ${state==='over'?'bg-destructive/10 text-destructive':state==='under'?'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100':'bg-muted text-foreground'}`}>{t(`bonusPresentation.${state}`)}</span></header>
          <p className="text-sm text-muted-foreground">{t('bonusPresentation.bonusPeople')}: {counts?.eligible??'—'} · {policy.bonusStructure==='branch'?t('branchStructure'):`${t('bonusPresentation.unitMultiplier')}: ${decimal((policy.multiplierBp??v.suggestedMultiplierBp)/10000)}`}</p>
          <p className="text-sm"><strong className={`mr-2 text-2xl tabular-nums ${state==='over'?'text-destructive':''}`}>{percent(b.bonusUsedCents,b.bonusPoolCents)}</strong>{t('bonusPresentation.poolUsed')}</p>
          <div role="meter" aria-label={t('bonusPresentation.poolUsed')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={b.bonusPoolCents>0?Math.max(0,Math.min(100,b.bonusUsedCents/b.bonusPoolCents*100)):0} aria-valuetext={b.bonusPoolCents>0?percent(b.bonusUsedCents,b.bonusPoolCents):t(`bonusPresentation.${state}`)} className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${state==='over'?'bg-destructive':state==='under'?'bg-amber-700':'bg-primary'}`} style={{width:`${b.bonusPoolCents>0?Math.max(0,Math.min(100,b.bonusUsedCents/b.bonusPoolCents*100)):b.bonusUsedCents>0?100:0}%`}}/>
          </div>
          <dl className="flex flex-wrap justify-between gap-2 text-sm tabular-nums"><div><dt className="inline text-muted-foreground">{t('bonusUsedCents')}: </dt><dd className="inline">{money(b.bonusUsedCents)} / {money(b.bonusPoolCents)}</dd></div><div className={b.balanceCents<0?'text-destructive':''}><dt className="inline text-muted-foreground">{t('balanceCents')}: </dt><dd className="inline">{money(b.balanceCents)}</dd></div></dl>
          <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="pb-2 text-left font-medium">{t('bonusPresentation.byType')}</caption><thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="px-2 py-2 text-left">{t('type')}</th><th scope="col" className="px-2 py-2 text-right">{t('people')}</th><th scope="col" className="px-2 py-2 text-right">{t('bonusPresentation.amount')}</th><th scope="col" className="px-2 py-2 text-right">{t('bonusPresentation.share')}</th></tr></thead><tbody className="divide-y divide-border">{rows.map(row=><tr key={row.key}><th scope="row" className="min-w-36 px-2 py-3 text-left font-normal">{t(row.key)}<span className="mt-1 block text-xs text-muted-foreground">{t(`bonusPresentation.${row.help}`)}</span></th><td className="px-2 py-3 text-right tabular-nums">{row.count??'—'}</td><td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">{money(row.amount)}</td><td className="px-2 py-3 text-right tabular-nums">{percent(row.amount,b.bonusPoolCents)}</td></tr>)}</tbody><tfoot className="border-t border-border font-semibold"><tr><th scope="row" colSpan={2} className="px-2 py-3 text-left">{t('bonusUsedCents')}</th><td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">{money(b.bonusUsedCents)}</td><td className="px-2 py-3 text-right tabular-nums">{percent(b.bonusUsedCents,b.bonusPoolCents)}</td></tr></tfoot></table></div>
          {!counts&&<p className="text-xs text-muted-foreground">{t('bonusPresentation.restrictedCount')}</p>}
          {!hideWorking&&<details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">{t('bonusPresentation.poolConstruction')}</summary><dl className="mt-3 divide-y divide-border text-sm">{[
            [t('patTarget'),money(policy.patTarget)],[t('patActual'),money(policy.patActual)],
            [t('bonusPresentation.achievement'),percent(policy.patActual,policy.patTarget)],
            [t('targetMonths'),decimal(policy.targetMonthsBp/10000)],
            [t('bonusPresentation.poolMultiplier'),policy.patTarget>0?decimal(policy.patActual/policy.patTarget*policy.targetMonthsBp/10000):'—'],
            [t('bonusPresentation.eligiblePayroll'),money(b.bonusPayrollCents)],
            [t('bonusPoolCents'),money(b.bonusPoolCents)],[t('bonusUsedCents'),money(b.bonusUsedCents)],[t('balanceCents'),money(b.balanceCents)],
          ].map(([label,amount])=><div key={label} className="flex justify-between gap-4 py-2"><dt>{label}</dt><dd className="shrink-0 text-right font-medium tabular-nums">{amount}</dd></div>)}</dl></details>}
        </Card>;
      })}
    </div>
    {policy.exemptReason&&<div className="border-t border-border pt-4"><p className="text-sm">{t('exemptionReason')}: {policy.exemptReason}</p></div>}
  </section>;
}
