'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';

/** One native template surface for On/Off Boarding and the shared builders. Native dialog owns focus and modality. */
export function TemplateSurface({kind,close,children,heading,canClose,closeDisabled=false,label,closeLabel}:{kind:'document'|'email';close:()=>void;children:ReactNode;heading?:ReactNode;canClose?:()=>boolean;closeDisabled?:boolean;label?:string;closeLabel?:string}){
 const ref=useRef<HTMLDialogElement>(null),backdropPointer=useRef(false);
 useEffect(()=>{
  const dialog=ref.current,previous=document.activeElement;
  dialog?.showModal();
  return()=>{if(dialog?.open&&typeof dialog.close==='function')dialog.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
 },[]);
 const requestClose=()=>{if(!closeDisabled&&(!canClose||canClose()))close();};
 const outside=(target:EventTarget|null,x:number,y:number)=>{const dialog=ref.current;if(!dialog||target!==dialog)return false;const rect=dialog.getBoundingClientRect();return x<rect.left||x>rect.right||y<rect.top||y>rect.bottom;};
 const closeText=closeLabel??(kind==='email'?'Close':'Back to templates');
 return <dialog ref={ref} className={'v9-dialog v9-template-surface '+(kind==='email'?'v9-email-drawer':'v9-template-screen')}
  aria-label={label??(kind==='email'?'Edit email template':'Edit document template')}
  onCancel={event=>{event.preventDefault();requestClose();}}
  onPointerDown={event=>{backdropPointer.current=outside(event.target,event.clientX,event.clientY);}}
  onClick={event=>{if(backdropPointer.current&&outside(event.target,event.clientX,event.clientY))requestClose();backdropPointer.current=false;}}>
  <div className="v9-template-surface-content"><header className="v9-heading">{heading??<h2>{kind==='email'?'Edit email template':'Edit document template'}</h2>}<button type="button" className="v9-button" disabled={closeDisabled} aria-label={closeText} onClick={requestClose}>{kind==='email'?<X size={16}/>:closeText}</button></header>{children}</div>
 </dialog>;
}
