'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';
import {ContractPanel,ContractFeedback} from './shared-case-ui';
import {recordSharedDecline} from './shared-actions';
/** Rendered only when the native owner reports a currently pending employee Sign step on Renew. */
export function ContractDecline({caseId,revision,reasons}:{caseId:string;revision:number;reasons:{code:string;label:string|null}[]}){
 const copy=useContractSharedCopy(),router=useRouter(),[reason,setReason]=useState(''),[notes,setNotes]=useState(''),[error,setError]=useState(''),[busy,start]=useTransition();
 function record(){start(async()=>{setError('');try{const result=await recordSharedDecline({caseId,revision,reason,notes});if(result.ok)router.refresh();else setError(result.error);}catch{setError('The decline could not be recorded. Your entries are still here. Try again.');}});}
 return <ContractPanel title={copy('Employee declined renewal')}><ContractFeedback error={error}/><p>{copy('Record this only after the employee confirms they will not sign the renewal. The renewal routing is withdrawn, its history is retained, and the configured decline workflow continues.')}</p><label className="v9-field"><span>{copy('Personnel termination reason')}</span><select disabled={busy} value={reason} onChange={event=>setReason(event.target.value)}><option value="">{copy('Choose a Personnel Management reason')}</option>{reasons.map(item=><option key={item.code} value={item.code}>{item.label??item.code.replaceAll('_',' ')}</option>)}</select></label><label className="v9-field"><span>{copy('Decline notes')}</span><textarea disabled={busy} rows={3} maxLength={5000} value={notes} onChange={event=>setNotes(event.target.value)}/></label><button className="v9-button" disabled={busy||!reason} aria-busy={busy} onClick={record}>{copy('Record employee decline')}</button><p className="v9-muted">{copy('People Ops records termination manually in Personnel Management after the Offboarding handoff. This action does not terminate the Personnel record or update Payroll.')}</p></ContractPanel>;
}
