'use client';
/** ADR-0151 §4.3 inline review card. A chat answer may PROPOSE one declared action with typed hints; this
 * card shows it inside the exchange using the existing review panels. Nothing was prepared during the model
 * turn and nothing is prepared here until the person presses the panel's own prepare button, which sends
 * the person's own values as a separate same-origin POST through the existing prepared-action store. The
 * review shown afterwards is the server's canonical prepared content, never model text; confirmation is the
 * existing digest-bound command, and a lost response reopens the same action id rather than confirming again.
 *
 * Hints never carry IDs: each panel resolves them against the caller's own fresh choices from the guarded
 * endpoint, so only the caller's own (or own-inbox) items can ever appear, and one match is preselected
 * while zero or several ask the person to pick. Every human field (reason, remark, note, decision) starts
 * empty. The existing page stays one click away as the fallback and reopen destination.
 *
 * Card states (review R6). The card itself owns three: READY (the panel), STALE (the sealed suggestion is no
 * longer in the caller's current registry-derived catalogue: refused, with a refresh and the usual page; no
 * choices are read), UNVERIFIED (the catalogue could not be checked just now: neutral copy and a retry, still
 * nothing preparable) and FAILURE (the card's own choices read failed: a plain reason and a retry, which is
 * safe because it is a read). The panels own the review lifecycle: confirming (busy), confirmed (receipt),
 * discarded/expired/refused (retired) and a lost or refused confirmation (reopen the same action id, never
 * confirm again). Mobile: content stacks and every action is full width. */
import Link from 'next/link';
import {useCallback,useEffect,useId,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Button} from '@/components/ui';
import {useTranslations} from 'next-intl';
import {ASSISTANT_PROPOSAL_FALLBACK,captureAssistantProposalHints,isAssistantProposableAction,type AssistantProposableAction,type AssistantProposalHints} from '@/lib/ai/assistant-action-proposal-hints';
import {OWN_LEAVE_EDIT_ACTION,type OwnLeaveChangeChoices} from '@/lib/assistant-actions/own-leave-change-contract';
import {OWN_CLAIM_CANCELLATION_ACTION,type OwnClaimCancellationChoices} from '@/lib/assistant-actions/own-claim-cancellation-contract';
import {OWN_OVERTIME_REQUEST_ACTION} from '@/lib/assistant-actions/own-overtime-request-contract';
import {LeaveCancellationModuleActionBrowserPacket,LeaveEditModuleActionBrowserPacket,ClaimCancellationModuleActionBrowserPacket,type LeaveChangeModuleActionBrowserPacket} from '@/lib/assistant-actions/module-action-http';
import {OwnLeaveChangePanel,readOwnLeaveChangeResponse} from './own-leave-change-panel';
import {ModuleClaimCancellationPanel,readModuleClaimCancellationResponse} from './module-claim-cancellation-panel';
import {OwnOvertimeRequestPanel} from './own-overtime-request-panel';
import {AssignedDecisionPanel} from './assigned-decision-panel';
const TITLES={'leave.cancel':'titleLeaveCancel','leave.edit':'titleLeaveEdit','claims.cancel':'titleClaimCancel','attendance.overtime.request':'titleOvertime',
 'approvals.claim.decide':'titleClaimDecision','approvals.attendance.decide':'titleAttendanceDecision','approvals.toil.decide':'titleToilDecision'} as const satisfies Record<AssistantProposableAction,string>;
/** The same guarded POST the panels use. One choices read per card mount; never retried. */
async function post(packet:unknown,signal:AbortSignal){return fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});}
function useOwnChoices<T>(load:(signal:AbortSignal)=>Promise<T>,unavailable:T):T|null{
 const [choices,setChoices]=useState<T|null>(null);
 useEffect(()=>{const controller=new AbortController();let live=true;
  load(controller.signal).then(value=>{if(live)setChoices(value);},()=>{if(live)setChoices(unavailable);});
  return()=>{live=false;controller.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 return choices;
}
/** FAILURE: the card's own choices read failed. Retrying is safe: it is a read and prepares nothing. */
function ProposalFailure({onRetry}:{onRetry:()=>void}){
 const t=useTranslations('assistant.workspace.proposal');
 return <div className="space-y-3" data-card-state="failure">
  <p role="alert" className="text-sm">{t('failureBody')}</p>
  <Button type="button" variant="outline" onClick={onRetry}>{t('retry')}</Button>
 </div>;
}
function LeaveChangeProposal({action,hints,onRetry,onSettled}:{action:'leave.cancel'|'leave.edit';hints:AssistantProposalHints;onRetry:()=>void;onSettled:(settled:boolean)=>void}){
 const t=useTranslations('assistant.workspace.proposal');
 const choices=useOwnChoices<OwnLeaveChangeChoices>(async signal=>{
  const packet=(action===OWN_LEAVE_EDIT_ACTION?LeaveEditModuleActionBrowserPacket:LeaveCancellationModuleActionBrowserPacket).parse({action,operation:'choices'}) as LeaveChangeModuleActionBrowserPacket;
  const result=await readOwnLeaveChangeResponse(await post(packet,signal),packet);
  return result.kind==='choices'?result:{kind:'unavailable'};
 },{kind:'unavailable'});
 if(!choices)return <p role="status" className="text-sm">{t('loading')}</p>;
 if(choices.kind==='unavailable')return <ProposalFailure onRetry={onRetry}/>;
 return <OwnLeaveChangePanel choices={choices} prefill={{action,startDate:hints.startDate,newStartDate:hints.newStartDate,newEndDate:hints.newEndDate}} onSettled={onSettled}/>;
}
function ClaimCancellationProposal({hints,onRetry,onSettled}:{hints:AssistantProposalHints;onRetry:()=>void;onSettled:(settled:boolean)=>void}){
 const t=useTranslations('assistant.workspace.proposal');
 const choices=useOwnChoices<OwnClaimCancellationChoices>(async signal=>{
  const packet=ClaimCancellationModuleActionBrowserPacket.parse({action:OWN_CLAIM_CANCELLATION_ACTION,operation:'choices'});
  const result=await readModuleClaimCancellationResponse(await post(packet,signal),packet);
  return result.kind==='choices'?result:{kind:'unavailable'};
 },{kind:'unavailable'});
 if(!choices)return <p role="status" className="text-sm">{t('loading')}</p>;
 if(choices.kind==='unavailable')return <ProposalFailure onRetry={onRetry}/>;
 return <ModuleClaimCancellationPanel choices={choices} prefill={{incurredOn:hints.incurredOn}} onSettled={onSettled}/>;
}
/** STALE (no longer offered) or UNVERIFIED (could not be checked just now). Both fail closed: nothing is read or
 * prepared here. A refresh re-runs the server's adjudication against the caller's current catalogue. */
function ProposalNotCurrent({availability}:{availability:'stale'|'unverified'}){
 const t=useTranslations('assistant.workspace.proposal'),router=useRouter();
 return <div className="space-y-3" data-card-state={availability}>
  <p role="status" className="text-sm">{t(availability==='stale'?'staleBody':'unverifiedBody')}</p>
  <Button type="button" variant={availability==='stale'?'default':'outline'} onClick={()=>router.refresh()}>{t(availability==='stale'?'refresh':'retry')}</Button>
 </div>;
}
const LINK='inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
export type ProposalAvailability='current'|'stale'|'unverified';
export function ConversationActionProposal({action,hints:raw,availability='current'}:{action:unknown;hints:unknown;availability?:ProposalAvailability}){
 const t=useTranslations('assistant.workspace.proposal'),headingId=useId(),[attempt,setAttempt]=useState(0),[settled,setSettled]=useState(false);
 const onSettled=useCallback((value:boolean)=>setSettled(value),[]);
 // The server already adjudicated this proposal; the card still refuses anything outside the closed shape.
 let hints:AssistantProposalHints;try{hints=captureAssistantProposalHints(action,raw);}catch{return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>;}
 if(!isAssistantProposableAction(action)||(availability!=='current'&&availability!=='stale'&&availability!=='unverified'))return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>;
 // A retry remounts the body, so the panel starts again from a fresh choices read with empty human fields.
 const retry=()=>setAttempt(value=>value+1),current=availability==='current';
 const body=availability!=='current'?<ProposalNotCurrent availability={availability}/>
  :action==='leave.cancel'||action==='leave.edit'?<LeaveChangeProposal key={attempt} action={action} hints={hints} onRetry={retry} onSettled={onSettled}/>
  :action===OWN_CLAIM_CANCELLATION_ACTION?<ClaimCancellationProposal key={attempt} hints={hints} onRetry={retry} onSettled={onSettled}/>
  :action===OWN_OVERTIME_REQUEST_ACTION?<OwnOvertimeRequestPanel prefill={{date:hints.date??'',plannedStartTime:hints.plannedStartTime??'',plannedEndTime:hints.plannedEndTime??''}} onSettled={onSettled}/>
  :<AssignedDecisionPanel action={action} prefill={{}} onSettled={onSettled}/>;
 // Once the person confirmed or discarded, it is no longer a suggestion: the badge and the "nothing prepared" note go.
 const badge=!current?(availability==='stale'?'badgeStale':'badgeUnverified'):settled?null:'badgeReady';
 const note=!current?'staleNote':settled?null:'note';
 // Mobile: everything stacks in one column and every action is full width; desktop keeps the panels' rows.
 return <section aria-labelledby={headingId} data-card-state={current?(settled?'settled':'ready'):availability} className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4 max-sm:[&_.flex-wrap]:flex-col max-sm:[&_.flex-wrap]:items-stretch max-sm:[&_button]:w-full">
  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
   <h2 id={headingId} className="text-base font-semibold">{t(TITLES[action])}</h2>
   {badge&&<span className={`w-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${current?'bg-primary/10 text-primary':'bg-muted text-muted-foreground'}`}>{t(badge)}</span>}
  </div>
  {note&&<p className="text-xs text-muted-foreground">{t(note)}</p>}
  {body}
  <Link href={ASSISTANT_PROPOSAL_FALLBACK[action]} className={`${LINK} max-sm:w-full`}>{t('openPage')}</Link>
 </section>;
}
