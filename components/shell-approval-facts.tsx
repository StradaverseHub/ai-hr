'use client';

import {createContext,Suspense,use,useContext,useEffect,useState,type ReactNode} from 'react';
import type {PendingTaskItem} from '@/core/approvals-inbox';

export type ShellApprovalResult=
 | {state:'ready';items:PendingTaskItem[];total:number;approvalCount:number;claimTotal:number;
    hasAssignedAttendanceApproval:boolean;hasAssignedApproval:boolean}
 | {state:'unavailable'};
type ShellApprovalFacts={result:ShellApprovalResult|{state:'pending'};canOpenApprovalsWithoutAssignment:boolean};
const Context=createContext<ShellApprovalFacts|undefined>(undefined);

function ResolveApprovalFacts({source,publish}:{
 source:Promise<ShellApprovalResult>;
 publish:(resolved:{source:Promise<ShellApprovalResult>;result:ShellApprovalResult})=>void;
}){
 const result=use(source);
 useEffect(()=>publish({source,result}),[source,result,publish]);
 return null;
}

/** Only this leaf suspends. The rail, header and page remain interactive while facts stream. */
export function ShellApprovalFactsProvider({source,canOpenApprovalsWithoutAssignment,children}:{
 source:Promise<ShellApprovalResult>;canOpenApprovalsWithoutAssignment:boolean;children:ReactNode;
}){
 const [resolved,setResolved]=useState<{source:Promise<ShellApprovalResult>;result:ShellApprovalResult}>();
 // A new layout render (including scope, principal and explicit refresh changes) cannot paint
 // the previous result while the replacement is pending, even before any effect runs.
 const result=resolved?.source===source?resolved.result:{state:'pending' as const};
 return <Context.Provider value={{result,canOpenApprovalsWithoutAssignment}}>
  {children}
  <Suspense fallback={null}><ResolveApprovalFacts source={source} publish={setResolved}/></Suspense>
 </Context.Provider>;
}

export function useShellApprovalFacts(){return useContext(Context);}
