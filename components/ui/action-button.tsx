'use client';

import {forwardRef,useEffect,useRef,useState,type ButtonHTMLAttributes,type MouseEvent} from 'react';
import {toast} from 'sonner';
import {useFormStatus} from 'react-dom';
import {useActionFeedbackLabels,usePendingAction,type ActionKind} from '@/components/action-feedback';

type Props=ButtonHTMLAttributes<HTMLButtonElement>&{pendingLabel?:string;actionKind?:ActionKind;guardNavigation?:boolean};

/** Shared React-form and explicit async feedback. Outcomes remain owned by the confirmed action response. */
export const ActionButton=forwardRef<HTMLButtonElement,Props>(function ActionButton(
 {children,disabled,pendingLabel,actionKind='processing',guardNavigation,onClick,'aria-busy':explicitBusy,...props},ref,
){
 const form=useFormStatus(),labels=useActionFeedbackLabels();
 const [callbackPending,setCallbackPending]=useState(false);
 const activating=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const formPending=props.type!=='button'&&props.type!=='reset'&&form.pending;
 const pending=formPending||callbackPending||explicitBusy===true||explicitBusy==='true';
 const label=pendingLabel??labels[actionKind];
 const content=pendingLabel??(actionKind==='processing'&&(explicitBusy===true||explicitBusy==='true')?children:label);
 usePendingAction(pending,label,guardNavigation??(props.type!=='button'&&form.method!=='get'));
 const click=(event:MouseEvent<HTMLButtonElement>)=>{
  if(pending||activating.current){event.preventDefault();return;}
  activating.current=true;
  // Guard another activation in this event turn; after React commits, the real pending owner takes over.
  queueMicrotask(()=>{activating.current=false;});
  const result=onClick?.(event) as unknown;
  if(result&&typeof (result as Promise<unknown>).then==='function'&&(props.type==='button'||!event.currentTarget.form||event.defaultPrevented)){
   setCallbackPending(true);
   // The callback owns its confirmed success/error messaging. A rejected callback must remain visible.
   void Promise.resolve(result).then(()=>{if(mounted.current)setCallbackPending(false);},()=>{if(mounted.current){setCallbackPending(false);toast.error(labels.uncertain);}});
  }
 };
 return <button {...props} ref={ref} onClick={click} disabled={disabled||pending}
  aria-busy={pending||explicitBusy} data-action-pending={pending||undefined}>
  {pending&&<span className="action-spinner" aria-hidden="true"/>}{pending?content:children}
 </button>;
});
