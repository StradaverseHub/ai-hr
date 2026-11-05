'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationCaseView} from '@/packs/probation/service';
import {DraftGuard} from './draft-guard';
import {requestLegacyReconciliation,approveLegacyReconciliation} from './actions';
export function LegacyReconciliationControls({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),router=useRouter(),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,start]=useTransition(),review=view.legacyReconciliation;
 if(!review||(!review.canRequest&&!review.request&&!review.holdReason)||view.sourceMoved)return null;
 const request=review.request;
 const run=(work:()=>Promise<{ok:boolean;detail?:string}>)=>{setError('');start(async()=>{const result=await work();if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}setReason('');router.refresh();});};
 return <section className="v9-panel v9-stack"><DraftGuard dirty={!!reason.trim()}/><h2>{t('legacyReview.title')}</h2><p className="v9-muted">{t('legacyReview.help')}</p>
  {review.holdReason&&<p className="v9-notice v9-warning">{review.holdReason}</p>}
  {error&&<p role="alert" className="v9-notice v9-error">{error}</p>}
  {request&&<><dl className="probation-facts"><div><dt>{t('intake.reviewReference')}</dt><dd>{request.id}</dd></div><div><dt>{t('columns.state')}</dt><dd>{t(request.appliedAt?'legacyReview.applied':request.approvedAt?'legacyReview.approved':'legacyReview.pending')}</dd></div></dl><p className="probation-note">{request.reason}</p></>}
  {(review.canRequest||request?.canApprove)&&<label className="v9-field"><span>{t('reason')}</span><textarea maxLength={5000} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>}
  <div className="probation-actions">{review.canRequest&&<button aria-busy={busy} type="button" className="v9-button" disabled={busy||reason.trim().length<3} onClick={()=>run(()=>requestLegacyReconciliation({caseId:view.record.id,revision:view.record.revision,reason}))}>{t('legacyReview.request')}</button>}
   {request?.canApprove&&<button aria-busy={busy} type="button" className="v9-button" disabled={busy||reason.trim().length<3} onClick={()=>run(()=>approveLegacyReconciliation({id:request.id,reason}))}>{t('legacyReview.approve')}</button>}</div>
 </section>;
}
