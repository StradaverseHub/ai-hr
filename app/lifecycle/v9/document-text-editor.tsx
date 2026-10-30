'use client';
import { useEffect,useRef,useState } from 'react';
import { DocumentBody } from '@/components/lifecycle-v9/document-body';
import type { Document } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
export function DocumentTextEditor({ document, person, busy, command, close }: { document: Document; person: string; busy: boolean; command: (command: LifecycleV9Command) => void | Promise<{ok:boolean;error?:string}>; close: () => void }) {
  const dialog=useRef<HTMLDialogElement>(null),[edits,setEdits]=useState({...document.edits}),[preview,setPreview]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
  const blocks=document.blocks.filter(block=>['heading','subheading','text'].includes(block.type)),blocked=busy||saving;
  async function done(){
    if(blocked)return;
    const dirty=blocks.some(block=>(edits[block.id]??block.text)!==(document.edits[block.id]??block.text));
    if(!dirty){close();return;}
    setSaving(true);setError('');
    try{const result=await command({type:'documentTextEdit',id:document.id,edits});if(result?.ok)close();else setError(result?.error??'The wording could not be saved. Try again.');}
    catch{setError('The wording could not be saved. Try again.');}finally{setSaving(false);}
  }
  return <dialog ref={dialog} className="v9-dialog" aria-label={`Edit before sending: ${document.name}`} onCancel={event=>{if(blocked)event.preventDefault();else close();}}>
    <header><div><h2>Edit before sending: {document.name}</h2><p className="v9-muted">For {person} only. The template does not change.</p></div><button type="button" className="v9-button" disabled={blocked} onClick={close}>Cancel</button></header>
    <div className="v9-stack">{preview?<DocumentBody document={{...document,edits}}/>:blocks.map(block=><label className="v9-field" key={block.id}><span>{block.type==='heading'?'Title':block.type==='subheading'?'Section heading':'Text'}</span>{block.type==='text'?<textarea rows={5} maxLength={20000} value={edits[block.id]??block.text} disabled={blocked} onChange={event=>setEdits(previous=>({...previous,[block.id]:event.target.value}))}/>:<input className="v9-input" maxLength={20000} value={edits[block.id]??block.text} disabled={blocked} onChange={event=>setEdits(previous=>({...previous,[block.id]:event.target.value}))}/>}</label>)}
    {error&&<p role="alert" className="v9-error">{error}</p>}<div className="v9-actions"><button type="button" className="v9-button" disabled={blocked} onClick={()=>setEdits({})}>Reset to template</button><button type="button" className="v9-button" disabled={blocked} onClick={()=>setPreview(value=>!value)}>{preview?'Edit wording':'Preview'}</button><button type="button" className="v9-button v9-button-primary" disabled={blocked} onClick={()=>void done()}>{saving?'Saving…':'Done'}</button></div></div>
  </dialog>;
}
