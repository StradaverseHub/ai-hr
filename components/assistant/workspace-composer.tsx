'use client';

import { lazy, Suspense, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { btnPrimary, inputCls } from '../ui';
import type { AiWorkspaceTaskId } from '../../lib/ai/workspace-tasks';
const AssistantFileImport=lazy(()=>import('./file-import').then(module=>({default:module.AssistantFileImport})));

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
};

function ComposerFields({ tasks, labels, layout = 'stacked',question,setQuestion,pending:externalPending }: Omit<Props, 'action'> & {question:string;setQuestion:(value:string)=>void}) {
  const formStatus = useFormStatus();
  const pending = externalPending ?? formStatus.pending;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const choose = (task: Task) => { setQuestion(task.prompt); textarea.current?.focus(); };
  if (layout === 'hero') return <>
    <div className="rounded-xl border border-border bg-card shadow-sm focus-within:ring-2 focus-within:ring-primary" data-ui-composer>
      <label htmlFor="assistant-question" className="sr-only">{labels.question}</label>
      <textarea ref={textarea} id="assistant-question" name="question" required rows={3} maxLength={2000}
        value={question} readOnly={pending} onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => {if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&!pending&&question.trim()){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}
        placeholder={labels.placeholder} aria-describedby="assistant-question-scope" className="min-h-24 w-full resize-y rounded-t-xl bg-transparent px-4 pt-3 text-sm outline-none" />
      <div className="flex items-center justify-between gap-3 px-3 pb-3">
        <p id="assistant-question-scope" className="text-xs text-muted-foreground">{labels.scope}</p>
        <button type="submit" disabled={pending || !question.trim()} aria-busy={pending}
          className={`${btnPrimary} min-h-11 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none motion-reduce:transform-none`}>{pending ? labels.working : labels.ask}</button>
      </div>
    </div>
    <span className="sr-only" role="status">{pending ? labels.working : ''}</span>
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
      <label htmlFor="assistant-question" className="text-sm font-medium">{labels.question}</label>
      <textarea ref={textarea} id="assistant-question" name="question" required rows={3} maxLength={2000}
        value={question} readOnly={pending} onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => {if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&!pending&&question.trim()){event.preventDefault();event.currentTarget.form?.requestSubmit();}}}
        placeholder={labels.placeholder} aria-describedby="assistant-question-scope" className={`${inputCls} min-h-28 w-full resize-y`} />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p id="assistant-question-scope" className="text-xs text-muted-foreground">{labels.scope}</p>
      <button type="submit" disabled={pending || !question.trim()} aria-busy={pending}
        className={`${btnPrimary} min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none motion-reduce:transform-none`}>{pending ? labels.working : labels.ask}</button>
      <span className="sr-only" role="status">{pending ? labels.working : ''}</span>
    </div>
  </>;
}

/** Task selection only writes local form state. No automatic provider call or hidden task capability. */
export function WorkspaceComposer({ action, tasks, labels, layout,fileImport,clearAfterSubmit,clientSubmit,pending }: Props) {
  const [question,setQuestion]=useState('');
  const submit=async(data:FormData)=>{if(clearAfterSubmit)setQuestion('');await action(data);};
  const composer=<form action={clientSubmit?undefined:submit} onSubmit={clientSubmit?event=>{event.preventDefault();if(!pending)void submit(new FormData(event.currentTarget));}:undefined} className="space-y-4"><ComposerFields pending={pending} tasks={tasks} labels={labels} layout={layout} question={question} setQuestion={setQuestion}/></form>;
  return fileImport?<Suspense fallback={composer}><AssistantFileImport normalComposer={composer} instruction={question} onInstructionChange={setQuestion}/></Suspense>:composer;
}
