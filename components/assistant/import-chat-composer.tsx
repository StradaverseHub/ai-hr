"use client";
import {useEffect,useId,useMemo,useRef} from 'react';
import {useTranslations} from 'next-intl';
import {Paperclip,X} from 'lucide-react';
import {useAssistantImport,type AttachmentChatTurn} from './use-assistant-import';
import {ChatImportReply} from './chat-import-reply';
import {ComposerFields,type ControlledProps} from './workspace-composer';

export function ImportChatComposer({action,clearAfterSubmit,question,setQuestion,onAttachmentTurn,onAttachmentBusy,...props}:ControlledProps){
 const t=useTranslations('assistant.fileImport'),controller=useAssistantImport(),id=useId();
 const previouslyAttached=useRef(false),attachmentInstruction=useRef('');
 const callbacks=useRef({onAttachmentTurn,onAttachmentBusy});callbacks.current={onAttachmentTurn,onAttachmentBusy};
 const {source,part,target,instruction,busy,error,draft,csv,consent,reviewed,selectedName,submittedQuestion,attached}=controller;
 // The cleared chat composer does not erase the instruction already bound to the inline draft.
 // Any new nonempty instruction invalidates that draft and requires consent again.
 useEffect(()=>{if(source&&attached&&busy!=='read'&&question.trim()&&question!==instruction)controller.changeInstruction(question);},[question,instruction,attached,busy,source]); // eslint-disable-line react-hooks/exhaustive-deps
 const turn=useMemo<AttachmentChatTurn|null>(()=>attached?{id,question:submittedQuestion?submittedQuestion+'\n'+selectedName:selectedName||'',answer:<ChatImportReply controller={controller}/>} : null,
  [id,source,part,target,instruction,busy,error,draft,csv,consent,reviewed,selectedName,submittedQuestion,attached]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{callbacks.current.onAttachmentTurn?.(turn);},[turn]);
 useEffect(()=>{callbacks.current.onAttachmentBusy?.(busy!==null);},[busy]);
 useEffect(()=>()=>{callbacks.current.onAttachmentTurn?.(null);callbacks.current.onAttachmentBusy?.(false);},[]);
 useEffect(()=>{if(attached)attachmentInstruction.current=instruction;if(previouslyAttached.current&&!attached&&error===t('expired')&&question===attachmentInstruction.current)setQuestion('');previouslyAttached.current=attached;},[attached,error,instruction,question,setQuestion,t]);
 const pending=!!props.pending||busy!==null;
 async function submit(data:FormData){
  if(pending)return;
  const request=String(data.get('question')??'');if(!request.trim())return;
  if(attached){if(!source||!consent||request!==instruction)return;const prepared=await controller.prepare(request);if(prepared&&clearAfterSubmit)setQuestion('');return;}
  if(clearAfterSubmit)setQuestion('');await action(data);
 }
 const attachmentControls=<><button type="button" disabled={pending} aria-label={t('attach')} title={t('attach')} onClick={()=>controller.picker.current?.click()} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><Paperclip aria-hidden className="size-4"/></button><input ref={controller.picker} type="file" accept=".pdf,.xlsx,.xls,.csv" className="sr-only" aria-label={t('attach')} tabIndex={-1} onChange={event=>void controller.load(Array.from(event.target.files??[]),question)}/></>;
 const attachmentChip=selectedName&&<div className="flex items-center gap-2 px-3 pt-3 text-xs"><span className="min-w-0 truncate rounded-md bg-muted px-2 py-1">{selectedName}</span><button type="button" aria-label={t('discard')} title={t('discard')} onClick={()=>{controller.discard();setQuestion('');}} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X aria-hidden className="size-3.5"/></button></div>;
 return <div className="space-y-2" onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(!pending&&event.dataTransfer.files.length){event.preventDefault();void controller.load(Array.from(event.dataTransfer.files),question);}}}>
  {!onAttachmentTurn&&turn&&<div role="log" aria-label={t('title')} className="space-y-3"><p className="ml-auto w-fit max-w-[90%] break-words rounded-2xl bg-muted px-4 py-3">{turn.question}</p>{turn.answer}</div>}
  {!attached&&error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <form onSubmit={event=>{event.preventDefault();void submit(new FormData(event.currentTarget));}} className="space-y-4"><ComposerFields {...props} question={question} setQuestion={setQuestion} pending={pending} attachmentControls={attachmentControls} attachmentChip={attachmentChip} submitDisabled={attached&&(!source||!consent||question!==instruction)}/></form>
  <details><summary className="min-h-8 w-fit cursor-pointer py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('title')}</summary><p className="pb-2 text-xs leading-relaxed text-muted-foreground">{t('hint')}</p></details>
 </div>;
}
