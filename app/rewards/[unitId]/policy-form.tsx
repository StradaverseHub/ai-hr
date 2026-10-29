import Link from 'next/link';
import { RewardSubmit } from '../submit-button';
import { getTranslations } from 'next-intl/server';
import { Field, inputCls } from '@/components/ui';
import { talents, type RewardPolicy } from '@/packs/rewards/model';
import { policyAction } from '../actions';
import {PolicyMatrixGrid} from '../policy-matrix-grid';
import {BranchPolicyFields} from '../branch-policy-fields';
import {rewardEligibilitySummary} from '@/packs/rewards/policy-eligibility';

export async function PolicyForm({unitId,revision,policy,readOnly=false}:{unitId:string;revision:number;policy:RewardPolicy;readOnly?:boolean}){
 const t=await getTranslations('rewards');
 return <form action={policyAction} className="space-y-6"><input type="hidden" name="unitId" value={unitId}/><input type="hidden" name="revision" value={revision}/>
  <RewardPolicyFields policy={policy} readOnly={readOnly} unitId={unitId}/>{!readOnly&&<RewardSubmit type="submit">{t('savePolicy')}</RewardSubmit>}
 </form>;
}
/** Reuse the same policy fields in an individual review and a versioned shared configuration. */
export async function RewardPolicyFields({policy:p,readOnly=false,context='unit',unitId}:{policy:RewardPolicy;readOnly?:boolean;context?:'unit'|'shared';hideUnitInputs?:boolean;unitId?:string}){
  const t = await getTranslations('rewards');
  const eligibility=rewardEligibilitySummary(p);
  const amount = (name: string, label: string, value: number | null, scale = 100) => <Field label={label}><input name={name} type="number" min="0" step="0.01" defaultValue={value == null ? '' : value / scale} className={inputCls} /></Field>;
  return <fieldset disabled={readOnly} className="space-y-6"><input type="hidden" name="policyGridVersion" value="1"/><input type="hidden" name="policyEligibilityVersion" value="1"/><input type="hidden" name="policyContext" value={context}/>
    <p className="max-w-3xl text-sm text-muted-foreground">{t(context==='shared'?'sharedPolicy.policyHelp':'configurationHelp')}</p>{context==='unit'&&<p className="text-sm text-muted-foreground">{t('unitInputsHelp')} {unitId&&<Link href={`/rewards/${unitId}#unit-governance`} className="text-primary underline">{t('unitInputsLink')}</Link>}</p>}
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('eligibility')}</legend>{eligibility.legacyDefaults&&<p className="text-sm text-muted-foreground">{t('eligibilitySummary.legacyDefaults')}</p>}<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {(['effectiveFrom', 'joinedBefore', 'confirmedBy'] as const).map(key => <Field key={key} label={t(key)}><input type="date" name={key} defaultValue={p[key]} required className={inputCls} /></Field>)}
      <Field label={t('eligibilitySummary.activeAsOf')}><input type="date" name="activeAsOf" defaultValue={eligibility.activeAsOf??`${p.year}-12-31`} required className={inputCls}/></Field>
      <Field label={t('eligibilitySummary.minimumRating')}><select name="minimumBonusRating" defaultValue={eligibility.minimumBonusRating??'BE'} className={inputCls}>{['UA','BE','ME','AE','OU'].map(rating=><option key={rating}>{rating}</option>)}</select></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="excludeNotice" defaultChecked={eligibility.excludeNotice}/>{t('eligibilitySummary.notice')}</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="excludeErCase" defaultChecked={eligibility.excludeErCase}/>{t('eligibilitySummary.er')}</label>
      {p.seniorMembershipMode === 'named-members' ? <p className="text-sm text-muted-foreground">{t(context==='shared'?'sharedPolicy.membershipHelp':'seniorMembershipHelp')}</p> : <Field label={t('seniorGrades')}><input readOnly value={p.seniorGrades.join(', ')} className={inputCls} /></Field>}
    </div><fieldset className="space-y-2"><legend className="font-medium">{t('salaryExclusion.label')}</legend><p className="text-sm text-muted-foreground">{t('salaryExclusion.help')}</p><div className="grid gap-4 sm:grid-cols-2">{(['blockedFrom','blockedTo'] as const).map(key=><Field key={key} label={t(key)}><input type="date" name={key} defaultValue={p[key]} required className={inputCls}/></Field>)}</div></fieldset></fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('salaryBudgets')}</legend><div className="grid gap-4 sm:grid-cols-3">
      {(['standard', 'h'] as const).flatMap(plan => [0, 1, 2].map(i => <div key={`${plan}.${i}`}>{amount(`${plan}.${i}`, `${t(plan)} · ${t(['merit', 'promotion', 'special'][i])} (%)`, (plan === 'h' ? p.hPools : p.standardPools)[i])}</div>))}
    </div></fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('meritMatrix')}</legend>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">{t('talent')}</th>{['below', 'within', 'above'].map(k => <th key={k} className="p-2 text-left">{t(k)} (%)</th>)}</tr></thead><tbody>{talents.map(talent => <tr key={talent}><th className="p-2 text-left">{talent}</th>{p.meritMatrix[talent].map((value, i) => <td key={i} className="p-2"><input aria-label={`${talent} ${t(['below', 'within', 'above'][i])}`} type="number" min="0" step="0.01" name={`merit.${talent}.${i}`} defaultValue={value / 100} required className={inputCls} /></td>)}</tr>)}</tbody></table></div>
      <PolicyMatrixGrid kind="ranges" matrix={p.ranges} year={p.year}/>
    </fieldset>
    <fieldset className="space-y-4"><legend className="mb-3 font-semibold">{t('bonusBudget')}</legend><PolicyMatrixGrid kind="bonusMatrix" matrix={p.bonusMatrix} year={p.year}/>
      <BranchPolicyFields structure={p.bonusStructure} factors={p.branchFactors} year={p.year}/>

    </fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 font-semibold">{t('lumpSum')}</legend><div className="grid gap-4 sm:grid-cols-3">{amount('lumpStep', t('rounding'), p.lumpStepCents)}{amount('lumpShare', t('balanceShare'), p.lumpShareBp)}{amount('lumpCap', t('optionalCap'), p.lumpCapCents)}</div><p className="text-sm text-muted-foreground">{t('lumpPolicyHelp')}</p></fieldset>

    </fieldset>;
}
