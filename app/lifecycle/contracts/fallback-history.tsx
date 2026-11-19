'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {AlertCircle} from 'lucide-react';
import type {ContractFallbackPage} from '@/packs/contracts/service';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';
import {readSharedFallbacks} from './shared-actions';
import {ContractPanel,ContractFeedback} from './shared-case-ui';
import {contractTimestamp} from './shared';
export function ContractFallbackHistory({caseId,initial}:{caseId:string;initial:ContractFallbackPage}){
 return <ContractFallbackHistoryPage key={JSON.stringify([caseId,initial])} caseId={caseId} initial={initial}/>;
}
function ContractFallbackHistoryPage({caseId,initial}:{caseId:string;initial:ContractFallbackPage}){
 const copy=useContractSharedCopy(),[page,setPage]=useState(initial),[error,setError]=useState(''),[busy,start]=useTransition();
 const alive=useRef(false);
 // A changed source snapshot remounts this page; ordinary identical polling preserves expanded history.
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 function more(){if(!page.nextBefore)return;start(async()=>{setError('');try{const result=await readSharedFallbacks(caseId,page.nextBefore!);if(!alive.current)return;if(result.ok)setPage(previous=>({...result.value,rows:[...previous.rows,...result.value.rows.filter(row=>!previous.rows.some(existing=>existing.ordinal===row.ordinal))]}));else setError(result.error);}catch{if(alive.current)setError('Fallback history could not be loaded. Your current page is retained; try again.');}});}
 if(!page.total)return null;
 return <ContractPanel title={copy('Recorded fallbacks')}><ContractFeedback error={error}/><ol className="contract-rail">{page.rows.map(receipt=><li key={receipt.ordinal}><AlertCircle aria-hidden/><div><strong>{receipt.workflowName??copy('Retained workflow')} · {receipt.stepNumber?copy('Step')+' '+receipt.stepNumber:copy('Retained workflow step')}{receipt.stepName?' · '+receipt.stepName:''}</strong><p>{contractTimestamp(receipt.at)}</p>{receipt.details.map((detail,index)=><div key={index}><p><strong>{copy('No one matched:')} {detail.intended}</strong></p><p>{detail.reason}</p><p className="v9-muted">{copy('Recorded fallback group (current name):')} {detail.groupCurrentName??copy('Unavailable group')}</p></div>)}</div></li>)}</ol><p className="v9-muted">{page.rows.length} {copy('of')} {page.total} {copy('recorded fallback events')}</p>{page.hasMore&&<button className="v9-button" disabled={busy} onClick={more}>{busy?copy('Loading…'):copy('Show more fallbacks')}</button>}</ContractPanel>;
}
