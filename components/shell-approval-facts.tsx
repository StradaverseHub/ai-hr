'use client';

import {createContext,useContext,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {PendingTaskItem} from '@/core/approvals-inbox';

export type ShellApprovalResult=
 | {state:'ready';items:PendingTaskItem[];total:number;approvalCount:number;claimTotal:number;
    lifecycleMyTasksCount?:number;hasAssignedAttendanceApproval:boolean;hasAssignedApproval:boolean}
 | {state:'unavailable'};
type ShellApprovalFacts={result:ShellApprovalResult|{state:'pending'};canOpenApprovalsWithoutAssignment:boolean};
const Context=createContext<ShellApprovalFacts|undefined>(undefined);

type ShellStreamResult<T>={state:'ready';value:T}|{state:'unavailable'};

export function useShellStreamValue<T>(source:Promise<T>|undefined){
 const [resolved,setResolved]=useState<{source:Promise<T>;result:ShellStreamResult<T>}>();
 useEffect(()=>{
  if(!source)return;
  let current=true;
  const publish=(result:ShellStreamResult<T>)=>{
   if(current)setResolved({source,result});
  };
  void source.then(value=>publish({state:'ready',value}),()=>publish({state:'unavailable'}));
  return ()=>{current=false;};
 },[source]);
 // A new render cannot display data from the previous scope while its replacement is pending.
 return resolved?.source===source?resolved?.result:undefined;
}

/** Flight streams the promise separately. No reader suspends the interactive shell. */
export function ShellApprovalFactsProvider({source,canOpenApprovalsWithoutAssignment,children}:{
 source:Promise<ShellApprovalResult>;canOpenApprovalsWithoutAssignment:boolean;children:ReactNode;
}){
 const streamed=useShellStreamValue(source);
 const result=streamed?.state==='ready'?streamed.value:streamed??pendingResult;
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
