'use client';
import {createContext,useCallback,useContext,useEffect,useRef,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import type {AssistantImportTarget} from '@/lib/assistant-import';
type Handoff={target:AssistantImportTarget;text:string;nonce:string;expires:number};
type Carrier={put:(target:AssistantImportTarget,text:string)=>string;take:(target:AssistantImportTarget,nonce:string)=>string|null};
const Context=createContext<Carrier|null>(null);
/** One-use, same-tab memory. A server-derived principal/scope key remounts this on identity changes.
 * No HR values in URLs, browser storage, conversation history or cross-tab broadcasts. */
export function AssistantImportHandoffProvider({children}:{children:ReactNode}){
 const value=useRef<Handoff|null>(null);
 const put=useCallback((target:AssistantImportTarget,text:string)=>{const nonce=crypto.randomUUID();value.current={target,text,nonce,expires:Date.now()+10*60*1000};return nonce;},[]);
 const take=useCallback((target:AssistantImportTarget,nonce:string)=>{
  const item=value.current;
  if(!item)return null;
  if(item.expires<Date.now()){value.current=null;return null;}
  if(item.target!==target||item.nonce!==nonce)return null;
  value.current=null;return item.text;
 },[]);
 return <Context.Provider value={{put,take}}>{children}</Context.Provider>;
}
export function useAssistantImportHandoff(){return useContext(Context);}
/** Native workbenches hydrate a draft only; their own Validate and Confirm still own all effects. */
export function useAssistantImportIntake(target:AssistantImportTarget,receive:(text:string)=>void,fail?:(message:string)=>void){
 const carrier=useContext(Context),received=useRef(false),callback=useRef(receive),failure=useRef(fail),t=useTranslations('assistant.fileImport');
 callback.current=receive;failure.current=fail;
 useEffect(()=>{
  if(received.current||!carrier)return;
  const nonce=new URLSearchParams(window.location.search).get('assistantImport');if(!nonce)return;
  received.current=true;
  const text=carrier.take(target,nonce);
  if(text===null){failure.current?.(t('expired'));return;}
  callback.current(text);
 },[carrier,target,t]);
}
