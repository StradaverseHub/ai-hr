/** Recruitment candidate e-mail transport selection (slice 19). Compatibility adapters (WorkOS, Keycloak) do not claim a capability
 * they cannot verify: candidate e-mail is available only with the embedded relay (AUTH_PROVIDER=internal) and an active relay for
 * the tenant. Nothing is queued otherwise, and the settings page says so. */
import { internalSelected } from './internal-auth/config';

/** One frozen candidate e-mail as the relay sends it. */
export type CandidateMail = { to: string; subject: string; text: string; html: string; senderName: string; replyTo: string; messageId: string };
/** A send that failed before any SMTP connection was attempted, so nothing can have reached the relay: an invalid message (refused by
 * the transport's own validation) or a relay that could not be prepared (credentials, token). Recorded as failed, never uncertain. */
export class CandidateMailNotSent extends Error {
  constructor(public readonly code: 'invalidMessage' | 'relayPreparation') {
    super(`candidate mail not sent: ${code}`);
    this.name = 'CandidateMailNotSent';
  }
}
/** A tenant's sender for one sweep: the relay version it starts on, the installation host for Message-IDs, and the send itself. */
export type CandidateEmailSender = { revision: string; host: string; send: (mail: CandidateMail) => Promise<void> };

/** The tenant's sender, or null when this installation cannot send candidate e-mail. */
export async function candidateEmailSender(tenantId: string): Promise<CandidateEmailSender | null> {
  if (!internalSelected()) return null;
  return (await import('./internal-auth/recruitment-candidate-mail')).internalCandidateEmailSender(tenantId);
}

const AVAILABILITY_TTL_MS = 30_000;
const known = new Map<string, { at: number; available: boolean }>();
/** Whether the tenant can send candidate e-mail now (cached per process for 30 seconds: pages and the public careers path ask often;
 * the sweep asks candidateEmailSender itself). A relay that cannot be read counts as unavailable. */
export async function candidateEmailAvailable(tenantId: string): Promise<boolean> {
  if (!internalSelected()) return false;
  const hit = known.get(tenantId);
  if (hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return hit.available;
  const available = await candidateEmailSender(tenantId).then((s) => s !== null, () => false);
  if (known.size > 10_000) known.clear();
  known.set(tenantId, { at: Date.now(), available });
  return available;
}
