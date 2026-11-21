'use client';

import { useClientReady } from './use-client-ready';
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {PendingTaskItem} from '@/core/approvals-inbox';
import type {NotificationLifecyclePreview} from './notification-center';

export type ShellApprovalResult=
 | {state:'ready';items:PendingTaskItem[];total:number;approvalCount:number;claimTotal:number;
    lifecycleMyTasksCount?:number;hasAssignedAttendanceApproval:boolean;hasAssignedApproval:boolean}
 | {state:'unavailable'};
type ShellTaskPreview={approvals:ShellApprovalResult;lifecycle:NotificationLifecyclePreview|null};
type ShellApprovalFacts={result:ShellApprovalResult|{state:'pending'};canOpenApprovalsWithoutAssignment:boolean;
 lifecycle?:NotificationLifecyclePreview;requestPreview:()=>void};
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

function useRemotePreview(revision:string|undefined){
 const [resolved,setResolved]=useState<{revision:string;value:ShellTaskPreview}>();
 const loader=useRef<{revision:string;start:()=>void}|undefined>(undefined);
 useEffect(()=>{
  if(!revision)return;
  const controller=new AbortController();
  let started=false;
  const start=()=>{
   if(started||controller.signal.aborted)return;
   started=true;
   void fetch('/api/notifications/shell-tasks',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
    .then(response=>{
     if(!response.ok)throw new Error('Shell tasks unavailable');
     return response.json() as Promise<ShellTaskPreview>;
    }).then(value=>{
     if(!controller.signal.aborted)setResolved({revision,value});
    }).catch(()=>{
     if(!controller.signal.aborted)setResolved({revision,value:{approvals:{state:'unavailable'},lifecycle:null}});
    });
  };
  loader.current={revision,start};
  if(document.readyState==='complete')start();
  else window.addEventListener('load',start,{once:true});
  return ()=>{
   window.removeEventListener('load',start);
   controller.abort();
   loader.current=undefined;
  };
 },[revision]);
 return {
  value:resolved?.revision===revision?resolved?.value:undefined,
  requestPreview:()=>{if(loader.current?.revision===revision)loader.current?.start();},
 };
}

type PreviewSource={source:Promise<ShellApprovalResult>;requestRevision?:never}
 | {source?:never;requestRevision:string};

export function ShellApprovalFactsProvider({source,requestRevision,canOpenApprovalsWithoutAssignment,children}:PreviewSource&{
 canOpenApprovalsWithoutAssignment:boolean;children:ReactNode;
}){
 const streamed=useShellStreamValue(source);
 const remote=useRemotePreview(requestRevision);
 const result=remote.value?.approvals??(streamed?.state==='ready'?streamed.value:streamed??pendingResult);
 return <Context.Provider value={{result,canOpenApprovalsWithoutAssignment,
  lifecycle:remote.value?.lifecycle??undefined,requestPreview:remote.requestPreview}}>{children}</Context.Provider>;
}

// Each streamed consumer hydrates against the same pending snapshot as its server HTML.
// The provider may already have published by the time a delayed boundary hydrates.
// Client-only mounts read live facts immediately; source changes still invalidate in the provider.
const pendingResult={state:'pending' as const};
export function useShellApprovalFacts(){
 const facts=useContext(Context);
 const hydrated=useClientReady();
 return facts&&!hydrated?{...facts,result:pendingResult,lifecycle:undefined}:facts;
}
