'use client';

import {createContext,useCallback,useContext,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {PendingTaskItem} from '@/core/approvals-inbox';

export type ShellApprovalResult=
 | {state:'ready';items:PendingTaskItem[];total:number;approvalCount:number;claimTotal:number;
    /** The lifecycle module inbox's My tasks count, added to the rail's My tasks badge only (ADR 0181 package 1.3). */
    lifecycleTaskCount?:number;
    hasAssignedAttendanceApproval:boolean;hasAssignedApproval:boolean}
 | {state:'unavailable'};
type ShellApprovalFacts={result:ShellApprovalResult|{state:'pending'};canOpenApprovalsWithoutAssignment:boolean;
 /** Re-read the facts after a save that kept the app frame (ADR 0181 decision 4). Never rejects. */
 refresh:()=>Promise<void>};
const Context=createContext<ShellApprovalFacts|undefined>(undefined);

/** Flight streams the promise separately. No reader suspends the interactive shell. */
export function ShellApprovalFactsProvider({source,canOpenApprovalsWithoutAssignment,refreshAction,children}:{
 source:Promise<ShellApprovalResult>;canOpenApprovalsWithoutAssignment:boolean;
 /** The server action that re-reads the facts (app/shell-facts-actions.ts), passed by the layout. */
 refreshAction?:()=>Promise<ShellApprovalResult>;children:ReactNode;
}){
 const [resolved,setResolved]=useState<{source:Promise<ShellApprovalResult>;result:ShellApprovalResult}>();
 useEffect(()=>{
  let current=true;
  const publish=(result:ShellApprovalResult)=>{
   if(current)setResolved({source,result});
  };
  void source.then(publish,()=>publish({state:'unavailable'}));
  return ()=>{current=false;};
 },[source]);
 // A save that keeps the app frame re-reads the facts through the same owner as the layout. The re-read belongs to
 // the layout render it was asked under: a new render (scope, principal, full refresh) supersedes it.
 const [refreshed,setRefreshed]=useState<{source:Promise<ShellApprovalResult>;result:ShellApprovalResult}>();
 const refresh=useCallback(async()=>{
  if(!refreshAction)return;
  try{
   const result=await refreshAction();
   setRefreshed({source,result});
  }catch(error){
   // Keep the facts already shown; the next layout render reads them again.
   console.error('Shell approval facts refresh failed',error);
  }
 },[source,refreshAction]);
 // A new layout render (including scope, principal and explicit refresh changes) cannot paint
 // the previous result while the replacement is pending, even before any effect runs.
 const result=refreshed?.source===source?refreshed.result:resolved?.source===source?resolved.result:{state:'pending' as const};
 return <Context.Provider value={{result,canOpenApprovalsWithoutAssignment,refresh}}>{children}</Context.Provider>;
}

// Each streamed consumer hydrates against the same pending snapshot as its server HTML.
// The provider may already have published by the time a delayed boundary hydrates.
// Client-only mounts read live facts immediately; source changes still invalidate in the provider.
const subscribeHydration=()=>()=>{};
const clientSnapshot=()=>true;
const serverSnapshot=()=>false;
const pendingResult={state:'pending' as const};
export function useShellApprovalFacts(){
 const facts=useContext(Context);
 const hydrated=useSyncExternalStore(subscribeHydration,clientSnapshot,serverSnapshot);
 return facts&&!hydrated?{...facts,result:pendingResult}:facts;
}
