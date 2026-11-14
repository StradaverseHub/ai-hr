/** Recruitment candidate e-mail through the embedded relay (slice 19, docs/adr/2026-11-14-recruitment-candidate-email.md).
 * Authentication owns the relay: the caller supplies the frozen message and its delivery identity, never relay settings, a From
 * address or an alternate installation. The From address is the tenant's bound sender (lifecycle 'noreply' binding) or the
 * installation's active relay; only the display name and reply-to come from the company's settings, frozen on the delivery row. */
import { readLifecycleRelayTx } from './active-relay';
import { internalConfig } from './config';
import { admittedAuthSql } from './store';
import { sendSmtp, type MailTransport } from './smtp';
import { EmailSettingsError } from '../identity/email-model';
import { CandidateMailNotSent, type CandidateEmailSender, type CandidateMail } from '../recruitment-candidate-email-ipc';

/** Null when the tenant has no active relay. The sender's revision identifies the relay version a send starts on. */
export async function internalCandidateEmailSender(tenantId: string, transport: MailTransport = sendSmtp): Promise<CandidateEmailSender | null> {
  // The tenant's bound sender ('noreply') or the installation relay. The binding's own display name is not used: the company's
  // frozen sender name always travels with the message.
  const active = await readLifecycleRelayTx(admittedAuthSql, tenantId);
  if (!active) return null;
  const host = new URL(internalConfig().origin).hostname;
  return {
    revision: active.revision, host,
    send: async (mail: CandidateMail) => {
      let connecting = false;
      try {
        await transport(active.relay, { to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, attachments: [],
          senderName: mail.senderName, replyTo: mail.replyTo, messageId: mail.messageId }, { connecting: () => { connecting = true; } });
      } catch (error) {
        // Before the connection nothing was sent: the message failed validation, or the relay could not be prepared.
        if (!connecting) throw new CandidateMailNotSent(error instanceof EmailSettingsError && error.code === 'invalid' ? 'invalidMessage' : 'relayPreparation');
        throw error;
      }
    },
  };
}
