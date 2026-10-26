import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { apiGet } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { identityNamespace } from './config';
import { SessionChangedError } from './errors';
import { openNativeSubmissionJournal } from './submission-native';
import { SubmissionJournalUnavailable, type EvidenceFile, type JournalEntry, type SubmissionKind } from './submission-journal';

type Journal=Awaited<ReturnType<typeof openNativeSubmissionJournal>>;
type Restored={entry:JournalEntry;command:string;file?:EvidenceFile};
let activeGeneration=-1;
let activeNamespace='';
let identity:ReturnType<typeof apiGet<'me'>>|null=null;
const journals=new Map<string,Promise<Journal>>();
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
  const owner=authGeneration(),key=JSON.stringify([owner,employmentId,kind]);
  const current=useRef(key);current.current=key;
  const restore=useRef(onRestore);restore.current=onRestore;
  const [attempt,setAttempt]=useState(0);
  const [state,setState]=useState<{key:string;ready:boolean;error:unknown}>({key,ready:false,error:null});
  function check(){assertAuthGeneration(owner);if(current.current!==key)throw new SessionChangedError();}
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
