'use client';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationLetterView} from '@/packs/probation/service';
import {pendingSigningSteps,signingComplete} from '@/lib/document-signing-model';
import {DocumentBody} from '@/components/lifecycle-v9/document-body';
import {SignatureInput,type SignatureInputLabels} from '@/components/lifecycle-v9/signature-input';
import {onboardingTimestamp} from '@/lib/onboarding-format';
import {signLetter,releaseLetter} from './actions';
export function LetterView({letter,actor}:{letter:ProbationLetterView;actor:{id:string;name:string}}){
 const t=useTranslations('probation'),s=useTranslations('documentSigning'),router=useRouter(),[busy,start]=useTransition(),[reason,setReason]=useState(''),[error,setError]=useState(''),document=letter.signing?.document;
 const step=document?pendingSigningSteps(document).find(step=>step.holderId===actor.id):undefined,complete=document?signingComplete(document,{requiredRoles:document.route.steps.filter(step=>step.required).map(step=>step.role)}):false;
 const actionable=!['locked','cancelled'].includes(letter.state),labels=Object.fromEntries(['title','method','typed','drawn','fullName','canvas','clear','consent','submit'].map(key=>[key,s(key)])) as SignatureInputLabels;
 const run=(work:()=>Promise<{ok:boolean;detail?:string}>)=>{setError('');start(async()=>{const result=await work();if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}router.refresh();});};
 return <main><header className="v9-heading"><div><h1>{letter.name}</h1><p>{t('version',{version:letter.templateVersion})} · {t('letters.frozen')}</p></div><Link className="v9-button" href={'/lifecycle/probation/'+letter.caseId}>{t('backCase')}</Link></header>
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}<section className="v9-panel"><DocumentBody document={letter.document}/></section>
  {document&&<section className="v9-panel v9-stack"><h2>{t('letters.signingHistory')}</h2><ol className="v9-list">{document.route.steps.map(step=>{const action=document.actions.find(a=>a.stepId===step.id&&a.contentRevision===document.contentRevision&&a.contentHash===document.contentHash&&a.action==='signed');return <li key={step.id}><strong>{t('roles.'+step.role)}</strong> · {action?action.actorName+' · '+onboardingTimestamp(action.at):step.holderId?t('letters.waiting'):t('letters.missingHolder')}</li>;})}</ol></section>}
  {actionable&&step&&<><SignatureInput name={actor.name} busy={busy} labels={labels} submit={signature=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:'signed',actionId:crypto.randomUUID(),...signature}))}/><section className="v9-panel v9-stack"><label className="v9-field"><span>{t('letters.returnReason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><button type="button" className="v9-button" disabled={busy||!reason.trim()} onClick={()=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:'returned',actionId:crypto.randomUUID(),comment:reason}))}>{t('letters.return')}</button></section></>}
  {actionable&&letter.canRelease&&complete&&letter.outcomeRevision!==null&&<section className="v9-panel v9-stack"><h2>{t('letters.release')}</h2><p>{t('letters.releaseHelp')}</p><label className="v9-field"><span>{t('reason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><button type="button" className="v9-button v9-button-primary" disabled={busy||!reason.trim()} onClick={()=>run(()=>releaseLetter({caseId:letter.caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason}))}>{t('letters.release')}</button></section>}
 </main>;
}
