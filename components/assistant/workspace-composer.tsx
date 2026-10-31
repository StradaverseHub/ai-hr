'use client';

import {useEffect,useId,useMemo,useRef,useState,type ReactNode} from 'react';
import { useFormStatus } from 'react-dom';
import {useTranslations} from 'next-intl';
import {ArrowUp,Paperclip,X} from 'lucide-react';
import { btnPrimary, inputCls } from '../ui';
import type { AiWorkspaceTaskId } from '../../lib/ai/workspace-tasks';
import {useAssistantImport,type AttachmentChatTurn} from './use-assistant-import';
import {ChatImportReply} from './chat-import-reply';

type Task = { id: AiWorkspaceTaskId; label: string; prompt: string };
type Props = {
  action: (formData: FormData) => Promise<void>;
  tasks: readonly Task[];
  labels: { tasks: string; taskHint: string; question: string; placeholder: string; ask: string; working: string; scope: string };
  /** 'hero': the Assistant home layout. The question box leads, with send inside it; task shortcuts follow as chips. */
  layout?: 'stacked' | 'hero';
  fileImport?: boolean;
  clearAfterSubmit?: boolean;
  clientSubmit?: boolean;
  pending?: boolean;
  question?:string;
  onQuestionChange?:(value:string)=>void;
  onAttachmentTurn?:(turn:AttachmentChatTurn|null)=>void;
  onAttachmentBusy?:(busy:boolean)=>void;
};

type FieldProps=Omit<Props,'action'>&{question:string;setQuestion:(value:string)=>void;attachmentControls?:ReactNode;attachmentChip?:ReactNode;submitDisabled?:boolean};
function ComposerFields({ tasks, labels, layout = 'stacked',question,setQuestion,pending:externalPending,attachmentControls,attachmentChip,submitDisabled }: FieldProps) {
  const formStatus = useFormStatus();
  const pending = externalPending ?? formStatus.pending;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const choose = (task: Task) => { setQuestion(task.prompt); textarea.current?.focus(); };
  if (layout === 'hero') return <>
    <div className="rounded-xl border border-border bg-card shadow-sm focus-within:ring-2 focus-within:ring-primary" data-ui-composer>
      {attachmentChip}
      <label htmlFor="assistant-question" className="sr-only">{labels.question}</label>
      <textarea ref={textarea} id="assistant-question" name="question" required rows={2} maxLength={2000}
        value={question} readOnly={pending} onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => {if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&!pending&&question.trim()){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}
        placeholder={labels.placeholder} aria-describedby="assistant-question-scope" className="max-h-48 min-h-16 w-full resize-y rounded-t-xl bg-transparent px-4 pt-3 text-sm outline-none" />
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <div className="flex min-w-0 items-center gap-2">{attachmentControls}<p id="assistant-question-scope" className="text-xs text-muted-foreground">{labels.scope}</p></div>
        <button type="submit" disabled={pending || submitDisabled || !question.trim()} aria-busy={pending} aria-label={pending?labels.working:labels.ask} title={labels.ask}
          className={`${btnPrimary} size-11 shrink-0 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none motion-reduce:transform-none`}><ArrowUp aria-hidden className="size-4"/></button>
      </div>
    </div>
    {tasks.length > 0 && <section aria-labelledby="assistant-task-heading" className="flex flex-wrap items-center justify-center gap-2">
      <h2 id="assistant-task-heading" className="sr-only">{labels.tasks}</h2>
      <p id="assistant-task-hint" className="sr-only">{labels.taskHint}</p>
      {tasks.map(task => <button key={task.id} type="button" disabled={pending} aria-describedby="assistant-task-hint"
        className="min-h-11 rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
        onClick={() => choose(task)}>{task.label}</button>)}
    </section>}
  </>;
  return <>
    {tasks.length > 0 && <section aria-labelledby="assistant-task-heading" className="space-y-2">
      <h2 id="assistant-task-heading" className="text-sm font-medium">{labels.tasks}</h2>
      <p id="assistant-task-hint" className="text-xs text-muted-foreground">{labels.taskHint}</p>
      <div className="flex flex-wrap gap-2" aria-describedby="assistant-task-hint">
        {tasks.map(task => <button key={task.id} type="button" disabled={pending}
          className="min-h-11 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
          onClick={() => choose(task)}>{task.label}</button>)}
      </div>
    </section>}
    <div className="space-y-2">
      {attachmentChip}
      <label htmlFor="assistant-question" className="text-sm font-medium">{labels.question}</label>
      <textarea ref={textarea} id="assistant-question" name="question" required rows={3} maxLength={2000}
        value={question} readOnly={pending} onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => {if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&!pending&&question.trim()){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}
        placeholder={labels.placeholder} aria-describedby="assistant-question-scope" className={`${inputCls} min-h-28 w-full resize-y`} />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">{attachmentControls}<p id="assistant-question-scope" className="text-xs text-muted-foreground">{labels.scope}</p></div>
      <button type="submit" disabled={pending || submitDisabled || !question.trim()} aria-busy={pending}
        className={`${btnPrimary} min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none motion-reduce:transform-none`}>{pending ? labels.working : labels.ask}</button>
      </div>
  </>;
}

/** Task selection only writes local form state. No automatic provider call or hidden task capability. */
export function WorkspaceComposer(props:Props) {
  const [localQuestion,setLocalQuestion]=useState('');
  const question=props.question??localQuestion,setQuestion=props.onQuestionChange??setLocalQuestion;
  return props.fileImport?<ImportChatComposer {...props} question={question} setQuestion={setQuestion}/>:<PlainComposer {...props} question={question} setQuestion={setQuestion}/>;
}
type ControlledProps=Props&{question:string;setQuestion:(value:string)=>void};
function PlainComposer({action,clearAfterSubmit,clientSubmit,question,setQuestion,...props}:ControlledProps){
 const submit=async(data:FormData)=>{if(clearAfterSubmit)setQuestion('');await action(data);};
 return <form action={clientSubmit?undefined:submit} onSubmit={clientSubmit?event=>{event.preventDefault();if(!props.pending)void submit(new FormData(event.currentTarget));}:undefined} className="space-y-4"><ComposerFields {...props} question={question} setQuestion={setQuestion}/></form>;
}
function ImportChatComposer({action,clearAfterSubmit,question,setQuestion,onAttachmentTurn,onAttachmentBusy,...props}:ControlledProps){
 const t=useTranslations('assistant.fileImport'),controller=useAssistantImport(),id=useId();
 const previouslyAttached=useRef(false),attachmentInstruction=useRef('');
 const callbacks=useRef({onAttachmentTurn,onAttachmentBusy});callbacks.current={onAttachmentTurn,onAttachmentBusy};
 const {source,part,target,instruction,busy,error,draft,csv,consent,reviewed,selectedName,submittedQuestion,attached}=controller;
 // The cleared chat composer does not erase the instruction already bound to the inline draft.
 // Any new nonempty instruction invalidates that draft and requires consent again.
 useEffect(()=>{if(question.trim()&&question!==instruction)controller.changeInstruction(question);},[question,instruction]); // eslint-disable-line react-hooks/exhaustive-deps
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
 const attachmentControls=<><button type="button" disabled={pending} aria-label={t('attach')} title={t('attach')} onClick={()=>controller.picker.current?.click()} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><Paperclip aria-hidden className="size-4"/></button><input ref={controller.picker} type="file" accept=".pdf,.xlsx,.xls,.csv" className="sr-only" aria-label={t('attach')} tabIndex={-1} onChange={event=>void controller.load(Array.from(event.target.files??[]))}/></>;
 const attachmentChip=selectedName&&<div className="flex items-center gap-2 px-3 pt-3 text-xs"><span className="min-w-0 truncate rounded-md bg-muted px-2 py-1">{selectedName}</span><button type="button" aria-label={t('discard')} title={t('discard')} onClick={()=>{controller.discard();setQuestion('');}} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X aria-hidden className="size-3.5"/></button></div>;
 return <div className="space-y-2" onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(!pending&&event.dataTransfer.files.length){event.preventDefault();void controller.load(Array.from(event.dataTransfer.files));}}}>
  {!onAttachmentTurn&&turn&&<div role="log" aria-label={t('title')} className="space-y-3"><p className="ml-auto w-fit max-w-[90%] break-words rounded-2xl bg-muted px-4 py-3">{turn.question}</p>{turn.answer}</div>}
  {!attached&&error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  <form onSubmit={event=>{event.preventDefault();void submit(new FormData(event.currentTarget));}} className="space-y-4"><ComposerFields {...props} question={question} setQuestion={setQuestion} pending={pending} attachmentControls={attachmentControls} attachmentChip={attachmentChip} submitDisabled={attached&&(!source||!consent||question!==instruction)}/></form>
  <details><summary className="min-h-8 w-fit cursor-pointer py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('title')}</summary><p className="pb-2 text-xs leading-relaxed text-muted-foreground">{t('hint')}</p></details>
 </div>;
}
