import { RewardSubmit } from '../submit-button';
import { getTranslations } from 'next-intl/server';
import { Button, Field, inputCls } from '@/components/ui';
import { talents, type RewardPolicy } from '@/packs/rewards/model';
import { policyAction } from '../actions';

const rows = (m: Record<string, number[]>, scale: number) => Object.entries(m).map(([key, values]) => [key, ...values.map(v => v / scale)].join(', ')).join('\n');
export async function PolicyForm({ unitId, revision, policy: p }: { unitId: string; revision: number; policy: RewardPolicy }) {
  const t = await getTranslations('rewards');
  const amount = (name: string, label: string, value: number | null, scale = 100) => <Field label={label}><input name={name} type="number" min="0" step="0.01" defaultValue={value == null ? '' : value / scale} className={inputCls} /></Field>;
  return <form action={policyAction} className="space-y-6">
    <input type="hidden" name="unitId" value={unitId} /><input type="hidden" name="revision" value={revision} />
    <p className="max-w-3xl text-sm text-muted-foreground">{t('configurationHelp')}</p>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('eligibility')}</legend><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {(['effectiveFrom', 'joinedBefore', 'confirmedBy', 'blockedFrom', 'blockedTo'] as const).map(key => <Field key={key} label={t(key)}><input type="date" name={key} defaultValue={p[key]} required className={inputCls} /></Field>)}
      <Field label={t('seniorGrades')}><input name="seniorGrades" defaultValue={p.seniorGrades.join(', ')} className={inputCls} /></Field>
    </div></fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('salaryBudgets')}</legend><div className="grid gap-4 sm:grid-cols-3">
      {(['standard', 'h'] as const).flatMap(plan => [0, 1, 2].map(i => <div key={`${plan}.${i}`}>{amount(`${plan}.${i}`, `${t(plan)} · ${t(['merit', 'promotion', 'special'][i])} (%)`, (plan === 'h' ? p.hPools : p.standardPools)[i])}</div>))}
    </div></fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('meritMatrix')}</legend>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">{t('talent')}</th>{['below', 'within', 'above'].map(k => <th key={k} className="p-2 text-left">{t(k)} (%)</th>)}</tr></thead><tbody>{talents.map(talent => <tr key={talent}><th className="p-2 text-left">{talent}</th>{p.meritMatrix[talent].map((value, i) => <td key={i} className="p-2"><input aria-label={`${talent} ${t(['below', 'within', 'above'][i])}`} type="number" min="0" step="0.01" name={`merit.${talent}.${i}`} defaultValue={value / 100} required className={inputCls} /></td>)}</tr>)}</tbody></table></div>
      <Field label={t('rangesHelp')}><textarea name="ranges" rows={7} defaultValue={rows(p.ranges, 100)} className={`${inputCls} h-auto py-2 font-mono`} /></Field>
    </fieldset>
    <fieldset className="space-y-4"><legend className="mb-3 font-semibold">{t('bonusBudget')}</legend><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {amount('patActual', t('patActual'), p.patActual)}{amount('patTarget', t('patTarget'), p.patTarget)}{amount('targetMonths', t('targetMonths'), p.targetMonthsBp, 10000)}{amount('multiplier', t('multiplierAuto'), p.multiplierBp, 10000)}
    </div><Field label={t('bonusMatrixHelp')}><textarea name="bonusMatrix" rows={8} defaultValue={rows(p.bonusMatrix, 10000)} className={`${inputCls} h-auto py-2 font-mono`} /></Field>
      <Field label={t('bonusStructure')}><select name="bonusStructure" defaultValue={p.bonusStructure} className={inputCls}><option value="standard">{t('standard')}</option><option value="branch">{t('branchStructure')}</option></select></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={t('branchFactorsHelp')}><textarea name="branchFactors" rows={5} defaultValue={rows(p.branchFactors, 10000)} className={`${inputCls} h-auto py-2 font-mono`} /></Field><Field label={t('branchRatingsHelp')}><textarea name="branchRatings" rows={5} defaultValue={Object.entries(p.branchRatings).map(x => x.join(', ')).join('\n')} className={`${inputCls} h-auto py-2 font-mono`} /></Field></div>
    </fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('lumpSum')}</legend><div className="grid gap-4 sm:grid-cols-3">{amount('lumpStep', t('rounding'), p.lumpStepCents)}{amount('lumpShare', t('balanceShare'), p.lumpShareBp)}{amount('lumpCap', t('optionalCap'), p.lumpCapCents)}</div><p className="text-sm text-muted-foreground">{t('lumpPolicyHelp')}</p></fieldset>
    <Field label={t('exemptionReason')}><textarea name="exemptReason" rows={3} maxLength={2000} defaultValue={p.exemptReason} className={`${inputCls} h-auto py-2`} /></Field>
    <RewardSubmit type="submit">{t('savePolicy')}</RewardSubmit>
  </form>;
}
