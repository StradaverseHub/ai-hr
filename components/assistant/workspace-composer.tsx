'use client';

import {lazy,Suspense,useRef,useState,type ReactNode} from 'react';
import { useFormStatus } from 'react-dom';
import {ArrowUp} from 'lucide-react';
import { btnPrimary, inputCls } from '../ui';
import type { AiWorkspaceTaskId } from '../../lib/ai/workspace-tasks';
import type {AttachmentChatTurn} from './use-assistant-import';
const ImportChatComposer=lazy(()=>import('./import-chat-composer').then(module=>({default:module.ImportChatComposer})));


type Task = { id: AiWorkspaceTaskId; label: string; prompt: string };
export type Props = {
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
export function ComposerFields({ tasks, labels, layout = 'stacked',question,setQuestion,pending:externalPending,attachmentControls,attachmentChip,submitDisabled }: FieldProps) {
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
  return props.fileImport?<Suspense fallback={<PlainComposer {...props} question={question} setQuestion={setQuestion}/>}><ImportChatComposer {...props} question={question} setQuestion={setQuestion}/></Suspense>:<PlainComposer {...props} question={question} setQuestion={setQuestion}/>;
}
export type ControlledProps=Props&{question:string;setQuestion:(value:string)=>void};
function PlainComposer({action,clearAfterSubmit,clientSubmit,question,setQuestion,...props}:ControlledProps){
 const submit=async(data:FormData)=>{if(clearAfterSubmit)setQuestion('');await action(data);};
 return <form action={clientSubmit?undefined:submit} onSubmit={clientSubmit?event=>{event.preventDefault();if(!props.pending)void submit(new FormData(event.currentTarget));}:undefined} className="space-y-4"><ComposerFields {...props} question={question} setQuestion={setQuestion}/></form>;
}
