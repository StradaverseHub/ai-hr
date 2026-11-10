'use client';
import { useRef } from 'react';
import { btnGhost, btnPrimary } from '@/components/ui';

type Labels = { open: string; title: string; reason: string; choose: string; external: string; confirm: string; cancel: string };

/**
 * Reject with a reason: a modal form whose reason is required here AND by the service (an archive reason of the
 * application's company is mandatory there; the database refuses an archived row without one).
 */
export function RejectDialog({ action, applicationId, returnTo, candidateName, reasons, labels }: {
  action: (form: FormData) => void | Promise<void>; applicationId: string; returnTo: string; candidateName: string;
  reasons: { id: string; internal: string; external: string }[]; labels: Labels;
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
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => dialog.current?.close()}>{labels.cancel}</button>
            <button type="submit" className={btnPrimary}>{labels.confirm}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
