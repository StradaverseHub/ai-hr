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
 * empty. The existing page stays one click away as the fallback and reopen destination. */
import Link from 'next/link';
import {useEffect,useId,useState} from 'react';
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
function LeaveChangeProposal({action,hints}:{action:'leave.cancel'|'leave.edit';hints:AssistantProposalHints}){
 const t=useTranslations('assistant.workspace.proposal');
 const choices=useOwnChoices<OwnLeaveChangeChoices>(async signal=>{
  const packet=(action===OWN_LEAVE_EDIT_ACTION?LeaveEditModuleActionBrowserPacket:LeaveCancellationModuleActionBrowserPacket).parse({action,operation:'choices'}) as LeaveChangeModuleActionBrowserPacket;
  const result=await readOwnLeaveChangeResponse(await post(packet,signal),packet);
  return result.kind==='choices'?result:{kind:'unavailable'};
 },{kind:'unavailable'});
 if(!choices)return <p role="status" className="text-sm">{t('loading')}</p>;
 return <OwnLeaveChangePanel choices={choices} prefill={{action,startDate:hints.startDate,newStartDate:hints.newStartDate,newEndDate:hints.newEndDate}}/>;
}
function ClaimCancellationProposal({hints}:{hints:AssistantProposalHints}){
 const t=useTranslations('assistant.workspace.proposal');
 const choices=useOwnChoices<OwnClaimCancellationChoices>(async signal=>{
  const packet=ClaimCancellationModuleActionBrowserPacket.parse({action:OWN_CLAIM_CANCELLATION_ACTION,operation:'choices'});
  const result=await readModuleClaimCancellationResponse(await post(packet,signal),packet);
  return result.kind==='choices'?result:{kind:'unavailable'};
 },{kind:'unavailable'});
 if(!choices)return <p role="status" className="text-sm">{t('loading')}</p>;
 return <ModuleClaimCancellationPanel choices={choices} prefill={{incurredOn:hints.incurredOn}}/>;
}
export function ConversationActionProposal({action,hints:raw}:{action:unknown;hints:unknown}){
 const t=useTranslations('assistant.workspace.proposal'),headingId=useId();
 // The server already adjudicated this proposal; the card still refuses anything outside the closed shape.
 let hints:AssistantProposalHints;try{hints=captureAssistantProposalHints(action,raw);}catch{return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>;}
 if(!isAssistantProposableAction(action))return <p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p>;
 const body=action==='leave.cancel'||action==='leave.edit'?<LeaveChangeProposal action={action} hints={hints}/>
  :action===OWN_CLAIM_CANCELLATION_ACTION?<ClaimCancellationProposal hints={hints}/>
  :action===OWN_OVERTIME_REQUEST_ACTION?<OwnOvertimeRequestPanel prefill={{date:hints.date??'',plannedStartTime:hints.plannedStartTime??'',plannedEndTime:hints.plannedEndTime??''}}/>
  :<AssignedDecisionPanel action={action} prefill={{}}/>;
 return <section aria-labelledby={headingId} className="space-y-3 rounded-lg border border-border p-4">
  <h2 id={headingId} className="text-base font-semibold">{t(TITLES[action])}</h2>
  <p className="text-xs text-muted-foreground">{t('note')}</p>
  {body}
  <Link href={ASSISTANT_PROPOSAL_FALLBACK[action]} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('openPage')}</Link>
 </section>;
}
