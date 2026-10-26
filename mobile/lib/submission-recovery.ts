import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { apiGet,apiPost } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { identityNamespace } from './config';
import { SessionChangedError } from './errors';
import { openNativeSubmissionJournal } from './submission-native';
import { SubmissionJournalUnavailable, type EvidenceFile, type JournalEntry, type SubmissionKind } from './submission-journal';
import {ClockPreparation} from '../../lib/clock-attempt';

type Journal=Awaited<ReturnType<typeof openNativeSubmissionJournal>>;
type Restored={entry:JournalEntry;command:string;file?:EvidenceFile};
let activeGeneration=-1;
let activeNamespace='';
let identity:ReturnType<typeof apiGet<'me'>>|null=null;
const journals=new Map<string,Promise<Journal>>();
export type PendingSubmissionSummary={employmentId:string;company:string;kind:SubmissionKind;requestId:string;createdAt:number;hasEvidence:boolean;stage?:'preparation'};
/** Fresh identity verification; returns no coordinates, reasons, attachments or temporary file paths. */
export async function listOwnedPendingSubmissions():Promise<PendingSubmissionSummary[]>{
  const owner=authGeneration(),namespace=identityNamespace();
  const previous=activeGeneration===owner&&activeNamespace===namespace&&identity?await identity:null;
  assertAuthGeneration(owner);
  const me=await apiGet('me');assertAuthGeneration(owner);
  if(identityNamespace()!==namespace||!me.actorId||previous?.actorId&&previous.actorId!==me.actorId)throw new SessionChangedError();
  if(activeGeneration!==owner||activeNamespace!==namespace){journals.clear();activeGeneration=owner;activeNamespace=namespace;}
  identity=Promise.resolve(me);
  const items:PendingSubmissionSummary[]=[];
  for(const employment of me.employments){
    const journal=await ownedJournal(employment.employmentId,owner);assertAuthGeneration(owner);
    for(const entry of await journal.pending())items.push({employmentId:employment.employmentId,company:employment.company,
      kind:entry.kind,requestId:entry.requestId,createdAt:entry.createdAt,hasEvidence:!!entry.evidence,...(entry.stage?{stage:entry.stage}:{})});
    assertAuthGeneration(owner);
  }
  return items;
}
/** Only an accepted receipt or server-ordered abandonment authorizes local cleanup. */
export async function reconcileOwnedPendingSubmission(item:PendingSubmissionSummary,action:'receipt'|'abandon'){
  const owner=authGeneration(),namespace=identityNamespace();
  const check=()=>{assertAuthGeneration(owner);if(identityNamespace()!==namespace)throw new SessionChangedError();};
  if(AppState.currentState!=='active')throw new SubmissionJournalUnavailable('Unlock the app to continue');
  const journal=await ownedJournal(item.employmentId,owner);check();
  if(!(await journal.pending()).some(entry=>entry.kind===item.kind&&entry.requestId===item.requestId))throw new SubmissionJournalUnavailable('Pending submission changed');
  check();
  const result=action==='abandon'?await apiPost('submission-abandon',{kind:item.kind,requestId:item.requestId},{employmentId:item.employmentId}):
    await apiGet('submission-receipt',{kind:item.kind,requestId:item.requestId,employmentId:item.employmentId});
  check();
  if(result.kind!==item.kind||result.requestId!==item.requestId)throw new SubmissionJournalUnavailable('Unexpected submission receipt');
  if(result.receipt||result.abandoned){await journal.resolve(item.kind,item.requestId);check();}
  return result;
}
async function ownedJournal(employmentId:string,owner:number){
  assertAuthGeneration(owner);
  const namespace=identityNamespace();
  if(activeGeneration!==owner||activeNamespace!==namespace){activeGeneration=owner;activeNamespace=namespace;identity=null;journals.clear();}
  if(!identity)identity=apiGet('me').catch(error=>{if(activeGeneration===owner&&activeNamespace===namespace)identity=null;throw error;});
  const me=await identity;assertAuthGeneration(owner);
  if(!me.actorId||!me.employments.some(e=>e.employmentId===employmentId))throw new SubmissionJournalUnavailable('Submission ownership cannot be verified');
  const scope={namespace,actorId:me.actorId,employmentId},key=JSON.stringify(scope);
  const check=()=>{assertAuthGeneration(owner);if(identityNamespace()!==namespace)throw new SessionChangedError();};
  let journal=journals.get(key);
  if(!journal){journal=openNativeSubmissionJournal(scope,check).catch(error=>{if(journals.get(key)===journal)journals.delete(key);throw error;});journals.set(key,journal);}
  const opened=await journal;check();return opened;
}

/** No automatic replay. Hydration exposes an uncertain claim, then the user checks its receipt. */
export function useSubmissionRecovery(kind:SubmissionKind,employmentId:string|undefined,onRestore:(value:Restored)=>void){
  const owner=authGeneration(),namespace=identityNamespace(),key=JSON.stringify([owner,namespace,employmentId,kind]);
  const current=useRef(key);current.current=key;
  const restore=useRef(onRestore);restore.current=onRestore;
  const [attempt,setAttempt]=useState(0);
  const [state,setState]=useState<{key:string;ready:boolean;error:unknown}>({key,ready:false,error:null});
  function check(){assertAuthGeneration(owner);if(current.current!==key||identityNamespace()!==namespace)throw new SessionChangedError();}
  useEffect(()=>{
    let disposed=false;
    current.current=key;
    setState({key,ready:false,error:null});
    if(employmentId)void (async()=>{
      const journal=await ownedJournal(employmentId,owner);check();
      const entry=(await journal.pending()).find(e=>e.kind===kind);check();
      if(entry){const restored=await journal.restore(entry);check();if(!disposed)restore.current({entry,...restored});}
      if(!disposed)setState({key,ready:true,error:null});
    })().catch(error=>{if(!disposed&&current.current===key)setState({key,ready:false,error});});
    return ()=>{disposed=true;if(current.current===key)current.current='';};
  },[key,attempt]);
  return {
    ready:state.key===key&&state.ready,
    error:state.key===key?state.error:null,
    reload:()=>setAttempt(value=>value+1),
    async prepareClock(action:'in'|'out',requestId:string){
      check();if(kind!=='clock'||!employmentId||state.key!==key||!state.ready||AppState.currentState!=='active')throw new SubmissionJournalUnavailable('Pending submissions have not been checked');
      const journal=await ownedJournal(employmentId,owner);check();
      const entry=await journal.prepareClock(action,requestId);check();
      if(AppState.currentState!=='active')throw new SubmissionJournalUnavailable('Unlock the app to continue');
      return entry;
    },
    async reportAttempt(requestId:string){
      check();if(kind!=='clock'||!employmentId||state.key!==key||!state.ready||AppState.currentState!=='active')throw new SubmissionJournalUnavailable('Unlock the app to continue');
      const journal=await ownedJournal(employmentId,owner);check();
      const entry=(await journal.pending()).find(value=>value.kind==='clock'&&value.requestId===requestId);check();
      if(entry?.stage!=='preparation')throw new SubmissionJournalUnavailable('Pending attempt changed');
      const restored=await journal.restore(entry);check();
      const receipt=await apiPost('clock-attempts',ClockPreparation.parse(JSON.parse(restored.command)),{employmentId});check();
      if(receipt.requestId!==requestId)throw new SubmissionJournalUnavailable('Unexpected attempt receipt');
      await journal.markAttemptReported(requestId,receipt);check();return receipt;
    },
    async stage(command:string,file?:EvidenceFile){
      check();if(!employmentId||state.key!==key||!state.ready)throw new SubmissionJournalUnavailable('Pending submissions have not been checked');
      const journal=await ownedJournal(employmentId,owner);check();
      const entry=await journal.stage(kind,command,file);check();
      const restored=await journal.restore(entry);check();
      // Encryption may finish after an OS picker, lock or background transition.
      if(AppState.currentState!=='active')throw new SubmissionJournalUnavailable('Unlock the app to continue');
      return restored;
    },
    async resolve(requestId:string){
      check();if(!employmentId)throw new SubmissionJournalUnavailable('Submission employment is unavailable');
      const journal=await ownedJournal(employmentId,owner);check();await journal.resolve(kind,requestId);check();
    },
  };
}
