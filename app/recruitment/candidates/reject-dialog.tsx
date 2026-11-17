'use client';
import { useRef } from 'react';
import { btnGhost, btnPrimary } from '@/components/ui';

type Labels = { open: string; title: string; reason: string; choose: string; external: string; confirm: string; cancel: string };
/** Slice 19: the rejection e-mail offered in the dialog, rendered on the server exactly as it would be queued (null: not offered). */
export type RejectEmailOffer = {
  /** The candidate's usable recorded address; null when there is none (nothing can be sent). */
  address: string | null;
  /** Why the e-mail cannot be sent (no usable address; a link-like name or job title), translated; null when it can. */
  blocked: string | null;
  fromLine: string; subjectLine: string; text: string; fingerprint: string;
  labels: { send: string; sendNote: string; delay: string; delays: { value: string; label: string }[]; preview: string };
};

/**
 * Reject with a reason: a modal form whose reason is required here AND by the service (an archive reason of the
 * application's company is mandatory there; the database refuses an archived row without one).
 */
export function RejectDialog({ action, applicationId, returnTo, candidateName, reasons, labels, email }: {
  action: (form: FormData) => void | Promise<void>; applicationId: string; returnTo: string; candidateName: string;
  reasons: { id: string; internal: string; external: string }[]; labels: Labels;
  email?: RejectEmailOffer | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className={btnGhost} onClick={() => dialog.current?.showModal()}>{labels.open}</button>
      <dialog ref={dialog} aria-labelledby={`reject-${applicationId}`}
        className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-black/30">
        <form action={action} className="space-y-4 p-5">
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <h2 id={`reject-${applicationId}`} className="text-base font-semibold">{labels.title}</h2>
          <p className="text-sm text-muted-foreground">{candidateName}</p>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">{labels.reason}<span className="ml-0.5 text-destructive">*</span></legend>
            {reasons.map((r) => (
              <label key={r.id} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary">
                <input type="radio" name="archiveReasonId" value={r.id} required className="mt-0.5" />
                <span>{r.internal}{r.external !== r.internal && <span className="block text-xs text-muted-foreground">{labels.external}: {r.external}</span>}</span>
              </label>
            ))}
          </fieldset>
          {email && (email.blocked !== null ? <p className="text-xs text-muted-foreground">{email.blocked}</p> : (
            // Unticked by default: nothing is sent unless the person ticks it, after seeing the e-mail below.
            <fieldset className="space-y-2 rounded-md border border-border p-3">
              <input type="hidden" name="emailFingerprint" value={email.fingerprint} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="sendEmail" className="mt-0.5" />
                <span>{email.labels.send}<span className="block text-xs text-muted-foreground">{email.labels.sendNote}</span></span>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                {email.labels.delay}
                <select name="emailDelay" defaultValue="0" className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground">
                  {email.labels.delays.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </label>
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-medium text-primary">{email.labels.preview}</summary>
                <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-2">
                  <p className="text-xs text-muted-foreground">{email.fromLine}</p>
                  <p className="font-medium">{email.subjectLine}</p>
                  <p className="max-h-60 overflow-auto whitespace-pre-wrap">{email.text}</p>
                </div>
              </details>
            </fieldset>
          ))}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => dialog.current?.close()}>{labels.cancel}</button>
            <button type="submit" className={btnPrimary}>{labels.confirm}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
