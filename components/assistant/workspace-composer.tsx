'use client';

import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { btnPrimary, inputCls } from '../ui';
import type { AiWorkspaceTaskId } from '../../lib/ai/workspace-tasks';

type Task = { id: AiWorkspaceTaskId; label: string; prompt: string };
type Props = {
  action: (formData: FormData) => Promise<void>;
  tasks: readonly Task[];
  labels: { tasks: string; taskHint: string; question: string; placeholder: string; ask: string; working: string; scope: string };
};

function ComposerFields({ tasks, labels }: Omit<Props, 'action'>) {
  const { pending } = useFormStatus();
  const [question, setQuestion] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  return <>
    {tasks.length > 0 && <section aria-labelledby="assistant-task-heading" className="space-y-2">
      <h2 id="assistant-task-heading" className="text-sm font-medium">{labels.tasks}</h2>
      <p id="assistant-task-hint" className="text-xs text-muted-foreground">{labels.taskHint}</p>
      <div className="flex flex-wrap gap-2" aria-describedby="assistant-task-hint">
        {tasks.map(task => <button key={task.id} type="button" disabled={pending}
          className="min-h-11 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
          onClick={() => { setQuestion(task.prompt); textarea.current?.focus(); }}>{task.label}</button>)}
      </div>
    </section>}
    <div className="space-y-2">
      <label htmlFor="assistant-question" className="text-sm font-medium">{labels.question}</label>
      <textarea ref={textarea} id="assistant-question" name="question" required rows={3} maxLength={2000}
        value={question} readOnly={pending} onChange={event => setQuestion(event.target.value)}
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
export function WorkspaceComposer({ action, tasks, labels }: Props) {
  return <form action={action} className="space-y-4"><ComposerFields tasks={tasks} labels={labels} /></form>;
}
