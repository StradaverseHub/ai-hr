'use client';

import {createContext,useContext,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {PendingTaskItem} from '@/core/approvals-inbox';

export type ShellApprovalResult=
 | {state:'ready';items:PendingTaskItem[];total:number;approvalCount:number;claimTotal:number;
    hasAssignedAttendanceApproval:boolean;hasAssignedApproval:boolean}
 | {state:'unavailable'};
type ShellApprovalFacts={result:ShellApprovalResult|{state:'pending'};canOpenApprovalsWithoutAssignment:boolean};
const Context=createContext<ShellApprovalFacts|undefined>(undefined);

/** Flight streams the promise separately. No reader suspends the interactive shell. */
export function ShellApprovalFactsProvider({source,canOpenApprovalsWithoutAssignment,children}:{
 source:Promise<ShellApprovalResult>;canOpenApprovalsWithoutAssignment:boolean;children:ReactNode;
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
 // A new layout render (including scope, principal and explicit refresh changes) cannot paint
 // the previous result while the replacement is pending, even before any effect runs.
 const result=resolved?.source===source?resolved.result:{state:'pending' as const};
 return <Context.Provider value={{result,canOpenApprovalsWithoutAssignment}}>{children}</Context.Provider>;
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
