'use client';
import {useActionState,useEffect,useRef,useState} from 'react';
import {previewTemplate} from '@/app/(app)/letters/templates/actions';
import type {LetterChoice} from '@/lib/letter-choice';
import type {LetterField} from '@/lib/letter-model';
import {btnPrimary} from '@/components/ui';
import {LetterChoicePicker,type LetterChoiceLabels} from './choice-picker';
import {LetterDocumentView} from './document-view';
import {LetterCustomInputs} from './custom-inputs';
import type {LetterEditorLabels} from './rich-editor';
export type LetterPreviewLabels={title:string;employee:string;button:string;working:string;select:string;help:string};
export function LetterTemplatePreview({versionId,companyId,fields,labels,pickerLabels,documentLabels,errors}:{versionId:string;companyId:string;fields:LetterField[];labels:LetterPreviewLabels;pickerLabels:LetterChoiceLabels;documentLabels:LetterEditorLabels;errors:Record<string,string>}){
 const [employee,setEmployee]=useState<LetterChoice|null>(null),[dirty,setDirty]=useState(true),[state,action,pending]=useActionState(previewTemplate,null),formRef=useRef<HTMLFormElement>(null);
 useEffect(()=>{const form=formRef.current;if(!form)return;const retain=(event:Event)=>event.preventDefault();form.addEventListener('reset',retain);return()=>form.removeEventListener('reset',retain);},[]);
 return <section className="space-y-4" aria-label={labels.title}><h2 className="font-semibold">{labels.title}</h2><p className="text-sm text-muted-foreground">{labels.help}</p><form ref={formRef} action={action} onChangeCapture={()=>setDirty(true)} onSubmit={()=>setDirty(false)} className="space-y-4"><input type="hidden" name="versionId" value={versionId}/><input type="hidden" name="employmentId" value={employee?.id??''}/><fieldset disabled={pending} className="min-w-0 space-y-4"><legend className="mb-2 text-sm font-medium">{labels.employee}</legend><p className="break-words text-sm">{employee?.label??labels.select}</p><LetterChoicePicker companyId={companyId} kind="employee" labels={pickerLabels} onChoose={value=>{setEmployee(value);setDirty(true);}}/>
  <LetterCustomInputs fields={fields} currencyLabel={documentLabels.condition.currency}/><button type="submit" className={`${btnPrimary} min-h-11`} disabled={pending||!employee} aria-busy={pending}>{pending?labels.working:labels.button}</button></fieldset></form>
  {!dirty&&!pending&&state?.error&&<p role="alert" className="text-sm text-destructive">{Object.hasOwn(errors,state.error)?errors[state.error]:errors.unavailable}{state.field&&<>: <code>{state.field}</code></>}</p>}{!dirty&&!pending&&state?.document&&<div className="rounded-md border bg-background p-4"><LetterDocumentView document={state.document} labels={documentLabels}/></div>}
 </section>;
}
