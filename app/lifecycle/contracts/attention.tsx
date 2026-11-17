'use client';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';

export const contractAttentionLabels:Record<string,string>={
 fallback:'Sent to the fallback group',employee_cannot_sign:"Employee can't sign",sent_back:'Letter sent back to its owner',
 template_stopped:'Stopped: document template or workflow',posting_mismatch:'Posting step does not match the decision',
 no_workflow:'No workflow ran',pay_pending:'Pay change pending: manual Payroll entry needs confirmation',source_changed:'Personnel source changed',
};
export function ContractAttention({flags,stalledDays,compact=false}:{flags:string[];stalledDays?:number|null;compact?:boolean}){
 const copy=useContractSharedCopy(),unique=[...new Set(flags)];
 if(!unique.length&&stalledDays==null)return null;
 return <div className={compact?'contract-attention':'v9-notice v9-error'} role="status" aria-label={copy('Needs attention')}>
  <strong>{copy('Needs attention')}</strong><ul>{unique.map(flag=><li key={flag}>{copy(contractAttentionLabels[flag]??flag)}</li>)}{stalledDays!=null&&<li>{copy('Stalled for')} {stalledDays} {copy('days')}</li>}</ul>
 </div>;
}
