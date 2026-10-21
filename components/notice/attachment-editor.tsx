'use client';
import {useId,useRef,useState} from 'react';
import {Button,inputCls} from '@/components/ui';
export type NoticeAttachmentMetadata={id:string;fileName:string;mimeType:string;byteLength:number};
export type NoticeAttachmentEditorLabels={title:string;help:string;choose:string;add:string;pending:string;remove:string;saveFirst:string;saveHint:string;file:string;tooLarge:string;changed:string;limit:string;unavailable:string;failed:string};
export function NoticeAttachmentEditor({noticeId,contentVersion,items,onUploaded,onRemove,onBusyChange,labels,locale}:{
 locale:string;noticeId?:string;contentVersion:number;items:NoticeAttachmentMetadata[];onUploaded:(file:NoticeAttachmentMetadata)=>void;onRemove:(id:string)=>void;onBusyChange:(busy:boolean)=>void;labels:NoticeAttachmentEditorLabels;
}){
 const inputId=useId(),input=useRef<HTMLInputElement>(null),inFlight=useRef(false);
 const [file,setFile]=useState<File|null>(null),[intent,setIntent]=useState<string|null>(null),[pending,setPending]=useState(false),[error,setError]=useState<keyof Pick<NoticeAttachmentEditorLabels,'file'|'tooLarge'|'changed'|'limit'|'unavailable'|'failed'>|null>(null),[ready,setReady]=useState(false);
 async function upload(){
  if(inFlight.current||!file||!intent||!noticeId)return;
  if(!file.size||file.size>10*1024*1024){setError('tooLarge');return;}
  inFlight.current=true;setPending(true);setError(null);
  try{
   const body=new FormData();body.set('file',file);body.set('uploadKey',intent);body.set('contentVersion',String(contentVersion));
   const response=await fetch(`/admin/notice-board/${noticeId}/attachments`,{method:'POST',body,credentials:'same-origin'});
   const result=await response.json();
   if(!response.ok){setError(['file','tooLarge','changed','limit','unavailable'].includes(result?.error)?result.error:'failed');return;}
   const item=result?.attachment;
   if(typeof item?.id!=='string'||typeof item.fileName!=='string'||typeof item.mimeType!=='string'||!Number.isInteger(item.byteLength)||item.byteLength<=0)throw Error('Invalid upload response');
   onUploaded(item);setFile(null);setIntent(null);if(input.current)input.current.value='';onBusyChange(false);setReady(true);
  }catch{setError('failed');}finally{inFlight.current=false;setPending(false);}
 }
 return <section className="space-y-3" aria-labelledby={inputId+'-title'}>
  <h2 id={inputId+'-title'} className="text-sm font-medium">{labels.title}</h2>
  {!noticeId?<p className="max-w-prose text-sm text-muted-foreground">{labels.saveFirst}</p>:<>
   <p className="max-w-prose text-sm text-muted-foreground">{labels.help}</p>
   {items.length>0&&<ul className="divide-y divide-border">{items.map(item=><li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
    <span className="min-w-0 flex-1 break-words text-sm">{item.fileName}<span className="ml-2 text-xs text-muted-foreground">{new Intl.NumberFormat(locale,{style:'unit',unit:'kilobyte',unitDisplay:'short',maximumFractionDigits:0}).format(item.byteLength/1024)}</span></span>
    <Button type="button" variant="ghost" className="min-h-11" disabled={pending} onClick={()=>onRemove(item.id)} aria-label={labels.remove+': '+item.fileName}>{labels.remove}</Button>
   </li>)}</ul>}
   {items.length<5&&<div className="space-y-2">
    <label htmlFor={inputId} className="block text-sm">{labels.choose}</label>
    {/* No name: file bytes must not be included in the parent server-action submission. */}
    <input ref={input} id={inputId} type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx,.pptx" disabled={pending} className={inputCls+' min-h-11 w-full'} onChange={event=>{const chosen=event.target.files?.[0]??null;setFile(chosen);setIntent(chosen?crypto.randomUUID():null);setError(null);setReady(false);onBusyChange(chosen!==null);}}/>
    <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11" disabled={!file||pending} onClick={upload}>{pending?labels.pending:labels.add}</Button>
     {file&&<Button type="button" variant="ghost" className="min-h-11" disabled={pending} onClick={()=>{setFile(null);setIntent(null);if(input.current)input.current.value='';setError(null);onBusyChange(false);}}>{labels.remove}</Button>}
    </div>
   </div>}
   {error&&<p role="alert" className="max-w-prose text-sm text-destructive">{labels[error]}</p>}
   {(ready||items.length>0)&&<p role="status" className="max-w-prose text-sm text-muted-foreground">{labels.saveHint}</p>}
  </>}
 </section>;
}
