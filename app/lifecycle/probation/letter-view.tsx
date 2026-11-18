'use client';
import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import type {ProbationLetterView} from '@/packs/probation/service';
import {currentRoundActions,pendingSigningSteps,signingComplete,signingSendBack,signingStepAction,type SigningStep} from '@/lib/document-signing-model';
import {PersonnelCompletionDocumentBody} from '@/components/lifecycle-v9/personnel-completion';
import {personnelCompletionIssues} from '@/lib/lifecycle-v9-personnel-completion';
import {DraftGuard} from './draft-guard';
import {SignerControls} from './signer-controls';
import {SignatureInput,type SignatureInputLabels} from '@/components/lifecycle-v9/signature-input';
import {probationTimestamp} from '@/lib/probation-display';
import {signLetter,resendLetter,releaseLetter,editLetterContent} from './actions';

/**
 * An outcome letter (lane M2; prototype OutcomeTab and LetterPaper): the letter card with its template, state pill and
 * signing routing, the letter on paper, then the signing panel and the release, send-back and signer actions. Used on the
 * letter's own page and, `embedded`, in the case's Outcome & letters tab. Every action is a server command that
 * re-checks the step, the holder and the frozen content; private content arrives already hidden from the server.
 */
export function LetterView({letter,actor,signerCandidates,embedded=false}:{letter:ProbationLetterView;actor:{id:string;name:string};signerCandidates?:{id:string;name:string}[];embedded?:boolean}){
 const t=useTranslations('probation'),s=useTranslations('documentSigning'),l=useTranslations('probation.caseView.letter'),f=useTranslations('probation.caseView.form'),router=useRouter(),[busy,start]=useTransition(),[signerDirty,setSignerDirty]=useState(false),[reason,setReason]=useState(''),[error,setError]=useState(''),document=letter.signing?.document,route=letter.route??document?.route;
 const [editing,setEditing]=useState(false),[edits,setEdits]=useState<Record<string,string>>({}),[fieldValues,setFieldValues]=useState(letter.document.values),[editReason,setEditReason]=useState('');
 const editDirty=Object.keys(edits).length>0||Object.entries(fieldValues).some(([key,value])=>value!==letter.document.values[key]);
 const completionIssues=letter.document.personnelCompletion?personnelCompletionIssues(letter.document,{final:true}):[];
 const pending=document&&route?pendingSigningSteps({...document,route}):[];
 const step=pending.find(step=>step.holderId===actor.id),complete=document?signingComplete(document,{requiredRoles:document.route.steps.filter(step=>step.required).map(step=>step.role)}):false;
 const actionable=letter.runtimeEnabled&&!['locked','cancelled','release_requested'].includes(letter.state),labels=Object.fromEntries(['title','method','typed','drawn','fullName','canvas','clear','consent','submit'].map(key=>[key,s(key)])) as SignatureInputLabels;
 // Routed letters (template versions with signing and review routing): steps are named by their action, Review and
 // Approve are decisions without a signature, and after a send-back only the owner sends it round again.
 const stepLabel=(step:SigningStep)=>letter.routed?t('letters.routedStep.'+step.kind)+(step.meantFor?' · '+t('letters.meantFor',{who:step.meantFor}):''):t('roles.'+step.role);
 // L4: a step not yet done names who holds it (the person, else the routing or group it went to), from the same
 // resolution the tracker's holder label uses; a delegate shows on whose behalf they act.
 const holder=(step:SigningStep)=>{const signer=letter.signers?.[step.id];if(!signer)return null;const who=signer.name??signer.label;if(!who)return null;return signer.representedName?t('letters.holderOnBehalf',{name:who,represented:signer.representedName}):who;};
 const sendBack=document&&letter.routed?signingSendBack(document):null,decision=document&&step&&letter.routed?signingStepAction(document,step):'signed';
 const run=(work:()=>Promise<{ok:boolean;detail?:string}>)=>{setError('');start(async()=>{const result=await work();if(!result.ok){setError(result.detail??t('errors.unavailable'));return;}router.refresh();});};
 // The state pill (prototype): released, filing, sent back, or who it waits for now.
 const waitingNames=pending.map(step=>holder(step)??stepLabel(step));
 const pill=letter.state==='locked'?{tone:'ok',text:l('state.released')}:letter.state==='release_requested'?{tone:'warn',text:l('state.filing')}:!letter.runtimeEnabled?{tone:'',text:l('state.paused')}
  :sendBack?{tone:'warn',text:l('state.sentBack')}:waitingNames.length?{tone:'warn',text:l('state.waitingFor',{names:waitingNames.join(l('and'))})}:complete?{tone:'info',text:l('state.ready')}:{tone:'warn',text:l('state.waiting')};
 const returnStep=document?.routing&&!sendBack?route?.steps.find(candidate=>candidate.holderId===actor.id):step;
 const returnSection=returnStep?<section className="pcc-card"><label className="pcc-field"><span>{t('letters.returnReason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button" disabled={busy||signerDirty||editDirty||!reason.trim()} onClick={()=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:returnStep.id,action:'returned',actionId:crypto.randomUUID(),comment:reason}))}>{t('letters.return')}</ActionButton></div></section>:null;
 const Root=embedded?'div':'main';
 return <Root className={embedded?'pcc-stack':'pcc'}><DraftGuard dirty={editDirty}/>
  {!embedded&&<Link className="pcc-back" href={'/lifecycle/probation/'+letter.caseId+'?tab=outcome'}><span aria-hidden="true">‹ </span>{t('backCase')}</Link>}
  {!letter.runtimeEnabled&&<p className="pcc-banner">{t(letter.sourceMoved?'sourceMoved':'runtimePaused')}</p>}
  {letter.runtimeEnabled&&letter.state==='release_requested'&&<p className="pcc-banner pcc-banner-info" role="status">{t('letters.filingPending')}</p>}
  {error&&<p className="pcc-banner pcc-banner-bad" role="alert">{error}</p>}
  <section className="pcc-card" aria-labelledby={'pcc-letter-'+letter.id}>
   <div className="pcc-row pcc-between"><div>{embedded?<h2 id={'pcc-letter-'+letter.id}>{letter.name}</h2>:<h1 id={'pcc-letter-'+letter.id} style={{fontSize:24,fontWeight:600}}>{letter.name}</h1>}<p className="pcc-sub">{l('sub',{version:letter.templateVersion})} · {t('letters.frozen')}</p></div>
    <span className={'pcc-pill'+(pill.tone?' pcc-pill-'+pill.tone:'')} data-testid="probation-letter-state">{pill.text}</span></div>
   {actionable&&sendBack&&<div className="pcc-banner pcc-banner-warn" role="status"><span>{t('letters.sentBack',{name:sendBack.actorName,reason:sendBack.comment})}</span>{letter.owner?.userId===actor.id&&<ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>run(()=>resendLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,actionId:crypto.randomUUID()}))}>{t('letters.resend')}</ActionButton>}</div>}
   {letter.unresolved.length>0&&<div className="pcc-banner pcc-banner-warn" role="status"><p>{t('letters.routingFallback')}</p><ul>{letter.unresolved.map(u=><li key={u.stepId}>{u.meantFor}: {u.reason}</li>)}</ul></div>}
   {document&&<section className="pcc-small pcc-muted" aria-labelledby={'pcc-routing-'+letter.id}><h3 id={'pcc-routing-'+letter.id} className="pcc-small" style={{fontWeight:600}}>{l('routing')}</h3><ol className="pcc-routing">{(route??document.route).steps.map(step=>{const action=letter.routed?currentRoundActions(document).find(a=>a.stepId===step.id&&['signed','reviewed','approved'].includes(a.action)):document.actions.find(a=>a.stepId===step.id&&a.contentRevision===document.contentRevision&&a.contentHash===document.contentHash&&a.action==='signed');return <li key={step.id}>{stepLabel(step)} · {action?action.actorName+' · '+probationTimestamp(action.at):step.holderId?(holder(step)?holder(step)+' · ':'')+t('letters.waiting'):t('letters.missingHolder')}</li>;})}</ol></section>}
   {letter.contentVisible?<div className="pcc-paper"><PersonnelCompletionDocumentBody document={letter.document} values={editing?fieldValues:letter.document.values} editableBy={editing?letter.editableFieldOwner:undefined} disabled={busy} change={(key,value)=>setFieldValues(current=>({...current,[key]:value}))}/></div>:<p className="pcc-wait" role="status">{t('letters.contentPrivate')}</p>}
  </section>
  {actionable&&letter.contentVisible&&letter.canEditContent&&<section className="pcc-card v9-stack"><button type="button" className="v9-button" disabled={busy} onClick={()=>setEditing(value=>!value)}>{t('letters.editContent')}</button>{editing&&<>
   {letter.blocks.filter(block=>['heading','subheading','text'].includes(block.type)).map(block=><label key={block.id} className="pcc-field"><span>{t('letters.wordingBlock',{id:block.id})}</span><textarea value={edits[block.id]??block.text} maxLength={20000} disabled={busy} onChange={event=>setEdits(current=>({...current,[block.id]:event.target.value}))}/></label>)}
   <label className="pcc-field"><span>{t('reason')}</span><textarea value={editReason} maxLength={5000} disabled={busy} onChange={event=>setEditReason(event.target.value)}/></label>
   <button type="button" className="v9-button v9-button-primary" disabled={busy||!editDirty||editReason.trim().length<3} onClick={()=>run(async()=>{const result=await editLetterContent({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,edits,values:Object.fromEntries(Object.entries(fieldValues).filter(([key,value])=>value!==letter.document.values[key])),reason:editReason});if(result.ok){setEditing(false);setEdits({});setEditReason('');}return result;})}>{t('letters.saveContent')}</button>
  </>}</section>}
  {actionable&&!step&&returnSection}
  {actionable&&step&&decision!=='signed'&&<section className="pcc-card"><div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy||signerDirty||editDirty} onClick={()=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:decision,actionId:crypto.randomUUID()}))}>{t('letters.decision.'+decision)}</ActionButton></div></section>}
  {actionable&&step&&decision!=='signed'&&returnSection}
  {actionable&&step&&decision==='signed'&&<><div className="pcc-sig"><div className="pcc-row pcc-between"><h3>{f('signHeading')}</h3></div><p className="pcc-small">{f('signWho',{name:actor.name,role:stepLabel(step)})}</p><p className="pcc-small pcc-muted">{f('signFingerprint')}</p>
   <SignatureInput resetDrawnOnMethodChange name={actor.name} busy={busy||signerDirty||editDirty||completionIssues.length>0} labels={labels} submit={signature=>run(()=>signLetter({caseId:letter.caseId,partId:letter.id,revision:letter.storageRevision,stepId:step.id,action:'signed',actionId:crypto.randomUUID(),...signature}))}/></div>{returnSection}</>}
  {actionable&&letter.canRelease&&complete&&letter.outcomeRevision!==null&&<section className="pcc-card"><h2>{t('letters.release')}</h2><p className="pcc-sub">{t('letters.releaseHelp')}</p><label className="pcc-field"><span>{t('reason')}</span><textarea value={reason} maxLength={5000} disabled={busy} onChange={e=>setReason(e.target.value)}/></label><div><ActionButton guardNavigation aria-busy={busy} type="button" className="v9-button v9-button-primary" disabled={busy||signerDirty||editDirty||!reason.trim()} onClick={()=>run(()=>releaseLetter({caseId:letter.caseId,partId:letter.id,outcomeRevision:letter.outcomeRevision!,reason}))}>{t('letters.release')}</ActionButton></div></section>}
  {actionable&&letter.canPrepare&&signerCandidates&&document&&<SignerControls blocked={busy} partId={letter.id} revision={letter.storageRevision} route={route??document.route} signing={document} candidates={signerCandidates} onDirtyChange={setSignerDirty}/>}
 </Root>;
}
