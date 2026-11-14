/**
 * Candidate e-mail delivery (slice 19): one tenant's step of the minute sweep (scripts/notification-email-sweep.ts), on the sweep's
 * own owner connection, modelled on lifecycle v9 delivery (packs/lifecycle/v9/service.ts v9DeliverEmails, 0714/0717):
 *
 *   purge  — the address and content of e-mails 90 days past their final state go (bounded, set-based);
 *   claim  — up to DELIVERY_BATCH due e-mails are leased (FOR UPDATE SKIP LOCKED: concurrent sweeps never claim one row twice);
 *            an expired STARTED lease becomes 'uncertain' first and is never sent again automatically;
 *   target — the frozen row is re-read by id and lease token (nothing while the company's switch is off: failed, not eligible);
 *   start  — a separate committed statement marks it 'sending' BEFORE any SMTP byte;
 *   send   — the relay gets exactly the frozen recipient, subject, text, HTML, display name and reply-to, with a deterministic
 *            Message-ID <recruitment-candidate-email.<id>@<installation host>>;
 *   finish — sent / retry (4xx, at most 5 attempts with backoff) / failed (5xx, authentication, TLS; or before any connection an invalid
 *            message or a relay that could not be prepared) / uncertain; a lost finish is
 *            never a reason to send again (the lease runs out and the row becomes uncertain).
 * When the installation cannot send (no embedded relay, no active relay), claimed e-mails are held (due again in 5 minutes, the
 * attempt not counted; failed as relay unavailable after 7 days). An e-mail whose frozen address is no longer the candidate's recorded
 * e-mail, or whose company switched candidate e-mail off, is not sent (failed, not eligible). Every database step is an owner-only 5220 function that takes the id and token, never an address or words.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import type { NotificationSweepConnection } from '../../core/notice-projection';
import { isModuleEnabled } from '../../core/entitlements';
import { notificationSmtpFailure } from '../../lib/notification-email-model';
import { CandidateMailNotSent, candidateEmailSender, type CandidateEmailSender } from '../../lib/recruitment-candidate-email-ipc';

export const DELIVERY_BATCH = 25;
export const PURGE_BATCH = 500;
/** Per-message outcomes (sent … held) are the candidates' own matter and only logged. `operational` counts the failures that say the
 *  installation's relay is broken — authentication, TLS, or a relay that could not be prepared — which the sweep reports as a failed
 *  run (as it does for letter mail); a bad candidate address never does. */
export type CandidateEmailDeliveryResult = { claimed: number; sent: number; retry: number; failed: number; uncertain: number; held: number; purged: number; operational: number };
const OPERATIONAL = new Set(['smtpAuthentication', 'smtpTls', 'relayPreparation']);
type Target = { eligible: false } | { eligible: true; recipient: string; subject: string; text: string; html: string; senderName: string; replyTo: string };

/** The sweep step for one tenant. `sender` is injected by tests (a faked transport); production resolves the tenant's relay. */
export async function deliverCandidateEmails(ctx: SessionContext, connection: NotificationSweepConnection,
  sender: (tenantId: string) => Promise<CandidateEmailSender | null> = candidateEmailSender): Promise<CandidateEmailDeliveryResult> {
  const out: CandidateEmailDeliveryResult = { claimed: 0, sent: 0, retry: 0, failed: 0, uncertain: 0, held: 0, purged: 0, operational: 0 };
  if (ctx.userId) throw new Error('Candidate e-mail delivery runs as the sweep.');
  if (!isModuleEnabled(ctx, 'recruitment')) return out;
  const one = async <T>(statement: ReturnType<typeof sql>): Promise<T | undefined> =>
    (await connection.withTenant(ctx, (tx) => tx.execute<{ r: T }>(statement)))[0]?.r;
  out.purged = Number(await one<number>(sql`select app.recruitment_candidate_email_purge(${PURGE_BATCH}) as r`) ?? 0);
  const claims = await connection.withTenant(ctx, (tx) => tx.execute<{ email_id: string; token: string }>(
    sql`select email_id, token from app.recruitment_candidate_email_claim(${DELIVERY_BATCH})`));
  out.claimed = claims.length;
  if (!claims.length) return out;
  let relay: CandidateEmailSender | null = null;
  try { relay = await sender(ctx.tenantId); } catch { relay = null; }
  for (const claim of claims) {
    const finish = (outcome: string, error: string | null) =>
      one<boolean>(sql`select app.recruitment_candidate_email_finish(${claim.email_id}::uuid, ${claim.token}::uuid, ${outcome}, ${error}) as r`);
    try {
      if (!relay) {
        if (await finish('held', 'relayUnavailable')) out.held++;
        continue;
      }
      const target = await one<Target | null>(sql`select app.recruitment_candidate_email_target(${claim.email_id}::uuid, ${claim.token}::uuid) as r`);
      if (!target) continue;
      if (!target.eligible) {
        if (await finish('skipped', 'notEligible')) out.failed++;
        continue;
      }
      // Committed before the relay sees a byte: from here on a crash is 'uncertain', never a second send.
      const started = await one<boolean>(sql`select app.recruitment_candidate_email_start(${claim.email_id}::uuid, ${claim.token}::uuid, ${relay.revision}) as r`);
      if (!started) continue;
      let result: { outcome: string; error: string | null };
      try {
        await relay.send({ to: target.recipient, subject: target.subject, text: target.text, html: target.html, senderName: target.senderName,
          replyTo: target.replyTo, messageId: `<recruitment-candidate-email.${claim.email_id}@${relay.host}>` });
        result = { outcome: 'sent', error: null };
      } catch (error) {
        // Failed before any SMTP connection (validation, relay preparation): nothing was sent, so failed with its own code.
        result = error instanceof CandidateMailNotSent ? { outcome: 'failed', error: error.code } : notificationSmtpFailure(error);
      }
      const finished = await finish(result.outcome, result.error).catch(() => false);
      if (!finished) { out.uncertain++; continue; }
      if (result.error && OPERATIONAL.has(result.error)) out.operational++;
      if (result.outcome === 'sent') out.sent++;
      else if (result.outcome === 'retry') out.retry++;
      else if (result.outcome === 'failed') out.failed++;
      else out.uncertain++;
    } catch {
      // Only the durable started/receipt state decides what happens next; the row is never sent again from here.
      out.uncertain++;
    }
  }
  return out;
}
