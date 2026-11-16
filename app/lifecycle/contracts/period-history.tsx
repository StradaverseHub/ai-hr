'use client';
import {useState,useTransition} from 'react';
import Link from 'next/link';
import type {ContractPeriodHistoryPage} from '@/packs/contracts/service';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';
import {ContractPanel,ContractFeedback,contractDate} from './shared-case-ui';
import {readSharedPeriods} from './shared-actions';
export function ContractPeriodHistory({caseId,initial}:{caseId:string;initial:ContractPeriodHistoryPage}){
 const copy=useContractSharedCopy(),[page,setPage]=useState(initial),[offset,setOffset]=useState(0),[error,setError]=useState(''),[busy,start]=useTransition();
 function read(next:number){start(async()=>{setError('');const result=await readSharedPeriods(caseId,next);if(result.ok){setPage(result.value);setOffset(next);}else setError(result.error);});}
 return <ContractPanel title={copy('Cases and contract periods')}><ContractFeedback error={error}/><div className="v9-table-scroll"><table className="v9-table"><thead><tr><th>{copy('Contract period')}</th><th>{copy('Dates')}</th><th>{copy('Case')}</th><th>{copy('Action')}</th></tr></thead><tbody>{page.rows.map(period=><tr key={period.id}><td>{period.contractNumber==null?copy('Legacy period'):`${copy('Contract')} #${period.contractNumber}`}</td><td>{contractDate(period.startOn)}–{contractDate(period.endOn)}</td><td>{period.caseNumber}{!period.shared&&<small>{copy('Original workflow retained')}</small>}</td><td>{period.current?copy('This case'):<Link href={'/lifecycle/contracts/'+period.id}>{copy('Open case')}</Link>}</td></tr>)}</tbody></table></div><div className="v9-actions"><p>{offset+1}–{Math.min(offset+page.rows.length,page.total)} / {page.total}</p>{offset>0&&<button className="v9-button" disabled={busy} onClick={()=>read(Math.max(0,offset-50))}>{copy('Previous')}</button>}{offset+page.rows.length<page.total&&<button className="v9-button" disabled={busy} onClick={()=>read(offset+50)}>{copy('Next')}</button>}</div></ContractPanel>;
}
