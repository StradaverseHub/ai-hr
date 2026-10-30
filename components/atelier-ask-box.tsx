'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { WorkspaceConversation } from './assistant/workspace-conversation';

/**
 * Atelier round 1 — Home's ask box. It is the EXISTING assistant (ADR-0082), not a new one: the form posts
 * through the shared in-place conversation. The server records and reauthorizes each answer. app/dashboard-atelier.tsx renders this only when mayUseAssistant() allows the viewer, so a
 * person without the module or a grant never meets a box that cannot answer.
 *
 * The suggestion chips only FILL the box; nothing is sent until the person presses Ask.
 */
const MAX_QUESTION_CHARS = 2000; // core/assistant.ts refuses longer questions

type Props = {
  label: string;
  placeholder: string;
  submitLabel: string;
  suggestions: readonly string[];
};

export function AtelierAskBox(props: Props) {
  return <WorkspaceConversation tasks={[]} fileImport={false} composer={({action,pending})=><form onSubmit={event=>{event.preventDefault();if(!pending)void action(new FormData(event.currentTarget));}} className="atelier-ask-form"><AskFields {...props} pending={pending}/></form>}/>;
}

function AskFields({
  label,
  placeholder,
  submitLabel,
  suggestions,
  pending:externalPending,
}: Props & {pending?:boolean}) {
  const status=useFormStatus();
  const pending=externalPending??status.pending;
  const t = useTranslations('assistant.workspace');
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const wasPending=useRef(false);
  useEffect(()=>{if(wasPending.current&&!pending)setValue('');wasPending.current=pending;},[pending]);
  return (
    <>
      <div className="atelier-ask" data-ui-composer>
        <label htmlFor={id} className="sr-only">{label}</label>
        <textarea
          ref={ref}
          id={id}
          name="question"
          required
          rows={2}
          maxLength={MAX_QUESTION_CHARS}
          value={value}
          readOnly={pending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line: the composer convention people already know.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !pending && value.trim()) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
        />
        <div className="atelier-ask-bar">
          <span role="status" className="mr-3 self-center text-sm text-muted-foreground">{pending ? t('working') : ''}</span>
          <button type="submit" aria-label={pending ? t('working') : submitLabel} title={submitLabel}
            aria-busy={pending} disabled={!value.trim() || pending} className="atelier-send">
            <ArrowUp aria-hidden className="size-4" />
          </button>
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="atelier-suggest">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={pending}
              onClick={() => {
                setValue(s);
                ref.current?.focus();
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
