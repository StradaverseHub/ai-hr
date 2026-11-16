'use client';
import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationLetterView} from '@/packs/probation/service';
import {currentRoundActions,pendingSigningSteps,signingComplete,signingSendBack,signingStepAction,type SigningStep} from '@/lib/document-signing-model';
import {DocumentBody} from '@/components/lifecycle-v9/document-body';
import {SignerControls} from './signer-controls';
import {SignatureInput,type SignatureInputLabels} from '@/components/lifecycle-v9/signature-input';
import {probationTimestamp} from '@/lib/probation-display';
import {signLetter,resendLetter,releaseLetter} from './actions';
export function LetterView({letter,actor,signerCandidates}:{letter:ProbationLetterView;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[]}){
 const t=useTranslations('probation'),s=useTranslations('documentSigning'),router=useRouter(),[busy,start]=useTransition(),[signerDirty,setSignerDirty]=useState(false),[reason,setReason]=useState(''),[error,setError]=useState(''),document=letter.signing?.document,route=letter.route??document?.route;
 const step=document&&route?pendingSigningSteps({...document,route}).find(step=>step.holderId===actor.id):undefined,complete=document?signingComplete(document,{requiredRoles:document.route.steps.filter(step=>step.required).map(step=>step.role)}):false;
 const actionable=letter.runtimeEnabled&&!['locked','cancelled','release_requested'].includes(letter.state),labels=Object.fromEntries(['title','method','typed','drawn','fullName','canvas','clear','consent','submit'].map(key=>[key,s(key)])) as SignatureInputLabels;
 // Routed letters (template versions with signing and review routing): steps are named by their action, Review and
 // Approve are decisions without a signature, and after a send-back only the owner sends it round again.
 const stepLabel=(step:SigningStep)=>letter.routed?t('letters.routedStep.'+step.kind)+(step.meantFor?' · '+t('letters.meantFor',{who:step.meantFor}):''):t('roles.'+step.role);
 const sendBack=document&&letter.routed?signingSendBack(document):null,decision=document&&step&&letter.routed?signingStepAction(document,step):'signed';
 const run=(work:()=>Promise<{ok:boolean;detail?:string}>)=>{setError('');start(async()=>{const result=await work();if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}router.refresh();});};
 const returnSection=step?<section className="v9-panel v9-stack"><label className="v9-field"><span>{t('letters.returnReason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||signerDirty||!reason.trim()} onClick={()=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:'returned',actionId:crypto.randomUUID(),comment:reason}))}>{t('letters.return')}</ActionButton></section>:null;
 return <main><header className="v9-heading"><div><h1>{letter.name}</h1><p>{t('version',{version:letter.templateVersion})} · {t('letters.frozen')}</p></div><Link className="v9-button" href={'/lifecycle/probation/'+letter.caseId}>{t('backCase')}</Link></header>
  {!letter.runtimeEnabled&&<p className="v9-notice">{t(letter.sourceMoved?'sourceMoved':'runtimePaused')}</p>}
  {letter.runtimeEnabled&&letter.state==='release_requested'&&<p className="v9-notice" role="status">{t('letters.filingPending')}</p>}
  {error&&<p className="v9-notice v9-error" role="alert">{error}</p>}
  {letter.unresolved.length>0&&<div className="v9-notice" role="status"><p>{t('letters.routingFallback')}</p><ul>{letter.unresolved.map(u=><li key={u.stepId}>{u.meantFor}: {u.reason}</li>)}</ul></div>}
  {letter.contentVisible?<section className="v9-panel"><DocumentBody document={letter.document}/></section>:<p className="v9-notice" role="status">{t('letters.contentPrivate')}</p>}
  {actionable&&sendBack&&<section className="v9-panel v9-stack"><p role="status">{t('letters.sentBack',{name:sendBack.actorName,reason:sendBack.comment})}</p>{letter.owner?.userId===actor.id&&<ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>run(()=>resendLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,actionId:crypto.randomUUID()}))}>{t('letters.resend')}</ActionButton>}</section>}
  {document&&<section className="v9-panel v9-stack"><h2>{t('letters.signingHistory')}</h2><ol className="v9-list">{(route??document.route).steps.map(step=>{const action=letter.routed?currentRoundActions(document).find(a=>a.stepId===step.id&&['signed','reviewed','approved'].includes(a.action)):document.actions.find(a=>a.stepId===step.id&&a.contentRevision===document.contentRevision&&a.contentHash===document.contentHash&&a.action==='signed');return <li key={step.id}><strong>{stepLabel(step)}</strong> · {action?action.actorName+' · '+probationTimestamp(action.at):step.holderId?t('letters.waiting'):t('letters.missingHolder')}</li>;})}</ol></section>}
  {actionable&&step&&decision!=='signed'&&<section className="v9-panel v9-stack"><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy||signerDirty} onClick={()=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:decision,actionId:crypto.randomUUID()}))}>{t('letters.decision.'+decision)}</ActionButton></section>}
  {actionable&&step&&decision!=='signed'&&returnSection}
  {actionable&&step&&decision==='signed'&&<><SignatureInput resetDrawnOnMethodChange name={actor.name} busy={busy||signerDirty} labels={labels} submit={signature=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:'signed',actionId:crypto.randomUUID(),...signature}))}/>{returnSection}</>}
  {actionable&&letter.canRelease&&complete&&letter.outcomeRevision!==null&&<section className="v9-panel v9-stack"><h2>{t('letters.release')}</h2><p>{t('letters.releaseHelp')}</p><label className="v9-field"><span>{t('reason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy||signerDirty||!reason.trim()} onClick={()=>run(()=>releaseLetter({caseId:letter.caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason}))}>{t('letters.release')}</ActionButton></section>}
  {actionable&&letter.canPrepare&&signerCandidates&&document&&<SignerControls blocked={busy} partId={letter.id} revision={letter.storageRevision} route={route??document.route} signing={document} candidates={signerCandidates} onDirtyChange={setSignerDirty}/>}
 </main>;
}
