import { randomUUID } from 'node:crypto';
import { client } from '../../db/client';
import { internalConfig } from './config';
import { digest, opaque, validOpaque, passwordHash, validatePassword } from './crypto';
import { authTransaction, readRecord, writeRecord, deleteRecord, revokeCredentialsSessions } from './store';
import { credentialByLogin, takeRate, InternalAuthError, verifyCredentialFactor, type Credential } from './service';
import { queueAuthMail, recoveryMailReady } from './mail';
type Recovery = { subject: string; version: string };
export async function requestRecovery(organization: string, username: string) {
  await takeRate('recovery-global', 120, 3600_000);
  await takeRate(`recovery:${organization.trim().toLowerCase()}:${username.trim().toLowerCase()}`, 3, 3600_000);
  if (!await recoveryMailReady()) throw new InternalAuthError('unavailable');
  const c = await credentialByLogin(organization, username);
  if (!c?.enabled || !c.emailVerified) return;
  await authTransaction(c.subject, async tx => {
    const current = await readRecord<Credential>(tx, `credential:${c.subject}`, true);
    if (!current?.enabled || current.version !== c.version) return;
    const raw = opaque();
    await writeRecord(tx, `recovery:${digest(raw)}`, { subject: c.subject, version: c.version } satisfies Recovery, c.subject, Date.now() + 30 * 60_000);
    await queueAuthMail(tx, c, 'Reset your AI HR password', `A password reset was requested for your AI HR login.\n\nOpen this link within 30 minutes:\n${internalConfig().origin}/reset-password#token=${raw}\n\nYour authenticator or a recovery code is still required if MFA is enrolled. If you did not request this, you can ignore this email.`);
  });
}
export async function completeRecovery(raw: string, password: string, code: string) {
  if (!validOpaque(raw)) throw new InternalAuthError('invalidChallenge');
  const key = `recovery:${digest(raw)}`, initial = await readRecord<Recovery>(client, key);
  if (!initial) throw new InternalAuthError('invalidChallenge');
  await takeRate(`recovery-complete:${initial.subject}`, 10);
  const result = await authTransaction(initial.subject, async tx => {
    const value = await readRecord<Recovery>(tx, key, true), c = await readRecord<Credential>(tx, `credential:${initial.subject}`, true);
    if (!value || !c?.enabled || c.version !== value.version) throw new InternalAuthError('invalidChallenge');
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
