'use client';

import { createContext, useContext, useRef, useState, useTransition, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { useTranslations } from 'next-intl';
import { Button } from './ui/button';
import { usePendingAction } from './action-feedback';
const SubmissionPending = createContext(false);

export type AttendanceSubmissionAction = (data: FormData) => void | { error: string } | Promise<void | { error: string }>;

/** Retain the live form (including its selected attachment) when routing cannot be resolved. */
export function AttendanceSubmissionForm({ action, className, children, onSubmitted }: {
  action: AttendanceSubmissionAction;
  className?: string;
  children: ReactNode;
  onSubmitted?: () => void;
}) {
  const t = useTranslations('attendanceWorkflow');
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  usePendingAction(pending,t('submissionSending'),true);
  const inFlight = useRef(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || pending) return;
    inFlight.current = true;
    const data = new FormData(event.currentTarget);
    start(async () => {
      setError('');
      try {
        const result = await action(data);
        if (result?.error) setError(result.error);
        else onSubmitted?.();
      } catch (failure) {
        if (isRedirectError(failure)) {
          if (!('handled' in failure && failure.handled === true)) throw failure;
          onSubmitted?.();
          return;
        }
        setError(t('requestFailed'));
      } finally {
        inFlight.current = false;
      }
    });
  };
  return <SubmissionPending.Provider value={pending}><form method="post" className={className} onSubmit={submit} aria-busy={pending}>
    {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <fieldset disabled={pending} className="m-0 min-w-0 space-y-2.5 border-0 p-0">{children}</fieldset>
  </form></SubmissionPending.Provider>;
}

export function AttendanceSubmissionButton(props: ComponentProps<typeof Button>) {
  const pending=useContext(SubmissionPending), t=useTranslations('attendanceWorkflow');
  return <Button {...props} type="submit" aria-busy={pending} disabled={pending || props.disabled} pendingLabel={t('submissionSending')} actionKind="submitting"/>;
}
