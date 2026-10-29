'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {encodePolicyGrid,policyGridRows} from '@/packs/rewards/policy-grid-validation';
import {useRewardPolicyYear} from './policy-year-context';
import {PolicyMatrixGrid} from './policy-matrix-grid';
type BranchProps={structure:'standard'|'branch';factors:Record<string,readonly number[]>;year:number};
export function BranchPolicyFields(props:BranchProps){const year=useRewardPolicyYear(props.year);return <BranchPolicyFieldsDraft key={year} {...props} year={year}/>;}
function BranchPolicyFieldsDraft({structure,factors,year}:BranchProps){
 const t=useTranslations('rewards'),[selected,setSelected]=useState(structure),[rows,setRows]=useState(()=>policyGridRows('branchFactors',factors));
 return <div className="space-y-4"><Field label={t('bonusStructure')}><select name="bonusStructure" value={selected} onChange={event=>setSelected(event.target.value as 'standard'|'branch')} className={inputCls}><option value="standard">{t('standard')}</option><option value="branch">{t('branchStructure')}</option></select></Field>
  <div hidden={selected!=='branch'}><fieldset disabled={selected!=='branch'}><PolicyMatrixGrid kind="branchFactors" matrix={factors} year={year} onRowsChange={setRows}/></fieldset></div>
  {selected==='standard'&&<><input type="hidden" name="branchFactors" value={encodePolicyGrid('branchFactors',rows)}/><input type="hidden" name="policyGridData.branchFactors" value={JSON.stringify(rows)}/></>}

 </div>;
}
