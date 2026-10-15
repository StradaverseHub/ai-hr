import { randomUUID } from 'node:crypto';
import { generateSecret } from 'otplib';
import { client } from '../../db/client';
import { internalConfig, internalIssuer } from './config';
import { digest, opaque, passwordHash, validOpaque, validatePassword } from './crypto';
import { authTransaction, readRecord, writeRecord } from './store';
import { InternalAuthError, loginKey, takeRate, type Credential, type Organization, type AuthReply } from './service';
import { sendInternalMail, type MailTransport } from './mail';
import { AccountEmailDeliveryError, type AccountEmailContext } from '../account-email-model';
export async function sendInternalInvitation(email: string, activationPath: string, context?: AccountEmailContext, transport?: MailTransport) {
  const match = /^\/invite\/([A-Za-z0-9_-]{43})\/activate$/.exec(activationPath);
  if (!match || !context) throw new AccountEmailDeliveryError('notEligible');
  const rows = await client.unsafe('select * from app.internal_auth_invitation_mail($1::uuid,$2::uuid,$3)', [context.deliveryId, context.leaseToken, digest(match[1])]);
  const invitation = rows[0];
  const org = invitation ? await readRecord<Organization>(client, `tenant:${invitation.tenant_id}`) : null;
  if (!org || invitation.email !== email) throw new AccountEmailDeliveryError('notEligible');
  await sendInternalMail({ to: email, subject: 'Your AI HR invitation',
    text: `You have been invited to AI HR. Organization code: ${org.code}. Open the link to choose your username and password and enroll your authenticator.\n\n${internalConfig().origin}${activationPath}\n\nThis invitation expires after seven days.` }, transport);
  return { invitationId: 'internal' };
}
export async function startInvitation(token: string, username: string, password: string, native = false): Promise<AuthReply> {
  if (!validOpaque(token)) throw new InternalAuthError('invalidChallenge');
  await takeRate('invite-global', 120, 3600_000);
  await takeRate(`invitation:${digest(token)}`, 5);
  const rows = await client.unsafe('select * from app.internal_auth_invitation($1)', [digest(token)]);
  const invitation = rows[0];
  if (!invitation) throw new InternalAuthError('invalidChallenge');
  const org = await readRecord<Organization>(client, `tenant:${invitation.tenant_id}`);
  username = username.trim().toLowerCase();
  if (!org || !/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username)) throw new InternalAuthError('invalidChallenge');
  try { validatePassword(password, username, invitation.email); } catch { throw new InternalAuthError('passwordPolicy'); }
  if (await readRecord(client, loginKey(org.code, username))) throw new InternalAuthError('conflict');
  const c: Credential = { subject: randomUUID(), tenantId: org.tenantId, issuer: internalIssuer(org.tenantId), organization: org.code,
    username, email: invitation.email, emailVerified: false, enabled: false, password: await passwordHash(password), mustChange: false,
    version: randomUUID(), totpSecret: null, lastStep: -1, recoveryHashes: [] };
  const raw = opaque(), secret = generateSecret(), expiresAt = Date.now() + 10 * 60_000;
  await authTransaction(c.subject, async tx => {
    // An unfinished invitation never reserves the username or creates an HR user/grant.
    await writeRecord(tx, `credential:${c.subject}`, c, c.subject, expiresAt);
    await writeRecord(tx, `challenge:${digest(raw)}`, { subject: c.subject, version: c.version, phase: 'enroll', attempts: 0,
      native, secret, invitation: token, expiresAt }, c.subject, expiresAt);
  });
  return { step: 'enroll', challenge: raw, secret, account: `${org.code}:${username}` };
}
/** Existing credentials may accept only invitations for their own tenant namespace and verified address. */
export async function acceptInternalInvitation(token: string, identity: { issuer: string; subject: string; email?: string | null; emailVerified: boolean }) {
  if (!validOpaque(token) || !identity.emailVerified) throw new InternalAuthError('invalidChallenge');
  const rows = await client.unsafe('select * from app.internal_auth_invitation($1)', [digest(token)]);
  const invitation = rows[0];
  if (!invitation || identity.issuer !== internalIssuer(invitation.tenant_id) || identity.email?.toLowerCase() !== invitation.email.toLowerCase()) throw new InternalAuthError('invalidChallenge');
  await (await import('../../core/auth')).acceptInvitation({ token, issuer: identity.issuer, subject: identity.subject, verifiedEmail: identity.email! });
}
