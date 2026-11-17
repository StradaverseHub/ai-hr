/** Authentication-owned projection of a case-authorized batch of sealed account bindings.
 * The SQL owner checks active principal/binding state set-wise; the canonical Auth helpers validate
 * decrypted account, password, MFA and expiry state. Never return a credential or secret to callers.
 */
import { internalIssuer } from './config';
import { AuthRecordExpiredError, decryptRecord } from './crypto';
import { parseCredential } from './credential';
import { accountAvailable } from './account-state';
import { DEFAULT_PASSWORD_POLICY, passwordExpired, passwordPolicyKey, validatePasswordPolicy, type PasswordPolicyState } from '../password-policy';
export type LifecycleRecipientBinding = { user_id: string; tenant_id: string; name: string; department: string; subject: string; issuer: string; sealed: string; policy_sealed: string | null };
export type LifecycleRecipientUser = { id: string; name: string; email: string; department: string };
export function lifecycleRecipientProjection(tenantId: string, bindings: readonly LifecycleRecipientBinding[], now = Date.now()): LifecycleRecipientUser[] {
  if (!bindings.length) return [];
  const issuer = internalIssuer(tenantId), firstPolicy = bindings[0].policy_sealed;
  // One tenant policy for the entire batch, exactly as passwordChangeRequired reads it.
  let state: PasswordPolicyState | null = null;
  try { state = firstPolicy ? decryptRecord<PasswordPolicyState>(firstPolicy, passwordPolicyKey(tenantId), now) : null; }
  catch (error) { if (!(error instanceof AuthRecordExpiredError)) throw error; }
  const policy = state ? validatePasswordPolicy(state.policy) : DEFAULT_PASSWORD_POLICY;
  const seen = new Set<string>(), out: LifecycleRecipientUser[] = [];
  for (const binding of bindings) {
    if (binding.tenant_id !== tenantId || binding.issuer !== issuer || binding.policy_sealed !== firstPolicy || seen.has(binding.user_id)) continue;
    let raw: unknown;
    try { raw = decryptRecord(binding.sealed, `credential:${binding.subject}`, now); }
    catch (error) { if (error instanceof AuthRecordExpiredError) continue; throw error; }
    const credential = parseCredential(raw);
    if (!credential || credential.subject !== binding.subject || credential.tenantId !== tenantId || credential.issuer !== issuer ||
      !accountAvailable(credential, new Date(now)) || !credential.password || credential.mustChange || !credential.totpSecret || !credential.emailVerified ||
      passwordExpired(credential.passwordChangedAt, policy, now) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credential.email)) continue;
    seen.add(binding.user_id);
    out.push({ id: binding.user_id, name: binding.name, email: credential.email, department: binding.department });
  }
  return out;
}
