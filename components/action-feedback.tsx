'use client';

import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {isHandledActionRedirect} from '@/lib/action-feedback-result';
import {registerUnsavedGuard} from '@/lib/unsaved-changes';

export type ActionKind='processing'|'saving'|'updating'|'uploading'|'submitting'|'generating'|'deleting'|'loading';
type Labels=Record<ActionKind,string>&{leave:string;uncertain:string;failed:string;cancelled:string;success:string};
const fallback:Labels={processing:'Processing…',saving:'Saving…',updating:'Updating…',uploading:'Uploading…',submitting:'Submitting…',generating:'Generating…',deleting:'Deleting…',loading:'Loading data…',leave:'An action has not finished processing. Leave this page?',uncertain:'The result could not be confirmed. Check the current status before repeating the action.',failed:'The action failed. Your entered information has been kept where possible.',cancelled:'Action cancelled.',success:'Action completed.'};
type Pending={message:string;important:boolean};
const Context=createContext<{labels:Labels;register:(id:symbol,value:Pending|null)=>void}>({labels:fallback,register:()=>{}});

/** Only action owners register work here. Finishing pending work is never interpreted as success. */
export function ActionFeedbackProvider({children}:{children:ReactNode}) {
 const t=useTranslations('common.actionFeedback');
 const [actions,setActions]=useState(new Map<symbol,Pending>());
 const current=useRef(actions);current.current=actions;
 const labels=useMemo(()=>Object.fromEntries(Object.keys(fallback).map(key=>[key,t(key)])) as Labels,[t]);
 const labelRef=useRef(labels);labelRef.current=labels;
 const register=useCallback((id:symbol,value:Pending|null)=>setActions(previous=>{if(!value&&!previous.has(id))return previous;const next=new Map(previous);if(value)next.set(id,value);else next.delete(id);return next;}),[]);
 useEffect(()=>{
  const pending=()=>[...current.current.values()].some(action=>action.important);
  const before=(event:BeforeUnloadEvent)=>{if(pending()){event.preventDefault();event.returnValue='';}};
  const click=(event:MouseEvent)=>{
   if(!pending()||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   const link=(event.target as Element|null)?.closest?.('a[href]') as HTMLAnchorElement|null;
   if(!link||link.hasAttribute('download')||link.target==='_blank'||link.getAttribute('aria-disabled')==='true')return;
   const destination=new URL(link.href,location.href);
   if(destination.pathname===location.pathname&&destination.search===location.search)return;
   if(!window.confirm(labelRef.current.leave)){event.preventDefault();event.stopPropagation();}
  };
  const unregister=registerUnsavedGuard({isDirty:pending,prompt:proceed=>{if(!pending()||window.confirm(labelRef.current.leave))proceed();}});
  // React observes pending on the next render. Refuse a second submit synchronously in this event turn.
  const submitting=new WeakSet<HTMLFormElement>();
  const submit=(event:SubmitEvent)=>{
   if(event.defaultPrevented||!(event.target instanceof HTMLFormElement))return;
   const form=event.target,method=event.submitter?.getAttribute('formmethod')??form.getAttribute('method');
   if(method?.toLowerCase()==='get')return;
   if(submitting.has(form)||form.getAttribute('aria-busy')==='true'||event.submitter?.getAttribute('aria-busy')==='true'){
    event.preventDefault();event.stopPropagation();return;
   }
   submitting.add(form);queueMicrotask(()=>submitting.delete(form));
  };
  window.addEventListener('beforeunload',before);document.addEventListener('click',click,true);document.addEventListener('submit',submit,true);
  return()=>{unregister();window.removeEventListener('beforeunload',before);document.removeEventListener('click',click,true);document.removeEventListener('submit',submit,true);};
 },[]);
 const last=[...actions.values()].at(-1);
 const context=useMemo(()=>({labels,register}),[labels,register]);
 return <Context.Provider value={context}>{children}<div className="action-feedback-announcement" role="status" aria-live="polite" aria-atomic="true">{last?.message??''}</div></Context.Provider>;
}

export function useActionFeedbackLabels(){return useContext(Context).labels;}
export function usePendingAction(pending:boolean,message:string,important=true){
 const {register}=useContext(Context);const id=useRef(Symbol('pending-action'));
 useEffect(()=>{if(pending)register(id.current,{message,important});return()=>register(id.current,null);},[pending,message,important,register]);
}

export type ActionOutcome<T=void>={status:'success';value:T;message?:string}|{status:'failed'|'uncertain'|'cancelled';message?:string};
export type ActionFeedbackState={status:'idle'|'processing'|'success'|'failed'|'uncertain'|'cancelled';message:string;progress?:number};
/** Explicit async actions return their verified outcome. A rejection means unknown, never safe-to-repeat. */
export function useActionFeedback({kind='processing',important=true}:{kind?:ActionKind;important?:boolean}={}){
 const labels=useActionFeedbackLabels();const [state,setState]=useState<ActionFeedbackState>({status:'idle',message:''});
 const running=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 usePendingAction(state.status==='processing',state.message,important);
 const run=async<T,>(work:(report:(message:string,progress?:number)=>void)=>Promise<ActionOutcome<T>>):Promise<ActionOutcome<T>|undefined>=>{
  if(running.current)return;running.current=true;setState({status:'processing',message:labels[kind]});
  const report=(message:string,progress?:number)=>{if(mounted.current)setState({status:'processing',message,...(typeof progress==='number'&&Number.isFinite(progress)&&progress>=0&&progress<=100?{progress}: {})});};
  let outcome:ActionOutcome<T>;
  try{outcome=await work(report);}catch(error){
   if(isHandledActionRedirect(error)){if(mounted.current)setState({status:'idle',message:''});return;}
   outcome={status:'uncertain',message:labels.uncertain};
  }
  finally{running.current=false;}
  if(mounted.current)setState({status:outcome.status,message:outcome.message??labels[outcome.status]});
  return outcome;
 };
 return {state,run,pending:state.status==='processing',reset:()=>{if(!running.current)setState({status:'idle',message:''});}};
}
export function ActionFeedback({state}:{state:ActionFeedbackState}){
 if(state.status==='idle')return null;
 return <div className="action-feedback" data-action-state={state.status} role={state.status==='failed'||state.status==='uncertain'?'alert':'status'} aria-live="polite" aria-atomic="true">
  {state.status==='processing'&&<span className="action-spinner" aria-hidden="true"/>}<span>{state.message}</span>
  {state.status==='processing'&&state.progress!==undefined&&<progress max={100} value={state.progress} aria-label={state.message}/>}
 </div>;
}
