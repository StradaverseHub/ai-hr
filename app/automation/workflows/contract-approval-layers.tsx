'use client';
import {useTranslations} from 'next-intl';
import type {AutomationRecipient} from '@/lib/automation/workflow';
import type {ContractApprovalLayer} from '@/lib/contract-automation';
import {recipientKey,recipientsFromKeys} from '../recipients';
import type {MultiSelectOption} from '../multi-select';

/** Approval layers are ordered decisions; document signing remains on each document template. */
export function ContractApprovalLayers({layers,onChange,options,disabled}:{layers:ContractApprovalLayer[];onChange:(layers:ContractApprovalLayer[])=>void;options:MultiSelectOption[];disabled:boolean}){
 const t=useTranslations('automation.contract');
 const update=(index:number,change:Partial<ContractApprovalLayer>)=>onChange(layers.map((layer,i)=>i===index?{...layer,...change}:layer));
 const choose=(key:string):ContractApprovalLayer['approver']|null=>{
  const recipient=recipientsFromKeys([key])[0];
  return recipient&&recipient.kind!=='pending'?recipient as ContractApprovalLayer['approver']:null;
 };
 return <div className="v9-stack">
  <p className="v9-muted">{t('approvalHelp')}</p>
  {layers.map((layer,index)=><fieldset className="v9-panel v9-stack" key={layer.id} disabled={disabled}>
   <legend>{t('layerNumber',{number:index+1})}</legend>
   <label className="v9-field"><span>{t('layerName')}</span><input className="v9-input" value={layer.name} maxLength={100} onChange={e=>update(index,{name:e.target.value})}/></label>
   <label className="v9-field"><span>{t('approver')}</span><select value={recipientKey(layer.approver as AutomationRecipient)} onChange={e=>{const approver=choose(e.target.value);if(approver)update(index,{approver});}}>
    {options.filter(option=>option.value!=='pending').map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
   </select></label>
   <label className="v9-field"><span>{t('pick')}</span><select value={layer.pick} onChange={e=>update(index,{pick:e.target.value as ContractApprovalLayer['pick']})}><option value="any">{t('any')}</option><option value="roundRobin">{t('roundRobin')}</option></select></label>
   <div className="v9-actions">
    <button type="button" className="v9-button" disabled={index===0} onClick={()=>{const next=[...layers];[next[index-1],next[index]]=[next[index],next[index-1]];onChange(next);}}>{t('up')}</button>
    <button type="button" className="v9-button" disabled={index===layers.length-1} onClick={()=>{const next=[...layers];[next[index+1],next[index]]=[next[index],next[index+1]];onChange(next);}}>{t('down')}</button>
    <button type="button" className="v9-button" onClick={()=>onChange(layers.filter((_,i)=>i!==index))}>{t('remove')}</button>
   </div>
  </fieldset>)}
  <div><button type="button" className="v9-button" disabled={disabled||layers.length>=30} onClick={()=>onChange([...layers,{id:crypto.randomUUID(),name:'',approver:{kind:'role',role:'directSuperior'},pick:'any'}])}>{t('addLayer')}</button></div>
 </div>;
}
