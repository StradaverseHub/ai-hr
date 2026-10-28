import { randomUUID } from 'node:crypto';
import {recoveryEmailDesign} from '../email-design/delivery';
import {renderEmailDesign} from '../email-design/render';
import {recoveryEmailContent} from '../account-email-content';
import { client } from '../../db/client';
import { internalConfig } from './config';
import { digest, opaque, validOpaque, passwordHash, validatePassword } from './crypto';
import { authTransaction, readRecord, writeRecord, deleteRecord, revokeCredentialsSessions } from './store';
import { canonicalOrg, credentialByLogin, takeRate, InternalAuthError, verifyCredentialFactor, type Credential } from './service';
import { sendInternalMail, type MailTransport } from './mail';
import { AccountEmailDeliveryError } from '../account-email-model';
import { attemptAccountEmail } from '../../core/account-email';
type Recovery = { subject: string; version: string };
export type RecoveryContext = { subject: string; issuer: string; tenantId: string; version: string; email: string; organization: string; username: string };
/** Public request confirmation never discloses account existence or SMTP readiness. */
export async function requestRecovery(organization: string, username: string, transport?: MailTransport,
  dispatch: (attempt: () => Promise<void>) => void | Promise<void> = attempt => attempt()) {
  await takeRate('recovery-global', 120, 3600_000);
  await takeRate(`recovery:${canonicalOrg(organization)}:${username.trim().toLowerCase()}`, 3, 3600_000);
  const c = await credentialByLogin(organization, username);
  if (!c?.enabled || !c.emailVerified) return;
  const delivery = await authTransaction(c.subject, async tx => {
    const current = await readRecord<Credential>(tx, `credential:${c.subject}`, true);
    if (!current?.enabled || current.version !== c.version) return null;
    const principal = await tx.unsafe('select tenant_id from app.principal_by_identity($1,$2)', [current.issuer, current.subject]);
    if (principal[0]?.tenant_id !== current.tenantId) return null;
    const rows = await tx.unsafe('select * from app.account_email_request_recovery($1)', [current.email]);
    const job = rows[0]; if (!job) return null;
    await writeRecord(tx, `recovery-mail:${job.id}`, { subject: current.subject, issuer: current.issuer, tenantId: current.tenantId,
      version: current.version, email: current.email, organization: current.organization, username: current.username } satisfies RecoveryContext, current.subject);
    return { id: job.id as string, lease: job.lease_token as string };
  });
  if (delivery) await dispatch(async () => attemptAccountEmail(delivery.id, delivery.lease, {
    sendInvitation: async () => { throw new AccountEmailDeliveryError('notEligible'); },
    sendPasswordReset: (email, context) => sendInternalRecovery(email, context, transport),
    emailReadiness: (await import('../identity/account-email-readiness')).accountEmailReadiness,
  }));
}
/** Exact delivery lease + authenticated original account binding; an email address is never a lookup. */
export async function sendInternalRecovery(email: string, context?: { deliveryId: string; leaseToken: string }, transport?: MailTransport) {
  if (!context) throw new AccountEmailDeliveryError('notEligible');
  const rows = await client.unsafe('select app.internal_auth_recovery_source($1::uuid,$2::uuid) id', [context.deliveryId, context.leaseToken]);
  const source = rows[0]?.id;
  if (!source) throw new AccountEmailDeliveryError('notEligible');
  const binding = await readRecord<RecoveryContext>(client, `recovery-mail:${source}`);
  if (!binding || binding.email !== email) throw new AccountEmailDeliveryError('notEligible');
  const token = await authTransaction(binding.subject, async tx => {
    const c = await readRecord<Credential>(tx, `credential:${binding.subject}`, true);
    if (!c?.enabled || !c.emailVerified || c.version !== binding.version || c.issuer !== binding.issuer ||
      c.tenantId !== binding.tenantId || c.email !== binding.email) throw new AccountEmailDeliveryError('notEligible');
    const principal = await tx.unsafe('select tenant_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
    if (principal[0]?.tenant_id !== c.tenantId) throw new AccountEmailDeliveryError('notEligible');
    const previous = await readRecord<{ key: string }>(tx, `recovery-active:${c.subject}`);
    if (previous) await deleteRecord(tx, previous.key);
    const raw = opaque(), key = `recovery:${digest(raw)}`;
    await writeRecord(tx, key, { subject: c.subject, version: c.version } satisfies Recovery, c.subject, Date.now() + 30 * 60_000);
    await writeRecord(tx, `recovery-active:${c.subject}`, { key }, c.subject);
    return raw;
  });
  const [principal]=await client.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)',[binding.issuer,binding.subject]);
  if(principal?.tenant_id!==binding.tenantId||!principal.app_user_id)throw new AccountEmailDeliveryError('notEligible');
  const design=await recoveryEmailDesign({tenantId:binding.tenantId,userId:principal.app_user_id}),link=`${internalConfig().origin}/reset-password#token=${token}`;
  await sendInternalMail({to:email,...renderEmailDesign(design.document,'recovery',design.locale,{...recoveryEmailContent(link),link},{...design.data,expiry_minutes:'30'})},transport);
}
export async function completeRecovery(raw: string, password: string, code: string) {
  if (!validOpaque(raw)) throw new InternalAuthError('invalidChallenge');
  const key = `recovery:${digest(raw)}`, initial = await readRecord<Recovery>(client, key);
  if (!initial) throw new InternalAuthError('invalidChallenge');
  await takeRate(`recovery-complete:${initial.subject}`, 10);
  const result = await authTransaction(initial.subject, async tx => {
    const value = await readRecord<Recovery>(tx, key, true), c = await readRecord<Credential>(tx, `credential:${initial.subject}`, true);
    if (!value || !c?.enabled || c.version !== value.version) throw new InternalAuthError('invalidChallenge');
    const principal = await tx.unsafe('select tenant_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
    if (principal[0]?.tenant_id !== c.tenantId) throw new InternalAuthError('invalidChallenge');
    try { validatePassword(password, c.username, c.email); } catch { throw new InternalAuthError('passwordPolicy'); }
    if (c.totpSecret && !await verifyCredentialFactor(c, code)) return false;
    c.password = await passwordHash(password); c.version = randomUUID(); c.mustChange = false;
    await revokeCredentialsSessions(tx, c.subject);
    await writeRecord(tx, `credential:${c.subject}`, c, c.subject);
    await deleteRecord(tx, key);
    const p = await tx.unsafe('select app_user_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
    if (p[0]) await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.password-reset','user',$2::uuid,NULL)", [c.tenantId, p[0].app_user_id]);
    return true;
  });
  if (!result) throw new InternalAuthError('invalidCode');
}
