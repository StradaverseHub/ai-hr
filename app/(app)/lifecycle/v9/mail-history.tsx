'use client';
import { UpdatedEmailReview } from './updated-email-review';
import { useState } from 'react';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
import type { Mail } from '@/lib/lifecycle-v9-model';
const statuses: Record<Mail['status'], string> = { pending: 'Queued for delivery', sending: 'Sending', sent: 'Sent', failed: 'Delivery failed', uncertain: 'Delivery outcome uncertain', cancelled: 'Cancelled' };
const errors: Record<string, string> = { relayUnavailable: 'Email delivery is unavailable. The message is held until the configured relay is ready.', recipientUnavailable: 'The recipient has no available verified delivery address.', recipientChanged: 'The recipient account changed. Review the recipient before sending again.', notEligible: 'The case, recipient or saved documents no longer meet the delivery requirements.', documentChanged: 'The saved document changed. Review the document before sending again.', smtpTemporary: 'The relay temporarily rejected delivery. Review before sending again.', smtpRejected: 'The relay rejected delivery.', smtpAuthentication: 'The configured relay could not authenticate.', smtpTls: 'The relay connection could not be verified.', uncertain: 'The relay acknowledgement was lost or incomplete. Review the delivery receipt before sending another copy.' };
type Result = { ok: boolean; error?: string };
type Props = { caseId?:string; mails: Mail[]; userName?: (id: string) => string; open?: boolean; busy?: boolean; command?: (command: LifecycleV9Command) => Promise<Result> };
function timestamp(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(value));
}
export function CaseMailHistory({ mails, userName = () => 'Linked recipient', ...props }: Props) {
  if (!mails.length) return null;
  return <ul className="v9-list" aria-label="Email delivery history">{mails.map(mail => <DeliveryRow key={mail.id} mail={mail} userName={userName} replaced={mails.some(next => next.retryOf === mail.id)} {...props}/>)}</ul>;
}
function DeliveryRow({ mail, userName, replaced, open, busy, command, caseId }: Omit<Props, 'mails'> & { mail: Mail; userName: (id: string) => string; replaced: boolean }) {
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [queued, setQueued] = useState(false);
  const retryable = !!command && open && !replaced && mail.status === 'failed' && ['smtpTemporary','smtpRejected','smtpAuthentication','smtpTls'].includes(mail.failure ?? '');
  async function retry() {
    setError('');
    try { const result = await command!({ type: 'emailRetry', id: mail.id, reason }); if (result.ok) { setQueued(true); setReason(''); } else setError(result.error ?? 'The retry could not be queued. Your review is still here.'); }
    catch { setError('The retry could not be queued. Your review is still here.'); }
  }
  return <li id={`delivery-${mail.id}`}><strong>{mail.subject}</strong>
    <div className="v9-muted">{statuses[mail.status]} · {mail.to.map((id, index) => mail.delivery?.toNames[index] ?? userName(id)).join(', ')}{mail.cc.length ? ' · CC ' + mail.cc.map((id, index) => mail.delivery?.ccNames[index] ?? userName(id)).join(', ') : ''}</div>
    {mail.failure && <p className="v9-error">{errors[mail.failure] ?? 'Delivery requires review.'}</p>}
    {mail.retryOf && <p><a className="v9-link" href={`#delivery-${mail.retryOf}`}>{mail.retryMode==='updated'?'Updated copy of an earlier delivery':'Retry of an earlier delivery'}</a>{mail.retryReason ? ` · ${mail.retryReason}` : ''}</p>}
    <details><summary>Review delivery</summary><div className="v9-stack">
      <p>Queued: <time dateTime={mail.at}>{timestamp(mail.at)}</time></p>
      <p>Delivery confirmed: {mail.status === 'sent' && mail.deliveredAt ? <time dateTime={mail.deliveredAt}>{timestamp(mail.deliveredAt)}</time> : 'No acknowledgement recorded'}</p>
      {mail.test && <p>Test message to the signed-in sender.</p>}
      {mail.delivery?.contact && <p>Onboarding contact: {mail.delivery.contact.email}</p>}
      <p className="v9-prewrap">{mail.body}</p>
      {mail.delivery?.assets?.length ? <p>Shared files and images: {mail.delivery.assets.map(asset => asset.name).join(', ')}</p> : null}
      {mail.status === 'uncertain' && <p className="v9-notice v9-warning">Check the relay receipt before sending another copy. An uncertain delivery cannot be retried here.</p>}
      {replaced && <p>A later delivery attempt is recorded below. This original receipt is retained.</p>}
      {error && <p className="v9-notice v9-error" role="alert">{error}</p>}
      {queued && <p role="status">Retry queued for delivery.</p>}
      {caseId&&command&&open&&!replaced&&!mail.test&&mail.templateId&&['failed','cancelled'].includes(mail.status)&&['smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','recipientUnavailable','recipientChanged','documentChanged','notEligible'].includes(mail.failure??'')&&<UpdatedEmailReview caseId={caseId} mailId={mail.id} busy={!!busy} command={command}/>}
      {retryable && !queued && <><p>Retry sends the same saved message and attachments. The original delivery remains in history.</p><label className="v9-field">Delivery review reason<textarea maxLength={4000} rows={3} value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></label><button type="button" className="v9-button" disabled={busy || !reason.trim()} onClick={() => void retry()}>Queue retry</button></>}
    </div></details>
  </li>;
}
