'use client';

import { useRef, useState, type ReactNode } from 'react';
import { saveAssessmentDraftAction } from '../onehr-actions';

/** Serialize autosaves, including their optimistic revisions. Drafts never submit an assessment. */
export function AssessmentDraftForm({children,action,revision,labels,className='space-y-4'}:{
  children:ReactNode; action:(data:FormData)=>Promise<void>; revision:number|null;
  labels:{saving:string;saved:string;privateDraft:string;failed:string};className?:string;
}) {
  const form=useRef<HTMLFormElement>(null),currentRevision=useRef(revision);
  const pending=useRef<ReturnType<typeof setTimeout>|null>(null),queue=useRef(Promise.resolve()),generation=useRef(0);
  const [state,setState]=useState<'idle'|'saving'|'saved'>('idle'),[error,setError]=useState('');
  function schedule(){
    if(pending.current)clearTimeout(pending.current);
    setState('saving');const scheduled=++generation.current;
    // Capture the form now: navigation may unmount the panel before the debounce expires.
    const data=new FormData(form.current!);
    pending.current=setTimeout(()=>{
      pending.current=null;
      queue.current=queue.current.then(async()=>{
        data.set('draftRevision',currentRevision.current==null?'':String(currentRevision.current));
        const result=await saveAssessmentDraftAction(data);
        if('error' in result){setError(result.error);setState('idle');return;}
        currentRevision.current=result.revision;
        if(form.current){const input=form.current.elements.namedItem('draftRevision');if(input instanceof HTMLInputElement)input.value=String(result.revision);}
        if(scheduled===generation.current){setError('');setState('saved');}
      }).catch(()=>{setError(labels.failed);setState('idle');});
    },600);
  }
  return <form data-assessment-draft ref={form} action={async data=>{await queue.current;data.set('draftRevision',currentRevision.current==null?'':String(currentRevision.current));await action(data);}} className={className} onChange={schedule} onSubmit={()=>{if(pending.current)clearTimeout(pending.current);}}>
    <input type="hidden" name="draftRevision" defaultValue={revision??''}/>
    <p className="text-xs text-muted-foreground" role="status">{state==='saving'?labels.saving:state==='saved'?labels.saved:labels.privateDraft}</p>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {children}
  </form>;
}
