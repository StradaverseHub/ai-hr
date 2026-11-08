'use client';
import {useEffect,useSyncExternalStore} from 'react';
import {useFormStatus} from 'react-dom';
const pendingForms=new Map<string,boolean>();
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
function setPending(formId:string,pending:boolean){if((pendingForms.get(formId)===true)===pending)return;if(pending)pendingForms.set(formId,true);else pendingForms.delete(formId);for(const listener of listeners)listener();}
const emptySubscribe=()=>()=>{};

/** Render inside a React action form when its submit control sits elsewhere through HTML's form attribute. */
export function ActionFormStatus({formId}:{formId:string}){
 const {pending}=useFormStatus();
 useEffect(()=>{setPending(formId,pending);return()=>{setPending(formId,false);};},[formId,pending]);
 return null;
}
export function useExternalActionFormPending(formId:string|undefined){
 return useSyncExternalStore(formId?subscribe:emptySubscribe,()=>formId?pendingForms.get(formId)===true:false,()=>false);
}
