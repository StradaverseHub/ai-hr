'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type ButtonHTMLAttributes, type FormHTMLAttributes } from 'react';
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
  const pendingForm = useRef<{ form: HTMLFormElement; previousBusy: string | null } | null>(null);
  const restoreBusy = useCallback(() => {
    const previous = pendingForm.current;
    if (previous) {
      if (previous.previousBusy === null) previous.form.removeAttribute('aria-busy');
      else previous.form.setAttribute('aria-busy', previous.previousBusy);
      pendingForm.current = null;
    }
  }, []);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    // The action can settle before its RSC transition commits. Keep capture refusal armed until then.
    if (busy && settled && !pending) {
      restoreBusy();
      inFlight.current = false;
      setBusy(false);
      setSettled(false);
    }
  }, [busy, settled, pending, restoreBusy]);
  useEffect(() => () => { restoreBusy(); inFlight.current = false; }, [restoreBusy]);
  if (!preserveDrafts) return <form {...props} action={submitAction}>{children}</form>;
  return <SavePending.Provider value={pending || busy}><form {...props} method="post" aria-busy={pending || busy} onSubmit={event => {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    // The document capture guard has already attached this submission's nonce.
    const data = new FormData(form, submitter);
    pendingForm.current = { form, previousBusy: form.getAttribute('aria-busy') };
    form.setAttribute('aria-busy', 'true'); // Capture guards see this before React renders pending.
    inFlight.current = true;
    setBusy(true);
    setSettled(false);
    startTransition(async () => {
      try { await submitAction(data); }
      catch (error) {
        // Next's reducer owns the seeded/fallback navigation separately from this rejection.
        // Never absorb ordinary errors or a redirect that has not been handled.
        if (!(isRedirectError(error) && 'handled' in error && error.handled === true)) throw error;
      } finally {
        setSettled(true);
      }
    });
  }}>{children}</form></SavePending.Provider>;
}

export function AttendanceSettingsSaveButton({ disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const pending = useContext(SavePending);
  return <button {...props} type={props.type ?? 'submit'} disabled={pending || disabled}/>;
}
