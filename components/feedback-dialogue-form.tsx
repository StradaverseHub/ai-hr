'use client';

import {useActionState, useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button, Field, inputCls} from './ui';
import {FEEDBACK_ANSWER_LIMIT, FEEDBACK_QUESTION_LIMIT, type FeedbackDialogueFormState} from '../lib/feedback-dialogue';

export function FeedbackDialogueForm({mode, feedbackId, questionId, planRevision, action}: {
  mode: 'ask' | 'answer'; feedbackId: string; questionId: string; planRevision?: number;
  action: (state: FeedbackDialogueFormState, data: FormData) => Promise<FeedbackDialogueFormState>;
}) {
  const t = useTranslations('feedback');
  const [state, submit, pending] = useActionState(action, {});
  const [value, setValue] = useState('');
  const asking = mode === 'ask';
  if (state.sent) return <p role="status" className="mt-3 text-sm text-muted-foreground">{t(asking ? 'dialogueQuestionSent' : 'dialogueAnswerSent')}</p>;
  return <form action={submit} className="mt-3 space-y-3">
    <input type="hidden" name="id" value={feedbackId} />
    <input type="hidden" name="questionId" value={questionId} />
    {asking && <input type="hidden" name="planRevision" value={planRevision} />}
    <Field label={t(asking ? 'dialogueQuestionLabel' : 'answerLabel')}>
      <textarea name={asking ? 'question' : 'answer'} rows={4} required maxLength={asking ? FEEDBACK_QUESTION_LIMIT : FEEDBACK_ANSWER_LIMIT}
        value={value} onChange={e => setValue(e.target.value)} className={`${inputCls} min-h-28 text-base sm:text-sm`}
        aria-describedby={`dialogue-hint-${mode}`} aria-invalid={!!state.error} disabled={pending} />
    </Field>
    <p id={`dialogue-hint-${mode}`} className="text-sm text-muted-foreground">{t(asking ? 'dialogueAskHint' : 'dialogueAnswerHint')}</p>
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    <Button type="submit" size="sm" pendingLabel={t('dialogueSending')} disabled={pending || !value.trim()}>{t(asking ? 'dialogueAskSubmit' : 'answerSubmit')}</Button>
  </form>;
}
