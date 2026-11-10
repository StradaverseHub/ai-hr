'use client';

import { startTransition, useActionState } from 'react';
import { ErrorBanner, Field, Input, btnGhost, btnPrimary } from '@/components/ui';
import { addApplicationFormAction, type AddApplicationState } from '../actions';

/**
 * Recruitment › Candidates › Add application (slice 5). The save RETURNS its outcome, so a possible duplicate keeps the
 * form open with the typing intact. What the viewer learns about a duplicate is decided on the server: a job operator
 * gets only "a possible duplicate exists — ask an HR administrator"; an administrator sees the matches and may add the
 * application to an existing candidate or confirm a separate one. The form has no `action` prop: onSubmit dispatches
 * the action itself (with the clicked button's value), so React never resets the typed values.
 * NO t() HERE: every string arrives translated.
 */
export type AddApplicationLabels = {
  job: string; choose: string; required: string; fullName: string; email: string; phone: string; idType: string; idNumber: string; idNone: string;
  source: string; add: string; adding: string; duplicateTitle: string; duplicateAskAdmin: string; duplicateAdmin: string; useExisting: string;
  createSeparate: string; matchedOn: string; noApplications: string;
};

export function AddApplicationForm({ returnTo, jobs, defaultJob, sources, idTypes, matchLabels, stateLabels, labels }: {
  returnTo: string;
  jobs: { id: string; label: string }[];
  defaultJob: string;
  sources: { value: string; label: string }[];
  idTypes: { value: string; label: string }[];
  /** idNumber / email / name / mobile → translated. */
  matchLabels: Record<string, string>;
  /** active / hired / archived → translated. */
  stateLabels: Record<string, string>;
  labels: AddApplicationLabels;
}) {
  const [state, formAction, pending] = useActionState<AddApplicationState, FormData>(addApplicationFormAction, { status: 'idle' });
  const v = state.values ?? {};
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(formData));
      }}
      className="space-y-3"
    >
      <input type="hidden" name="returnTo" value={returnTo} />
      <ErrorBanner message={state.status === 'error' ? state.errorText : undefined} />
      <Field label={labels.job} required requiredAriaLabel={labels.required}>
        <select name="jobId" defaultValue={v.jobId ?? defaultJob} required key={`job-${state.nonce ?? 0}`}
          className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20">
          <option value="" disabled>{labels.choose}</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
        </select>
      </Field>
      <Field label={labels.fullName} required requiredAriaLabel={labels.required}><Input key={`n-${state.nonce ?? 0}`} name="fullName" required maxLength={200} defaultValue={v.fullName ?? ''} /></Field>
      <Field label={labels.email}><Input key={`e-${state.nonce ?? 0}`} name="email" type="email" maxLength={254} defaultValue={v.email ?? ''} /></Field>
      <Field label={labels.phone}><Input key={`p-${state.nonce ?? 0}`} name="phone" maxLength={40} defaultValue={v.phone ?? ''} /></Field>
      <div className="grid grid-cols-[8rem_1fr] gap-2">
        <Field label={labels.idType}>
          <select key={`it-${state.nonce ?? 0}`} name="idType" defaultValue={v.idType ?? ''}
            className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20">
            <option value="">{labels.idNone}</option>
            {idTypes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label={labels.idNumber}><Input key={`in-${state.nonce ?? 0}`} name="idNumber" maxLength={40} autoComplete="off" defaultValue={v.idNumber ?? ''} /></Field>
      </div>
      <Field label={labels.source}>
        <select key={`s-${state.nonce ?? 0}`} name="candidateSource" defaultValue={v.candidateSource ?? ''}
          className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20">
          <option value="">{labels.choose}</option>
          {sources.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>

      {state.status === 'duplicate' && state.duplicate && (
        <div role="alert" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">{labels.duplicateTitle}</p>
          {state.duplicate.matches === null ? <p>{labels.duplicateAskAdmin}</p> : (
            <>
              <p>{labels.duplicateAdmin}</p>
              <ul className="space-y-2">
                {state.duplicate.matches.map((m) => (
                  <li key={m.candidateId} className="space-y-1 rounded-md border border-border bg-card p-2">
                    <p className="font-medium">{m.fullName}</p>
                    <p className="text-xs text-muted-foreground">{[m.email, m.phone].filter(Boolean).join(' · ')}</p>
                    <p className="text-xs">{labels.matchedOn} {m.matchedOn.map((k) => matchLabels[k] ?? k).join(', ')}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.applications.length ? m.applications.map((a) => `${a.jobTitle} · ${a.jobNumber} (${stateLabels[a.state] ?? a.state})`).join('; ') : labels.noApplications}
                    </p>
                    <button type="submit" name="existingCandidateId" value={m.candidateId} className={btnGhost} disabled={pending}>{labels.useExisting}</button>
                  </li>
                ))}
              </ul>
              <button type="submit" name="confirmSeparate" value="1" className={btnGhost} disabled={pending}>{labels.createSeparate}</button>
            </>
          )}
        </div>
      )}
      <button type="submit" className={btnPrimary} disabled={pending}>{pending ? labels.adding : labels.add}</button>
    </form>
  );
}
