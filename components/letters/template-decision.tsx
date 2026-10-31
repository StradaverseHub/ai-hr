'use client';
import {useActionState,useRef,useEffect} from 'react';
import {updateTemplate} from '@/app/(app)/letters/templates/actions';
import {Field,inputCls} from '@/components/ui';
import {LetterSubmit} from './submit';
export function LetterTemplateDecision({versionId,templateId,revision,action,label,pendingLabel,reasonLabel,errors}:{versionId:string;templateId:string;revision:number;action:'submit'|'approve'|'reject'|'activate'|'deactivate';label:string;pendingLabel:string;reasonLabel?:string;errors:Record<string,string>}){
 const [state,dispatch]=useActionState(updateTemplate,null),formRef=useRef<HTMLFormElement>(null);
 useEffect(()=>{const form=formRef.current;if(!form)return;const retain=(event:Event)=>event.preventDefault();form.addEventListener('reset',retain);return()=>form.removeEventListener('reset',retain);},[]);
 return <form ref={formRef} action={dispatch} className="space-y-3">{state?.error&&<p role="alert" className="text-sm text-destructive">{Object.hasOwn(errors,state.error)?errors[state.error]:errors.unavailable}</p>}<input type="hidden" name="versionId" value={versionId}/><input type="hidden" name="templateId" value={templateId}/><input type="hidden" name="expectedRevision" value={revision}/><input type="hidden" name="action" value={action}/>{action==='reject'&&<Field label={reasonLabel??label}><textarea name="reason" className={`${inputCls} min-h-24`} required maxLength={2000}/></Field>}<LetterSubmit label={label} pendingLabel={pendingLabel} secondary={action!=='approve'}/></form>;
}
