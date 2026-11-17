'use client';
import { useEffect, useRef, useState } from 'react';
import type { InvitationOffer, InvitationPreview } from '@/packs/recruitment/service';
import { previewInvitationAction } from '../../actions';

/** The schedule form fields the invitation is made of (interviewers never are). */
const FIELDS = ['roundNo', 'type', 'startsAt', 'durationMinutes', 'addressId', 'roomId', 'site', 'meetingRoom'] as const;

export type InvitationLabels = {
  send: string; note: string; reminder: string | null; noReminder: string | null; incomplete: string; preview: string; fromLine: string; subjectLine: string;
  blocked: { no_address: string; value_link: string };
};

/**
 * Slice 20: "E-mail the candidate an invitation" inside the schedule form (ticked by default while the company's candidate e-mail is
 * on). As the person types, the server renders the e-mail of what the form holds (previewInvitationAction: the same renderer and the
 * same stored wording, sender, address and room the saved interview is frozen with) and the panel shows it; when ticked, the form posts
 * exactly the subject and text shown, and the server refuses the save if the saved interview would render differently.
 */
export function InvitationPanel({ applicationId, offer, labels }: { applicationId: string; offer: InvitationOffer; labels: InvitationLabels }) {
  const ref = useRef<HTMLFieldSetElement>(null);
  const [preview, setPreview] = useState<InvitationPreview>({ status: 'incomplete' });
  const [send, setSend] = useState(offer.recipient !== null);
  const latest = useRef(0);
  useEffect(() => {
    const form = ref.current?.closest('form');
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const data = new FormData(form);
        const input: Record<string, string> = { applicationId };
        for (const k of FIELDS) input[k] = String(data.get(k) ?? '');
        const n = ++latest.current;
        previewInvitationAction(input).then((p) => { if (n === latest.current) setPreview(p); }, () => { if (n === latest.current) setPreview({ status: 'unavailable' }); });
      }, 350);
    };
    const onEdit = (e: Event) => { if ((FIELDS as readonly string[]).includes((e.target as HTMLInputElement | null)?.name ?? '')) refresh(); };
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    refresh();
    return () => { clearTimeout(timer); form.removeEventListener('input', onEdit); form.removeEventListener('change', onEdit); };
  }, [applicationId]);
  const ready = preview.status === 'ready' && preview.blocked === null && offer.recipient !== null;
  const blocked = offer.recipient === null ? labels.blocked.no_address : preview.status === 'ready' && preview.blocked ? labels.blocked[preview.blocked] : null;
  return (
    <fieldset ref={ref} className="space-y-2 rounded-lg border border-border p-3 text-sm sm:col-span-3">
      <label className="flex items-start gap-2">
        <input type="checkbox" name="sendInvitation" className="mt-0.5 accent-primary" checked={send && ready} disabled={!ready} onChange={(e) => setSend(e.target.checked)} />
        <span>
          <span className="font-medium">{labels.send}</span>
          {offer.recipient && <span className="block text-xs text-muted-foreground">{labels.note}</span>}
          {offer.recipient && <span className="block text-xs text-muted-foreground">{labels.reminder ?? labels.noReminder}</span>}
        </span>
      </label>
      {blocked && <p className="text-xs text-destructive" role="status">{blocked}</p>}
      {!blocked && preview.status !== 'ready' && <p className="text-xs text-muted-foreground" role="status">{labels.incomplete}</p>}
      {preview.status === 'ready' && (
        <div className="space-y-1 rounded-md bg-muted/40 p-2" aria-live="polite">
          <p className="text-xs font-medium text-muted-foreground">{labels.preview}</p>
          <p className="text-xs text-muted-foreground">{labels.fromLine}</p>
          <p className="font-medium">{labels.subjectLine.replace('{subject}', preview.subject)}</p>
          <p className="max-h-72 overflow-auto whitespace-pre-wrap">{preview.text}</p>
        </div>
      )}
      {send && ready && preview.status === 'ready' && (
        <>
          <input type="hidden" name="invitationSubject" value={preview.subject} />
          <input type="hidden" name="invitationText" value={preview.text} />
        </>
      )}
    </fieldset>
  );
}
