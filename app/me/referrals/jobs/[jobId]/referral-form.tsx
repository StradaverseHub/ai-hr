'use client';

import { startTransition, useActionState, useEffect, useRef } from 'react';
import { Field, Input, btnPrimary, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { submitReferralAction, type ReferralFormState } from '../../actions';

/**
 * The refer form (Recruitment slice 7). The save RETURNS its outcome, so a refusal keeps the typing intact; on success the
 * action moves to My referrals. The error is an alert right beside Send (announced, and scrolled into view), not a
 * banner above the form that the person has already scrolled past. The form has no `action` prop: onSubmit dispatches it, so React never resets the values.
 * NO t() HERE: every string arrives translated, including one sentence per error code.
 */
export type ReferralFormLabels = {
  fullName: string; email: string; mobile: string; contactHint: string; resume: string; resumeHint: string; reason: string; reasonHint: string;
  confirm: string; submit: string; submitting: string; required: string; errors: Record<string, string>;
};

export function ReferralForm({ jobId, accept, reasonMax, labels }: { jobId: string; accept: string; reasonMax: number; labels: ReferralFormLabels }) {
  const [state, formAction, pending] = useActionState<ReferralFormState, FormData>(submitReferralAction, { status: 'idle' });
  const v = state.values;
  const k = state.nonce ?? 0;
  const alertRef = useRef<HTMLParagraphElement>(null);
  const error = state.status === 'error' ? labels.errors[state.code ?? 'unavailable'] ?? labels.errors.unavailable : null;
  useEffect(() => {
    if (state.nonce) alertRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.nonce]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
      className="space-y-4"
    >
      <input type="hidden" name="jobId" value={jobId} />
      <Field label={labels.fullName} required requiredAriaLabel={labels.required}>
        <Input key={`n-${k}`} name="fullName" required maxLength={200} autoComplete="off" defaultValue={v?.fullName ?? ''} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={labels.email}><Input key={`e-${k}`} name="email" type="email" maxLength={254} autoComplete="off" defaultValue={v?.email ?? ''} /></Field>
        <Field label={labels.mobile}><Input key={`m-${k}`} name="mobile" type="tel" maxLength={40} autoComplete="off" defaultValue={v?.mobile ?? ''} /></Field>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{labels.contactHint}</p>
      <Field label={labels.resume}>
        <input name="resume" type="file" accept={accept} className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-sm" />
      </Field>
      <p className="-mt-2 text-xs text-muted-foreground">{labels.resumeHint}</p>
      <Field label={labels.reason} required requiredAriaLabel={labels.required}>
        <textarea key={`r-${k}`} name="reason" required maxLength={reasonMax} rows={5} defaultValue={v?.reason ?? ''} className={cn(inputCls, 'h-auto min-h-28 py-2')} />
      </Field>
      <p className="-mt-2 text-xs text-muted-foreground">{labels.reasonHint}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" required className="mt-0.5" />
        <span>{labels.confirm}</span>
      </label>
      <div className="space-y-3">
        {/* Always mounted, so a screen reader announces the message the moment it appears. */}
        <p ref={alertRef} role="alert" aria-live="assertive"
          className={cn(error ? 'rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive' : 'sr-only')}>
          {error ?? ''}
        </p>
        <button type="submit" className={btnPrimary} disabled={pending}>{pending ? labels.submitting : labels.submit}</button>
      </div>
    </form>
  );
}
