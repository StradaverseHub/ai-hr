'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorBanner } from '@/components/ui';
import type { SuggestedArchiveState } from '../actions';

/**
 * Slice 17: the "Suggested to archive" form. The ticked applications and the archive reason go to the server in ONE action; the
 * outcome comes back in the action's state (never the URL): how many were archived, and each selected application that was left as
 * it was with the sentence why (no longer suggested, a blocked-list hold, already closed, not found). The rows are rendered on the
 * server (children); the list refreshes after the action, so archived applications leave it.
 *
 * Like ./action-form, the form has no `action` prop: onSubmit dispatches the server action itself, so React never resets the ticks
 * and the reason. A refusal of the whole action keeps them; only a completed action clears the form. The result stays on screen even
 * when the list is now empty (the page renders this wrapper around the empty state too).
 */
export function SuggestedArchiveForm({ action, jobId, names, labels, children }: {
  action: (prev: SuggestedArchiveState, form: FormData) => Promise<SuggestedArchiveState>;
  jobId: string;
  /** The candidates' display names on the list, by application id (to name a refused one). */
  names: Record<string, string>;
  labels: { refusedTitle: string; unknown: string; working: string };
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<SuggestedArchiveState, FormData>(action, { status: 'idle' });
  const ref = useRef<HTMLFormElement>(null);
  // Names seen on any render, so an application that just left the list is still named in the result (React's "store information from
  // previous renders" pattern: adjusted while rendering, no effect).
  const [lastNames, setLastNames] = useState(names);
  const [known, setKnown] = useState(names);
  if (names !== lastNames) {
    setLastNames(names);
    setKnown({ ...known, ...names });
  }
  useEffect(() => {
    if (state.status === 'done') ref.current?.reset();
  }, [state]);
  return (
    <form
      ref={ref}
      aria-busy={pending}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(formData));
      }}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <div role="status" aria-live="polite" className="space-y-2">
        {pending && <p className="text-sm text-muted-foreground">{labels.working}</p>}
        {state.status === 'done' && state.archivedText && (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">{state.archivedText}</p>
        )}
        {state.status === 'done' && (state.refused?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-destructive/40 px-3 py-2 text-sm">
            <p className="font-medium">{labels.refusedTitle}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {state.refused!.map((r) => <li key={r.applicationId}>{known[r.applicationId] ?? labels.unknown} — {r.text}</li>)}
            </ul>
          </div>
        )}
      </div>
      <div role="alert"><ErrorBanner message={state.status === 'refused' ? state.errorText : undefined} /></div>
      {children}
    </form>
  );
}
