'use client';

import { createContext, useContext, useRef, useTransition, type ButtonHTMLAttributes, type FormHTMLAttributes } from 'react';
import { isRedirectError } from 'next/dist/client/components/redirect-error';

const SavePending = createContext(false);

/** Next 16.3 rejects an action whose redirect navigation it owns with a handled redirect. Letting that
 * rejection reach its RedirectBoundary remounts every independent form on the page.
 * A submit handler also avoids React's automatic action-form reset, retaining later edits. */
export function AttendanceSettingsActionForm({ submitAction, preserveDrafts = true, children, ...props }: {
  submitAction: (data: FormData) => Promise<void>;
  preserveDrafts?: boolean;
} & Omit<FormHTMLAttributes<HTMLFormElement>, 'action' | 'onSubmit'>) {
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  if (!preserveDrafts) return <form {...props} action={submitAction}>{children}</form>;
  return <SavePending.Provider value={pending}><form {...props} method="post" aria-busy={pending} onSubmit={event => {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    // The document capture guard has already attached this submission's nonce.
    const data = new FormData(form, submitter);
    const previousBusy = form.getAttribute('aria-busy');
    form.setAttribute('aria-busy', 'true'); // Capture guards see this before React renders pending.
    inFlight.current = true;
    startTransition(async () => {
      try { await submitAction(data); }
      catch (error) {
        // Next's reducer owns the seeded/fallback navigation separately from this rejection.
        // Never absorb ordinary errors or a redirect that has not been handled.
        if (!(isRedirectError(error) && 'handled' in error && error.handled === true)) throw error;
      } finally {
        inFlight.current = false;
        if (previousBusy === null) form.removeAttribute('aria-busy');
        else form.setAttribute('aria-busy', previousBusy);
      }
    });
  }}>{children}</form></SavePending.Provider>;
}

export function AttendanceSettingsSaveButton({ disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const pending = useContext(SavePending);
  return <button {...props} type={props.type ?? 'submit'} disabled={pending || disabled}/>;
}
