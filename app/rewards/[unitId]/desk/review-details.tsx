import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Card, thCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import { defaultPolicy, meritMatrixRows, performances } from '@/packs/rewards/model';
import { BonusBudgetCards } from '../bonus-budget';
import { UnitMultiplier } from '../unit-multiplier';
import { BonusPoolWorking } from './bonus-pool-working';
import { SalaryIncreaseTable } from './salary-increase-table';
import { changedRewardMatrixCells } from './reference-matrix';
import type { RewardView } from './desk-model';

const money = (cents: number) => formatMoney(cents === 0 ? 0 : cents / 100, 'MYR');
const summaryCls = 'cursor-pointer select-none px-4 py-3 font-semibold';

/**
 * 37f82412 — "Budget details", closed by default below the People table: the merit / promotion / special
 * pool table and the bonus use by type, for the Standard and JG H plans. Group Rewards, CTRO and EC also see
 * the pool working, the suggested multiplier, the lump-sum working and the EC direct reports here.
 */
export function BudgetDetails({ value: v, setupHref }: { value: RewardView; setupHref: string | null }) {
  const t = useTranslations('rewards'), d = useTranslations('rewards.desk'), locale = useLocale();
  const unitId = v.unit.id;
  const scope = t('unitBonus.appliesOnlyTo', { company: v.companyName, unit: v.name });
  return <details id="budget-details" className="scroll-mt-6 rounded-lg border border-border">
    <summary className={summaryCls}>{d('budgetDetails')}</summary>
    <div className="space-y-6 border-t border-border p-4">
      <section id="salary-increase" className="scroll-mt-6 space-y-3"><h2 className="text-base font-semibold">{d('tiles.salary')}</h2><SalaryIncreaseTable budgets={v.budgets} />
        {(['standard', 'h'] as const).some(plan => v.payWindow[plan]?.count) && <p className="text-sm">{(['standard', 'h'] as const).filter(plan => v.payWindow[plan]?.count).map(plan => <span key={plan} className="mr-4 inline-block">{t(plan)} · {t('payWindow.excludedFromBase', { count: v.payWindow[plan]!.count, amount: money(v.payWindow[plan]!.payrollCents) })}</span>)}{setupHref && <Link className="text-primary hover:underline" href={setupHref}>{t('payWindow.viewList')}</Link>}</p>}
      </section>
      <section id="bonus" className="scroll-mt-6 space-y-3"><h2 className="text-base font-semibold">{d('tiles.bonus')}</h2>
        <BonusBudgetCards value={v} t={key => t(key)} locale={locale} hideWorking hideSetupStates={!v.fullView} />
        {v.fullView && <>
          <BonusPoolWorking value={v} />
          <Card><div className="space-y-3 p-4"><h3 className="font-medium">{t('bonusPresentation.unitMultiplier')}</h3><UnitMultiplier value={{ unitId, revision: v.unit.revision, unitName: v.name, scope, multiplierBp: v.unit.policy.multiplierBp, suggestedMultiplierBp: v.suggestedMultiplierBp, suggestion: v.suggestion && { patActualMissing: v.suggestion.patActualMissing, achievementBp: v.suggestion.achievementBp, targetMonthsBp: v.suggestion.targetMonthsBp, poolMultiplierBp: v.suggestion.poolMultiplierBp }, branch: v.unit.policy.bonusStructure === 'branch', canConfigure: false }} /></div></Card>
          {v.lumpWorking.length > 0 && <Card className="space-y-2 p-4"><h3 className="font-medium">{t('lumpSum')} · {t('showWorking')}</h3><ul className="space-y-1 text-sm">{v.lumpWorking.map(p => <li key={p.plan}>{t(p.plan)}: {money(p.balanceCents)} / {p.count} → {money(p.perPersonCents)}</li>)}</ul></Card>}
        </>}
      </section>
      {v.fullView && v.ec && <Card id="ec-reports" className="scroll-mt-6 space-y-2 p-4"><h2 className="font-semibold">{t('desk.ec')}</h2><div className="flex flex-wrap gap-6 text-sm"><span>{t('referenceOnly')}: <b>{money(v.ec.referenceCents)}</b></span><span>{t('increment')}: <b>{money(v.ec.incrementCents)}</b></span><span>{t('bonus')}: <b>{money(v.ec.bonusCents)}</b></span></div></Card>}
    </div>
  </details>;
}

/** 37f82412 — "Reference", closed by default: the merit matrix and the bonus months (and branch factors). */
export function ReferenceDetails({ value: v }: { value: RewardView }) {
  const t = useTranslations('rewards'), d = useTranslations('rewards.desk');
  const policy = v.unit.policy, defaults = defaultPolicy(policy.year);
  return <details id="reference" className="scroll-mt-6 rounded-lg border border-border">
    <summary className={summaryCls}>{d('reference')}</summary>
    <div className="space-y-6 border-t border-border p-4">
      <section className="space-y-2"><h3 className="font-medium">{t('meritMatrix')} <span className="ml-2 rounded-full bg-muted px-2 py-1 text-xs font-normal">{t('desk.cellsAdjusted', { count: changedRewardMatrixCells(policy.meritMatrix, defaults.meritMatrix) })}</span></h3>
        <p className="text-sm text-muted-foreground">{t('matrixHelp')}</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className={thCls}>{t('talent')}</th>{['below', 'within', 'above'].map(k => <th key={k} className={thCls}>{t(k)}</th>)}</tr></thead><tbody>{meritMatrixRows(policy.meritMatrix).map(([talent, values]) => <tr key={talent}><th className={thCls}>{talent}</th>{values.map((n, i) => <td key={i} className="px-3 py-2 text-center">{n / 100}%</td>)}</tr>)}</tbody></table></div>
      </section>
      <section className="space-y-2"><h3 className="font-medium">{t('bonusMatrix')} <span className="ml-2 rounded-full bg-muted px-2 py-1 text-xs font-normal">{t('desk.cellsAdjusted', { count: changedRewardMatrixCells(policy.bonusMatrix, defaults.bonusMatrix) })}</span></h3>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className={thCls}>{t('grade')}</th>{performances.map(k => <th key={k} className={thCls}>{k}</th>)}</tr></thead><tbody>{Object.entries(policy.bonusMatrix).map(([g, values]) => <tr key={g}><th className={thCls}>{g}</th>{values.map((n, i) => <td key={i} className="px-3 py-2 text-center">{n / 10000}</td>)}</tr>)}</tbody></table></div>
      </section>
      {/* 8296a4d9: under branch factors (PPCH) each person's multiplier comes from these two tables. */}
      {policy.bonusStructure === 'branch' && <section className="space-y-4 overflow-x-auto"><table className="w-full text-sm"><caption className="pb-2 text-left font-medium">{t('branchGrid.factors')}</caption><thead><tr><th className={thCls}>{t('branchGrid.segment')}</th>{performances.map(k => <th key={k} className={thCls}>{k}</th>)}</tr></thead><tbody>{Object.entries(policy.branchFactors).map(([segment, values]) => <tr key={segment}><th className={thCls}>{segment}</th>{values.map((n, i) => <td key={i} className="px-3 py-2 text-center tabular-nums">{(n / 10000).toFixed(2)}</td>)}</tr>)}</tbody></table>
        <table className="w-full text-sm"><caption className="pb-2 text-left font-medium">{t('branchGrid.ratings')}</caption><thead><tr><th className={thCls}>{t('branchGrid.branch')}</th><th className={thCls}>{t('branchGrid.rating')}</th></tr></thead><tbody>{Object.entries(policy.branchRatings).map(([branch, rating]) => <tr key={branch}><th className={thCls}>{branch}</th><td className="px-3 py-2">{rating}</td></tr>)}</tbody></table>
        {!Object.keys(policy.branchFactors).length && <p className="text-sm text-muted-foreground">{t('branchGrid.empty')}</p>}</section>}
    </div>
  </details>;
}
