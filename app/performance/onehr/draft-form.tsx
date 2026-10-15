'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { saveAssessmentDraftAction } from '../onehr-actions';

const flushEvent='performance-assessment-flush';
/** The composer waits for every active widget's autosave before it reads a private draft. */
export async function flushAssessmentDrafts(){
 const pending:Promise<void>[]=[];window.dispatchEvent(new CustomEvent(flushEvent,{detail:{pending}}));await Promise.all(pending);
}

/** Serialize autosaves, including their optimistic revisions. Drafts never submit an assessment. */
function EditableAssessmentDraftForm({children,action,revision,labels,className='space-y-4',save=saveAssessmentDraftAction,changeKey}:{
  save?:(data:FormData)=>Promise<{revision:number}|{error:string}>;changeKey?:string;
  children:ReactNode; action:(data:FormData)=>Promise<void>; revision:number|null;
  labels:{saving:string;saved:string;privateDraft:string;failed:string};className?:string;
}) {
  const form=useRef<HTMLFormElement>(null),currentRevision=useRef(revision);
  const pending=useRef<ReturnType<typeof setTimeout>|null>(null),queue=useRef(Promise.resolve()),generation=useRef(0);
  const pendingSave=useRef<(()=>void)|null>(null),saveError=useRef('');
  useEffect(()=>{
    const flush=(event:Event)=>{
      if(pending.current){clearTimeout(pending.current);pending.current=null;pendingSave.current?.();}
      (event as CustomEvent<{pending:Promise<void>[]} >).detail.pending.push(queue.current.then(()=>{if(saveError.current)throw Error(saveError.current);}));
    };
    window.addEventListener(flushEvent,flush);return ()=>window.removeEventListener(flushEvent,flush);
  },[]);
  const [state,setState]=useState<'idle'|'saving'|'saved'>('idle'),[error,setError]=useState('');
  function schedule(){
    if(pending.current)clearTimeout(pending.current);
    setState('saving');const scheduled=++generation.current;
    // Capture the form now: navigation may unmount the panel before the debounce expires.
    const data=new FormData(form.current!);
    const commit=()=>{
      pending.current=null;pendingSave.current=null;
      queue.current=queue.current.then(async()=>{
        data.set('draftRevision',currentRevision.current==null?'':String(currentRevision.current));
        const result=await save(data);
        if('error' in result){saveError.current=result.error;setError(result.error);setState('idle');return;}
        saveError.current='';
        currentRevision.current=result.revision;
        if(form.current){const input=form.current.elements.namedItem('draftRevision');if(input instanceof HTMLInputElement)input.value=String(result.revision);}
        if(scheduled===generation.current){setError('');setState('saved');}
      }).catch(()=>{saveError.current=labels.failed;setError(labels.failed);setState('idle');});
    };
    pendingSave.current=commit;pending.current=setTimeout(commit,600);
  }
  const previousKey=useRef(changeKey);
  useEffect(()=>{if(previousKey.current!==changeKey){previousKey.current=changeKey;schedule();}},[changeKey]);
  return <form data-assessment-draft ref={form} action={async data=>{await queue.current;data.set('draftRevision',currentRevision.current==null?'':String(currentRevision.current));await action(data);}} className={className} onChange={event=>{const target=event.target;if((target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement)&&target.form===form.current)schedule();}} onSubmit={()=>{if(pending.current)clearTimeout(pending.current);pending.current=null;pendingSave.current=null;}}>
    <input type="hidden" name="draftRevision" defaultValue={revision??''}/>
    <p className="text-xs text-muted-foreground" role="status">{state==='saving'?labels.saving:state==='saved'?labels.saved:labels.privateDraft}</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {children}
  </form>;
}

/** Submitted/read-only assessments do not mount a private-draft form or its autosave listener. */
export function AssessmentDraftForm({readOnly=false,...props}:Parameters<typeof EditableAssessmentDraftForm>[0]&{readOnly?:boolean}){
 return readOnly?<div className={props.className??'space-y-4'}>{props.children}</div>:<EditableAssessmentDraftForm {...props}/>;
}
