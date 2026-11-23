'use client';

import { startTransition, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { ActionButton } from '@/components/ui/action-button';
import { DatabaseErrorText } from '@/components/database-error-text';
import { parseDatabaseErrorRef } from '@/lib/database-error-token';
import { isActionRedirect } from '@/lib/action-feedback-result';
import { personnelWorkflowInput } from '@/lib/personnel-form-contract';
import type { DirectSuperiorSaveOutcome } from './actions';

type ChangeMode = '' | 'amend' | 'movement';
/** The server's typed outcome, plus the one the browser itself concludes when no answer can be read. */
type Outcome = DirectSuperiorSaveOutcome | { status: 'uncertain'; submissionId: string };

/** Board 8f959c7a — how long Save may spin before the card says the result could not be confirmed. */
export const DIRECT_SUPERIOR_CONFIRM_WITHIN_MS = 20_000;

/**
 * Board 8f959c7a — the Direct Superior card's save. The action RETURNS its outcome instead of redirecting,
 * so a refusal is shown here, in red under Save, with the radio, date and reason still filled in, and a
 * confirmed save shows straight away with the current superior the server read back. The rest of the page
 * refreshes in the background; the confirmation never waits for that.
 *
 * Save never spins forever: after DIRECT_SUPERIOR_CONFIRM_WITHIN_MS without an answer, or when the answer
 * cannot be read, the card says the result could not be confirmed and points at Employment History. It
 * never retries by itself. A manual retry of a change that did commit is refused by the service in plain
 * words ("already saved"), so nothing is recorded twice.
 *
 * The action is called as a plain async call, deliberately NOT through useActionState/startTransition: an
 * unanswered async transition entangles every later transition in React (router.refresh and the Link to
 * Employment History included) until it settles, which would freeze the very way out this card offers.
 */
export function DirectSuperiorChangeForm({ action, children, employmentId, currentLineId, historyHref, labels,
  confirmWithinMs = DIRECT_SUPERIOR_CONFIRM_WITHIN_MS }: {
  action: (previous: DirectSuperiorSaveOutcome, data: FormData) => Promise<DirectSuperiorSaveOutcome>;
  children: ReactNode;
  employmentId: string;
  currentLineId: string | null;
  historyHref: string;
  labels: Record<'title' | 'amendment' | 'movement' | 'effectiveDate' | 'reason' | 'cancel' | 'save'
    | 'uncertain' | 'checkHistory' | 'current' | 'none', string>;
  confirmWithinMs?: number;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' });
  const [review, setReview] = useState(false);
  const [mode, setMode] = useState<ChangeMode>('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  const [resets, setResets] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const busy = waiting !== null && waiting === submitted && timedOut !== submitted;

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setTimedOut(waiting), confirmWithinMs);
    return () => clearTimeout(timer);
  }, [waiting, confirmWithinMs]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    // Correlates this click with its answer only; it is never an idempotency key or a secret.
    const submissionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    data.set('submissionId', submissionId);
    setSubmitted(submissionId);
    setWaiting(submissionId);
    setTimedOut(null);
    void action({ status: 'idle' }, data).then(
      result => result,
      // A redirect (an expired session) is navigation, not a result. Anything else means the answer was
      // lost: the write may or may not have committed.
      error => isActionRedirect(error) ? null : { status: 'uncertain' as const, submissionId },
    ).then(result => {
      if (!mounted.current || !result) return;
      const settled: Outcome = result.status === 'idle' ? { status: 'uncertain', submissionId } : { ...result, submissionId };
      setWaiting(current => current === submissionId ? null : current);
      setOutcome(settled);
      if (settled.status === 'saved') {
        // The saved change closes the review and resets the fields to the refreshed current superior.
        setReview(false);
        setMode('');
        setResets(count => count + 1);
        startTransition(() => router.refresh());
      }
    });
  };

  const answered = outcome.status !== 'idle' && outcome.submissionId === submitted;
  const shown: Outcome | null = answered ? outcome : submitted && timedOut === submitted
    ? { status: 'uncertain', submissionId: submitted } : null;

  return (
    <div className="space-y-3">
      <form key={`${currentLineId ?? 'unassigned'}:${resets}`} onSubmit={submit} aria-busy={busy}
        className="grid items-end gap-3 sm:grid-cols-3">
        <input type="hidden" name="employmentId" value={employmentId} />
        <input type="hidden" name="currentLineId" value={currentLineId ?? ''} />
        {children}
        {!review && <div>
          <button type="button" className={btnPrimary} onClick={() => setReview(true)}>{labels.save}</button>
        </div>}
        {review && (
          <fieldset className="space-y-3 rounded-lg border border-border p-4 sm:col-span-3">
            <legend className="px-1 font-semibold">{labels.title}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(['amend', 'movement'] as const).map(option => (
                <label key={option} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input type="radio" name="superiorChangeMode" value={option} required
                    checked={mode === option} onChange={() => setMode(option)} className="mt-0.5" />
                  {option === 'amend' ? labels.amendment : labels.movement}
                </label>
              ))}
            </div>
            {mode === 'movement' && <label className="block max-w-48 text-sm">
              {labels.effectiveDate}
              <input className={inputCls} {...personnelWorkflowInput('employment_history.event_information.effectivefrom', 'movement', 'record')} />
            </label>}
            {!!mode && <label className="block text-sm">
              {labels.reason}
              <input className={inputCls} {...personnelWorkflowInput('employment_history.event_information.correctionreason', 'movement', 'record')} maxLength={200} />
            </label>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btnGhost} disabled={busy} onClick={() => { setMode(''); setReview(false); }}>{labels.cancel}</button>
              <ActionButton type="submit" actionKind="saving" className={btnPrimary} disabled={!mode} aria-busy={busy}>{labels.save}</ActionButton>
            </div>
          </fieldset>
        )}
      </form>
      {shown?.status === 'refused' && (
        <p role="alert" data-direct-superior-outcome="refused" className="text-sm font-medium text-destructive">
          {/* PR 224 — a database refusal carries a DB- reference: the shared explanation, in the viewer's language. */}
          {parseDatabaseErrorRef(shown.message) ? <DatabaseErrorText message={shown.message} /> : shown.message}
        </p>
      )}
      {shown?.status === 'uncertain' && (
        <div role="alert" data-direct-superior-outcome="uncertain" className="rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          <p>{labels.uncertain}</p>
          <Link href={historyHref} className="font-medium underline underline-offset-2">{labels.checkHistory}</Link>
        </div>
      )}
      {shown?.status === 'saved' && (
        <div role="status" data-direct-superior-outcome="saved" className="rounded-md border border-emerald-500/50 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-100">
          <p className="font-medium">{shown.message}</p>
          {shown.current !== undefined && <p>{labels.current}: {shown.current?.label ?? labels.none}</p>}
        </div>
      )}
    </div>
  );
}
