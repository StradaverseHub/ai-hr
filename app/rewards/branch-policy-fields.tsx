'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {PolicyMatrixGrid} from './policy-matrix-grid';
export function BranchPolicyFields({structure,factors,year}:{structure:'standard'|'branch';factors:Record<string,readonly number[]>;year:number}){
 const t=useTranslations('rewards'),[selected,setSelected]=useState(structure);
 return <div className="space-y-4"><Field label={t('bonusStructure')}><select name="bonusStructure" value={selected} onChange={event=>setSelected(event.target.value as 'standard'|'branch')} className={inputCls}><option value="standard">{t('standard')}</option><option value="branch">{t('branchStructure')}</option></select></Field>
  <div hidden={selected!=='branch'}><fieldset disabled={selected!=='branch'}><PolicyMatrixGrid kind="branchFactors" matrix={factors} year={year}/></fieldset></div>
  {selected==='standard'&&<input type="hidden" name="branchFactors" value={Object.entries(factors).map(([name,values])=>[name,...values.map(value=>value/10000)].join(', ')).join('\n')}/>}
 </div>;
}
